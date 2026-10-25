import { resolveScalarReturnTarget, resolveFunctionCallerTarget } from './scalarReturnBinding';
import { ColumnAspect, ColumnFlowEntry, ColumnEdge, HopFinding, InvalidRoute } from './smTypes';
import type { DatabaseModel, LineageNode } from '../../engine/types';
import { edgeApiType } from '../support/aiPresenter';
import { getNodeColumns, SCRIPT_TYPES } from '../support/graphUtils';
import { ColumnStore } from '../../engine/columnStore';
import { isIndirectOnly } from '../../engine/shared/bridgeContract';
import { normalizeColName, schemaKey } from '../../utils/sql';
import { DirectedGraph } from 'graphology';
import { bfsFromNode } from 'graphology-traversal';

/** Debug/info/warn/error sink shape shared by every optional logger this module accepts — a local alias, not `engine/graphGuards`' `LogFn`, since `columnTracer.ts` isn't on the `src/ai -> src/engine` coupling allowlist `tests/unit/ai-core/rule-gates.test.ts` gates. */
type TracerLogFn = (level: 'info' | 'debug' | 'warn' | 'error', msg: string, err?: unknown) => void;

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
    for (const ref of this.spineEndpointsFor(candidateNodeId, new Set(), traceDirection)) {
      const key = this.columnKey(ref.col);
      if (!byKey.has(key)) byKey.set(key, ref.col);
    }
    return [...byKey.values()];
  }

  /** The committed endpoints a candidate owns on the traced spine, as qualified identities. */
  spineEndpointsFor(
    candidateNodeId: string,
    writtenCarrierIds: ReadonlySet<string>,
    traceDirection: 'upstream' | 'downstream',
  ): Array<{ node: string; col: string }> {
    const endpoints = new Map<string, { node: string; col: string }>();
    for (const e of this.aspect.edges) {
      if (isIndirectOnly(e.transforms)) continue;
      const node = traceDirection === 'downstream' ? e.to_node : e.from_node;
      const col = traceDirection === 'downstream' ? e.to_col : e.from_col;
      if (!col || (node !== candidateNodeId && !writtenCarrierIds.has(node))) continue;
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
      const question = `Column \`${edge.from_col}\` at \`${edge.from_node}\`: continues the trace into ${fed} at \`${edge.hop_node}\` — establish its column relationships from this object's SQL.`;
      const existing = byNode.get(edge.from_node);
      if (existing) existing.push(question);
      else byNode.set(edge.from_node, [question]);
    }
    return byNode;
  }

  /** Verifies a supplier's independent identity and adjacency; destination-dependent checks stay with the full mapping. */
  validateColumnSupplier(
    focusId: string, cont: ColumnFlowEntry['upstream_columns'][number], path: string,
    nodeMap: Map<string, LineageNode>, store: ColumnStore | null, removedSet?: ReadonlySet<string>,
    contributorIds?: ReadonlySet<string>, log?: TracerLogFn,
  ): { neighbor: LineageNode } | { invalidRoute: InvalidRoute } {
    if (cont.col.trim().length === 0) return { invalidRoute: { kind: 'bad_contributor_col', id: cont.node, path: `${path}.col`,
      reason: 'An upstream column reference must name a non-empty column; procedure metadata fallback does not supply a column identity.' } };
    const neighbor = nodeMap.get(cont.node);
    if (!neighbor) return { invalidRoute: { kind: 'absent_contributor', id: cont.node, path: `${path}.node`,
      reason: `Upstream node "${cont.node}" is absent from the loaded model.` } };
    if (removedSet?.has(neighbor.id)) return { invalidRoute: { kind: 'pruned_contributor', id: cont.node, path: `${path}.node`,
      reason: `Upstream node "${cont.node}" was already pruned earlier this run and cannot supply column "${cont.col}" — a removed node stays removed.` } };
    const columns = (getNodeColumns(neighbor.id, nodeMap, store ?? undefined) ?? []).map(column => column.name);
    if (columns.length && !columns.some(column => this.columnKey(column) === this.columnKey(cont.col))) {
      return { invalidRoute: { kind: 'bad_contributor_col', id: cont.node, path: `${path}.col`,
        reason: `upstream column "${cont.col}" does not exist on "${cont.node}"`, allowed_values: columns, when: { node: neighbor.id } } };
    }
    if (!columns.length && !allowsMissingColumnMetadata(neighbor)) return { invalidRoute: {
      kind: 'bad_contributor_col', id: cont.node, path: `${path}.col`,
      reason: `Column metadata is unavailable for ${neighbor.type} "${neighbor.id}"; upstream column "${cont.col}" cannot be verified.`,
    } };
    if (!columns.length) log?.('debug', `[CT] unverifiable contributor column "${cont.col}" on "${cont.node}" — ${neighbor.type} metadata fallback`);
    // A missing declared column is refused regardless of the supplier's adjacency.
    if (contributorIds && neighbor.id !== focusId && !contributorIds.has(neighbor.id)) return { invalidRoute: {
      kind: 'absent_contributor', id: neighbor.id, path: `${path}.node`,
      reason: `Upstream node "${cont.node}" has no dependency edge to ${focusId}; a column contributor is a neighbor of the focus or a read supplier of its declared scalar caller.`,
    } };
    return { neighbor };
  }

  /** Validates the submitted column flow, verifying existence of output and upstream columns. */
  validateColumnFlow(
    focusId: string,
    finding: Pick<HopFinding, 'column_flow'>,
    nodeMap: Map<string, LineageNode>,
    model: DatabaseModel,
    store: ColumnStore | null,
    log: TracerLogFn | undefined,
    removedSet: ReadonlySet<string> | undefined,
    _traceDirection: 'upstream' | 'downstream',
    incomingRefs?: readonly { node: string; col: string }[],
    returnTargets: readonly { node: string; col: string }[] = [],
    callerTargets: readonly { node: string; col: string }[] = [],
    incomingDownstreamRefs: readonly { node: string; col: string }[] = [],
    roots: readonly { node: string; col: string }[] = [],
    contributorIds?: ReadonlySet<string>,
  ): { invalidRoutes: InvalidRoute[]; stagedEdges: ColumnEdge[]; entrySides?: Array<{ index: number; upstream: boolean; downstream: boolean }> } {
    const identifierKey = (id: string): string => schemaKey(id, model.identifierCaseSensitive);
    const invalidRoutes: InvalidRoute[] = [];
    const stagedEdges: ColumnEdge[] = [];

    const columnFlow = finding.column_flow ?? [];
    if (returnTargets.length) {
      for (const target of returnTargets) {
        const entries = columnFlow.filter(entry => entry.returns_to && entry.returns_to.node === target.node && this.columnKey(entry.returns_to.col) === this.columnKey(target.col));
        if (entries.length !== 1) invalidRoutes.push({ kind: 'bad_return_target', id: focusId, path: 'column_flow', reason: `Scalar caller destination ${target.node}.${target.col} requires exactly one authored returns_to entry.` });
      }
    }
    if (columnFlow.length === 0) {
      return { invalidRoutes, stagedEdges };
    }

    const focusNode = nodeMap.get(focusId);
    if (!focusNode) return { invalidRoutes, stagedEdges };

    const validFocusCols = new Set<string>((getNodeColumns(focusNode.id, nodeMap, store ?? undefined) || []).map((c) => this.columnKey(c.name)));
    const entryEdges = new Map<number, ColumnEdge[]>();

    for (let entryIndex = 0; entryIndex < columnFlow.length; entryIndex++) {
      const entry = columnFlow[entryIndex];
      const suppliers = entry.upstream_columns.map((ref, index) => {
        const checked = this.validateColumnSupplier(focusId, ref, `column_flow.${entryIndex}.upstream_columns.${index}`,
          nodeMap, store, removedSet, contributorIds, log);
        if ('invalidRoute' in checked) { invalidRoutes.push(checked.invalidRoute); return undefined; }
        return checked.neighbor;
      });
      const outNorm = this.columnKey(entry.out_col);
      if (returnTargets.length || entry.returns_to) {
        const target = entry.returns_to;
        const declared = target && callerTargets.some(expected => expected.node === target.node && this.columnKey(expected.col) === this.columnKey(target.col));
        const bound = target ? resolveScalarReturnTarget(focusId, target, nodeMap, store, model.identifierCaseSensitive)
          ?? (declared && validFocusCols.size === 0 ? resolveFunctionCallerTarget(focusId, target, nodeMap, model, store) : null) : null;
        if (!bound || entry.writes_to !== undefined || this.columnKey(entry.out_col) !== this.columnKey(bound.col)
          || !returnTargets.some(expected => expected.node === bound.node && this.columnKey(expected.col) === this.columnKey(bound.col))) {
          invalidRoutes.push({ kind: 'bad_return_target', id: focusId, path: `column_flow.${entryIndex}.returns_to`, reason: 'returns_to must identify one supplied qualified scalar caller output, match out_col, and exclude writes_to.' });
          continue;
        }
      }

      if (!entry.returns_to && validFocusCols.size === 0 && !allowsMissingColumnMetadata(focusNode)) {
        invalidRoutes.push({ kind: 'bad_out_col', id: focusId, path: `column_flow.${entryIndex}.out_col`, reason: `Column metadata is unavailable for ${focusNode.type} "${focusId}"; output "${entry.out_col}" cannot be verified.` });
        continue;
      }
      if (!entry.returns_to && validFocusCols.size > 0 && !validFocusCols.has(outNorm)) {
          invalidRoutes.push({ kind: 'bad_out_col', id: focusId, path: `column_flow.${entryIndex}.out_col`, reason: `out_col "${entry.out_col}" does not exist on ${focusId}`, allowed_values: (getNodeColumns(focusId, nodeMap, store ?? undefined) ?? []).map(column => column.name), when: { node: focusId } });
        continue;
      }

      const stagedBeforeEntry = stagedEdges.length;
      const resolvedTarget = resolveColumnFlowTarget(entry, focusId, nodeMap);
      const toNodeId = resolvedTarget?.attributionTo ?? null;
      const toNodeObj = toNodeId ? nodeMap.get(toNodeId) : null;
      if (entry.writes_to && !toNodeObj) {
        invalidRoutes.push({ kind: 'bad_write_target', id: entry.writes_to.node, path: `column_flow.${entryIndex}.writes_to.node`, reason: `writes_to target "${entry.writes_to.node}" is absent from the loaded model.` });
        continue;
      }
      if (entry.writes_to && toNodeObj && toNodeId && identifierKey(toNodeId) !== identifierKey(focusId)) {
        const focusLower = identifierKey(focusId);
        const toLower = identifierKey(toNodeId);
        if (!model.edges.some(e => identifierKey(e.source) === focusLower && identifierKey(e.target) === toLower)) {
          invalidRoutes.push({ kind: 'bad_write_target', id: toNodeObj.id, path: `column_flow.${entryIndex}.writes_to.node`, reason: `writes_to names "${toNodeObj.id}" but ${focusId} has no recorded dependency into it.` });
          continue;
        }
      }
      if (entry.writes_to === null && focusNode.type === 'procedure'
        && model.edges.some(e => identifierKey(e.source) === identifierKey(focusId) && edgeApiType(e.type, focusNode.type) === 'write')) {
        log?.('debug', `[CT] writes_to null on writer focus="${focusId}" out_col="${entry.out_col}" — no writer edge staged`);
      }
      const toCol = resolvedTarget?.attributionCol ?? entry.out_col;
      if (toNodeObj && !entry.returns_to) {
        const toCols = new Set<string>((getNodeColumns(toNodeObj.id, nodeMap, store ?? undefined) || []).map((c) => this.columnKey(c.name)));
        if (toCols.size === 0 && !allowsMissingColumnMetadata(toNodeObj)) {
          invalidRoutes.push({ kind: 'bad_out_col', id: toNodeObj.id, path: `column_flow.${entryIndex}.writes_to.col`, reason: `Column metadata is unavailable for ${toNodeObj.type} "${toNodeObj.id}"; destination "${toCol}" cannot be verified.` });
          continue;
        }
        if (toCols.size > 0 && !toCols.has(this.columnKey(toCol))) {
          invalidRoutes.push({ kind: 'bad_out_col', id: toNodeObj.id, path: `column_flow.${entryIndex}.writes_to.col`, reason: `to_col "${toCol}" does not exist on ${toNodeObj.id}`, allowed_values: (getNodeColumns(toNodeObj.id, nodeMap, store ?? undefined) ?? []).map(column => column.name), when: { node: toNodeObj.id } });
          continue;
        }
      }
      const toNodeForEdge = toNodeId;

      for (let refIndex = 0; refIndex < entry.upstream_columns.length; refIndex++) {
        const cont = entry.upstream_columns[refIndex];
        const neighbor = suppliers[refIndex];
        if (!neighbor) continue;

        if (callerTargets.length && !model.edges.some(edge => edge.source === neighbor.id
          && (edge.target === focusId || (entry.returns_to
            ? edge.target === toNodeForEdge
            : callerTargets.some(target => edge.target === target.node)))
          && edgeApiType(edge.type, neighbor.type) === 'read')) {
          invalidRoutes.push({ kind: 'absent_contributor', id: neighbor.id, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.node`, reason: 'A caller-context investigation accepts real read contributors of the function or its declared callers, not unrelated loaded objects.' });
          continue;
        }

        const fromNode = neighbor.id;
        if (fromNode === toNodeForEdge && this.columnKey(cont.col) === this.columnKey(toCol)) {
          const neighborCols = (getNodeColumns(neighbor.id, nodeMap, store ?? undefined) ?? []).map(column => column.name);
          invalidRoutes.push({
            kind: 'self_loop_column',
            id: fromNode,
            path: `column_flow.${entryIndex}.upstream_columns.${refIndex}`,
            reason: `upstream_columns entry "${fromNode}.${cont.col}" is identical to its own writes_to target "${toNodeForEdge}.${toCol}" - a column cannot be its own upstream source.`,
            ...(neighborCols.length > 0 ? { allowed_values: neighborCols, when: { node: neighbor.id } } : {}),
          });
          continue;
        }

        if (!toNodeForEdge) continue;
        stagedEdges.push({
          hop: 0,
          hop_node: focusId,
          to_node: toNodeForEdge,
          to_col: toCol,
          from_node: fromNode,
          from_col: cont.col,
          ...(cont.transforms ? { transforms: [...cont.transforms] } : {}),
          ...(cont.note ? { note: cont.note } : {}),
        });
      }

      const writerEdge = resolvedTarget?.writerEdge ?? null;
      const writerTargetObj = writerEdge ? nodeMap.get(writerEdge.toNode) : null;
      if (writerEdge && writerTargetObj && !SCRIPT_TYPES.has(writerTargetObj.type)
        && entry.upstream_columns.every(ref => isIndirectOnly(ref.transforms))) {
        stagedEdges.push({
          hop: 0,
          hop_node: focusId,
          from_node: focusId,
          from_col: entry.out_col,
          to_node: writerEdge.toNode,
          to_col: writerEdge.toCol,
        });
      }
      entryEdges.set(entryIndex, stagedEdges.slice(stagedBeforeEntry));
    }

    // Attachment to the requested chain selects CT carry only; when no separate downstream
    // obligations are supplied, carry is computed directly by the caller from stagedEdges.
    if (incomingDownstreamRefs.length === 0) return { invalidRoutes, stagedEdges };

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
        const target = resolveColumnFlowTarget(entry, focusId, nodeMap);
        const upstream = activeNorm.includes(this.columnKey(entry.out_col)) && (anchors.has(endpointKey(focusId, entry.out_col))
          || target !== null && anchors.has(endpointKey(target.attributionTo, target.attributionCol)));
        const downstream = incomingDownstreamRefs.some(ref => this.columnKey(ref.col) === this.columnKey(entry.out_col));
        if ((upstream || downstream) && (upstream && upDetached.length === 0 || downstream && downDetached.length === 0)) {
          entrySides.push({ index: entryIndex, upstream, downstream });
        }
        continue;
      }
      if (edges.length === 0 && entry.upstream_columns.length > 0) continue;
      const attachedUpstream = edges.length === 0 ? anchors.has(endpointKey(focusId, entry.out_col)) : upDetached.length === 0;
      const attachedDownstream = edges.length > 0 && downDetached.length === 0;
      const upstream = attachedUpstream && activeNorm.includes(this.columnKey(entry.out_col));
      if (upstream || attachedDownstream) {
        entrySides.push({ index: entryIndex, upstream, downstream: attachedDownstream });
      }
    }
    return { invalidRoutes, stagedEdges, entrySides };
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
  direction: 'upstream' | 'downstream' = 'upstream',
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

/** Computes which column endpoints and edges attach to the requested origin outputs (`roots`). */
export function columnAttachment(
  roots: readonly { node: string; col: string }[],
  edges: ReadonlyArray<ColumnClosureEdge>,
  direction: 'upstream' | 'downstream' | 'both',
  endpointKey: (node: string, col: string) => string,
): ColumnAttachment {
  const rootKeys = new Set(roots.map(root => endpointKey(root.node, root.col)));
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

/** Returns the attached endpoint keys of {@link columnAttachment} for CT carry selection. */
export function columnClosure(
  roots: readonly { node: string; col: string }[],
  edges: ReadonlyArray<ColumnClosureEdge>,
  direction: 'upstream' | 'downstream' | 'both',
  endpointKey: (node: string, col: string) => string,
): Set<string> {
  return columnAttachment(roots, edges, direction, endpointKey).endpoints;
}

interface ColumnFlowTargetResolution {
  attributionTo: string;
  attributionCol: string;
  writerEdge: { toNode: string; toCol: string } | null;
}

/** Resolves where one `column_flow` entry's recorded columns land and any explicit writer edge. */
export function resolveColumnFlowTarget(
  entry: ColumnFlowEntry,
  focusId: string,
  nodeMap: Map<string, LineageNode>,
): ColumnFlowTargetResolution | null {
  if (entry.returns_to) {
    const toNode = nodeMap.get(entry.returns_to.node)?.id;
    if (!toNode) return null;
    return { attributionTo: toNode, attributionCol: entry.returns_to.col, writerEdge: null };
  }
  if (entry.writes_to?.node) {
    const toNode = nodeMap.get(entry.writes_to.node)?.id;
    if (!toNode) return null;
    return {
      attributionTo: toNode,
      attributionCol: entry.writes_to.col,
      writerEdge: { toNode, toCol: entry.writes_to.col },
    };
  }
  if (nodeMap.get(focusId)?.type === 'procedure') return null;
  return { attributionTo: focusId, attributionCol: entry.out_col, writerEdge: null };
}

/** A node whose column names are trusted unverified when it has no column metadata: a procedure, an external object or a function without declared columns. Tables and views always own columns. */
export function allowsMissingColumnMetadata(node: LineageNode): boolean {
  return node.type === 'procedure' || node.type === 'external' || node.type === 'function';
}
