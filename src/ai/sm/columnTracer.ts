import { resolveScalarReturnTarget, resolveFunctionCallerTarget } from './scalarReturnBinding';
import { ColumnAspect, ColumnFlowEntry, ColumnEdge, HopFinding, InvalidRoute } from './smTypes';
import type { DatabaseModel, LineageNode } from '../../engine/types';
import { isIndirectOnly } from '../../engine/shared/bridgeContract';
import { resolveModelNodeId } from '../support/inputNormalization';
import { edgeApiType } from '../support/aiPresenter';
import { getNodeColumns, SCRIPT_TYPES } from '../support/graphUtils';
import { ColumnStore } from '../../engine/columnStore';
import { computeUnaccounted } from './smCompleteness';
import { normalizeColName, schemaKey } from '../../utils/sql';
import { DirectedGraph } from 'graphology';
import { bfsFromNode } from 'graphology-traversal';

/**
 * Debug/info/warn/error sink shape shared by every optional logger this module accepts — a local
 * alias, not `engine/graphGuards`' `LogFn`, since `columnTracer.ts` isn't on the `src/ai ->
 * src/engine` coupling allowlist `tests/unit/ai-core/rule-gates.test.ts` gates.
 */
type TracerLogFn = (level: 'info' | 'debug' | 'warn' | 'error', msg: string, err?: unknown) => void;

