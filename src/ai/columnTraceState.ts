/**
 * Column-Trace State Machine — Hop-and-Distill pattern.
 *
 * Extends HopStateMachine (smBase.ts) for shared state, memory, and helpers.
 * CT-specific: frontier management, column tracking, verdict handling, chain assembly.
 *
 * Lifecycle: init() → getHopContext() ↔ submitVerdicts() loop → getResult()
 */

import type { DatabaseModel, LineageNode } from '../engine/types';
import type { ColumnStore } from '../engine/columnStore';
import type { SerializedFilterState } from '../engine/projectStore';
import { SCRIPT_TYPES, getNodeColumns, getNodeDdl, buildHopFocusNode } from './tools';
import { presentNode, presentColumn, presentColumnCompact, presentFkCompact, strip, edgeApiType } from './aiPresenter';
import type Graph from 'graphology';
import { wouldOrphanNotedNode, type LogFn } from './smGuards';
import { HopStateMachine, type BaseWorkingMemory, type BoundaryFlag, type HopNeighbor, type ShortMemory, type DetailSlot } from './smBase';

// ─── Public types ──────────────────────────────────────────────────────────────

export type ColumnTraceDirection = 'up' | 'down' | 'both';
export type HopVerdict = 'trace' | 'prune' | 'pass' | 'revisit';

export interface FrontierEntry {
  nodeId: string;
  activeColumns: string[];
  depth: number;
  parentNodeId: string | null;
  question?: string;           // AI's sub-question for this node (self-ask routing)
}

export interface ChainEntry {
  nodeId: string;
  schema: string;
  name: string;
  type: string;
  columnsIn: string[];
  columnsOut: string[];
  summary: string;
  notes?: string;            // free-form AI findings for this node (AI-read only)
  index?: string;
  boundaryFlag: BoundaryFlag;
}

export interface OutOfScopeEntry {
  nodeId: string;
  reason: string;
}

export interface ColumnTraceConfig {
  maxFrontierSize?: number;   // default 200
  activeFilter?: SerializedFilterState | null;  // user's active filter — for scope REPORTING, not filtering
}


// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_REJECTIONS_PER_HOP = 2;
const MAX_REVISITS = 3;            // cap on re-expanding pruned branches per trace
const DEFAULT_MAX_FRONTIER = 200;
const BFS_SCOPE_CAP = 10_000; // cap scope computation (not frontier) — just for perf safety
const MAX_AUTODISCOVER_CANDIDATES = 5;  // above this, ask user to specify origin
const CANDIDATE_DISPLAY_LIMIT = 10;     // max candidates shown in ambiguity error
const DEPTH_WARNING_THRESHOLD = 10;     // log warning when trace depth exceeds this

// ─── Class ─────────────────────────────────────────────────────────────────────

export class ColumnTraceState extends HopStateMachine {

  // CT-specific state
  private readonly maxFrontierSize: number;
  private direction: ColumnTraceDirection = 'up';
  private targetColumns: string[] = [];
  private frontier: FrontierEntry[] = [];
  private frontierIds = new Set<string>();
  private chain = new Map<string, ChainEntry>();
  private passthroughMap = new Map<string, string[]>();
  private outOfScope: OutOfScopeEntry[] = [];
  private prunedEntries = new Map<string, { parentColumns: string[]; depth: number; parentNodeId: string | null }>();
  private revisitCount = 0;
  private scopeSize = 0;
  private currentFocusActiveColumns: string[] = [];
  private currentFocusDepth = 0;
  private rejectionsThisHop = 0;
  private rejectionHistory: Array<{ hop: number; nodeId: string; submitted: string[]; valid: string[] }> = [];

  constructor(
    model: DatabaseModel,
    graph: Graph,
    log: LogFn,
    config?: ColumnTraceConfig,
    store?: ColumnStore | null,
  ) {
    super(model, graph, log, {
      activeFilter: config?.activeFilter,
    }, store);
    this.maxFrontierSize = config?.maxFrontierSize ?? DEFAULT_MAX_FRONTIER;
  }

  // ─── Frontier coordinators (single mutation point for frontier + frontierIds sync) ─

  private frontierPush(entry: FrontierEntry): void {
    this.frontier.push(entry);
    this.frontierIds.add(entry.nodeId);
  }

  /** Update existing frontier entry if present, otherwise push new. Returns action taken. */
  private frontierUpdateOrPush(entry: FrontierEntry): 'updated' | 'pushed' {
    if (this.frontierIds.has(entry.nodeId)) {
      const idx = this.frontier.findIndex(f => f.nodeId === entry.nodeId);
      if (idx >= 0) {
        this.frontier[idx].activeColumns = entry.activeColumns;
        this.frontier[idx].question = entry.question;
        return 'updated';
      }
    }
    this.frontierPush(entry);
    return 'pushed';
  }

  /** Remove a frontier entry by nodeId (used by cascade prune). */
  private frontierRemove(nodeId: string): boolean {
    const idx = this.frontier.findIndex(f => f.nodeId === nodeId);
    if (idx >= 0) {
      this.frontier.splice(idx, 1);
      this.frontierIds.delete(nodeId);
      return true;
    }
    this.frontierIds.delete(nodeId);
    return false;
  }

  // ─── Removed-node coordinators (sync removedSet + outOfScope + prunedEntries) ─

  /** Mark a node as pruned by AI (reversible via restorePruned). */
  private markPruned(nodeId: string, summary: string, undoData: { parentColumns: string[]; depth: number; parentNodeId: string | null }): void {
    this.removedSet.add(nodeId);
    this.outOfScope.push({ nodeId, reason: summary });
    this.prunedEntries.set(nodeId, undoData);
  }

  /** Mark a node as cascade-removed (NOT reversible — not added to prunedEntries). */
  private markCascadeRemoved(nodeId: string): void {
    this.removedSet.add(nodeId);
    this.outOfScope.push({ nodeId, reason: 'Cascade-removed (unreachable after prune)' });
  }

  /** Restore a previously pruned node. Returns undo data or undefined if not found. */
  private restorePruned(nodeId: string): { parentColumns: string[]; depth: number; parentNodeId: string | null } | undefined {
    const stored = this.prunedEntries.get(nodeId);
    if (!stored) return undefined;
    this.removedSet.delete(nodeId);
    this.outOfScope = this.outOfScope.filter(e => e.nodeId !== nodeId);
    this.prunedEntries.delete(nodeId);
    return stored;
  }

  protected getScopeDirection(): 'upstream' | 'downstream' | 'bidirectional' {
    return this.direction === 'up' ? 'upstream' : this.direction === 'down' ? 'downstream' : 'bidirectional';
  }

