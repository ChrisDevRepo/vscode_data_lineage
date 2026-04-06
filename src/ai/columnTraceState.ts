/**
 * Column-Trace State Machine — Hop-and-Distill pattern.
 *
 * Owns graph traversal, column tracking, frontier management, boundary detection,
 * column validation (reject/retry), and final assembly. Zero VS Code imports.
 *
 * Lifecycle: init() → getHopContext() ↔ submitVerdicts() loop → getResult()
 *
 * @see tmp/ai-architecture-hop-and-distill.md
 * @see tmp/ai-implementation-plan-hop-and-distill.md
 */

import type { DatabaseModel, LineageNode, ColumnDef, NeighborIndex, ObjectType } from '../engine/types';
import type { ColumnStore } from '../engine/columnStore';
import type { SerializedFilterState } from '../engine/projectStore';
import { buildNodeMap, buildEdgeTypeMap, buildUnrelatedMap, SCRIPT_TYPES, getNodeColumns, getNodeDdl, buildHopFocusNode } from './tools';
import { presentNode, presentColumn, presentColumnCompact, presentFkCompact, strip, edgeApiType } from './aiPresenter';
import type Graph from 'graphology';
import { wouldOrphanNotedNode, type LogFn } from './smGuards';

// ─── Public types ──────────────────────────────────────────────────────────────

export type ColumnTraceDirection = 'up' | 'down' | 'both';
export type HopVerdict = 'trace' | 'prune' | 'pass' | 'revisit';
export type BoundaryFlag = 'none' | 'source' | 'sink' | 'external' | 'cycle';

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

export type { LogFn } from './smGuards';

// ─── Internal types ────────────────────────────────────────────────────────────

interface HopNeighbor {
  id: string;
  s: string;
  n: string;
  t: string;
  edge_direction: 'upstream' | 'downstream';
  edge_type: string;
  boundary: BoundaryFlag;
  boundary_reason?: string;
  cols?: string[];                 // compact column strings: "Amount decimal(18,2), not null, PK"
  fks?: string[];                  // compact FK strings: "CustomerKey → dbo.DimCustomer"
  hasDdl: boolean;
}

const MAX_REJECTIONS_PER_HOP = 2;
const MAX_REVISITS = 3;            // cap on re-expanding pruned branches per trace
const DEFAULT_MAX_FRONTIER = 200;
const BFS_SCOPE_CAP = 10_000; // cap scope computation (not frontier) — just for perf safety
const MAX_AUTODISCOVER_CANDIDATES = 5;  // above this, ask user to specify origin
const CANDIDATE_DISPLAY_LIMIT = 10;     // max candidates shown in ambiguity error
const DEPTH_WARNING_THRESHOLD = 10;     // log warning when trace depth exceeds this

// ─── Class ─────────────────────────────────────────────────────────────────────

export class ColumnTraceState {
  private readonly model: DatabaseModel;
  private readonly graph: Graph;
  private readonly store: ColumnStore | null;
  private readonly log: LogFn;
  private readonly maxFrontierSize: number;
  private readonly activeFilter: SerializedFilterState | null;
  private readonly filterSchemas: Set<string> | null;

  // Lookup caches (built once in constructor)
  private readonly nodeMap: Map<string, LineageNode>;
  private readonly edgeTypeMap: Map<string, string>;
  private readonly unrelatedMap: Map<string, string[]>;

  // Lifecycle status — enforces valid transitions
  private _status: 'created' | 'initialized' | 'hopping' | 'awaiting_verdicts' | 'complete' | 'error' = 'created';

  // State (set by init, mutated by submitVerdicts)
  private direction: ColumnTraceDirection = 'up';
  private targetColumns: string[] = [];
  private originNodeId: string | null = null;
  private frontier: FrontierEntry[] = [];
  private frontierIds = new Set<string>(); // dedup: prevent same node queued twice
  private visited = new Set<string>();
  private chain = new Map<string, ChainEntry>();
  private passthroughMap = new Map<string, string[]>(); // nodeId → columns at time of passthrough
  private removedSet = new Set<string>();
  private outOfScope: OutOfScopeEntry[] = [];
  private prunedEntries = new Map<string, { parentColumns: string[]; depth: number; parentNodeId: string | null }>();
  private revisitCount = 0;
  private hopCount = 0;
  private scopeSize = 0;

