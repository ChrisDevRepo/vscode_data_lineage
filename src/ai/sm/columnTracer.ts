import { resolveScalarReturnTarget, resolveFunctionCallerTarget } from './scalarReturnBinding';
import { ColumnAspect, ColumnFlowEntry, ColumnEdge, HopFinding, InvalidRoute } from './smTypes';
import type { DatabaseModel, LineageNode } from '../../engine/types';
import { resolveModelNodeId } from '../support/modelReferences';
import { edgeApiType } from '../support/aiPresenter';
import { getNodeColumns } from '../support/graphUtils';
import { ColumnStore } from '../../engine/columnStore';
import { isIndirectOnly } from '../../engine/shared/bridgeContract';
import { normalizeColName, schemaKey } from '../../utils/sql';
import { DirectedGraph } from 'graphology';
import { bfsFromNode } from 'graphology-traversal';

/** Debug/info/warn/error sink shape shared by every optional logger this module accepts — a local alias, not `engine/graphGuards`' `LogFn`, since `columnTracer.ts` isn't on the `src/ai -> src/engine` coupling allowlist `tests/unit/ai-core/rule-gates.test.ts` gates. */
type TracerLogFn = (level: 'info' | 'debug' | 'warn' | 'error', msg: string, err?: unknown) => void;

/** Native-valid destination fields used to prepare one column entry. */
export type ColumnFlowHeader = Pick<ColumnFlowEntry, 'out_node' | 'out_col' | 'returns_to'>;
/** One authored supplier checked against the current model at its original path. */
export interface VerifiedColumnSupplier { ref: ColumnFlowEntry['upstream_columns'][number]; neighbor: LineageNode; path: string }

/** Traces column-level lineage (Column Flow) between database objects. */
export class ColumnTracer {
  private aspect: ColumnAspect;

  /**
   * @param targetColumns - Columns requested at the start of the trace.
   * @param initialAspect - Existing aspect to continue from instead of a fresh one; the engine always starts fresh.
   *
   * @remarks
   * `target_columns` and `active_columns` are copied, never aliased: the snapshot invariant is
   * `JSON.stringify(init.targetColumns) === JSON.stringify(columnAspect.target_columns)`, so a
   * shared array would let an in-place edit silently rewrite the frozen target set and break `toJSON()`.
   */
  constructor(targetColumns: string[], initialAspect?: ColumnAspect, private readonly identifierCaseSensitive = false) {
    this.aspect = initialAspect ?? {
      target_columns: [...targetColumns],
      active_columns: [...targetColumns],
      edges: [],
    };
  }

  private columnKey = (value: string): string => normalizeColName(value, this.identifierCaseSensitive);

  /** Current column-trace state. */
  get state(): ColumnAspect {
    return this.aspect;
  }

  /**
   * The aspect a complete exploration delivers: authored edges attached to the tracked roots in the approved
   * direction by the same owner as hop-time carry. Detached claims are withheld and logged; no edge is added or rewritten.
   */
  deliveredState(roots: readonly { node: string; col: string }[], direction: 'upstream' | 'downstream' | 'both', log?: TracerLogFn): ColumnAspect {
    const closure = columnAttachment(roots, this.aspect.edges, direction, columnEndpointKeyFactory(new Map(), this.identifierCaseSensitive));
    const delivered = this.aspect.edges.filter(edge => closure.attaches(edge));
    if (delivered.length === this.aspect.edges.length) return this.aspect;
    const detached = this.aspect.edges.filter(edge => !delivered.includes(edge)).map(e => `${e.from_node}.${e.from_col} -> ${e.to_node}.${e.to_col}`);
    log?.('debug', `[Disposition] getResult withholds ${detached.length} column edge(s) outside the closure of the tracked roots — ${detached.join(', ')}`);
    return { ...this.aspect, edges: delivered };
  }

  /** Columns requested at the start of the trace. */
  get targetColumns(): string[] {
    return this.aspect.target_columns;
  }

  /** Tracked columns served to the next hop. */
  get activeColumns(): string[] {
    return this.aspect.active_columns;
  }