  // ─── init ──────────────────────────────────────────────────────────────────

  init(params: {
    targetColumns: string[];
    origin?: string;
    direction?: ColumnTraceDirection;
  }): { ok: true; scopeSize: number; originNode: Record<string, unknown> }
     | { error: string; hint?: string; candidates?: Array<{ id: string; name: string; type: string }> } {

    // Reset all mutable state (safe to call init() again on same instance)
    this.resetSharedState();
    this.frontier = [];
    this.frontierIds.clear();
    this.chain.clear();
    this.passthroughMap.clear();
    this.outOfScope = [];
    this.scopeSize = 0;
    this.currentFocusActiveColumns = [];
    this.currentFocusDepth = 0;
    this.rejectionsThisHop = 0;
    this.prunedEntries.clear();
    this.revisitCount = 0;
    this.rejectionHistory = [];

    const { targetColumns: rawCols, origin, direction = 'up' } = params;

    // Runtime validation — LM API passes untyped JSON
    const VALID_DIRECTIONS: ColumnTraceDirection[] = ['up', 'down', 'both'];
    if (!VALID_DIRECTIONS.includes(direction)) {
      this._status = 'error';
      this.log('debug', `INIT ERROR: invalid direction "${direction}"`);
      return { error: 'invalid_direction', hint: `direction must be 'up', 'down', or 'both'` };
    }
    this.direction = direction;
    this.targetColumns = [...new Set((rawCols ?? []).map((c: string) => c.trim()).filter(Boolean))];

    // Resolve origin
    let originNode: LineageNode | undefined;
    if (origin) {
      originNode = this.nodeMap.get(origin.toLowerCase());
      if (!originNode) {
        this._status = 'error';
        this.log('debug', `INIT ERROR: origin "${origin}" not found`);
        return { error: 'origin_not_found', hint: `Object "${origin}" not found in loaded model.` };
      }
    } else if (!this.targetColumns.length) {
      // No columns AND no origin — can't auto-discover
      this._status = 'error';
      this.log('debug', 'INIT ERROR: no origin and no columns');
      return { error: 'no_origin', hint: 'Provide origin object when tracing without columns.' };
    } else {
      // Auto-discover: find tables/views with a matching column
      const colLower = new Set(this.targetColumns.map(c => c.toLowerCase()));
      // Auto-discover: use ColumnStore reverse index (O(1)) or scan nodes (fallback for tests)
      let candidates: LineageNode[];
      if (this.store) {
        candidates = this.targetColumns.flatMap(col => this.store!.findByColumnName(col))
            .filter((id: string, i: number, arr: string[]) => arr.indexOf(id) === i)
            .map((id: string) => this.nodeMap.get(id))
            .filter((n): n is LineageNode => !!n);
      } else {
        candidates = this.model.nodes.filter(n => {
            const cols = n.columns;
            return cols?.some(c => colLower.has(c.name.toLowerCase()));
          });
      }
      if (candidates.length === 0) {
        this._status = 'error';
        this.log('debug', `INIT ERROR: no object contains columns [${this.targetColumns}]`);
        return { error: 'column_not_found', hint: `No object contains column(s): ${this.targetColumns.join(', ')}.` };
      }
      if (candidates.length > MAX_AUTODISCOVER_CANDIDATES) {
        // Too many candidates — ask for clarification
        this._status = 'error';
        this.log('debug', `INIT ERROR: ${candidates.length} candidates for columns [${this.targetColumns}] — ambiguous`);
        return {
          error: 'ambiguous_origin',
          hint: `${candidates.length} objects contain column(s) "${this.targetColumns.join(', ')}". Provide the origin object ID.`,
          candidates: candidates.slice(0, CANDIDATE_DISPLAY_LIMIT).map((c: LineageNode) => ({ id: c.id, name: c.name, type: c.type })),
        };
      }
      // 1-5 candidates: pick the one with highest degree (most connected = likely the fact/main table)
      originNode = candidates.sort((a: LineageNode, b: LineageNode) => {
        const degA = (this.model.neighborIndex[a.id]?.in.length ?? 0) + (this.model.neighborIndex[a.id]?.out.length ?? 0);
        const degB = (this.model.neighborIndex[b.id]?.in.length ?? 0) + (this.model.neighborIndex[b.id]?.out.length ?? 0);
        return degB - degA;
      })[0];
      this.log('info', `Auto-discovered origin: ${originNode!.id} (${candidates.length} candidate(s), picked highest degree)`);
    }

    // All error paths returned above — originNode is guaranteed defined here
    const origin_ = originNode!;
    this.originNodeId = origin_.id;

    // Compute scope via NeighborIndex BFS (direction-aware)
    const scopeIds = this.bfsScopeViaIndex(origin_.id);
    this.scopeNodeIds = scopeIds;
    this.scopeSize = scopeIds.size;

    // Seed frontier with directional neighbors of origin
    const neighbors = this.getDirectionalNeighbors(origin_.id);
    for (const nid of neighbors) {
      if (this.frontier.length >= this.maxFrontierSize) break;
      this.frontierPush({
        nodeId: nid,
        activeColumns: [...this.targetColumns],
        depth: 1,
        parentNodeId: origin_.id,
      });
    }

    // Add origin to visited + chain (root entry)
    this.visited.add(origin_.id);
    this.chain.set(origin_.id, {
      nodeId: origin_.id,
      schema: origin_.schema,
      name: origin_.name,
      type: origin_.type,
      columnsIn: [...this.targetColumns],
      columnsOut: [],  // filled by first hop's verdicts
      summary: 'Trace origin',
      boundaryFlag: 'none',
    });

    this._status = 'initialized';
    this.log('info', `INIT | origin=${origin_.id} | columns=[${this.targetColumns}] | direction=${direction} | scope=${scopeIds.size} nodes to walk | frontier=${this.frontier.length} initial`);
    this.log('debug', `INIT detail | origin=${origin_.id} (${origin_.type}) | auto_discovered=${!origin} | scope=${scopeIds.size} | frontier=${this.frontier.length} | direction=${direction}`);

    return {
      ok: true,
      scopeSize: scopeIds.size,
      originNode: strip(presentNode(origin_, this.model.neighborIndex)),
    };
  }

  // ─── getHopContext ─────────────────────────────────────────────────────────