  // Current hop context (for submitVerdicts validation)
  private currentFocusNodeId: string | null = null;
  private currentFocusActiveColumns: string[] = [];
  private currentFocusDepth = 0;
  private rejectionsThisHop = 0;  // capped at MAX_REJECTIONS_PER_HOP per hop

  constructor(
    model: DatabaseModel,
    graph: Graph,
    log: LogFn,
    config?: ColumnTraceConfig,
    store?: ColumnStore | null,
  ) {
    this.model = model;
    this.graph = graph;
    this.store = store ?? null;
    this.log = log;
    this.maxFrontierSize = config?.maxFrontierSize ?? DEFAULT_MAX_FRONTIER;
    this.activeFilter = config?.activeFilter ?? null;
    this.filterSchemas = this.activeFilter?.schemas?.length
      ? new Set(this.activeFilter.schemas.map(s => s.toLowerCase()))
      : null;
    this.nodeMap = buildNodeMap(model);
    this.edgeTypeMap = buildEdgeTypeMap(model);
    this.unrelatedMap = buildUnrelatedMap(model);
  }

  // ─── init ──────────────────────────────────────────────────────────────────

  init(params: {
    targetColumns: string[];
    origin?: string;
    direction?: ColumnTraceDirection;
  }): { ok: true; scopeSize: number; originNode: Record<string, unknown> }
     | { error: string; hint?: string; candidates?: Array<{ id: string; name: string; type: string }> } {

    // Reset all mutable state (safe to call init() again on same instance)
    this.frontier = [];
    this.frontierIds.clear();
    this.visited.clear();
    this.chain.clear();
    this.passthroughMap.clear();
    this.removedSet.clear();
    this.outOfScope = [];
    this.hopCount = 0;
    this.scopeSize = 0;
    this.currentFocusNodeId = null;
    this.currentFocusActiveColumns = [];
    this.currentFocusDepth = 0;
    this.rejectionsThisHop = 0;
    this._status = 'created';

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
    const scopeIds = this.bfsScope(origin_.id);
    this.scopeSize = scopeIds.size;

    // Seed frontier with directional neighbors of origin
    const neighbors = this.getDirectionalNeighbors(origin_.id);
    for (const nid of neighbors) {
      if (this.frontier.length >= this.maxFrontierSize) break;
      this.frontier.push({
        nodeId: nid,
        activeColumns: [...this.targetColumns],
        depth: 1,
        parentNodeId: origin_.id,
      });
      this.frontierIds.add(nid);
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
    frontier_remaining: number;
    goal: { columns: string[]; direction: ColumnTraceDirection; origin: string | null };
    sub_question: string;
    path_so_far: Array<{ node_id: string; summary: string; columns_in: string[]; columns_out: string[]; notes?: string }>;
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
        this.log('warn', `Node not in model: ${candidate.nodeId} — skipped`);
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

    // Build neighbor list
    const neighborIds = this.getDirectionalNeighbors(entry.nodeId);
    const nb = this.model.neighborIndex[entry.nodeId] ?? { in: [], out: [] };
    const inSet = new Set(nb.in);
    const neighbors: HopNeighbor[] = [];

    for (const nid of neighborIds) {
      const nNode = this.nodeMap.get(nid);
      if (!nNode) continue;

      // Per-neighbor direction: check whether this neighbor is in the focus node's in-set or out-set
      const isUpstream = inSet.has(nid);
      const primaryKey = isUpstream ? `${nid}→${entry.nodeId}` : `${entry.nodeId}→${nid}`;
      const reverseKey = isUpstream ? `${entry.nodeId}→${nid}` : `${nid}→${entry.nodeId}`;
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
      const neighbor: HopNeighbor = {
        id: nid,
        s: nNode.schema,
        n: nNode.name,
        t: nNode.type,
        edge_direction: isUpstream ? 'upstream' : 'downstream',
        edge_type: edgeType,
        boundary,
        hasDdl: SCRIPT_TYPES.has(nNode.type) && !!getNodeDdl(nid, this.nodeMap, this.store ?? undefined),
      };

      if (boundary !== 'none') {
        neighbor.boundary_reason = this.boundaryReason(boundary, nNode);
      }

      const nCols = getNodeColumns(nid, this.nodeMap, this.store ?? undefined);
      if (nCols?.length) {
        neighbor.cols = nCols.map(c => presentColumnCompact(c));
      }

      // FK info on neighbor
      if (nNode.fks?.length) {
        neighbor.fks = nNode.fks.map(fk => presentFkCompact(fk));
      }

      neighbors.push(neighbor);
    }

    // Build path summary (two-level: summary for scan, notes for detail)
    const pathSoFar: Array<{ node_id: string; summary: string; columns_in: string[]; columns_out: string[]; notes?: string }> = [];
    for (const e of this.chain.values()) {
      if (e.nodeId === this.originNodeId && e.columnsOut.length === 0) continue;
      pathSoFar.push({ node_id: e.nodeId, summary: e.summary, columns_in: e.columnsIn, columns_out: e.columnsOut, notes: e.notes });
    }
    for (const [ptId, ptCols] of this.passthroughMap) {
      if (this.chain.has(ptId)) continue; // Diamond: node already in chain via another path
      pathSoFar.push({ node_id: ptId, summary: 'pass', columns_in: ptCols, columns_out: [] });
    }

    // sub_question: AI's own question from previous hop (self-ask) or default phrasing
    const subQuestion = entry.question
      ?? `Analyze ${node.id} for columns [${entry.activeColumns.join(', ')}]. Which neighbors carry these columns?`;
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
      frontier_remaining: this.frontier.length,
      goal: { columns: this.targetColumns, direction: this.direction, origin: this.originNodeId },
      sub_question: subQuestion,
      path_so_far: pathSoFar,
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

  // ─── submitVerdicts ────────────────────────────────────────────────────────

  submitVerdicts(params: {
    focusNodeId: string;
    notes?: string;              // free-form AI findings for the focus node
    verdicts: Array<{
      nodeId: string;
      verdict: HopVerdict;
      columnsOut?: string[];
      summary?: string;
      question?: string;         // AI's sub-question for this neighbor (self-ask)
    }>;
  }): { ok: true; advanced: number; frontierSize: number }
     | { error: 'invalid_columns'; nodeId: string; invalid: string[]; valid: string[] }
     | { error: string; hint?: string } {

    if (this._status !== 'awaiting_verdicts') {
      this.log('debug', `submitVerdicts: invalid status "${this._status}"`);
      return { error: `invalid_status: expected 'awaiting_verdicts', got '${this._status}'` };
    }
    if (params.focusNodeId !== this.currentFocusNodeId) {
      this.log('debug', `submitVerdicts: focus mismatch — expected=${this.currentFocusNodeId}, got=${params.focusNodeId}`);
      return { error: 'focus_mismatch', hint: `Expected focus ${this.currentFocusNodeId}, got ${params.focusNodeId}. Extract the id field from focus_node in the hop context response.` };
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
        continue; // no further validation needed for revisit
      }
      if (v.verdict === 'trace') {
        if (!v.columnsOut?.length && this.targetColumns.length > 0) {
          return { error: 'missing_columns', hint: `Verdict "trace" for ${v.nodeId} requires columnsOut (column mode).` };
        }
        // Column validation (skip if no columns to validate or rejection cap reached)
        if (v.columnsOut?.length && this.rejectionsThisHop < MAX_REJECTIONS_PER_HOP) {
          const neighbor = this.nodeMap.get(v.nodeId);
          const neighborCols = getNodeColumns(v.nodeId, this.nodeMap, this.store ?? undefined);
          if (neighborCols?.length) {
            const validSet = new Set(neighborCols.map(c => c.name.toLowerCase()));
            const invalid = v.columnsOut.filter(c => !validSet.has(c.toLowerCase()));
            if (invalid.length > 0) {
              this.rejectionsThisHop++;
              this.log('warn', `REJECT (${this.rejectionsThisHop}/${MAX_REJECTIONS_PER_HOP}): columns [${invalid}] not found on ${v.nodeId}. Valid: [${neighborCols.map(c => c.name)}]`);
              return {
                error: 'invalid_columns',
                nodeId: v.nodeId,
                invalid,
                valid: neighborCols.map(c => c.name),
              };
            }
          } else if (neighbor?.type === 'procedure') {
            const focusId = this.currentFocusNodeId ?? '';
            const isExec = this.edgeTypeMap.get(`${focusId}→${v.nodeId}`) === 'exec'
              || this.edgeTypeMap.get(`${v.nodeId}→${focusId}`) === 'exec';
            if (isExec) {
              this.log('debug', `SP→SP exec: ${focusId} → ${v.nodeId} — column validation skipped`);
            }
          }
        } else {
          this.log('warn', `Rejection cap reached (${MAX_REJECTIONS_PER_HOP}) — accepting columns on trust for ${v.nodeId}`);
        }
      }
    }

    // All validations passed — commit mutations
    // Store notes on focus node's chain entry (blackboard pattern)
    if (params.notes && this.currentFocusNodeId) {
      let focusChain = this.chain.get(this.currentFocusNodeId);
      if (!focusChain) {
        // Focus node not yet in chain (e.g., first hop — auto-seeded by init, not verdicted)
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
            boundaryFlag: 'none', // Focus node is active traversal, not a revisit
          };
          this.chain.set(this.currentFocusNodeId, focusChain);
        }
      }
      if (focusChain) focusChain.notes = params.notes;
    }
    let advanced = 0;
    for (const v of params.verdicts) {
      const boundary = this.detectBoundary(v.nodeId);
      const neighbor = this.nodeMap.get(v.nodeId);

      if (v.verdict === 'prune') {
        // Guard: reject prune if it would disconnect any chain node from origin
        const chainIds = new Set(this.chain.keys());
        if (chainIds.size > 0) {
          const orphanedId = wouldOrphanNotedNode(this.graph, this.originNodeId!, this.removedSet, chainIds, v.nodeId);
          if (orphanedId) {
            this.log('info', `CT PRUNE REJECTED | ${v.nodeId} | would orphan chain node ${orphanedId}`);
            continue;
          }
        }
        this.removedSet.add(v.nodeId);
        this.outOfScope.push({ nodeId: v.nodeId, reason: v.summary ?? 'Pruned by AI' });
        // Store enough data to support revisit (shallow undo buffer)
        this.prunedEntries.set(v.nodeId, {
          parentColumns: [...this.currentFocusActiveColumns],
          depth: this.currentFocusDepth + 1,
          parentNodeId: this.currentFocusNodeId,
        });
        this.log('debug', `Verdict: ${v.nodeId} = prune ("${v.summary ?? ''}")`);
        continue;
      }

      if (v.verdict === 'revisit') {
        // Restore a previously pruned node to the frontier
        const stored = this.prunedEntries.get(v.nodeId);
        if (!stored) {
          return { error: 'revisit_invalid', hint: `${v.nodeId} was not previously pruned — only pruned nodes can be revisited.` };
        }
        if (this.revisitCount >= MAX_REVISITS) {
          return { error: 'revisit_cap_reached', hint: `Maximum ${MAX_REVISITS} revisits per trace. Remaining revisits: 0.` };
        }
        // Undo the prune
        this.removedSet.delete(v.nodeId);
        this.outOfScope = this.outOfScope.filter(e => e.nodeId !== v.nodeId);
        this.prunedEntries.delete(v.nodeId);
        this.revisitCount++;
        // Re-add to frontier
        const revisitColumns = v.columnsOut?.length ? v.columnsOut : stored.parentColumns;
        this.frontier.push({
          nodeId: v.nodeId,
          activeColumns: revisitColumns,
          depth: stored.depth,
          parentNodeId: stored.parentNodeId,
          question: v.question ?? `Revisiting ${v.nodeId} — previously pruned, now relevant.`,
        });
        this.frontierIds.add(v.nodeId);
        advanced++;
        this.log('info', `Verdict: ${v.nodeId} = REVISIT (${this.revisitCount}/${MAX_REVISITS}) → re-added to frontier`);
        continue;
      }

      if (v.verdict === 'pass') {
        // Passthrough uses verdict columnsOut if provided, else inherits current active columns
        const passColumns = v.columnsOut?.length ? v.columnsOut : this.currentFocusActiveColumns;
        this.passthroughMap.set(v.nodeId, [...passColumns]);
        this.visited.add(v.nodeId); // Mark visited so it won't reappear as neighbor
        if (boundary === 'none') {
          const delta = this.advanceFrontier(v.nodeId, passColumns, this.currentFocusDepth + 1); // Passthrough children are one level deeper
          advanced += delta;
          this.log('debug', `Verdict: ${v.nodeId} = pass, columns=[${passColumns}] → queued ${delta} children`); // Log children queued, not total
        } else {
          this.log('debug', `Verdict: ${v.nodeId} = pass (boundary=${boundary}), columns=[${passColumns}] → terminal`);
        }
        continue;
      }

      // trace — push the node ITSELF to frontier as next focus hop (not its children)
      // Merge columns from converging paths (diamond pattern)
      const existingChain = this.chain.get(v.nodeId);
      if (existingChain) {
        // Merge columnsIn (union of all incoming paths)
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
      }

      if (boundary === 'none') {
        // If already in frontier (e.g., seeded by init), update existing entry with question + columns
        const existingIdx = this.frontierIds.has(v.nodeId)
          ? this.frontier.findIndex(f => f.nodeId === v.nodeId)
          : -1;
        if (existingIdx >= 0) {
          this.frontier[existingIdx].activeColumns = v.columnsOut ?? this.frontier[existingIdx].activeColumns;
          this.frontier[existingIdx].question = v.question;
          this.log('debug', `Verdict: ${v.nodeId} = trace, updated existing frontier entry${v.question ? ` Q: "${v.question}"` : ''}`);
        } else {
          this.frontier.push({
            nodeId: v.nodeId,
            activeColumns: v.columnsOut ?? [],
            depth: this.currentFocusDepth + 1,
            parentNodeId: this.currentFocusNodeId ?? '',
            question: v.question,
          });
          this.frontierIds.add(v.nodeId);
          this.log('debug', `Verdict: ${v.nodeId} = trace, columns [${v.columnsOut}]${v.question ? ` Q: "${v.question}"` : ''} → queued as next focus hop`);
        }
        advanced++;
      } else {
        this.log('debug', `Verdict: ${v.nodeId} = trace (boundary=${boundary}), columns [${v.columnsOut}] → terminal, not queued`);
      }
    }