  /** Column-flow edges committed so far. */
  get edges(): ColumnEdge[] {
    return this.aspect.edges;
  }

  /** Replaces the active column set after a hop commits new edges. */
  setActiveColumns(columns: string[]): void {
    this.aspect.active_columns = columns;
  }

  /** Distinct column names of the committed endpoints a candidate owns on the traced spine. */
  spineColumnsFor(candidateNodeId: string, traceDirection: 'upstream' | 'downstream'): string[] {
    const byKey = new Map<string, string>();
    for (const ref of this.spineEndpointsFor(candidateNodeId, traceDirection)) {
      const key = this.columnKey(ref.col);
      if (!byKey.has(key)) byKey.set(key, ref.col);
    }
    return [...byKey.values()];
  }

  /** The committed endpoints a candidate owns on the traced spine, as qualified identities. */
  spineEndpointsFor(candidateNodeId: string, traceDirection: 'upstream' | 'downstream'): Array<{ node: string; col: string }> {
    const endpoints = new Map<string, { node: string; col: string }>();
    for (const e of this.aspect.edges) {
      if (isIndirectOnly(e.transforms)) continue;
      const node = traceDirection === 'downstream' ? e.to_node : e.from_node;
      const col = traceDirection === 'downstream' ? e.to_col : e.from_col;
      if (!col || node !== candidateNodeId) continue;
      const key = `${node}|${this.columnKey(col)}`;
      if (!endpoints.has(key)) endpoints.set(key, { node, col });
    }
    return [...endpoints.values()];
  }

  /** Generates continuation questions only for qualified endpoints the next hop receives; extra accepted graph pairs remain stored without inventing another task. */
  getColumnLineageQuestionsByNode(focusId: string, hopCount: number, continuations: ReadonlyMap<string, readonly { node: string; col: string }[]>): Map<string, string[]> {
    const hopEdges = this.aspect.edges.filter(
      e => e.hop_node === focusId && e.hop === hopCount && e.from_node !== e.hop_node && !isIndirectOnly(e.transforms)
        && continuations.get(e.from_node)?.some(ref => ref.node === e.from_node && this.columnKey(ref.col) === this.columnKey(e.from_col)),
    );
    const byNode = new Map<string, string[]>();
    if (hopEdges.length === 0) return byNode;

    const fedByKey = new Map<string, { edge: ColumnEdge; toCols: string[] }>();
    for (const edge of hopEdges) {
      const key = `${edge.from_node}.${edge.from_col}`;
      const group = fedByKey.get(key);
      if (!group) fedByKey.set(key, { edge, toCols: [edge.to_col] });
      else if (!group.toCols.some(c => this.columnKey(c) === this.columnKey(edge.to_col))) group.toCols.push(edge.to_col);
    }

    for (const { edge, toCols } of fedByKey.values()) {
      const fed = toCols.map(c => `\`${c}\``).join(', ');
      const question = `Column \`${edge.from_col}\` at \`${edge.from_node}\`: continues the trace into ${fed} at \`${edge.hop_node}\` — determine its origin here.`;
      const existing = byNode.get(edge.from_node);
      if (existing) existing.push(question);
      else byNode.set(edge.from_node, [question]);
    }
    return byNode;
  }

  /** Verifies a supplier's independent identity and adjacency with the one endpoint check. */
  validateColumnSupplier(
    focusId: string, cont: ColumnFlowEntry['upstream_columns'][number], path: string,
    nodeMap: Map<string, LineageNode>, store: ColumnStore | null, removedSet?: ReadonlySet<string>,
    contributorIds?: ReadonlySet<string>, log?: TracerLogFn,
  ): { neighbor: LineageNode } | { invalidRoute: InvalidRoute } {
    if (cont.col.trim().length === 0) return { invalidRoute: { kind: 'bad_contributor_col', id: cont.node, path: `${path}.col`,
      reason: 'An upstream column reference must name a non-empty column; procedure metadata fallback does not supply a column identity.' } };
    const checked = this.checkEndpoint(focusId, cont, { node: `${path}.node`, col: `${path}.col` }, SOURCE_FAULTS, nodeMap, store, removedSet, contributorIds, log);
    return 'invalidRoute' in checked ? checked : { neighbor: checked.node };
  }