  getHopContext(): {
    trace_status: 'in_progress';
    action_required: 'submit_hop_analysis';
    verdicts_expected: number;
    ct_mode: 'hop_and_distill';
    hop: number;
    current_depth: number;
    frontier_remaining: number;
    goal: { columns: string[]; direction: ColumnTraceDirection; origin: string | null };
    sub_question: string;
    path_so_far: Array<{ node_id: string; summary: string; columns_in: string[]; columns: string[]; notes?: string }>;
    working_memory: BaseWorkingMemory & { frontier_remaining: number; current_depth: number };
    focus_node: Record<string, unknown>;
    active_columns: string[];
    neighbors: HopNeighbor[];
    out_of_scope_so_far: OutOfScopeEntry[] | { count: number; recent: OutOfScopeEntry[] };
  } | { done: true } | { error: string } {

    if (this._status !== 'initialized' && this._status !== 'hopping') {
      this.log('debug', `getHopContext: invalid status "${this._status}"`);
      return { error: `invalid_status: expected 'initialized' or 'hopping', got '${this._status}'` };
    }

    // Pop next valid frontier entry (skip visited + missing nodes without recursion)
    let entry: FrontierEntry | undefined;
    let node: LineageNode | undefined;
    while (this.frontier.length > 0) {
      const candidate = this.frontier.shift()!;
      if (this.visited.has(candidate.nodeId)) {
        this.log('debug', `Frontier skip: ${candidate.nodeId} — already visited`);
        continue;
      }
      if (this.removedSet.has(candidate.nodeId)) {
        this.log('debug', `Frontier skip: ${candidate.nodeId} — pruned (parent removed)`);
        continue;
      }
      const n = this.nodeMap.get(candidate.nodeId);
      if (!n) {
        this.log('debug', `Node not in model: ${candidate.nodeId} — skipped`);
        this.visited.add(candidate.nodeId); // prevent re-encounter
        continue;
      }
      entry = candidate;
      node = n;
      break;
    }

    if (!entry || !node) {
      this._status = 'complete';
      this.log('info', `Frontier drained — all paths exhausted | visited=${this.visited.size}/${this.scopeSize} | chain=${this.chain.size} | removed=${this.removedSet.size} | passthrough=${this.passthroughMap.size}`);
      return { done: true };
    }

    this.visited.add(entry.nodeId);
    this.hopCount++;
    this.rejectionsThisHop = 0; // reset rejection counter for new hop

    this.currentFocusNodeId = entry.nodeId;
    this.currentFocusActiveColumns = entry.activeColumns;
    this.currentFocusDepth = entry.depth;

    // Build focus node detail (shared helper + CT-specific active_columns)
    const focusNode = buildHopFocusNode(node, this.nodeMap, this.unrelatedMap, this.store ?? undefined, 'ct_ddl');
    focusNode.active_columns = entry.activeColumns;

    const neighbors = this.buildCtNeighborList(entry.nodeId);

    // Build path summary (two-level: summary for scan, notes for detail)
    const pathSoFar: Array<{ node_id: string; summary: string; columns_in: string[]; columns: string[]; notes?: string }> = [];
    for (const e of this.chain.values()) {
      if (e.nodeId === this.originNodeId && e.columnsOut.length === 0) continue;
      pathSoFar.push({ node_id: e.nodeId, summary: e.summary, columns_in: e.columnsIn, columns: e.columnsOut, notes: e.notes });
    }
    for (const [ptId, ptCols] of this.passthroughMap) {
      if (this.chain.has(ptId)) continue; // Diamond: node already in chain via another path
      pathSoFar.push({ node_id: ptId, summary: 'pass', columns_in: ptCols, columns: [] });
    }

    // sub_question: AI's own question from previous hop (self-ask), or type-aware default
    const isTableNode = !SCRIPT_TYPES.has(node.type);
    const subQuestion = entry.question
      ?? (isTableNode
        ? `This is a table (no DDL body). Tables store columns — they do not transform them. ` +
          `Upstream neighbors that INSERT INTO this table carry column(s) [${entry.activeColumns.join(', ')}] upstream. ` +
          `Trace through upstream SPs/views that write to this table. ` +
          `Prune only downstream neighbors that merely SELECT from this table.`
        : `Analyze ${node.id} for columns [${entry.activeColumns.join(', ')}]. Which neighbors carry these columns?`);
    const pct = this.scopeSize > 0 ? Math.round((this.visited.size / this.scopeSize) * 100) : 0;
    this.log('info', `Hop ${this.hopCount} | ${node.id} | cols=[${entry.activeColumns}] | neighbors=${neighbors.length} | progress: ${this.visited.size}/${this.scopeSize} visited (${pct}%) | frontier=${this.frontier.length} | depth=${entry.depth}`);
    this.log('debug', `Hop ${this.hopCount} detail | ${node.id} (${node.type}) | task=${entry.question ? 'self-ask' : 'default'} | chain=${this.chain.size} | removed=${this.removedSet.size} | passthrough=${this.passthroughMap.size}`);
    if (entry.depth >= DEPTH_WARNING_THRESHOLD) {
      this.log('warn', `Deep trace: depth=${entry.depth}, frontier=${this.frontier.length}, visited=${this.visited.size}/${this.scopeSize}`);
    }

    this._status = 'awaiting_verdicts';
    return {
      trace_status: 'in_progress' as const,
      action_required: 'submit_hop_analysis' as const,
      verdicts_expected: neighbors.length,
      ct_mode: 'hop_and_distill',
      hop: this.hopCount,
      current_depth: entry.depth,
      frontier_remaining: this.frontier.length,
      goal: { columns: this.targetColumns, direction: this.direction, origin: this.originNodeId },
      sub_question: subQuestion,
      path_so_far: pathSoFar,
      working_memory: {
        ...this.buildBaseWorkingMemory(),
        frontier_remaining: this.frontier.length,
        current_depth: entry.depth,
      },
      focus_node: strip(focusNode) as Record<string, unknown>,
      active_columns: entry.activeColumns,
      neighbors,
      out_of_scope_so_far: this.outOfScope.length <= 10
        ? this.outOfScope
        : { count: this.outOfScope.length, recent: this.outOfScope.slice(-5) },
      // Revisitable: pruned nodes the AI can re-expand (max 5 shown, capped by MAX_REVISITS)
      ...(this.prunedEntries.size > 0 && this.revisitCount < MAX_REVISITS
        ? { revisitable: [...this.prunedEntries.keys()].slice(0, 5), revisits_remaining: MAX_REVISITS - this.revisitCount }
        : {}),
    };
  }

  // ─── Shared: neighbor list builder ─────────────────────────────────────────

