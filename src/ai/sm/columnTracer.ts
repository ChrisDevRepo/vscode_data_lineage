import { ColumnAspect, ColumnFlowEntry, ColumnEdge, HopFinding, InvalidRoute } from './smTypes';
import type { DatabaseModel, LineageNode } from '../../engine/types';
import { resolveModelNodeId } from '../support/inputNormalization';
import { getNodeColumns } from '../support/graphUtils';
import { ColumnStore } from '../../engine/columnStore';
import { computeUnaccounted } from './smCompleteness';
import { normalizeColName } from '../../utils/sql';

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
   * `JSON.stringify(init.targetColumns) === JSON.stringify(columnAspect.target_columns)`, so one
   * shared array would let an in-place edit of the active set (or of the caller's own array)
   * silently rewrite the frozen target set and make `toJSON()` throw.
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
   * A projection for delivery only, never a mutation of the trace: {@link state} keeps every
   * committed edge, so a checkpoint resumes on the chain it was dumped with and the engine's own
   * completeness accounting reads the same edge set it always did. `target_columns` and
   * `active_columns` carry through untouched — where an endpoint node ended up says nothing about
   * which columns the trace is following.
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
   * The structural completeness guard for the column chain: every active
   * column must be resolved — continued (an entry with upstream real columns) or produced here
   * (an entry with `upstream_columns: []`). A node producing none of the tracked columns
   * submits `column_flow:[]` and is retained: only its column chain is empty, and it is kept in
   * the answer for what it does to the row set (it never prunes itself).
   * An entry's `out_col` is how the AI accounts for that column, so
   * the result is the pure set-difference `active_columns − {out_col}`. A non-empty
   * result means the chain was left incomplete; the engine rejects and the worker
   * re-asks. No content judgment — column names only.
   *
   * @param columnFlow - The column flow entries submitted by the AI.
   * @returns An array of active columns that were not accounted for.
   */
  unaccountedActiveColumns(columnFlow: ColumnFlowEntry[]): string[] {
    return computeUnaccounted(this.aspect.active_columns, columnFlow.map(e => e.out_col));
  }

  /**
   * Resolves which columns are active for a candidate node, bounded to the traced spine.
   *
   * @remarks
   * The spine for a candidate is the set of columns that flow *from* it into the tracked chain —
   * `from_col` on accumulated edges whose `from_node` is the candidate (staged by the routing hop's
   * `column_flow` before the candidate is dispatched). Off-spine sibling columns the AI lists in
   * a route candidate (`entryColumns`) are dropped — mechanical enforcement of the CT "route only
   * upstream columns" contract, so a model that over-declares carrier columns cannot drag off-trace
   * edges across later hops.
   *
   * Every committed edge is a column demand on the node that supplies it, and a node consumes one
   * hop, so a non-empty spine is returned whole: the active set is the union of those demands,
   * whatever order the routes that reached the node arrived in. A route's own column list (or its
   * row-role `none`) describes that one edge and never narrows a demand another edge placed.
   *
   * - spine-derived empty (candidate's upstream edges not yet staged — freshly-routed first
   *   appearance, e.g. a terminal source) → trust `entryColumns` so the node is still dispatched.
   * - otherwise → the full spine-derived set.
   *
   * An edge whose `from_node` is a non-bodied carrier the candidate writes is on the candidate's
   * spine too: a carrier is never analysed, so the column an edge leaves open there is owed by the
   * carrier's producers, the same side the reopen of an open column end is offered to.
   *
   * @param candidateNodeId - The id of the node being considered.
   * @param entryColumns - The columns declared for entry by the AI.
   * @param writtenCarrierIds - Non-bodied carriers the candidate writes; empty when it writes none.
   * @returns The resolved active columns for the candidate node.
   */
  determineActiveColumnsForCandidate(
    candidateNodeId: string,
    entryColumns: string[],
    writtenCarrierIds: ReadonlySet<string> = new Set(),
  ): string[] {
    const spineByNorm = new Map<string, string>();
    for (const e of this.aspect.edges) {
      if (!e.from_col || (e.from_node !== candidateNodeId && !writtenCarrierIds.has(e.from_node))) continue;
      const key = normalizeColName(e.from_col);
      if (!spineByNorm.has(key)) spineByNorm.set(key, e.from_col);
    }
    return spineByNorm.size > 0 ? [...spineByNorm.values()] : entryColumns;
  }

  /**
   * Generates chain-continuation questions for the real upstream column edges staged at the given
   * hop, grouped by the upstream node that must next answer each one. Injected as
   * `<lineage_questions>` in that node's own `<current_task>` — never a different, unrelated hop.
   *
   * @remarks
   * Terminal/current-node production is represented by a flow entry with `upstream_columns: []`, which
   * stages no edge and therefore spawns no continuation question. Each question is labelled by
   * `edge.from_col` — the column that is actually active once the named node is traced — not
   * `edge.to_col`, so the wording matches that hop's own `<column_trace>` active-column label.
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

    const seen = new Set<string>();

    for (const edge of hopEdges) {
      const key = `${edge.from_node}.${edge.from_col}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const question = `Column \`${edge.from_col}\` at \`${edge.from_node}\`: continues the trace into \`${edge.to_col}\` at \`${edge.hop_node}\` — determine its origin here.`;
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
   * @param removedSet - Node ids already pruned this run (PRUNE-BEFORE-DEMAND). Optional and
   * defaults to empty so every pre-existing direct-call site (tests, and any future caller that
   * has no removal state to offer) keeps validating exactly as before. Naming an already-removed
   * node as an `upstream_columns` supplier is rejected here, at declare time — the alternative
   * (staging the edge anyway) hands `enqueueHop` a demand on a node that stays removed by
   * invariant ({@link reopensColumnChain}), which can only drop it silently.
   * @returns Validation result containing any error, invalid routes, or successfully staged edges.
   */
  validateColumnFlow(
    focusId: string,
    finding: HopFinding,
    nodeMap: Map<string, LineageNode>,
    model: DatabaseModel,
    store: ColumnStore | null,
    log?: (level: 'info' | 'debug' | 'warn' | 'error', msg: string, err?: unknown) => void,
    removedSet?: ReadonlySet<string>,
  ): { error?: { error: string; hint: string }; invalidRoutes: InvalidRoute[]; stagedEdges: ColumnEdge[] } {
    const invalidRoutes: InvalidRoute[] = [];
    const stagedEdges: ColumnEdge[] = [];

    const columnFlow = finding.column_flow!;
    if (columnFlow.length === 0) {
      return { invalidRoutes, stagedEdges };
    }

    const focusNode = nodeMap.get(focusId);
    if (!focusNode) return { invalidRoutes, stagedEdges };

    const validFocusCols = new Set<string>((getNodeColumns(focusNode.id, nodeMap, store ?? undefined) || []).map((c) => normalizeColName(c.name)));
    const activeNorm = this.aspect.active_columns.map(normalizeColName);

    for (let entryIndex = 0; entryIndex < columnFlow.length; entryIndex++) {
      const entry = columnFlow[entryIndex];
      if (!activeNorm.includes(normalizeColName(entry.out_col))) {
        // `available_columns` names the tracked set and nothing else. Falling back to the node's
        // own DDL columns listed the rejected value itself as a valid one, so the envelope
        // contradicted its own reason and no rewrite of it could succeed. A column that is on the
        // node yet off the tracked spine gets its own kind so the repair (pick a tracked column)
        // stays distinguishable from naming a column the node does not carry at all; when the node
        // declares no columns, existence is unverifiable and the not-on-node code stands.
        const existsOnNode = validFocusCols.size > 0 && validFocusCols.has(normalizeColName(entry.out_col));
        invalidRoutes.push(existsOnNode
          ? { kind: 'untracked_out_col', id: focusId, path: `column_flow.${entryIndex}.out_col`, reason: `out_col "${entry.out_col}" exists on ${focusId} but is not an actively tracked column`, available_columns: [...this.aspect.active_columns] }
          : { kind: 'bad_out_col', id: focusId, path: `column_flow.${entryIndex}.out_col`, reason: `out_col "${entry.out_col}" is not an active tracked column`, available_columns: [...this.aspect.active_columns] });
        continue;
      }

      if (validFocusCols.size > 0 && !validFocusCols.has(normalizeColName(entry.out_col))) {
          invalidRoutes.push({ kind: 'bad_out_col', id: focusId, path: `column_flow.${entryIndex}.out_col`, reason: `out_col "${entry.out_col}" does not exist on ${focusId}`, available_columns: Array.from(validFocusCols).sort() });
        continue;
      }

      // Resolve the edge's TARGET (writes_to.node, else focus) once: the out_col checks above only cover
      // the focus node, so writes_to.col is never validated elsewhere. Procs/functions expose no
      // written-column DDL (skip); tables/views must resolve — the sole place catching an empty/wrong to_col.
      const toNodeId = entry.writes_to?.node ? resolveModelNodeId(entry.writes_to.node, nodeMap) : focusId;
      const toNodeObj = toNodeId ? nodeMap.get(toNodeId) : null;
      if (entry.writes_to && !toNodeObj) {
        invalidRoutes.push({ kind: 'absent_contributor', id: entry.writes_to.node, path: `column_flow.${entryIndex}.writes_to.node`, reason: `writes_to target "${entry.writes_to.node}" is absent from the loaded model.` });
        continue;
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

        // PRUNE-BEFORE-DEMAND, order (a): the supplier was pruned on an earlier hop, before this
        // edge names it. A removed node stays removed by invariant (reopensColumnChain never
        // clears removedSet), so staging this edge would hand enqueueHop a demand on a node that
        // can never be dispatched to answer it — content-kind, rejected here instead of dropped
        // silently three steps downstream.
        if (removedSet?.has(neighbor.id)) {
          invalidRoutes.push({ kind: 'pruned_contributor', id: cont.node, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.node`, reason: `Upstream node "${cont.node}" was already pruned earlier this run and cannot supply column "${cont.col}" — a removed node stays removed.` });
          continue;
        }

        if (neighbor.type === 'procedure') {
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

        const fromNode = resolveModelNodeId(cont.node, nodeMap) ?? cont.node.toLowerCase();

        // A column can't be its own upstream source - reject the degenerate self-loop before it stages.
        if (fromNode === toNodeForEdge && normalizeColName(cont.col) === normalizeColName(toCol)) {
          invalidRoutes.push({
            kind: 'self_loop_column',
            id: fromNode,
            path: `column_flow.${entryIndex}.upstream_columns.${refIndex}`,
            reason: `upstream_columns entry "${fromNode}.${cont.col}" is identical to its own writes_to target "${toNodeForEdge}.${toCol}" - a column cannot be its own upstream source.`,
          });
          continue;
        }

        stagedEdges.push({
          hop: 0, // Assigned by caller
          hop_node: focusId,
          to_node: toNodeForEdge,
          to_col: toCol,
          from_node: fromNode,
          from_col: cont.col,
          // Carried verbatim per contributor, or omitted. The value set is already enforced by the
          // tool schema, so there is nothing left to check and nothing to substitute when absent.
          ...(cont.transforms ? { transforms: [...cont.transforms] } : {}),
          ...(cont.note ? { note: cont.note } : {}),
        });
      }
    }

    return { invalidRoutes, stagedEdges };
  }
}