  /** The one check of a stored pair endpoint (D-130): a loaded object that is not pruned, the focus or its neighbor, owning the column where metadata exists. */
  private checkEndpoint(
    focusId: string, ref: { node: string; col: string }, at: { node: string; col: string }, faults: EndpointFaults,
    nodeMap: Map<string, LineageNode>, store: ColumnStore | null, removedSet?: ReadonlySet<string>, contributorIds?: ReadonlySet<string>, log?: TracerLogFn,
  ): { node: LineageNode } | { invalidRoute: InvalidRoute } {
    const node = nodeMap.get(ref.node);
    if (!node) return { invalidRoute: { kind: 'absent_contributor', id: ref.node, path: at.node, reason: faults.absent } };
    if (removedSet?.has(node.id)) return { invalidRoute: { kind: 'pruned_contributor', id: ref.node, path: at.node, reason: faults.pruned } };
    const columns = (getNodeColumns(node.id, nodeMap, store ?? undefined) ?? []).map(column => column.name);
    if (columns.length && !columns.some(column => this.columnKey(column) === this.columnKey(ref.col))) {
      return { invalidRoute: { kind: faults.columnKind, id: ref.node, path: at.col, reason: faults.column, allowed_values: columns, when: { node: node.id } } };
    }
    if (!columns.length && !allowsMissingColumnMetadata(node)) return { invalidRoute: { kind: faults.columnKind, id: ref.node, path: at.col, reason: faults.metadata(node.type) } };
    if (!columns.length) log?.('debug', `[CT] unverifiable column "${ref.col}" on "${ref.node}" — ${node.type} metadata fallback`);
    // A missing declared column is refused regardless of the endpoint's adjacency.
    if (contributorIds && node.id !== focusId && !contributorIds.has(node.id)) return { invalidRoute: { kind: 'absent_contributor', id: node.id, path: at.node, reason: faults.edge } };
    return { node };
  }