  /** Build the neighbor list for a focus node. Used by getHopContext() and rebuildCurrentHopContext(). */
  private buildCtNeighborList(focusNodeId: string): HopNeighbor[] {
    const neighborIds = this.getDirectionalNeighbors(focusNodeId);
    const nb = this.model.neighborIndex[focusNodeId] ?? { in: [], out: [] };
    const inSet = new Set(nb.in);
    const neighbors: HopNeighbor[] = [];

    for (const nid of neighborIds) {
      const nNode = this.nodeMap.get(nid);
      if (!nNode) continue;

      const isUpstream = inSet.has(nid);
      const primaryKey = isUpstream ? `${nid}→${focusNodeId}` : `${focusNodeId}→${nid}`;
      const reverseKey = isUpstream ? `${focusNodeId}→${nid}` : `${nid}→${focusNodeId}`;
      let edgeType = this.edgeTypeMap.get(primaryKey);
      if (!edgeType) {
        edgeType = this.edgeTypeMap.get(reverseKey);
        if (edgeType) {
          this.log('debug', `Edge ${primaryKey} not found, used reverse ${reverseKey} (${edgeType})`);
        } else {
          edgeType = 'read';
        }
      }

      const boundary = this.detectBoundary(nid);
      // Skip cycle-back neighbors (already visited as focus node).
      // Boundary merges (source/sink) are preserved — they were never focus nodes.
      if (boundary === 'cycle') continue;
      const neighbor: HopNeighbor = {
        id: nid, s: nNode.schema, n: nNode.name, t: nNode.type,
        edge_direction: isUpstream ? 'upstream' : 'downstream',
        edge_type: edgeType, boundary,
        hasDdl: SCRIPT_TYPES.has(nNode.type) && !!getNodeDdl(nid, this.nodeMap, this.store ?? undefined),
      };
      if (boundary !== 'none') neighbor.boundary_reason = this.boundaryReason(boundary, nNode);
      const nCols = getNodeColumns(nid, this.nodeMap, this.store ?? undefined);
      if (nCols?.length) neighbor.cols = nCols.map(c => presentColumnCompact(c));
      if (nNode.fks?.length) neighbor.fks = nNode.fks.map(fk => presentFkCompact(fk));
      neighbors.push(neighbor);
    }

    return neighbors;
  }

  // ─── rebuildCurrentHopContext (for error recovery — does NOT mutate state) ──

  /** Rebuild the current hop context from cached fields. Used by focus_mismatch to resend context without advancing frontier. */
  private rebuildCurrentHopContext(): Record<string, unknown> | null {
    if (!this.currentFocusNodeId) return null;
    const node = this.nodeMap.get(this.currentFocusNodeId);
    if (!node) return null;

    const focusNode = buildHopFocusNode(node, this.nodeMap, this.unrelatedMap, this.store ?? undefined, 'ct_ddl');
    focusNode.active_columns = this.currentFocusActiveColumns;

    return {
      focus_node: strip(focusNode),
      active_columns: this.currentFocusActiveColumns,
      neighbors: this.buildCtNeighborList(this.currentFocusNodeId),
      hop: this.hopCount,
      frontier_remaining: this.frontier.length,
    };
  }

  // ─── submitVerdicts ────────────────────────────────────────────────────────

  submitVerdicts(params: {
    focusNodeId: string;
    notes?: string;              // free-form AI findings for the focus node
    badge_label?: string;        // semantic role label for enrich_view (e.g. "Source", "ETL")
    note_caption?: string;       // one-line caption for enrich_view note
    verdicts: Array<{
      nodeId: string;
      verdict: HopVerdict;
      columnsOut?: string[];
      summary?: string;
      question?: string;         // AI's sub-question for this neighbor (self-ask)
    }>;
  }): { ok: true; advanced: number; frontierSize: number }
     | { error: 'invalid_columns'; nodeId: string; invalid: string[]; valid: string[] }
     | { error: string; hint?: string; limit?: number } {

    if (this._status !== 'awaiting_verdicts') {
      this.log('debug', `submitVerdicts: invalid status "${this._status}"`);
      return { error: `invalid_status: expected 'awaiting_verdicts', got '${this._status}'` };
    }
    if (params.focusNodeId !== this.currentFocusNodeId) {
      this.log('debug', `submitVerdicts: focus mismatch — expected=${this.currentFocusNodeId}, got=${params.focusNodeId}`);
      const hopContext = this.rebuildCurrentHopContext();
      return { error: 'focus_mismatch', hint: `Expected focus ${this.currentFocusNodeId}, got ${params.focusNodeId}. Extract the id field from focus_node in the hop context response.`, ...(hopContext && { hop_context: hopContext }) };
    }

    // Validate all verdicts before committing (transactional)
    for (const v of params.verdicts) {
      if (v.verdict === 'revisit') {
        if (!this.prunedEntries.has(v.nodeId)) {
          this.log('debug', `submitVerdicts: revisit invalid — ${v.nodeId} was not pruned`);
          return { error: 'revisit_invalid', hint: `${v.nodeId} was not previously pruned — only pruned nodes can be revisited.` };
        }
        if (this.revisitCount >= MAX_REVISITS) {
          this.log('debug', `submitVerdicts: revisit cap (${MAX_REVISITS}) reached`);
          return { error: 'revisit_cap_reached', hint: `Maximum ${MAX_REVISITS} revisits per trace. Remaining revisits: 0.` };
        }
        continue;
      }
      if (v.verdict === 'trace') {
        const colErr = this.validateTraceColumns(v.nodeId, v.columnsOut);
        if (colErr) return colErr;
      }
    }

    // All validations passed — commit mutations

    // 1. Store detail memory (before verdicts — doesn't depend on summary)
    this.storeFocusNodeDetail(params);

    // 2. Apply verdicts (populates chain summaries via applyTrace)
    let advanced = 0;
    let pruneCount = 0;
    for (const v of params.verdicts) {
      const result = this.applyVerdict(v);
      if ('error' in result) return result;
      advanced += result.advanced;
      if (v.verdict === 'prune') pruneCount++;
    }

    // 3. Update short memory (after verdicts — captures both chain and passthrough nodes)
    //    Two parts: SM-generated metadata (traced/pruned) + AI-generated insight (notes)
    //    SM adds the mechanical facts automatically. AI writes only the insight (FOUND/OPEN).
    const focusChain = this.chain.get(this.currentFocusNodeId!);
    const focusName = focusChain?.name ?? this.nodeMap.get(this.currentFocusNodeId!)?.name ?? '';
    const isPass = !focusChain && this.passthroughMap.has(this.currentFocusNodeId!);
    if (focusName && (focusChain || isPass)) {
      // SM metadata: which neighbors traced/pruned (AI doesn't need to repeat this)
      const traced = params.verdicts.filter(v => v.verdict === 'trace').map(v => this.nodeMap.get(v.nodeId)?.name ?? v.nodeId);
      const pruned = params.verdicts.filter(v => v.verdict === 'prune').map(v => this.nodeMap.get(v.nodeId)?.name ?? v.nodeId);
      // AI insight: from note_caption (concise) or summary or notes (fallback)
      const aiInsight = params.note_caption || focusChain?.summary || '';
      // Compose: name + [pass] + AI insight + SM metadata
      const parts: string[] = [];
      if (isPass) parts.push('[pass]');
      if (aiInsight) parts.push(aiInsight);
      if (traced.length) parts.push(`→ traced: ${traced.join(', ')}`);
      if (pruned.length) parts.push(`✕ pruned: ${pruned.join(', ')}`);
      const entry = `${focusName}: ${parts.join(' | ')}`;
      const smErr = this.updateShortMemory(entry);
      if (smErr) return { error: 'notes_too_long', limit: this.shortMemoryHardLimit, hint: `Shorten your notes — aim for ~${this.shortMemorySoftLimit} chars.` };
    }

    // Cascade prune: remove frontier entries unreachable from origin after prunes
    let cascaded = 0;
    if (pruneCount > 0) {
      cascaded = this.cascadePruneFrontier();
      if (cascaded > 0) this.log('info', `CT cascade: ${cascaded} frontier nodes removed (unreachable after prune)`);
    }

    this._status = 'hopping'; // ready for next getHopContext()
    const relevant = params.verdicts.filter(v => v.verdict === 'trace').length;
    const passthrough = params.verdicts.filter(v => v.verdict === 'pass').length;
    const pctDone = this.scopeSize > 0 ? Math.round((this.visited.size / this.scopeSize) * 100) : 0;
    this.log('info', `Verdicts: ${relevant} relevant, ${pruneCount} removed${cascaded > 0 ? ` (+${cascaded} cascaded)` : ''}, ${passthrough} passthrough | +${advanced} to frontier → ${this.frontier.length} remaining | visited ${this.visited.size}/${this.scopeSize} (${pctDone}%) | chain=${this.chain.size}`);
    return { ok: true, advanced, frontierSize: this.frontier.length };
  }

