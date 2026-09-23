import { ColumnAspect, ColumnFlowEntry, ColumnEdge, HopFinding, InvalidRoute } from './smTypes';
import type { DatabaseModel, LineageNode } from '../../engine/types';
import { resolveModelNodeId } from '../support/inputNormalization';
import { edgeApiType } from '../support/aiPresenter';
import { getNodeColumns, SCRIPT_TYPES } from '../support/graphUtils';
import { ColumnStore } from '../../engine/columnStore';
import { computeUnaccounted } from './smCompleteness';
import { normalizeColName } from '../../utils/sql';

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
   * @param initialAspect - Restored aspect when rehydrating from a snapshot.
   *
   * @remarks
   * `target_columns` and `active_columns` are copied, never aliased: the snapshot invariant is
   * `JSON.stringify(init.targetColumns) === JSON.stringify(columnAspect.target_columns)`, so a
   * shared array would let an in-place edit silently rewrite the frozen target set and break `toJSON()`.
   */
  constructor(targetColumns: string[], initialAspect?: ColumnAspect) {
    this.aspect = initialAspect ?? {
      target_columns: [...targetColumns],
      active_columns: [...targetColumns],
      edges: [],
    };
  }

  /** Current column-trace state. */
  get state(): ColumnAspect {
    return this.aspect;
  }

  /**
   * The aspect as delivered, minus the edges whose endpoint the render dispositioned away.
   *
   * @remarks
   * A projection for delivery only, never a mutation: {@link state} keeps every committed edge, so
   * a checkpoint resumes on the chain it was dumped with and completeness accounting reads the
   * same edge set it always did. `target_columns`/`active_columns` carry through untouched.
   *
   * @param droppedEndpointIds - Endpoint node ids the render withheld; empty on almost every call.
   * @returns The aspect to deliver — the live state itself when nothing was withheld.
   */
  deliveredState(droppedEndpointIds: ReadonlySet<string>): ColumnAspect {
    if (droppedEndpointIds.size === 0) return this.aspect;
    return {
      ...this.aspect,
      edges: this.aspect.edges.filter(
        e => !droppedEndpointIds.has(e.from_node) && !droppedEndpointIds.has(e.to_node)),
    };
  }

  /** Columns requested at the start of the trace. */
  get targetColumns(): string[] {
    return this.aspect.target_columns;
  }

  /** Columns that the next hop must account for. */
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
   * the PREVIOUS node. A non-empty result means the chain was left incomplete and the engine rejects.
   *
   * @param columnFlow - The column flow entries submitted by the AI.
   * @param traceDirection - Trace direction of the owning exploration.
   * @returns An array of active columns that were not accounted for.
   */
  unaccountedActiveColumns(columnFlow: ColumnFlowEntry[], traceDirection: 'upstream' | 'downstream'): string[] {
    const accounted = traceDirection === 'downstream'
      ? columnFlow.flatMap(e => [e.out_col, ...e.upstream_columns.map(r => r.col)])
      : columnFlow.map(e => e.out_col);
    return computeUnaccounted(this.aspect.active_columns, accounted);
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
    for (const e of this.aspect.edges) {
      const nodeKey = traceDirection === 'downstream' ? e.to_node : e.from_node;
      const colVal = traceDirection === 'downstream' ? e.to_col : e.from_col;
      if (!colVal || (nodeKey !== candidateNodeId && !writtenCarrierIds.has(nodeKey))) continue;
      const key = normalizeColName(colVal);
      if (!spineByNorm.has(key)) spineByNorm.set(key, colVal);
    }
    if (spineByNorm.size === 0) return entryColumns;
    const spine = [...spineByNorm.values()];
    if (log && entryColumns.length > 0) {
      const spineNorms = new Set(spineByNorm.keys());
      const dropped = entryColumns.filter((c) => !spineNorms.has(normalizeColName(c)));
      if (dropped.length > 0) {
        log('debug', `[Normalize] entry columns bound to spine id=${candidateNodeId} from=[${entryColumns.join(', ')}] to=[${spine.join(', ')}] — off-spine entry column(s) dropped: [${dropped.join(', ')}]`);
      }
    }
    return spine;
  }

  /**
   * Generates chain-continuation questions for the real upstream column edges staged at the given
   * hop, grouped by the upstream node that must next answer each one. Injected as
   * `<lineage_questions>` in that node's own `<current_task>` — never a different, unrelated hop.
   *
   * @remarks
   * Terminal/current-node production (`upstream_columns: []`) stages no edge and spawns no
   * question. Each question is labelled by `edge.from_col`, not `edge.to_col`, so the wording
   * matches that hop's own `<column_trace>` active-column label.
   *
   * @param focusId - The id of the focus node.
   * @param hopCount - The hop count matching the edges to query.
   * @returns Continuation questions keyed by the upstream node id that must answer each one.
   */
  getColumnLineageQuestionsByNode(focusId: string, hopCount: number): Map<string, string[]> {
    const hopEdges = this.aspect.edges.filter(
      e => e.hop_node === focusId && e.hop === hopCount,
    );
    const byNode = new Map<string, string[]>();
    if (hopEdges.length === 0) return byNode;

    const fedByKey = new Map<string, { edge: ColumnEdge; toCols: string[] }>();
    for (const edge of hopEdges) {
      const key = `${edge.from_node}.${edge.from_col}`;
      const group = fedByKey.get(key);
      if (!group) fedByKey.set(key, { edge, toCols: [edge.to_col] });
      else if (!group.toCols.some(c => normalizeColName(c) === normalizeColName(edge.to_col))) group.toCols.push(edge.to_col);
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
   * the acceptance is logged at `debug` instead of passing silently.
   * @param removedSet - Node ids already pruned this run (PRUNE-BEFORE-DEMAND). Naming an
   * already-removed node as an `upstream_columns` supplier is rejected here, at declare time,
   * rather than staging a demand `enqueueHop` can never dispatch to.
   * @param traceDirection - Trace direction of the owning exploration; resolves which neighbour
   * side a continuation may name at a body-less focus (producers for upstream, consumers for
   * downstream).
   * @returns Validation result containing any error, invalid routes, or successfully staged edges.
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
  ): { error?: { error: string; hint: string }; invalidRoutes: InvalidRoute[]; stagedEdges: ColumnEdge[] } {
    const invalidRoutes: InvalidRoute[] = [];
    const stagedEdges: ColumnEdge[] = [];

    const columnFlow = finding.verdict === 'end_branch' ? [] : finding.column_flow ?? [];
    if (columnFlow.length === 0) {
      return { invalidRoutes, stagedEdges };
    }

    const focusNode = nodeMap.get(focusId);
    if (!focusNode) return { invalidRoutes, stagedEdges };

    const focusIsCarrier = !SCRIPT_TYPES.has(focusNode.type);
    const continuationSide = traceDirection === 'downstream' ? 'out' : 'in';
    const continuationNeighbors = focusIsCarrier
      ? new Set((model.neighborIndex[focusId.toLowerCase()]?.[continuationSide] ?? []).map((id) => id.toLowerCase()))
      : null;

    const validFocusCols = new Set<string>((getNodeColumns(focusNode.id, nodeMap, store ?? undefined) || []).map((c) => normalizeColName(c.name)));
    const activeNorm = this.aspect.active_columns.map(normalizeColName);

    for (let entryIndex = 0; entryIndex < columnFlow.length; entryIndex++) {
      const entry = columnFlow[entryIndex];
      const outNorm = normalizeColName(entry.out_col);
      if (traceDirection === 'upstream' && !activeNorm.includes(outNorm)) {
        const existsOnNode = validFocusCols.size > 0 && validFocusCols.has(outNorm);
        invalidRoutes.push(existsOnNode
          ? { kind: 'untracked_out_col', id: focusId, path: `column_flow.${entryIndex}.out_col`, reason: `out_col "${entry.out_col}" exists on ${focusId} but is not an actively tracked column`, available_columns: [...this.aspect.active_columns] }
          : { kind: 'bad_out_col', id: focusId, path: `column_flow.${entryIndex}.out_col`, reason: `out_col "${entry.out_col}" is not an active tracked column`, available_columns: [...this.aspect.active_columns] });
        continue;
      }

      if (validFocusCols.size > 0 && !validFocusCols.has(outNorm)) {
          invalidRoutes.push({ kind: 'bad_out_col', id: focusId, path: `column_flow.${entryIndex}.out_col`, reason: `out_col "${entry.out_col}" does not exist on ${focusId}`, available_columns: Array.from(validFocusCols).sort() });
        continue;
      }

      if (traceDirection === 'downstream' && entry.upstream_columns.length > 0
        && !entry.upstream_columns.some((ref) => activeNorm.includes(normalizeColName(ref.col)))) {
        invalidRoutes.push({
          kind: 'untracked_out_col',
          id: focusId,
          path: `column_flow.${entryIndex}.upstream_columns`,
          reason: `column_flow.${entryIndex} continues the trace (upstream_columns is non-empty) into out_col "${entry.out_col}", but none of its upstream_columns[].col names an active tracked column — one contributor must carry the column this hop received before deriving "${entry.out_col}", or upstream_columns: [] if it originates here`,
          available_columns: [...this.aspect.active_columns],
        });
        continue;
      }

      const toNodeId = entry.writes_to?.node ? resolveModelNodeId(entry.writes_to.node, nodeMap) : focusId;
      const toNodeObj = toNodeId ? nodeMap.get(toNodeId) : null;
      if (entry.writes_to && !toNodeObj) {
        invalidRoutes.push({ kind: 'absent_contributor', id: entry.writes_to.node, path: `column_flow.${entryIndex}.writes_to.node`, reason: `writes_to target "${entry.writes_to.node}" is absent from the loaded model.` });
        continue;
      }
      if (entry.writes_to && toNodeObj && toNodeId && toNodeId.toLowerCase() !== focusId.toLowerCase()) {
        const focusLower = focusId.toLowerCase();
        const toLower = toNodeId.toLowerCase();
        const verbs = new Set<string>();
        for (const e of model.edges) {
          if (e.source.toLowerCase() === focusLower && e.target.toLowerCase() === toLower) {
            verbs.add(edgeApiType(e.type, focusNode.type));
          }
        }
        if (verbs.size > 0 && [...verbs].every((v) => v === 'read')) {
          invalidRoutes.push({ kind: 'bad_writes_to_target', id: toNodeObj.id, path: `column_flow.${entryIndex}.writes_to.node`, reason: `writes_to names "${toNodeObj.id}" but that node only reads ${focusId} — a downstream reader is never the write destination. Omit writes_to (it defaults to the focus) unless this hop writes a real column on another node; every open neighbor you do not prune is visited anyway.` });
          continue;
        }
      }
      const toCol = entry.writes_to?.col ?? entry.out_col;
      if (toNodeObj && toNodeObj.type !== 'procedure' && toNodeObj.type !== 'function') {
        const toCols = new Set<string>((getNodeColumns(toNodeObj.id, nodeMap, store ?? undefined) || []).map((c) => normalizeColName(c.name)));
        if (toCols.size > 0 && !toCols.has(normalizeColName(toCol))) {
          invalidRoutes.push({ kind: 'bad_out_col', id: toNodeObj.id, path: `column_flow.${entryIndex}.writes_to.col`, reason: `to_col "${toCol}" does not exist on ${toNodeObj.id}`, available_columns: Array.from(toCols).sort() });
          continue;
        }
      }
      const toNodeForEdge = toNodeId ?? focusId;

      for (let refIndex = 0; refIndex < entry.upstream_columns.length; refIndex++) {
        const cont = entry.upstream_columns[refIndex];
        const neighborId = resolveModelNodeId(cont.node, nodeMap);
        const neighbor = neighborId ? nodeMap.get(neighborId) : null;
        if (!neighbor) {
          invalidRoutes.push({ kind: 'absent_contributor', id: cont.node, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.node`, reason: `Upstream node "${cont.node}" is absent from the loaded model.` });
          continue;
        }

        if (removedSet?.has(neighbor.id)) {
          invalidRoutes.push({ kind: 'pruned_contributor', id: cont.node, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.node`, reason: `Upstream node "${cont.node}" was already pruned earlier this run and cannot supply column "${cont.col}" — a removed node stays removed.` });
          continue;
        }

        const fromNode = resolveModelNodeId(cont.node, nodeMap) ?? cont.node.toLowerCase();
        if (fromNode === toNodeForEdge && normalizeColName(cont.col) === normalizeColName(toCol)) {
          invalidRoutes.push({
            kind: 'self_loop_column',
            id: fromNode,
            path: `column_flow.${entryIndex}.upstream_columns.${refIndex}`,
            reason: `upstream_columns entry "${fromNode}.${cont.col}" is identical to its own writes_to target "${toNodeForEdge}.${toCol}" - a column cannot be its own upstream source.`,
          });
          continue;
        }

        if (/^(N?'[^']*')$/.test(cont.col.trim()) || /^[+-]?(\d+\.?\d*|\.\d+)$/.test(cont.col.trim())) {
          invalidRoutes.push({ kind: 'bad_contributor_col', id: cont.node, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.col`, reason: `upstream column "${cont.col}" is a literal, not a column reference — explain literals in sections[].text, remove that upstream column, or use upstream_columns: [] when the active column terminates here` });
          continue;
        }

        if (continuationNeighbors) {
          if (continuationNeighbors.size === 0) {
            log?.('debug', `[CT] unverifiable continuation "${cont.col}" on carrier "${focusId}" from "${cont.node}" — no recorded ${continuationSide === 'in' ? 'writers' : 'readers'}, accepting unverified`);
          } else {
            if (!continuationNeighbors.has(neighbor.id.toLowerCase())) {
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
        } else if (neighbor.type === 'procedure') {
          const spInbound = model.neighborIndex[neighbor.id.toLowerCase()]?.in ?? [];
          const inboundCols = new Set<string>();
          for (const inId of spInbound) {
            (getNodeColumns(inId, nodeMap, store ?? undefined) || []).forEach((c) => inboundCols.add(normalizeColName(c.name)));
          }
          if (inboundCols.size > 0 && !inboundCols.has(normalizeColName(cont.col))) {
            invalidRoutes.push({ kind: 'bad_contributor_col', id: cont.node, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.col`, reason: `upstream column "${cont.col}" is not in any inbound source of procedure "${cont.node}"`, available_columns: Array.from(inboundCols).sort() });
            continue;
          }
        } else {
          const validNeighborCols = new Set<string>((getNodeColumns(neighbor.id, nodeMap, store ?? undefined) || []).map((c) => normalizeColName(c.name)));
          if (validNeighborCols.size === 0) {
            log?.('debug', `[CT] unverifiable contributor column "${cont.col}" on "${cont.node}" — neighbour declares no columns, accepting unverified`);
          } else if (!validNeighborCols.has(normalizeColName(cont.col))) {
            invalidRoutes.push({ kind: 'bad_contributor_col', id: cont.node, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.col`, reason: `upstream column "${cont.col}" does not exist on "${cont.node}"`, available_columns: Array.from(validNeighborCols).sort() });
            continue;
          }
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
    }

    return { invalidRoutes, stagedEdges };
  }
}