    // Cascade prune: remove frontier entries unreachable from origin after prunes
    const removed = params.verdicts.filter(v => v.verdict === 'prune').length;
    let cascaded = 0;
    if (removed > 0) {
      cascaded = this.cascadePruneFrontier();
      if (cascaded > 0) this.log('info', `CT cascade: ${cascaded} frontier nodes removed (unreachable after prune)`);
    }

    this._status = 'hopping'; // ready for next getHopContext()
    const relevant = params.verdicts.filter(v => v.verdict === 'trace').length;
    const passthrough = params.verdicts.filter(v => v.verdict === 'pass').length;
    const pctDone = this.scopeSize > 0 ? Math.round((this.visited.size / this.scopeSize) * 100) : 0;
    this.log('info', `Verdicts: ${relevant} relevant, ${removed} removed${cascaded > 0 ? ` (+${cascaded} cascaded)` : ''}, ${passthrough} passthrough | +${advanced} to frontier → ${this.frontier.length} remaining | visited ${this.visited.size}/${this.scopeSize} (${pctDone}%) | chain=${this.chain.size}`);
    return { ok: true, advanced, frontierSize: this.frontier.length };
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

    return {
      status: 'complete',
      targetColumns: this.targetColumns,
      originNodeId: this.originNodeId ?? '',
      direction: this.direction,
      chain: chainArr, fullNodes, edges, outOfScope: this.outOfScope, stats,
    };
  }

  // ─── Accessors ─────────────────────────────────────────────────────────────

  get status(): string { return this._status; }
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

  private detectBoundary(nodeId: string): BoundaryFlag {
    const node = this.nodeMap.get(nodeId);
    if (!node) return 'external';
    if (node.type === 'external') return 'external';
    if (this.visited.has(nodeId)) return 'cycle';
    const nb = this.model.neighborIndex[nodeId] ?? { in: [], out: [] };
    if (this.direction !== 'down' && nb.in.length === 0) return 'source';
    if (this.direction !== 'up' && nb.out.length === 0) return 'sink';
    return 'none';
  }

  private boundaryReason(flag: BoundaryFlag, node: LineageNode): string {
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
        this.removedSet.add(this.frontier[i].nodeId);
        this.outOfScope.push({ nodeId: this.frontier[i].nodeId, reason: 'Cascade-removed (unreachable after prune)' });
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
      this.frontier.push({
        nodeId: nid,
        activeColumns: [...activeColumns],
        depth: parentDepth + 1,
        parentNodeId: nodeId,
      });
      this.frontierIds.add(nid);
      added++;
    }
    return added;
  }

  /** Direction-aware BFS via NeighborIndex to compute reachable scope (no graphology needed). */
  private bfsScope(startId: string): Set<string> {
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