  // ─── Verdict handlers (extracted from submitVerdicts for single-responsibility) ─

  /** Store AI notes in the focus node's chain entry + detail memory. Short memory is updated separately after verdicts. */
  private storeFocusNodeDetail(params: { notes?: string; badge_label?: string; note_caption?: string }): void {
    if (!params.notes || !this.currentFocusNodeId) return;
    let focusChain = this.chain.get(this.currentFocusNodeId);
    if (!focusChain) {
      const focusNode = this.nodeMap.get(this.currentFocusNodeId);
      if (focusNode) {
        focusChain = {
          nodeId: this.currentFocusNodeId,
          schema: focusNode.schema,
          name: focusNode.name,
          type: focusNode.type,
          columnsIn: [...this.currentFocusActiveColumns],
          columnsOut: [],
          summary: '',
          boundaryFlag: 'none',
        };
        this.chain.set(this.currentFocusNodeId, focusChain);
      }
    }
    if (focusChain) {
      focusChain.notes = params.notes;
      this.storeDetail(this.currentFocusNodeId, params.notes, focusChain.summary || '', {
        badge_label: params.badge_label,
        note_caption: params.note_caption,
      });
    }
  }

  /** Validate column names for a trace verdict. Returns error object or null if valid. */
  private validateTraceColumns(nodeId: string, columnsOut?: string[]): { error: string; hint?: string; nodeId?: string; invalid?: string[]; valid?: string[] } | null {
    if (!columnsOut?.length && this.targetColumns.length > 0) {
      return { error: 'missing_columns', hint: `Verdict "trace" for ${nodeId} requires columnsOut (column mode).` };
    }
    if (!columnsOut?.length) return null;
    const neighbor = this.nodeMap.get(nodeId);
    const neighborCols = getNodeColumns(nodeId, this.nodeMap, this.store ?? undefined);
    if (neighborCols?.length) {
      const validSet = new Set(neighborCols.map(c => c.name.toLowerCase()));
      const invalid = columnsOut.filter(c => !validSet.has(c.toLowerCase()));
      if (invalid.length > 0) {
        this.rejectionsThisHop++;
        this.rejectionHistory.push({ hop: this.hopCount, nodeId, submitted: invalid, valid: neighborCols.map(c => c.name) });
        this.log('debug', `REJECT (${this.rejectionsThisHop}): columns [${invalid}] not found on ${nodeId}. Valid: [${neighborCols.map(c => c.name)}]`);
        return {
          error: 'invalid_columns',
          nodeId,
          invalid,
          valid: neighborCols.map(c => c.name),
          hint: this.rejectionsThisHop >= MAX_REJECTIONS_PER_HOP
            ? `Column rejected ${this.rejectionsThisHop} times. Fix the column name, or prune/pass this neighbor to continue the trace.`
            : 'Fix the column name from the valid list and resubmit.',
        };
      }
    } else if (neighbor?.type === 'procedure') {
      const focusId = this.currentFocusNodeId ?? '';
      const isExec = this.edgeTypeMap.get(`${focusId}→${nodeId}`) === 'exec'
        || this.edgeTypeMap.get(`${nodeId}→${focusId}`) === 'exec';
      if (isExec) {
        this.log('debug', `SP→SP exec: ${focusId} → ${nodeId} — column validation skipped`);
      }
    }
    return null;
  }

  /** Dispatch a single verdict to its handler. Returns advanced count or error. */
  private applyVerdict(v: {
    nodeId: string;
    verdict: HopVerdict;
    columnsOut?: string[];
    summary?: string;
    question?: string;
  }): { advanced: number } | { error: string; hint?: string } {
    switch (v.verdict) {
      case 'prune': return this.applyPrune(v);
      case 'revisit': return this.applyRevisit(v);
      case 'pass': return this.applyPass(v);
      default: return this.applyTrace(v);
    }
  }