/**
 * Traces column-level lineage (Column Flow) between database objects.
 */
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
   * The aspect as delivered, minus the edges whose endpoint the render dispositioned away.
   *
   * @remarks
   * A projection for delivery only, never a mutation: {@link state} keeps every committed edge, so
   * the state dump records the full chain and completeness accounting reads the same edge set it
   * always did. `target_columns`/`active_columns` carry through untouched. Every
   * call projects the edges that remain after withholding through {@link columnAttachment} of `roots`:
   * an edge outside it (one whose path ran through a withheld endpoint) is withheld too and named in one `log` line; no edge is added or rewritten.
   *
   * @param droppedEndpointIds - Endpoint node ids the render withheld; empty on almost every call.
   * @param roots - The requested output columns the trace started from.
   * @param direction - The approved trace direction that defines the closure.
   * @param log - Optional logger naming the edges withheld by the closure.
   * @param rendered - Node ids of the delivered object result; an edge whose destination or
   *   authoring hop is outside it is withheld and named in one `log` line. A source may lie outside.
   * @returns The aspect to deliver — the live state itself when nothing was withheld.
   */
  deliveredState(
    droppedEndpointIds: ReadonlySet<string>,
    roots: readonly { node: string; col: string }[],
    direction: 'upstream' | 'downstream' | 'both',
    log?: TracerLogFn,
    rendered?: ReadonlySet<string>,
  ): ColumnAspect {
    const present = this.aspect.edges.filter(
      e => !droppedEndpointIds.has(e.from_node) && !droppedEndpointIds.has(e.to_node));
    const kept = rendered ? present.filter(e => rendered.has(e.to_node) && rendered.has(e.hop_node)) : present;
    if (kept.length < present.length) {
      const absent = present.filter(e => !kept.includes(e)).map(e => `${e.from_node}.${e.from_col} -> ${e.to_node}.${e.to_col} (hop ${e.hop_node})`);
      log?.('debug', `[Disposition] getResult withholds ${absent.length} column edge(s) whose destination or authoring hop is not in the delivered object result — ${absent.join(', ')}`);
    }
    const endpointKey = columnEndpointKeyFactory(new Map(), this.identifierCaseSensitive);
    const closure = columnAttachment(roots, kept, direction, endpointKey);
    const delivered = kept.filter(e => closure.attaches(e));
    if (delivered.length < kept.length) {
      const detached = kept.filter(e => !delivered.includes(e)).map(e => `${e.from_node}.${e.from_col} -> ${e.to_node}.${e.to_col}`);
      log?.('debug', `[Disposition] getResult withholds ${detached.length} column edge(s) outside the closure of the tracked roots — ${detached.join(', ')}`);
    }
    return delivered.length === this.aspect.edges.length ? this.aspect : { ...this.aspect, edges: delivered };
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

  /**
   * Replaces the active column set after a hop commits new edges.
   *
   * @param columns - The new set of active columns.
   */
  setActiveColumns(columns: string[]): void {
    this.aspect.active_columns = columns;
  }

  /**
   * Active tracked columns the AI left unaccounted for in this hop's `column_flow`.
   *
   * @remarks
   * The structural completeness guard for the column chain: every active column must be resolved —
   * continued (an entry with upstream real columns) or produced here (`upstream_columns: []`). An
   * UPSTREAM trace accounts via `active_columns − {out_col}`; a DOWNSTREAM trace accounts against
   * `out_col` UNION every `upstream_columns[].col` named, since the active column there lives on
   * the PREVIOUS node. A non-empty result is returned on the hop ack as data. The engine does not reject the hop for it.
   *
   * @param columnFlow - The column flow entries submitted by the AI.
   * @param traceDirection - Trace direction of the owning exploration.
   * @returns An array of active columns that were not accounted for.
   */
  unaccountedActiveColumns(columnFlow: ColumnFlowEntry[], traceDirection: 'upstream' | 'downstream'): string[] {
    const accounted = traceDirection === 'downstream'
      ? columnFlow.flatMap(e => [e.out_col, ...e.upstream_columns.map(r => r.col)])
      : columnFlow.map(e => e.out_col);
    return computeUnaccounted(this.aspect.active_columns, accounted, this.identifierCaseSensitive);
  }

  /**
   * Resolves which columns are active for a candidate node, bounded to the traced spine.
   *
   * @remarks
   * The spine for a candidate is the columns flowing *from* it into the tracked chain (staged by
   * the routing hop before dispatch); a non-bodied carrier the candidate writes is on the spine
   * too, since a carrier is never analysed and the column is owed by its producers. Off-spine
   * `entryColumns` are dropped — NORMALIZE-WITH-LOG via `log`, never silent. An empty spine
   * (candidate not yet staged) falls back to `entryColumns` so the node still dispatches.
   *
   * @param candidateNodeId - The id of the node being considered.
   * @param entryColumns - The columns declared for entry by the AI.
   * @param writtenCarrierIds - Non-bodied carriers the candidate writes; empty when it writes none.
   * @param log - Optional logger; the caller (`smBase.ts`) supplies the one it already holds.
   * @param traceDirection - Trace direction of the owning exploration. `from_node`/`from_col` name
   * the supplier side (next node, upstream); `to_node`/`to_col` name the write target (next node,
   * downstream).
   * @returns The resolved active columns for the candidate node.
   */
  determineActiveColumnsForCandidate(
    candidateNodeId: string,
    entryColumns: string[],
    writtenCarrierIds: ReadonlySet<string> = new Set(),
    log: TracerLogFn | undefined,
    traceDirection: 'upstream' | 'downstream',
  ): string[] {
    const spineByNorm = new Map<string, string>();
    for (const ref of this.spineEndpointsFor(candidateNodeId, writtenCarrierIds, traceDirection)) {
      const key = this.columnKey(ref.col);
      if (!spineByNorm.has(key)) spineByNorm.set(key, ref.col);
    }
    if (spineByNorm.size === 0) return entryColumns;
    const spine = [...spineByNorm.values()];
    if (log && entryColumns.length > 0) {
      const spineNorms = new Set(spineByNorm.keys());
      const dropped = entryColumns.filter((c) => !spineNorms.has(this.columnKey(c)));
      if (dropped.length > 0) {
        log('debug', `[Normalize] entry columns bound to spine id=${candidateNodeId} from=[${entryColumns.join(', ')}] to=[${spine.join(', ')}] — off-spine entry column(s) dropped: [${dropped.join(', ')}]`);
      }
    }
    return spine;
  }

  /**
   * The committed endpoints a candidate owns on the traced spine, as qualified identities.
   *
   * @remarks
   * Upstream, an endpoint is the source side of a committed edge that sits on the candidate or on a
   * non-bodied carrier it writes; downstream, the destination side. Each endpoint is an exact
   * recorded (node, column) pair, deduplicated by identity — never a column name matched on
   * another object.
   *
   * @param candidateNodeId - Canonical id of the candidate node.
   * @param writtenCarrierIds - Non-bodied carriers the candidate writes.
   * @param traceDirection - Which edge side names the candidate's endpoint.
   * @returns The candidate's qualified spine endpoints in commit order.
   */
  spineEndpointsFor(
    candidateNodeId: string,
    writtenCarrierIds: ReadonlySet<string>,
    traceDirection: 'upstream' | 'downstream',
  ): Array<{ node: string; col: string }> {
    const endpoints = new Map<string, { node: string; col: string }>();
    for (const e of this.aspect.edges) {
      const node = traceDirection === 'downstream' ? e.to_node : e.from_node;
      const col = traceDirection === 'downstream' ? e.to_col : e.from_col;
      if (!col || (node !== candidateNodeId && !writtenCarrierIds.has(node))) continue;
      const key = `${node}|${this.columnKey(col)}`;
      if (!endpoints.has(key)) endpoints.set(key, { node, col });
    }
    return [...endpoints.values()];
  }

  /**
   * Generates chain-continuation questions for the real upstream column edges staged at the given
   * hop, grouped by the upstream node that must next answer each one. Injected as
   * `<lineage_questions>` in that node's own `<current_task>` — never a different, unrelated hop.
   *
   * @remarks
   * Terminal/current-node production (`upstream_columns: []`) stages no edge and spawns no
   * question. Each question is labelled by `edge.from_col`, not `edge.to_col`, so the wording
   * matches that hop's own `<column_trace>` active-column label. Writer edges
   * (`from_node === hop_node`) never spawn one: they attribute the focus's own write, they do not
   * continue the chain into the focus again.
   *
   * @param focusId - The id of the focus node.
   * @param hopCount - The hop count matching the edges to query.
   * @returns Continuation questions keyed by the upstream node id that must answer each one.
   */
  getColumnLineageQuestionsByNode(focusId: string, hopCount: number): Map<string, string[]> {
    const hopEdges = this.aspect.edges.filter(
      e => e.hop_node === focusId && e.hop === hopCount && e.from_node !== e.hop_node,
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

  /**
   * Validates the submitted column flow, verifying existence of output and upstream columns.
   *
   * @remarks
   * Also rejects a degenerate self-loop entry — an `upstream_columns` contributor whose resolved
   * node+column equals the entry's own resolved `writes_to` target (or the focus node, when
   * `writes_to` is omitted) — via {@link InvalidRoute} kind `self_loop_column`. A column can never
   * be its own upstream source, so no edge is staged for that contributor.
   *
   * @param focusId - The id of the focus node.
   * @param finding - The parsed findings submission containing the column_flow.
   * @param nodeMap - Map of all available lineage nodes.
   * @param model - The underlying database model.
   * @param store - Optional column store for checking declared column lists.
   * @param log - Optional logger; a neighbour with zero declared columns cannot be verified, so
   * only procedure/external fallback is accepted and logged at `debug`; ordinary table/view references require declared columns.
   * @param removedSet - Node ids already pruned this run (PRUNE-BEFORE-DEMAND). Naming an
   * already-removed node as an `upstream_columns` supplier is rejected here, at declare time,
   * rather than staging a demand `enqueueHop` can never dispatch to.
   * @param traceDirection - Trace direction of the owning exploration; resolves which neighbour
   * side a continuation may name at a body-less focus (producers for upstream, consumers for
   * downstream).
   * @param incomingRefs - Transient qualified endpoints supplied by the task context. When omitted,
   * committed endpoints anchor validation, or the initial focus columns when no edges are committed.
   * They select entry sides; attachment is decided by the {@link columnAttachment} of `roots` alone.
   * @param incomingDownstreamRefs - Separate explicitly arriving downstream obligations at a mixed-side hop.
   *   The two anchor sets remain separate to preserve their recorded continuation legs.
   * @param roots - The requested output columns; with the committed and staged edges they define
   *   {@link columnAttachment} in the hop's direction (both sides at a mixed-side hop).
   * @param contributorIds - Canonical ids an `upstream_columns` contributor may name besides the
   *   focus: its object neighbors and the read suppliers of its declared scalar callers. A column the
   *   object does not declare, a literal, or a carrier continuation at a non-writer is refused wherever
   *   the object sits; any other contributor is dropped with an `absent_contributor` notice, so no column edge joins an object
   *   unconnected to the hop; omitted, adjacency is not checked.
   * @returns Validation result containing any error, invalid routes, successfully staged edges and
   *   the accepted entry sides when separate downstream obligations were supplied.
   */
  validateColumnFlow(
    focusId: string,
    finding: HopFinding,
    nodeMap: Map<string, LineageNode>,
    model: DatabaseModel,
    store: ColumnStore | null,
    log: TracerLogFn | undefined,
    removedSet: ReadonlySet<string> | undefined,
    traceDirection: 'upstream' | 'downstream',
    incomingRefs?: readonly { node: string; col: string }[],
    returnTargets: readonly { node: string; col: string }[] = [],
    callerTargets: readonly { node: string; col: string }[] = [],
    incomingDownstreamRefs: readonly { node: string; col: string }[] = [],
    roots: readonly { node: string; col: string }[] = [],
    contributorIds?: ReadonlySet<string>,
  ): { error?: { error: string; hint: string }; invalidRoutes: InvalidRoute[]; stagedEdges: ColumnEdge[]; entrySides?: Array<{ index: number; upstream: boolean; downstream: boolean }> } {
    const identifierKey = (id: string): string => schemaKey(id, model.identifierCaseSensitive);
    const invalidRoutes: InvalidRoute[] = [];
    const stagedEdges: ColumnEdge[] = [];

    const columnFlow = finding.column_flow ?? [];
    if (returnTargets.length) {
      for (const target of returnTargets) {
        const entries = columnFlow.filter(entry => entry.returns_to && resolveModelNodeId(entry.returns_to.node, nodeMap, model.identifierCaseSensitive) === target.node && this.columnKey(entry.returns_to.col) === this.columnKey(target.col));
        if (entries.length !== 1) invalidRoutes.push({ kind: 'bad_return_target', id: focusId, path: 'column_flow', reason: `Scalar caller destination ${target.node}.${target.col} requires exactly one authored returns_to entry.` });
      }
    }
    if (columnFlow.length === 0) {
      return { invalidRoutes, stagedEdges };
    }

    const focusNode = nodeMap.get(focusId);
    if (!focusNode) return { invalidRoutes, stagedEdges };

    const focusIsCarrier = !SCRIPT_TYPES.has(focusNode.type);
    const continuationSide = traceDirection === 'downstream' ? 'out' : 'in';
    const continuationNeighbors = focusIsCarrier
      ? new Set((model.neighborIndex[identifierKey(focusId)]?.[continuationSide] ?? []).map((id) => identifierKey(id)))
      : null;

    const validFocusCols = new Set<string>((getNodeColumns(focusNode.id, nodeMap, store ?? undefined) || []).map((c) => this.columnKey(c.name)));
    const activeNorm = this.aspect.active_columns.map(this.columnKey);
    const entryEdges = new Map<number, ColumnEdge[]>();
    const endpointKey = columnEndpointKeyFactory(nodeMap, model.identifierCaseSensitive);
    const committedRefs = this.aspect.edges.flatMap(edge => [
      { node: edge.from_node, col: edge.from_col },
      { node: edge.to_node, col: edge.to_col },
    ]);
    const anchors = new Map((incomingRefs ?? committedRefs)
      .map(ref => [endpointKey(ref.node, ref.col), `${resolveModelNodeId(ref.node, nodeMap, model.identifierCaseSensitive) ?? ref.node}.${ref.col}`]));
    if (incomingRefs === undefined && this.aspect.edges.length === 0) {
      for (const col of this.aspect.active_columns) anchors.set(endpointKey(focusId, col), `${focusId}.${col}`);
    }

    for (let entryIndex = 0; entryIndex < columnFlow.length; entryIndex++) {
      const entry = columnFlow[entryIndex];
      const outNorm = this.columnKey(entry.out_col);
      if (focusNode.type === 'function' && validFocusCols.size === 0 && !entry.returns_to) {
        invalidRoutes.push({ kind: 'bad_return_target', id: focusId, path: `column_flow.${entryIndex}.out_col`, reason: 'This function declares no real output columns. Only a supplied scalar caller destination can receive its authored contribution.' });
        continue;
      }
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

      if (traceDirection === 'upstream' && incomingDownstreamRefs.length === 0 && !activeNorm.includes(outNorm)) {
        const existsOnNode = validFocusCols.size > 0 && validFocusCols.has(outNorm);
        invalidRoutes.push(existsOnNode
          ? { kind: 'untracked_out_col', id: focusId, path: `column_flow.${entryIndex}.out_col`, reason: `out_col "${entry.out_col}" exists on ${focusId} but is not an actively tracked column`, available_columns: [...this.aspect.active_columns] }
          : { kind: 'bad_out_col', id: focusId, path: `column_flow.${entryIndex}.out_col`, reason: `out_col "${entry.out_col}" is not an active tracked column`, available_columns: [...this.aspect.active_columns], ...(validFocusCols.size > 0 && focusNode.type !== 'procedure' ? { actual_columns: (getNodeColumns(focusNode.id, nodeMap, store ?? undefined) ?? []).map(column => column.name) } : {}) });
        continue;
      }

      if (!entry.returns_to && validFocusCols.size === 0 && !allowsMissingColumnMetadata(focusNode)) {
        invalidRoutes.push({ kind: 'bad_out_col', id: focusId, path: `column_flow.${entryIndex}.out_col`, reason: `Column metadata is unavailable for ${focusNode.type} "${focusId}"; output "${entry.out_col}" cannot be verified.` });
        continue;
      }
      if (!entry.returns_to && validFocusCols.size > 0 && !validFocusCols.has(outNorm)) {
          invalidRoutes.push({ kind: 'bad_out_col', id: focusId, path: `column_flow.${entryIndex}.out_col`, reason: `out_col "${entry.out_col}" does not exist on ${focusId}`, available_columns: Array.from(validFocusCols).sort(), ...(focusNode.type !== 'procedure' ? { actual_columns: (getNodeColumns(focusNode.id, nodeMap, store ?? undefined) ?? []).map(column => column.name) } : {}) });
        continue;
      }

      const stagedBeforeEntry = stagedEdges.length;
      const resolvedTarget = resolveColumnFlowTarget(entry, focusId, nodeMap, model.identifierCaseSensitive);
      const toNodeId = resolvedTarget?.attributionTo ?? null;
      const toNodeObj = toNodeId ? nodeMap.get(toNodeId) : null;
      if (entry.writes_to && !toNodeObj) {
        invalidRoutes.push({ kind: 'absent_contributor', id: entry.writes_to.node, path: `column_flow.${entryIndex}.writes_to.node`, reason: `writes_to target "${entry.writes_to.node}" is absent from the loaded model.` });
        continue;
      }
      if (entry.writes_to && toNodeObj && toNodeId && identifierKey(toNodeId) !== identifierKey(focusId)) {
        const focusLower = identifierKey(focusId);
        const toLower = identifierKey(toNodeId);
        const verbs = new Set<string>();
        for (const e of model.edges) {
          if (identifierKey(e.source) === focusLower && identifierKey(e.target) === toLower) {
            verbs.add(edgeApiType(e.type, focusNode.type));
          }
        }
        if (verbs.size === 0) {
          invalidRoutes.push({ kind: 'bad_writes_to_target', id: toNodeObj.id, path: `column_flow.${entryIndex}.writes_to.node`, reason: `writes_to names "${toNodeObj.id}" but ${focusId} has no recorded dependency into it — a write destination is a node this hop writes.` });
          continue;
        }
        if ([...verbs].every((v) => v === 'read')) {
          invalidRoutes.push({ kind: 'bad_writes_to_target', id: toNodeObj.id, path: `column_flow.${entryIndex}.writes_to.node`, reason: `writes_to names "${toNodeObj.id}" but that node only reads ${focusId} — a downstream reader is never the write destination.` });
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
          invalidRoutes.push({ kind: 'bad_out_col', id: toNodeObj.id, path: `column_flow.${entryIndex}.writes_to.col`, reason: `to_col "${toCol}" does not exist on ${toNodeObj.id}`, available_columns: Array.from(toCols).sort(), ...(toNodeObj.type !== 'procedure' ? { actual_columns: (getNodeColumns(toNodeObj.id, nodeMap, store ?? undefined) ?? []).map(column => column.name) } : {}) });
          continue;
        }
      }
      const toNodeForEdge = toNodeId ?? focusId;

      const rowRoleOnly: string[] = [];
      for (let refIndex = 0; refIndex < entry.upstream_columns.length; refIndex++) {
        const cont = entry.upstream_columns[refIndex];
        if (cont.col.trim().length === 0) {
          invalidRoutes.push({ kind: 'bad_contributor_col', id: cont.node, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.col`, reason: 'An upstream column reference must name a non-empty column; procedure metadata fallback does not supply a column identity.' });
          continue;
        }
        const neighborId = resolveModelNodeId(cont.node, nodeMap, model.identifierCaseSensitive);
        const neighbor = neighborId ? nodeMap.get(neighborId) : null;
        if (!neighbor) {
          invalidRoutes.push({ kind: 'absent_contributor', id: cont.node, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.node`, reason: `Upstream node "${cont.node}" is absent from the loaded model.` });
          continue;
        }

        if (callerTargets.length && !model.edges.some(edge => edge.source === neighbor.id
          && (edge.target === focusId || (entry.returns_to
            ? edge.target === toNodeForEdge
            : callerTargets.some(target => edge.target === target.node)))
          && edgeApiType(edge.type, neighbor.type) === 'read')) {
          invalidRoutes.push({ kind: 'absent_contributor', id: neighbor.id, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.node`, reason: 'A caller-context investigation accepts real read contributors of the function or its declared callers, not unrelated loaded objects.' });
          continue;
        }

        if (removedSet?.has(neighbor.id)) {
          invalidRoutes.push({ kind: 'pruned_contributor', id: cont.node, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.node`, reason: `Upstream node "${cont.node}" was already pruned earlier this run and cannot supply column "${cont.col}" — a removed node stays removed.` });
          continue;
        }

        const fromNode = resolveModelNodeId(cont.node, nodeMap, model.identifierCaseSensitive) ?? identifierKey(cont.node);
        if (fromNode === toNodeForEdge && this.columnKey(cont.col) === this.columnKey(toCol)) {
          invalidRoutes.push({
            kind: 'self_loop_column',
            id: fromNode,
            path: `column_flow.${entryIndex}.upstream_columns.${refIndex}`,
            reason: `upstream_columns entry "${fromNode}.${cont.col}" is identical to its own writes_to target "${toNodeForEdge}.${toCol}" - a column cannot be its own upstream source.`,
          });
          continue;
        }

        if (/^(N?'[^']*')$/.test(cont.col.trim()) || /^[+-]?(\d+\.?\d*|\.\d+)$/.test(cont.col.trim())) {
          invalidRoutes.push({ kind: 'bad_contributor_col', id: cont.node, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.col`, reason: `upstream column "${cont.col}" is a literal, not a column reference — explain literals in sections, remove that upstream column, or use upstream_columns: [] when the active column terminates here` });
          continue;
        }

        const validNeighborCols = new Set<string>((getNodeColumns(neighbor.id, nodeMap, store ?? undefined) || []).map(c => this.columnKey(c.name)));
        if (validNeighborCols.size > 0 && !validNeighborCols.has(this.columnKey(cont.col))) {
          invalidRoutes.push({ kind: 'bad_contributor_col', id: cont.node, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.col`, reason: `upstream column "${cont.col}" does not exist on "${cont.node}"`, available_columns: Array.from(validNeighborCols).sort(), ...(neighbor.type !== 'procedure' ? { actual_columns: (getNodeColumns(neighbor.id, nodeMap, store ?? undefined) ?? []).map(column => column.name) } : {}) });
          continue;
        }
        if (validNeighborCols.size === 0 && !allowsMissingColumnMetadata(neighbor)) {
          invalidRoutes.push({ kind: 'bad_contributor_col', id: cont.node, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.col`, reason: neighbor.type === 'function'
            ? 'This function declares no real columns; formal parameters and return_value are not upstream model columns. Its supplied scalar-return task records contributors at the real caller output.'
            : `Column metadata is unavailable for ${neighbor.type} "${neighbor.id}"; upstream column "${cont.col}" cannot be verified.` });
          continue;
        }
        if (validNeighborCols.size === 0 && neighbor.type === 'procedure' && !continuationNeighbors) {
          const spInbound = model.neighborIndex[identifierKey(neighbor.id)]?.in ?? [];
          const inboundCols = new Set<string>();
          for (const inId of spInbound) {
            (getNodeColumns(inId, nodeMap, store ?? undefined) || []).forEach(c => inboundCols.add(this.columnKey(c.name)));
          }
          if (inboundCols.size > 0 && !inboundCols.has(this.columnKey(cont.col))) {
            invalidRoutes.push({ kind: 'bad_contributor_col', id: cont.node, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.col`, reason: `upstream column "${cont.col}" is not in any inbound source of procedure "${cont.node}"`, available_columns: Array.from(inboundCols).sort() });
            continue;
          }
        }
        if (validNeighborCols.size === 0) {
          log?.('debug', `[CT] unverifiable contributor column "${cont.col}" on "${cont.node}" — ${neighbor.type} metadata fallback`);
        }

        if (continuationNeighbors) {
          if (continuationNeighbors.size === 0) {
            log?.('debug', `[CT] unverifiable continuation "${cont.col}" on carrier "${focusId}" from "${cont.node}" — no recorded ${continuationSide === 'in' ? 'writers' : 'readers'}, accepting unverified`);
          } else {
            if (!continuationNeighbors.has(identifierKey(neighbor.id))) {
              invalidRoutes.push({
                kind: 'non_writer_continuation',
                id: cont.node,
                path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.node`,
                reason: `focus "${focusId}" has no body of its own, so upstream_columns declare continuation at the nodes that ${continuationSide === 'in' ? 'write it' : 'read from it'} — "${cont.node}" is not one of them`,
                available_routes: Array.from(continuationNeighbors).sort(),
              });
              continue;
            }
            log?.('debug', `[CT] continuation edge "${cont.col}" on carrier "${focusId}" from "${cont.node}" — attributed on that node's own hop`);
          }
        }

        // Adjacency is judged last, after the column and the carrier's continuation: a nonexistent column or a literal is refused wherever the object sits, and a non-writer continuation keeps its own refusal.
        if (contributorIds && neighbor.id !== focusId && !contributorIds.has(neighbor.id)) {
          invalidRoutes.push({ kind: 'absent_contributor', id: neighbor.id, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.node`, reason: `Upstream node "${cont.node}" has no dependency edge to ${focusId}; a column contributor is a neighbor of the focus or a read supplier of its declared scalar caller.` });
          continue;
        }

        // Direct lineage only: a column that just joins, filters, groups or orders rows is object lineage — its node is a row-role visit and the hop's sections explain the rule.
        if (!continuationNeighbors && isIndirectOnly(cont.transforms)) {
          rowRoleOnly.push(`${fromNode}.${cont.col}`);
          continue;
        }

        stagedEdges.push({
          hop: 0, // Assigned by caller
          hop_node: focusId,
          to_node: toNodeForEdge,
          to_col: toCol,
          from_node: fromNode,
          from_col: cont.col,
          ...(cont.transforms ? { transforms: [...cont.transforms] } : {}),
          ...(cont.note ? { note: cont.note } : {}),
        });
      }

      if (rowRoleOnly.length > 0) {
        log?.('debug', `[Normalize] column_flow.${entryIndex} into "${entry.out_col}" — row role only, not a column source: [${rowRoleOnly.join(', ')}]`);
      }
      const writerEdge = resolvedTarget?.writerEdge ?? null;
      const writerTargetObj = writerEdge ? nodeMap.get(writerEdge.toNode) : null;
      if (writerEdge && writerTargetObj && !SCRIPT_TYPES.has(writerTargetObj.type)
        && (entry.upstream_columns.length === 0 || stagedEdges.length > stagedBeforeEntry || rowRoleOnly.length > 0)) {
        stagedEdges.push({
          hop: 0, // Assigned by caller
          hop_node: focusId,
          from_node: focusId,
          from_col: entry.out_col,
          to_node: writerEdge.toNode,
          to_col: writerEdge.toCol,
        });
      }
      entryEdges.set(entryIndex, stagedEdges.slice(stagedBeforeEntry));
    }

    // A link is admitted only when its destination is in the closure of the tracked roots over the
    // committed and staged links; one fixpoint, so the order of the entries never decides.
    const mixed = incomingDownstreamRefs.length > 0;
    const closureEdges = [...this.aspect.edges, ...stagedEdges];
    const attached = columnAttachment(roots, closureEdges, mixed ? 'upstream' : traceDirection, endpointKey);
    const downstreamAttached = mixed ? columnAttachment(roots, closureEdges, 'downstream', endpointKey) : undefined;
    const detachedIn = (edges: ColumnEdge[], closure: ColumnAttachment): ColumnEdge[] =>
      edges.filter(edge => !closure.attaches(edge));
    const rejectDetached = (entryIndex: number, detached: ColumnEdge[]): void => {
      const entry = columnFlow[entryIndex];
      const tracked = [...anchors.values()].join(', ');
      invalidRoutes.push({
        kind: 'untracked_out_col',
        id: focusId,
        path: `column_flow.${entryIndex}.upstream_columns`,
        reason: detached.length > 0
          ? `column_flow.${entryIndex} into "${entry.out_col}" links ${[...new Set(detached.map(edge => `${edge.from_node}.${edge.from_col} -> ${edge.to_node}.${edge.to_col}`))].join(', ')}, which attach to no tracked endpoint [${tracked}].`
          : `column_flow.${entryIndex} into "${entry.out_col}" is disconnected from the tracked endpoints [${tracked}].`,
        available_columns: [...this.aspect.active_columns],
      });
    };

    if (focusIsCarrier) {
      const rejectedEdges = new Set<ColumnEdge>();
      for (const [entryIndex, edges] of entryEdges) {
        const upDetached = detachedIn(edges, attached);
        const downDetached = downstreamAttached ? detachedIn(edges, downstreamAttached) : upDetached;
        const detached = downDetached.length < upDetached.length ? downDetached : upDetached;
        if (detached.length === 0) continue;
        rejectDetached(entryIndex, detached);
        for (const edge of edges) rejectedEdges.add(edge);
      }
      return { invalidRoutes, stagedEdges: stagedEdges.filter(edge => !rejectedEdges.has(edge)) };
    }

    const entrySides: Array<{ index: number; upstream: boolean; downstream: boolean }> = [];
    const rejectedEdges = new Set<ColumnEdge>();
    for (const [entryIndex, edges] of entryEdges) {
      const entry = columnFlow[entryIndex];
      const upDetached = detachedIn(edges, attached);
      const downDetached = downstreamAttached ? detachedIn(edges, downstreamAttached) : undefined;
      if (entry.upstream_columns.length === 0) {
        const target = resolveColumnFlowTarget(entry, focusId, nodeMap, model.identifierCaseSensitive);
        const upstream = activeNorm.includes(this.columnKey(entry.out_col)) && (anchors.has(endpointKey(focusId, entry.out_col))
          || target !== null && anchors.has(endpointKey(target.attributionTo, target.attributionCol)));
        const downstream = incomingDownstreamRefs.some(ref => this.columnKey(ref.col) === this.columnKey(entry.out_col));
        if (!mixed || upstream || downstream) {
          if (!mixed ? upDetached.length === 0
            : upstream && upDetached.length === 0 || downstream && downDetached?.length === 0) {
            entrySides.push({ index: entryIndex, upstream, downstream });
            continue;
          }
          rejectDetached(entryIndex, downDetached && downDetached.length < upDetached.length ? downDetached : upDetached);
          for (const edge of edges) rejectedEdges.add(edge);
          continue;
        }
      }
      if (edges.length === 0 && entry.upstream_columns.length > 0) continue;
      const attachedUpstream = edges.length === 0 ? anchors.has(endpointKey(focusId, entry.out_col)) : upDetached.length === 0;
      const attachedDownstream = edges.length > 0 && downDetached?.length === 0;
      const upstream = attachedUpstream && activeNorm.includes(this.columnKey(entry.out_col));
      if (mixed ? upstream || attachedDownstream : attachedUpstream) {
        entrySides.push({ index: entryIndex, upstream, downstream: attachedDownstream });
        continue;
      }
      rejectDetached(entryIndex, downDetached && downDetached.length < upDetached.length ? downDetached : upDetached);
      for (const edge of edges) rejectedEdges.add(edge);
    }
    return { invalidRoutes, stagedEdges: stagedEdges.filter(edge => !rejectedEdges.has(edge)),
      ...(mixed ? { entrySides } : {}) };
  }
}

/** One directed endpoint pair of a staged or submitted column edge, as keyed by {@link columnEndpointKeyFactory}. */
export interface ColumnEndpointLink {
  /** Canonical source endpoint of the recorded data flow. */
  readonly from: string;
  /** Canonical destination endpoint of the recorded data flow. */
  readonly to: string;
}

/**
 * Builds the canonical identity key of one (node, column) endpoint for column-chain
 * reachability.
 *
 * @remarks
 * The node id is resolved against the loaded model and lower-cased when unresolvable; the
 * column name is normalized. One key formula shared by the validator and the downstream carry
 * selection, so an identity the validator accepts is the identity the next hop receives.
 *
 * @param nodeMap - Map of all available lineage nodes, for id resolution.
 */
export function columnEndpointKeyFactory(nodeMap: Map<string, LineageNode>, identifierCaseSensitive = false): (node: string, col: string) => string {
  return (node, col) => JSON.stringify([resolveModelNodeId(node, nodeMap, identifierCaseSensitive) ?? schemaKey(node, identifierCaseSensitive), normalizeColName(col, identifierCaseSensitive)]);
}

/**
 * Finds endpoints connected to upstream trace seeds, or downstream of received source endpoints.
 *
 * @remarks
 * Upstream closure follows inbound links; admission also accepts a submitted link from a
 * reached source endpoint. Downstream propagation
 * follows data-flow direction: another input to a tracked output cannot promote that input's
 * unrelated outputs. Seeds remain reachable even when they have no recorded links.
 *
 * @param seeds - Endpoint keys the chain is already known to hold.
 * @param links - Staged or submitted endpoint pairs to close over.
 * @param direction - Whether to validate upstream connectivity or propagate downstream values.
 */
export function reachableColumnEndpoints(
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

/** The fields of a column edge that {@link columnClosure} reads. */
export type ColumnClosureEdge = Pick<ColumnEdge, 'hop_node' | 'from_node' | 'from_col' | 'to_node' | 'to_col'>;

/** Which column endpoints and edges are attached to the trace; see {@link columnAttachment}. */
export interface ColumnAttachment {
  /** Keys of the attached endpoints. */
  readonly endpoints: Set<string>;
  /**
   * Keys of the endpoints the tracked value flows through: the requested outputs and, when the
   * direction includes downstream, everything they feed. A link out of one is attached; an input of
   * what they feed (a second contributor) is in {@link endpoints} but not here, so it is never carried on.
   */
  readonly flowing: Set<string>;
  /** Whether a committed or staged edge is attached. */
  attaches(edge: ColumnClosureEdge): boolean;
}

/**
 * The one definition of what is attached to the trace — a column island is an endpoint or edge
 * outside it. Admission, carry and delivery all read it.
 *
 * @remarks
 * Upstream: the requested output columns and everything that feeds them. Downstream: the requested
 * outputs, everything they feed, and every input of what they feed — a second contributor to a
 * reached output is attached, its other outputs are not. Both: the union. An edge is attached when
 * its `to` endpoint is.
 *
 * The origin's own explicit write of a requested output (an edge from the root out of the origin
 * hop to another node) attaches that one destination when the direction rule does not already hold
 * it, together with what the origin hop itself recorded into it and whatever feeds those inputs. It
 * is not an anchor for another hop: an edge into it authored elsewhere is not attached.
 * Library BFS only ({@link reachableColumnEndpoints}).
 *
 * @param roots - The requested output columns on the origin.
 * @param edges - Committed plus staged column edges.
 * @param direction - The approved trace direction.
 * @param endpointKey - Key factory of {@link columnEndpointKeyFactory}.
 */
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

/**
 * The attached endpoint keys of {@link columnAttachment}; the carry reads this set.
 *
 * @param roots - The requested output columns on the origin.
 * @param edges - Committed plus staged column edges.
 * @param direction - The approved trace direction.
 * @param endpointKey - Key factory of {@link columnEndpointKeyFactory}.
 */
export function columnClosure(
  roots: readonly { node: string; col: string }[],
  edges: ReadonlyArray<ColumnClosureEdge>,
  direction: 'upstream' | 'downstream' | 'both',
  endpointKey: (node: string, col: string) => string,
): Set<string> {
  return columnAttachment(roots, edges, direction, endpointKey).endpoints;
}

/** Where one `column_flow` entry's recorded columns land, and the writer edge it stages. */
export interface ColumnFlowTargetResolution {
  /** Node the attribution edges land on: `writes_to.node` when named, else the focus. */
  attributionTo: string;
  /** Column the attribution edges land on: `writes_to.col` when named, else `out_col`. */
  attributionCol: string;
  /** The explicitly named focus→carrier writer edge; absent when no destination is declared. */
  writerEdge: { toNode: string; toCol: string } | null;
}

/**
 * Resolves where one `column_flow` entry's recorded columns land.
 *
 * @remarks
 * Attribution edges (one per upstream real column) land on `writes_to.node` when the entry names
 * it, else on the focus. The {@link ColumnFlowTargetResolution.writerEdge} is the writer→carrier
 * relation that keeps the column chain connected to the traced origin: a named `writes_to` states
 * it directly. Explicit `null` declares no table write, and omission defaults attribution to
 * the focus without inferring a write target from topology or matching column names.
 *
 * @param entry - The submitted column-flow entry.
 * @param focusId - Canonical id of the focus node.
 * @param nodeMap - Map of all available lineage nodes.
 * @returns The attribution target and writer edge to stage, or `null` when `writes_to` names a
 * node absent from the loaded model.
 */
export function resolveColumnFlowTarget(
  entry: ColumnFlowEntry,
  focusId: string,
  nodeMap: Map<string, LineageNode>,
  identifierCaseSensitive = false,
): ColumnFlowTargetResolution | null {
  if (entry.returns_to) {
    const toNode = resolveModelNodeId(entry.returns_to.node, nodeMap, identifierCaseSensitive);
    if (!toNode) return null;
    return { attributionTo: toNode, attributionCol: entry.returns_to.col, writerEdge: null };
  }
  if (entry.writes_to?.node) {
    const toNode = resolveModelNodeId(entry.writes_to.node, nodeMap, identifierCaseSensitive);
    if (!toNode) return null;
    return {
      attributionTo: toNode,
      attributionCol: entry.writes_to.col,
      writerEdge: { toNode, toCol: entry.writes_to.col },
    };
  }
  return { attributionTo: focusId, attributionCol: entry.out_col, writerEdge: null };
}

/** Missing catalogs do not prove columns on ordinary tables, views or functions. */
function allowsMissingColumnMetadata(node: LineageNode): boolean {
  return node.type === 'procedure' || node.type === 'external';
}