  /** Stores one direct pair per verified supplier into the entry's destination, `out_node.out_col` or the focus column, after the same endpoint check; a supplier identical to that destination is refused (topology: a column cannot be its own upstream source); the backend adds no pair of its own (D-130). */
  prepareColumnEntry(
    focusId: string, entry: ColumnFlowHeader, suppliers: readonly VerifiedColumnSupplier[], path: string,
    nodeMap: Map<string, LineageNode>, model: DatabaseModel, store: ColumnStore | null, log: TracerLogFn | undefined,
    returnTargets: readonly { node: string; col: string }[], callerTargets: readonly { node: string; col: string }[],
    removedSet?: ReadonlySet<string>, contributorIds?: ReadonlySet<string>,
  ): { invalidRoutes: InvalidRoute[]; stagedEdges: ColumnEdge[] } {
    const invalidRoutes: InvalidRoute[] = [], stagedEdges: ColumnEdge[] = [];
    if (!nodeMap.get(focusId)) return { invalidRoutes, stagedEdges };
    const validFocusCols = new Set((getNodeColumns(focusId, nodeMap, store ?? undefined) ?? []).map(column => this.columnKey(column.name)));
    if (returnTargets.length || entry.returns_to) {
      const target = entry.returns_to;
      const declared = target && callerTargets.some(expected => expected.node === target.node && this.columnKey(expected.col) === this.columnKey(target.col));
      const bound = target ? resolveScalarReturnTarget(focusId, target, nodeMap, store, model.identifierCaseSensitive)
        ?? (declared && validFocusCols.size === 0 ? resolveFunctionCallerTarget(focusId, target, nodeMap, model, store) : null) : null;
      if (!bound || entry.out_node !== undefined || this.columnKey(entry.out_col) !== this.columnKey(bound.col)
        || !returnTargets.some(expected => expected.node === bound.node && this.columnKey(expected.col) === this.columnKey(bound.col))) {
        invalidRoutes.push({ kind: 'bad_return_target', id: focusId, path: `${path}.returns_to`, reason: 'returns_to must identify one supplied qualified scalar caller output, match out_col, and exclude out_node.' });
        return { invalidRoutes, stagedEdges };
      }
    }

    const target = resolveColumnFlowTarget(entry, focusId, nodeMap, this.identifierCaseSensitive);
    if (!entry.returns_to) {
      const node = target?.attributionTo ?? entry.out_node ?? focusId;
      const destination = this.checkEndpoint(focusId, { node, col: entry.out_col }, { node: `${path}.out_node`, col: `${path}.out_col` },
        node === focusId ? FOCUS_FAULTS : DESTINATION_FAULTS, nodeMap, store, removedSet, contributorIds, log);
      if ('invalidRoute' in destination) {
        invalidRoutes.push(destination.invalidRoute);
        return { invalidRoutes, stagedEdges };
      }
    }
    if (!target) return { invalidRoutes, stagedEdges };

    for (const { ref: cont, neighbor, path: refPath } of suppliers) {
      if (callerTargets.length && !model.edges.some(edge => edge.source === neighbor.id
        && (edge.target === focusId || (entry.returns_to
          ? edge.target === target.attributionTo
          : callerTargets.some(caller => edge.target === caller.node)))
        && edgeApiType(edge.type, neighbor.type) === 'read')) {
        invalidRoutes.push({ kind: 'absent_contributor', id: neighbor.id, path: `${refPath}.node`, reason: 'A caller-context investigation accepts real read contributors of the function or its declared callers, not unrelated loaded objects.' });
        continue;
      }
      if (neighbor.id === target.attributionTo && this.columnKey(cont.col) === this.columnKey(target.attributionCol)) {
        invalidRoutes.push({ kind: 'self_loop_column', id: neighbor.id, path: refPath,
          reason: `upstream_columns entry "${neighbor.id}.${cont.col}" is identical to its own out_node target "${target.attributionTo}.${target.attributionCol}" - a column cannot be its own upstream source.` });
        continue;
      }
      stagedEdges.push({
        hop: 0,
        hop_node: focusId,
        to_node: target.attributionTo,
        to_col: target.attributionCol,
        from_node: neighbor.id,
        from_col: cont.col,
        ...(cont.transforms ? { transforms: [...cont.transforms] } : {}),
        ...(cont.note ? { note: cont.note } : {}),
      });
    }
    return { invalidRoutes, stagedEdges };
  }

  /** Destination cardinality depends on a complete list of readable submitted destination identities. */
  checkReturnTargets(focusId: string, targets: readonly { node: string; col: string }[], returned: readonly { node: string; col: string }[] | undefined): InvalidRoute[] {
    return returned === undefined ? [] : targets.flatMap(target => returned.filter(entry => entry.node === target.node && this.columnKey(entry.col) === this.columnKey(target.col)).length === 1 ? []
      : [{ kind: 'bad_return_target' as const, id: focusId, path: 'column_flow', reason: `Scalar caller destination ${target.node}.${target.col} requires exactly one authored returns_to entry.` }]);
  }