  /** Prune: remove node from graph + cascade. SM-internal skip if chain/orphan guard fires. */
  private applyPrune(v: { nodeId: string; summary?: string }): { advanced: number } {
    // O(1) guard: chain nodes can never be pruned
    if (this.chain.has(v.nodeId)) {
      this.log('debug', `Verdict: ${v.nodeId} = prune → auto-skipped (already in chain)`);
      return { advanced: 0 };
    }
    // O(V+E) guard: reject if prune would orphan a chain node
    const chainIds = new Set(this.chain.keys());
    if (chainIds.size > 0) {
      const orphanedId = wouldOrphanNotedNode(this.graph, this.originNodeId!, this.removedSet, chainIds, v.nodeId);
      if (orphanedId) {
        this.log('debug', `Verdict: ${v.nodeId} = prune → skipped (would orphan chain node ${orphanedId})`);
        return { advanced: 0 };
      }
    }
    this.markPruned(v.nodeId, v.summary ?? 'Pruned by AI', {
      parentColumns: [...this.currentFocusActiveColumns],
      depth: this.currentFocusDepth + 1,
      parentNodeId: this.currentFocusNodeId,
    });
    this.log('debug', `Verdict: ${v.nodeId} = prune ("${v.summary ?? ''}")`);
    return { advanced: 0 };
  }

  /** Revisit: restore a previously pruned node to the frontier. AI-correctable error on invalid. */
  private applyRevisit(v: { nodeId: string; columnsOut?: string[]; question?: string }): { advanced: number } | { error: string; hint?: string } {
    if (!this.prunedEntries.has(v.nodeId)) {
      return { error: 'revisit_invalid', hint: `${v.nodeId} was not previously pruned — only pruned nodes can be revisited.` };
    }
    if (this.revisitCount >= MAX_REVISITS) {
      return { error: 'revisit_cap_reached', hint: `Maximum ${MAX_REVISITS} revisits per trace. Remaining revisits: 0.` };
    }
    const stored = this.restorePruned(v.nodeId)!;
    this.revisitCount++;
    const revisitColumns = v.columnsOut?.length ? v.columnsOut : stored.parentColumns;
    this.frontierPush({
      nodeId: v.nodeId,
      activeColumns: revisitColumns,
      depth: stored.depth,
      parentNodeId: stored.parentNodeId,
      question: v.question ?? `Revisiting ${v.nodeId} — previously pruned, now relevant.`,
    });
    this.log('info', `Verdict: ${v.nodeId} = REVISIT (${this.revisitCount}/${MAX_REVISITS}) → re-added to frontier`);
    return { advanced: 1 };
  }

  /** Pass: mark as passthrough, queue as lightweight focus hop (AI verdicts neighbors). */
  private applyPass(v: { nodeId: string; columnsOut?: string[] }): { advanced: number } {
    const boundary = this.detectBoundary(v.nodeId);
    const passColumns = v.columnsOut?.length ? v.columnsOut : this.currentFocusActiveColumns;
    this.passthroughMap.set(v.nodeId, [...passColumns]);
    if (boundary !== 'none') {
      this.visited.add(v.nodeId);
      this.log('debug', `Verdict: ${v.nodeId} = pass (boundary=${boundary}) → terminal`);
      return { advanced: 0 };
    }
    // Queue as lightweight focus hop — AI will see neighbors and verdict them
    // NOT marked visited yet — will be visited when getHopContext() pops it
    const entry: FrontierEntry = {
      nodeId: v.nodeId,
      activeColumns: passColumns,
      depth: this.currentFocusDepth + 1,
      parentNodeId: this.currentFocusNodeId ?? '',
      question: `Passthrough — which neighbors carry [${passColumns.join(', ')}] upstream?`,
    };
    this.frontierUpdateOrPush(entry);
    this.log('debug', `Verdict: ${v.nodeId} = pass → queued as focus hop (no auto-expand)`);
    return { advanced: 1 };
  }

  /** Trace: add to chain (or merge if convergent path), push to frontier. */
  private applyTrace(v: { nodeId: string; columnsOut?: string[]; summary?: string; question?: string }): { advanced: number } {
    const boundary = this.detectBoundary(v.nodeId);
    const neighbor = this.nodeMap.get(v.nodeId);

    // Chain entry: merge or create
    const existingChain = this.chain.get(v.nodeId);
    if (existingChain) {
      const mergedIn = new Set([...existingChain.columnsIn, ...this.currentFocusActiveColumns]);
      existingChain.columnsIn = [...mergedIn];
      if (v.columnsOut?.length) {
        const mergedOut = new Set([...existingChain.columnsOut, ...v.columnsOut]);
        existingChain.columnsOut = [...mergedOut];
      }
      this.log('debug', `Verdict: ${v.nodeId} = trace (merge into existing chain entry), columnsIn=[${existingChain.columnsIn}]`);
    } else {
      this.chain.set(v.nodeId, {
        nodeId: v.nodeId,
        schema: neighbor?.schema ?? '',
        name: neighbor?.name ?? '',
        type: neighbor?.type ?? '',
        columnsIn: [...this.currentFocusActiveColumns],
        columnsOut: v.columnsOut ?? [],
        summary: v.summary ?? '',
        boundaryFlag: boundary,
      });
      if (v.summary) {
        this.storeDetail(v.nodeId, v.summary, v.summary, {});
      }
    }

    // Frontier: update or push (non-boundary only)
    if (boundary === 'none') {
      const entry: FrontierEntry = {
        nodeId: v.nodeId,
        activeColumns: v.columnsOut ?? [],
        depth: this.currentFocusDepth + 1,
        parentNodeId: this.currentFocusNodeId ?? '',
        question: v.question,
      };
      const action = this.frontierUpdateOrPush(entry);
      if (action === 'updated') {
        this.log('debug', `Verdict: ${v.nodeId} = trace, updated existing frontier entry${v.question ? ` Q: "${v.question}"` : ''}`);
      } else {
        this.log('debug', `Verdict: ${v.nodeId} = trace, columns [${v.columnsOut}]${v.question ? ` Q: "${v.question}"` : ''} → queued as next focus hop`);
      }
      return { advanced: 1 };
    }
    this.log('debug', `Verdict: ${v.nodeId} = trace (boundary=${boundary}), columns [${v.columnsOut}] → terminal, not queued`);
    return { advanced: 0 };
  }

  // ─── submitBatch (inline mode) ──────────────────────────────────────────────

  /**
   * Batch submit all verdicts at once (inline mode only).
   * AI provides verdicts keyed by node ID. SM loops frontier internally:
   *   getHopContext() → match AI verdict → submitVerdicts() → repeat
   * Stops on first rejection or when frontier is empty.
   */
  submitBatch(entries: Array<{
    nodeId: string;
    notes?: string;
    badge_label?: string;
    note_caption?: string;
    verdicts: Array<{
      nodeId: string;
      verdict: HopVerdict;
      columnsOut?: string[];
      summary?: string;
      question?: string;
    }>;
  }>): { ok: true; result: ReturnType<ColumnTraceState['getResult']> }
     | { error: string; hint?: string; processed: number; failed_node?: string } {

    if (!this._inlineMode) {
      return { error: 'batch_not_inline', hint: 'Batch submit is only available in inline mode.', processed: 0 };
    }

    const entryMap = new Map(entries.map(e => [e.nodeId.toLowerCase(), e]));
    let processed = 0;

    while (true) {
      // If already awaiting verdicts (first hop from init), use current focus.
      // Otherwise advance to next hop.
      if (this._status !== 'awaiting_verdicts') {
        const hop = this.getHopContext();
        if ('done' in hop) break;
        if ('error' in hop) return { error: hop.error, hint: 'Internal hop error', processed, failed_node: this.currentFocusNodeId ?? undefined };
      }

      const focusId = this.currentFocusNodeId!;
      const entry = entryMap.get(focusId.toLowerCase());
      if (!entry) {
        // AI didn't provide verdict for this focus node — return partial result
        return {
          error: 'missing_verdict',
          hint: `No verdict provided for focus node ${focusId}. Provide a verdict and resubmit.`,
          processed,
          failed_node: focusId,
        };
      }

      const result = this.submitVerdicts({
        focusNodeId: focusId,
        notes: entry.notes,
        badge_label: entry.badge_label,
        note_caption: entry.note_caption,
        verdicts: entry.verdicts,
      });

      if ('error' in result) {
        return { error: result.error, hint: (result as { hint?: string }).hint, processed, failed_node: focusId };
      }
      processed++;
    }

    this.log('info', `Batch complete: ${processed} hops processed`);
    return { ok: true, result: this.getResult() };
  }

  // ─── getResult ─────────────────────────────────────────────────────────────

  getResult(): {
    status: 'complete';
    targetColumns: string[];
    originNodeId: string;
    direction: ColumnTraceDirection;
    chain: ChainEntry[];
    fullNodes: Record<string, unknown>[];
    edges: [string, string, string][];
    outOfScope: OutOfScopeEntry[];
    stats: { hops: number; examined: number; relevant: number; removed: number; passthrough: number };
    column_rejections?: Array<{ hop: number; nodeId: string; submitted: string[]; valid: string[] }>;
    suggested_labels: Array<{ node_id: string; text: string }>;
    suggested_notes:  Array<{ node_id: string; text: string }>;
    suggested_sections: Array<{ label: string; node_ids: string[] }>;
    short_memory: ShortMemory;
    detail_slots: DetailSlot[];
  } | { error: string; hint?: string } {

    if (this._status === 'created' || this._status === 'error' || this._status === 'awaiting_verdicts') {
      this.log('debug', `getResult: invalid status "${this._status}"`);
      return { error: `invalid_status: cannot get result in '${this._status}' state` };
    }
    if (this._status !== 'complete' && this.frontier.length > 0) {
      this.log('debug', `getResult: frontier not empty (${this.frontier.length} remaining)`);
      return { error: 'frontier_not_empty', hint: `${this.frontier.length} entries remain. Call getHopContext/submitVerdicts until done.` };
    }
    this._status = 'complete'; // E1: ensure status is complete when returning results

    // Build chain array (Map insertion order = BFS order)
    const chainArr = [...this.chain.values()];
    for (let i = 0; i < chainArr.length; i++) {
      chainArr[i].index = `${i + 1}/${chainArr.length}`;
    }

    // Build fullNodes: DDL for relevant, columns for passthrough
    const relevantIds = new Set(this.chain.keys());
    const allIds = new Set([...relevantIds, ...this.passthroughMap.keys()]);
    const fullNodes: Record<string, unknown>[] = [];

    for (const id of allIds) {
      const node = this.nodeMap.get(id);
      if (!node) continue;
      const out: Record<string, unknown> = {
        id: node.id, s: node.schema, n: node.name, t: node.type,
      };
      const idDdl = getNodeDdl(id, this.nodeMap, this.store ?? undefined);
      if (relevantIds.has(id) && SCRIPT_TYPES.has(node.type) && idDdl) {
        out.ddl = idDdl; // Full DDL — never truncated
      }
      const idCols = getNodeColumns(id, this.nodeMap, this.store ?? undefined);
      if (idCols?.length) {
        out.cols = idCols.map(c => strip(presentColumn(c)));
      }
      fullNodes.push(strip(out) as Record<string, unknown>);
    }

    // Build edges between chain + passthrough nodes
    const edges: [string, string, string][] = [];
    for (const e of this.model.edges) {
      if (allIds.has(e.source) && allIds.has(e.target)) {
        edges.push([e.source, e.target, edgeApiType(e.type)]);
      }
    }

    const stats = {
      hops: this.hopCount,
      examined: this.visited.size,
      relevant: this.chain.size,
      removed: this.removedSet.size,
      passthrough: this.passthroughMap.size,
    };

    const pruneRate = this.scopeSize > 0 ? Math.round(((this.scopeSize - stats.examined) / this.scopeSize) * 100) : 0;
    this.log('info', `COMPLETE | ${stats.hops} hops | examined ${stats.examined}/${this.scopeSize} (${pruneRate}% pruned) | chain=${stats.relevant} relevant + ${stats.passthrough} passthrough | ${stats.removed} removed`);
    this.log('debug', `COMPLETE detail | fullNodes=${fullNodes.length} | edges=${edges.length} | outOfScope=${this.outOfScope.length} | revisits=${this.revisitCount}`);

    // Derive badge/note suggestions from chain entries.
    // Chain is already the curated traced set — every entry is a relevant node.
    // badge_label from detail slot (AI-provided) falls back to node name.
    // notes = AI's per-hop findings (richer). summary = verdict reason (always set).
    const BADGE_NUM_RE = /^\d+[\.\s]+/;
    const stripBadgeNum = (s: string) => s.replace(BADGE_NUM_RE, '').trim();
    const suggested_labels = chainArr.map(e => {
      const slot = this.detailSlots.get(e.nodeId);
      const label = slot?.badge_label ? stripBadgeNum(slot.badge_label) : e.name;
      return { node_id: e.nodeId, text: label };
    });
    const suggested_notes  = chainArr.map(e => {
      const slot = this.detailSlots.get(e.nodeId);
      return { node_id: e.nodeId, text: slot?.note_caption ?? e.notes ?? e.summary };
    });

    // Group per-node labels into sections by shared badge_label, depth-ordered.
    // Uses the same depth ordering as the parent's getResult() — chainArr is already in BFS order.
    const sectionMap = new Map<string, string[]>();
    const sectionOrder: string[] = [];
    for (const sl of suggested_labels) {
      const slot = this.detailSlots.get(sl.node_id);
      if (!slot?.badge_label) continue; // Only nodes with explicit badge_label form sections
      const label = stripBadgeNum(slot.badge_label);
      if (!sectionMap.has(label)) {
        sectionMap.set(label, []);
        sectionOrder.push(label);
      }
      sectionMap.get(label)!.push(sl.node_id);
    }
    const suggested_sections = sectionOrder.map(label => ({
      label,
      node_ids: sectionMap.get(label)!,
    }));

    // Attach both memory tiers (matches BB pattern via buildSharedResult → getMemoryForSynthesis)
    const memory = this.getMemoryForSynthesis();

    return {
      status: 'complete',
      targetColumns: this.targetColumns,
      originNodeId: this.originNodeId ?? '',
      direction: this.direction,
      chain: chainArr, fullNodes, edges, outOfScope: this.outOfScope, stats,
      ...(this.rejectionHistory.length > 0 && { column_rejections: this.rejectionHistory }),
      suggested_labels,
      suggested_notes,
      suggested_sections,
      short_memory: memory.short_memory,
      detail_slots: memory.detail_slots,
    };
  }