  /** Attachment and carry use the complete authored list; local verified edges remain available to independent scope rules. */
  finishColumnFlow(
    focusId: string, columnFlow: readonly ColumnFlowEntry[] | undefined, invalidRoutes: InvalidRoute[], stagedEdges: ColumnEdge[], entryEdges: ReadonlyMap<number, ColumnEdge[]>,
    nodeMap: Map<string, LineageNode>, model: DatabaseModel, incomingRefs: readonly { node: string; col: string }[] | undefined,
    incomingDownstreamRefs: readonly { node: string; col: string }[], roots: readonly { node: string; col: string }[],
  ): { invalidRoutes: InvalidRoute[]; stagedEdges: ColumnEdge[]; entrySides?: Array<{ index: number; upstream: boolean; downstream: boolean }> } {
    // Attachment to the requested chain selects CT carry only; when no separate downstream
    // obligations are supplied, carry is computed directly by the caller from stagedEdges.
    if (!columnFlow || incomingDownstreamRefs.length === 0) return { invalidRoutes, stagedEdges };

    const activeNorm = this.aspect.active_columns.map(this.columnKey);
    const endpointKey = columnEndpointKeyFactory(nodeMap, model.identifierCaseSensitive);
    const committedRefs = this.aspect.edges.filter(edge => !isIndirectOnly(edge.transforms)).flatMap(edge => [
      { node: edge.from_node, col: edge.from_col },
      { node: edge.to_node, col: edge.to_col },
    ]);
    const anchors = new Map((incomingRefs ?? committedRefs)
      .map(ref => [endpointKey(ref.node, ref.col), `${ref.node}.${ref.col}`]));
    if (incomingRefs === undefined && this.aspect.edges.length === 0) {
      for (const col of this.aspect.active_columns) anchors.set(endpointKey(focusId, col), `${focusId}.${col}`);
    }
    const closureEdges = [...this.aspect.edges, ...stagedEdges];
    const attached = columnAttachment(roots, closureEdges, 'upstream', endpointKey);
    const downstreamAttached = columnAttachment(roots, closureEdges, 'downstream', endpointKey);
    const detachedIn = (edges: ColumnEdge[], closure: ColumnAttachment): ColumnEdge[] =>
      edges.filter(edge => !closure.attaches(edge));

    const entrySides: Array<{ index: number; upstream: boolean; downstream: boolean }> = [];
    for (const [entryIndex, edges] of entryEdges) {
      const entry = columnFlow[entryIndex];
      const upDetached = detachedIn(edges, attached);
      const downDetached = detachedIn(edges, downstreamAttached);
      if (entry.upstream_columns.length === 0) {
        const target = resolveColumnFlowTarget(entry, focusId, nodeMap, this.identifierCaseSensitive);
        const upstream = activeNorm.includes(this.columnKey(entry.out_col)) && (anchors.has(endpointKey(focusId, entry.out_col))
          || target !== null && anchors.has(endpointKey(target.attributionTo, target.attributionCol)));
        const downstream = incomingDownstreamRefs.some(ref => this.columnKey(ref.col) === this.columnKey(entry.out_col));
        if ((upstream && upDetached.length === 0) || (downstream && downDetached.length === 0)) {
          entrySides.push({ index: entryIndex, upstream, downstream });
        }
        continue;
      }
      if (edges.length === 0) continue;
      const attachedDownstream = downDetached.length === 0;
      const upstream = upDetached.length === 0 && activeNorm.includes(this.columnKey(entry.out_col));
      if (upstream || attachedDownstream) {
        entrySides.push({ index: entryIndex, upstream, downstream: attachedDownstream });
      }
    }
    return { invalidRoutes, stagedEdges, entrySides };
  }

  /** Direct typed callers use the same supplier, target, edge, cardinality and attachment owners. */
  validateColumnFlow(
    focusId: string, finding: Pick<HopFinding, 'column_flow'>, nodeMap: Map<string, LineageNode>, model: DatabaseModel,
    store: ColumnStore | null, log: TracerLogFn | undefined, removedSet: ReadonlySet<string> | undefined, _traceDirection: 'upstream' | 'downstream',
    incomingRefs?: readonly { node: string; col: string }[], returnTargets: readonly { node: string; col: string }[] = [], callerTargets: readonly { node: string; col: string }[] = [],
    incomingDownstreamRefs: readonly { node: string; col: string }[] = [], roots: readonly { node: string; col: string }[] = [], contributorIds?: ReadonlySet<string>,
  ): ReturnType<ColumnTracer['finishColumnFlow']> {
    const flow = finding.column_flow ?? [], stagedEdges: ColumnEdge[] = [], entryEdges = new Map<number, ColumnEdge[]>();
    const invalidRoutes = this.checkReturnTargets(focusId, returnTargets, flow.flatMap(entry => entry.returns_to ? [entry.returns_to] : []));
    for (const [index, entry] of flow.entries()) {
      const path = `column_flow.${index}`, suppliers: VerifiedColumnSupplier[] = [];
      for (const [refIndex, ref] of entry.upstream_columns.entries()) {
        const refPath = `${path}.upstream_columns.${refIndex}`;
        const checked = this.validateColumnSupplier(focusId, ref, refPath, nodeMap, store, removedSet, contributorIds, log);
        if ('invalidRoute' in checked) invalidRoutes.push(checked.invalidRoute);
        else suppliers.push({ ref, path: refPath, neighbor: checked.neighbor });
      }
      const prepared = this.prepareColumnEntry(focusId, entry, suppliers, path, nodeMap, model, store, log, returnTargets, callerTargets, removedSet, contributorIds);
      invalidRoutes.push(...prepared.invalidRoutes); stagedEdges.push(...prepared.stagedEdges); entryEdges.set(index, prepared.stagedEdges);
    }
    return this.finishColumnFlow(focusId, flow, invalidRoutes, stagedEdges, entryEdges, nodeMap, model, incomingRefs, incomingDownstreamRefs, roots);
  }

}