  // ─── Accessors ─────────────────────────────────────────────────────────────

  get isInitialized(): boolean { return this._status !== 'created' && this._status !== 'error'; }
  get isComplete(): boolean { return this._status === 'complete'; }
  get isAwaitingVerdicts(): boolean { return this._status === 'awaiting_verdicts'; }
  get hops(): number { return this.hopCount; }
  get frontierSize(): number { return this.frontier.length; }
  get scope(): number { return this.scopeSize; }
  get visited_count(): number { return this.visited.size; }
  get removedCount(): number { return this.removedSet.size; }
  get chainSize(): number { return this.chain.size; }
  get columns(): readonly string[] { return this.targetColumns; }

  /** Estimate total DDL chars for all scriptable nodes in scope (for inline vs state machine decision). */
  estimateScopeDdlChars(): number {
    let total = 0;
    for (const nid of this.visited) {
      const node = this.nodeMap.get(nid);
      if (node && SCRIPT_TYPES.has(node.type)) {
        const ddl = getNodeDdl(nid, this.nodeMap, this.store ?? undefined);
        if (ddl) total += ddl.length;
      }
    }
    // Also include frontier nodes (not yet visited but in scope)
    for (const entry of this.frontier) {
      const node = this.nodeMap.get(entry.nodeId);
      if (node && SCRIPT_TYPES.has(node.type)) {
        const ddl = getNodeDdl(entry.nodeId, this.nodeMap, this.store ?? undefined);
        if (ddl) total += ddl.length;
      }
    }
    return total;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private getDirectionalNeighbors(nodeId: string): string[] {
    const nb = this.model.neighborIndex[nodeId] ?? { in: [], out: [] };
    switch (this.direction) {
      case 'up': return nb.in;
      case 'down': return nb.out;
      case 'both': return [...new Set([...nb.in, ...nb.out])];
    }
  }

  protected override detectBoundary(nodeId: string): BoundaryFlag {
    const node = this.nodeMap.get(nodeId);
    if (!node) return 'external';
    if (node.type === 'external') return 'external';
    if (this.visited.has(nodeId)) return 'cycle';
    const nb = this.model.neighborIndex[nodeId] ?? { in: [], out: [] };
    if (this.direction !== 'down' && nb.in.length === 0) return 'source';
    if (this.direction !== 'up' && nb.out.length === 0) return 'sink';
    return 'none';
  }

  protected override boundaryReason(flag: BoundaryFlag, node: LineageNode): string {
    switch (flag) {
      case 'source': return 'No upstream SP writes to this object — source boundary';
      case 'sink': return 'No downstream readers — sink boundary';
      case 'external': return `External reference (${node.externalType ?? 'unknown'}) — no DDL available`;
      case 'cycle': return 'Already visited — cycle detected';
      default: return '';
    }
  }

  /** Cascade: remove frontier nodes unreachable from origin after prunes. BFS-based, diamond-safe. */
  private cascadePruneFrontier(): number {
    if (!this.originNodeId) return 0;
    const reachable = new Set<string>();
    const queue = [this.originNodeId];
    reachable.add(this.originNodeId);
    let idx = 0;
    while (idx < queue.length) {
      const id = queue[idx++];
      const neighbors = this.getDirectionalNeighbors(id);
      for (const nid of neighbors) {
        if (!reachable.has(nid) && !this.removedSet.has(nid)) {
          reachable.add(nid);
          queue.push(nid);
        }
      }
    }
    let cascaded = 0;
    for (let i = this.frontier.length - 1; i >= 0; i--) {
      if (!reachable.has(this.frontier[i].nodeId)) {
        this.markCascadeRemoved(this.frontier[i].nodeId);
        this.frontierIds.delete(this.frontier[i].nodeId);
        this.frontier.splice(i, 1);
        cascaded++;
      }
    }
    return cascaded;
  }

  private advanceFrontier(nodeId: string, activeColumns: string[], parentDepth: number): number {
    const neighbors = this.getDirectionalNeighbors(nodeId);
    let added = 0;
    for (const nid of neighbors) {
      if (this.visited.has(nid) || this.removedSet.has(nid) || this.frontierIds.has(nid)) continue;
      if (this.frontier.length >= this.maxFrontierSize) {
        this.outOfScope.push({ nodeId: nid, reason: 'Frontier size cap reached' });
        this.log('warn', `Frontier cap (${this.maxFrontierSize}) — ${nid} added to outOfScope`);
        continue;
      }
      this.frontierPush({
        nodeId: nid,
        activeColumns: [...activeColumns],
        depth: parentDepth + 1,
        parentNodeId: nodeId,
      });
      added++;
    }
    return added;
  }

  /** Direction-aware BFS via NeighborIndex to compute reachable scope. */
  private bfsScopeViaIndex(startId: string): Set<string> {
    const seen = new Set<string>([startId]);
    const queue = [startId];
    let idx = 0;
    while (idx < queue.length) {
      const id = queue[idx++];
      const neighbors = this.getDirectionalNeighbors(id);
      for (const nid of neighbors) {
        if (!seen.has(nid)) {
          seen.add(nid);
          queue.push(nid);
          if (seen.size >= BFS_SCOPE_CAP) return seen;
        }
      }
    }
    return seen;
  }
}