interface ColumnEndpointLink {
  readonly from: string;
  readonly to: string;
}

/** Builds the canonical identity key of one `(node, column)` endpoint for column-chain reachability. */
export function columnEndpointKeyFactory(nodeMap: Map<string, LineageNode>, identifierCaseSensitive = false): (node: string, col: string) => string {
  return (node, col) => JSON.stringify([nodeMap.get(node)?.id ?? schemaKey(node, identifierCaseSensitive), normalizeColName(col, identifierCaseSensitive)]);
}

function reachableColumnEndpoints(
  seeds: ReadonlySet<string>,
  links: ReadonlyArray<ColumnEndpointLink>,
  direction: 'upstream' | 'downstream',
): Set<string> {
  const graph = new DirectedGraph();
  for (const link of links) {
    graph.mergeNode(link.from);
    graph.mergeNode(link.to);
    graph.mergeEdge(link.from, link.to);
  }
  const reachable = new Set(seeds);
  const visited = new Set<string>();
  for (const seed of seeds) {
    if (!graph.hasNode(seed) || visited.has(seed)) continue;
    bfsFromNode(graph, seed, endpoint => { visited.add(endpoint); }, {
      mode: direction === 'downstream' ? 'outbound' : 'inbound',
    });
  }
  for (const endpoint of visited) reachable.add(endpoint);
  return reachable;
}

type ColumnClosureEdge = Pick<ColumnEdge, 'hop_node' | 'from_node' | 'from_col' | 'to_node' | 'to_col'>;

interface ColumnAttachment {
  readonly endpoints: Set<string>;
  readonly flowing: Set<string>;
  attaches(edge: ColumnClosureEdge): boolean;
}

/** Computes attachment for carry and delivery. A trusted procedure-origin output binds to its own authored write
 * under that name (D-026/D-130); the local root link routes that explicit reference and is never a stored lineage pair. */
export function columnAttachment(
  roots: readonly { node: string; col: string }[],
  storedEdges: ReadonlyArray<ColumnClosureEdge>,
  direction: 'upstream' | 'downstream' | 'both',
  endpointKey: (node: string, col: string) => string,
): ColumnAttachment {
  const rootKeys = new Set(roots.map(root => endpointKey(root.node, root.col)));
  const edges = [...storedEdges, ...storedEdges.flatMap(edge => edge.to_node !== edge.hop_node && rootKeys.has(endpointKey(edge.hop_node, edge.to_col))
    ? [{ hop_node: edge.hop_node, from_node: edge.hop_node, from_col: edge.to_col, to_node: edge.to_node, to_col: edge.to_col }] : [])];
  const links = edges.map(edge => ({ from: endpointKey(edge.from_node, edge.from_col), to: endpointKey(edge.to_node, edge.to_col) }));
  const endpoints = new Set(rootKeys);
  if (direction !== 'downstream') for (const key of reachableColumnEndpoints(rootKeys, links, 'upstream')) endpoints.add(key);
  const flowing = new Set(rootKeys);
  if (direction !== 'upstream') {
    const fed = reachableColumnEndpoints(rootKeys, links, 'downstream');
    for (const key of fed) flowing.add(key);
    for (const key of reachableColumnEndpoints(fed, links, 'upstream')) endpoints.add(key);
  }
  const ownWrites = new Map<string, string>();
  edges.forEach((edge, index) => {
    if (edge.from_node === edge.hop_node && edge.to_node !== edge.from_node && rootKeys.has(links[index].from)
      && !endpoints.has(links[index].to)) ownWrites.set(links[index].to, edge.hop_node);
  });
  if (ownWrites.size > 0) {
    const ownInputs = new Set<string>();
    edges.forEach((edge, index) => { if (ownWrites.get(links[index].to) === edge.hop_node) ownInputs.add(links[index].from); });
    for (const key of ownWrites.keys()) endpoints.add(key);
    for (const key of reachableColumnEndpoints(ownInputs, links.filter(link => !ownWrites.has(link.to)), 'upstream')) endpoints.add(key);
  }
  return {
    endpoints,
    flowing,
    attaches: edge => {
      const to = endpointKey(edge.to_node, edge.to_col);
      return endpoints.has(to) && (!ownWrites.has(to) || ownWrites.get(to) === edge.hop_node);
    },
  };
}

interface ColumnFlowTargetResolution {
  attributionTo: string;
  attributionCol: string;
}

/** Resolves the destination column of one `column_flow` entry: `returns_to`, `out_node.out_col`, or the focus column; `null` when the named object resolves to none. */
export function resolveColumnFlowTarget(
  entry: ColumnFlowHeader,
  focusId: string,
  nodeMap: Map<string, LineageNode>,
  identifierCaseSensitive = false,
): ColumnFlowTargetResolution | null {
  const named = entry.returns_to?.node ?? entry.out_node;
  if (named === undefined) return { attributionTo: focusId, attributionCol: entry.out_col };
  const toNode = resolveModelNodeId(named, nodeMap, identifierCaseSensitive);
  return toNode ? { attributionTo: toNode, attributionCol: entry.returns_to?.col ?? entry.out_col } : null;
}

/** Wording of one endpoint check's faults; reasons are diagnostics, the issue code carries the model-visible text. */
interface EndpointFaults {
  readonly absent: string;
  readonly pruned: string;
  readonly edge: string;
  readonly columnKind: 'bad_contributor_col' | 'bad_out_col';
  readonly column: string;
  readonly metadata: (type: string) => string;
}

const SOURCE_FAULTS: EndpointFaults = {
  absent: 'The upstream node is absent from the loaded model.',
  pruned: 'The upstream node was pruned earlier this run and cannot supply a column; a removed node stays removed.',
  edge: 'The upstream node has no dependency edge to the focus; a column contributor is a neighbor of the focus or a read supplier of its declared scalar caller.',
  columnKind: 'bad_contributor_col',
  column: 'The upstream column does not exist on that node.',
  metadata: type => `Column metadata is unavailable for this ${type}; the upstream column cannot be verified.`,
};

const DESTINATION_FAULTS: EndpointFaults = {
  absent: 'out_node is absent from the loaded model.',
  pruned: 'out_node was pruned earlier this run and cannot receive a column; a removed node stays removed.',
  edge: 'out_node has no dependency edge to the focus.',
  columnKind: 'bad_out_col',
  column: 'out_col does not exist on out_node.',
  metadata: type => `Column metadata is unavailable for this ${type}; the destination column cannot be verified.`,
};

/** The focus as the destination keeps the output-column wording. */
const FOCUS_FAULTS: EndpointFaults = {
  ...DESTINATION_FAULTS,
  column: 'out_col does not exist on the focus object.',
  metadata: type => `Column metadata is unavailable for this ${type}; the output column cannot be verified.`,
};

/** A node whose column names are trusted unverified when it has no column metadata: a procedure, an external object or a function without declared columns. Tables and views always own columns. */
export function allowsMissingColumnMetadata(node: LineageNode): boolean {
  return node.type === 'procedure' || node.type === 'external' || node.type === 'function';
}
