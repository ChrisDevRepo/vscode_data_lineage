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
import { buildNodeMap, buildEdgeTypeMap, buildUnrelatedMap, SCRIPT_TYPES, deriveCaps } from './tools';
import { presentNode, presentColumn, presentColumnCompact, presentFkCompact, strip, edgeApiType } from './aiPresenter';

// ─── Public types ──────────────────────────────────────────────────────────────

export type ColumnTraceDirection = 'up' | 'down' | 'both';
export type HopVerdict = 'trace' | 'prune' | 'pass';
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
  maxDdlChars?: number;       // default deriveCaps().MAX_DDL_CHARS
}

export type LogFn = (level: 'info' | 'debug' | 'warn', msg: string) => void;

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
const DEFAULT_MAX_FRONTIER = 200;
const BFS_SCOPE_CAP = 10_000; // cap scope computation (not frontier) — just for perf safety

// ─── Class ─────────────────────────────────────────────────────────────────────

export class ColumnTraceState {
  private readonly model: DatabaseModel;
  private readonly store: ColumnStore | null;
  private readonly log: LogFn;
  private readonly maxFrontierSize: number;
  private readonly maxDdlChars: number;

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
  private hopCount = 0;
  private scopeSize = 0;

  // Current hop context (for submitVerdicts validation)
  private currentFocusNodeId: string | null = null;
  private currentFocusActiveColumns: string[] = [];
  private currentFocusDepth = 0;
  private rejectionsThisHop = 0;  // Gap 1: cap at MAX_REJECTIONS_PER_HOP

  constructor(
    model: DatabaseModel,
    log: LogFn,
    config?: ColumnTraceConfig,
    store?: ColumnStore | null,
  ) {
    this.model = model;
    this.store = store ?? null;
    this.log = log;
    this.maxFrontierSize = config?.maxFrontierSize ?? DEFAULT_MAX_FRONTIER;
    this.maxDdlChars = config?.maxDdlChars ?? deriveCaps().MAX_DDL_CHARS;
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

    const { targetColumns, origin, direction = 'up' } = params;

    this.direction = direction;
    this.targetColumns = targetColumns;

    // Resolve origin
    let originNode: LineageNode | undefined;
    if (origin) {
      originNode = this.nodeMap.get(origin.toLowerCase());
      if (!originNode) {
        this._status = 'error';
        return { error: 'origin_not_found', hint: `Object "${origin}" not found in loaded model.` };
      }
    } else if (!targetColumns.length) {
      // No columns AND no origin — can't auto-discover
      this._status = 'error';
      return { error: 'no_origin', hint: 'Provide origin object when tracing without columns.' };
    } else {
      // Auto-discover: find tables/views with a matching column
      const colLower = new Set(targetColumns.map(c => c.toLowerCase()));
      // Auto-discover: use ColumnStore reverse index (O(1)) or scan nodes (fallback for tests)
      const candidates = this.store
        ? targetColumns.flatMap(col => this.store!.findByColumnName(col))
            .filter((id, i, arr) => arr.indexOf(id) === i)  // deduplicate
            .map(id => this.nodeMap.get(id))
            .filter((n): n is LineageNode => !!n)
        : this.model.nodes.filter(n => {
            const cols = n.columns;
            return cols?.some(c => colLower.has(c.name.toLowerCase()));
          });
      if (candidates.length === 0) {
        this._status = 'error';
        return { error: 'column_not_found', hint: `No object contains column(s): ${targetColumns.join(', ')}.` };
      }
      if (candidates.length > 5) {
        // Too many candidates — ask for clarification
        this._status = 'error';
        return {
          error: 'ambiguous_origin',
          hint: `${candidates.length} objects contain column(s) "${targetColumns.join(', ')}". Provide the origin object ID.`,
          candidates: candidates.slice(0, 10).map(c => ({ id: c.id, name: c.name, type: c.type })),
        };
      }
      // 1-5 candidates: pick the one with highest degree (most connected = likely the fact/main table)
      originNode = candidates.sort((a, b) => {
        const degA = (this.model.neighborIndex[a.id]?.in.length ?? 0) + (this.model.neighborIndex[a.id]?.out.length ?? 0);
        const degB = (this.model.neighborIndex[b.id]?.in.length ?? 0) + (this.model.neighborIndex[b.id]?.out.length ?? 0);
        return degB - degA;
      })[0];
      this.log('info', `Auto-discovered origin: ${originNode.id} (${candidates.length} candidate(s), picked highest degree)`);
    }

    this.originNodeId = originNode.id;

    // Compute scope via NeighborIndex BFS (direction-aware)
    const scopeIds = this.bfsScope(originNode.id);
    this.scopeSize = scopeIds.size;

    // Seed frontier with directional neighbors of origin
    const neighbors = this.getDirectionalNeighbors(originNode.id);
    for (const nid of neighbors) {
      if (this.frontier.length >= this.maxFrontierSize) break;
      this.frontier.push({
        nodeId: nid,
        activeColumns: [...targetColumns],
        depth: 1,
        parentNodeId: originNode.id,
      });
      this.frontierIds.add(nid);
    }

    // Add origin to visited + chain (root entry)
    this.visited.add(originNode.id);
    this.chain.set(originNode.id, {
      nodeId: originNode.id,
      schema: originNode.schema,
      name: originNode.name,
      type: originNode.type,
      columnsIn: [...targetColumns],
      columnsOut: [],  // filled by first hop's verdicts
      summary: 'Trace origin',
      boundaryFlag: 'none',
    });

    this._status = 'initialized';
    this.log('info', `INIT | origin=${originNode.id} | columns=[${targetColumns}] | direction=${direction} | scope=${scopeIds.size} nodes to walk | frontier=${this.frontier.length} initial`);

    return {
      ok: true,
      scopeSize: scopeIds.size,
      originNode: strip(presentNode(originNode, this.model.neighborIndex)),
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
    sub_question: string;
    path_so_far: Array<{ node_id: string; summary: string; columns_in: string[]; columns_out: string[]; notes?: string }>;
    focus_node: Record<string, unknown>;
    active_columns: string[];
    neighbors: HopNeighbor[];
    out_of_scope_so_far: OutOfScopeEntry[] | { count: number; recent: OutOfScopeEntry[] };
  } | { done: true } | { error: string } {

    if (this._status !== 'initialized' && this._status !== 'hopping') {
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

    // Build focus node detail
    const focusNode: Record<string, unknown> = {
      id: node.id,
      s: node.schema,
      n: node.name,
      t: node.type,
      active_columns: entry.activeColumns,
    };

    const nodeDdl = this.getNodeDdl(node.id);
    const nodeCols = this.getNodeColumns(node.id);
    if (SCRIPT_TYPES.has(node.type) && nodeDdl) {
      const ddl = nodeDdl.length > this.maxDdlChars
        ? nodeDdl.slice(0, this.maxDdlChars) + `\n-- [truncated at ${this.maxDdlChars} chars]`
        : nodeDdl;
      focusNode.ct_ddl = ddl;
      if (nodeDdl.length > this.maxDdlChars) {
        focusNode.ddl_truncated = true;
      }
    } else if (nodeCols?.length) {
      focusNode.cols = nodeCols.map(c => presentColumnCompact(c));
    }

    // FK info on focus node
    const focusNodeObj = this.nodeMap.get(node.id);
    if (focusNodeObj?.fks?.length) {
      focusNode.fks = focusNodeObj.fks.map(fk => presentFkCompact(fk));
    }

    // Attach unresolved refs
    const unrelKey = `${node.schema}.${node.name}`.toLowerCase();
    const unrel = this.unrelatedMap.get(unrelKey);
    if (unrel?.length) focusNode.unresolved_refs = unrel;

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
        hasDdl: SCRIPT_TYPES.has(nNode.type) && !!this.getNodeDdl(nid),
      };

      if (boundary !== 'none') {
        neighbor.boundary_reason = this.boundaryReason(boundary, nNode);
      }

      const nCols = this.getNodeColumns(nid);
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
      if (this.chain.has(ptId)) continue; // Bug #7 fix: already in chain, skip duplicate
      pathSoFar.push({ node_id: ptId, summary: 'pass', columns_in: ptCols, columns_out: [] });
    }

    // sub_question: AI's own question from previous hop (self-ask) or default phrasing
    const subQuestion = entry.question
      ?? `Analyze ${node.id} for columns [${entry.activeColumns.join(', ')}]. Which neighbors carry these columns?`;
    const pct = this.scopeSize > 0 ? Math.round((this.visited.size / this.scopeSize) * 100) : 0;
    this.log('info', `Hop ${this.hopCount} | ${node.id} | cols=[${entry.activeColumns}] | neighbors=${neighbors.length} | progress: ${this.visited.size}/${this.scopeSize} visited (${pct}%) | frontier=${this.frontier.length} | depth=${entry.depth}`);
    if (entry.depth >= 10) {
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
      sub_question: subQuestion,
      path_so_far: pathSoFar,
      focus_node: strip(focusNode) as Record<string, unknown>,
      active_columns: entry.activeColumns,
      neighbors,
      out_of_scope_so_far: this.outOfScope.length <= 10
        ? this.outOfScope
        : { count: this.outOfScope.length, recent: this.outOfScope.slice(-5) },
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
      return { error: `invalid_status: expected 'awaiting_verdicts', got '${this._status}'` };
    }
    if (params.focusNodeId !== this.currentFocusNodeId) {
      return { error: 'focus_mismatch', hint: `Expected focus ${this.currentFocusNodeId}, got ${params.focusNodeId}` };
    }

    // Validate all verdicts before committing (transactional)
    for (const v of params.verdicts) {
      if (v.verdict === 'trace') {
        if (!v.columnsOut?.length && this.targetColumns.length > 0) {
          return { error: 'missing_columns', hint: `Verdict "trace" for ${v.nodeId} requires columnsOut (column mode).` };
        }
        // Column validation (skip if no columns to validate or rejection cap reached)
        if (v.columnsOut?.length && this.rejectionsThisHop < MAX_REJECTIONS_PER_HOP) {
          const neighbor = this.nodeMap.get(v.nodeId);
          const neighborCols = this.getNodeColumns(v.nodeId);
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
            boundaryFlag: 'none', // Bug #2 fix: focus node is active, not a cycle
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
        this.removedSet.add(v.nodeId);
        this.outOfScope.push({ nodeId: v.nodeId, reason: v.summary ?? 'Pruned by AI' });
        this.log('debug', `Verdict: ${v.nodeId} = prune ("${v.summary ?? ''}")`);
        continue;
      }

      if (v.verdict === 'pass') {
        // Passthrough uses verdict columnsOut if provided, else inherits current active columns
        const passColumns = v.columnsOut?.length ? v.columnsOut : this.currentFocusActiveColumns;
        this.passthroughMap.set(v.nodeId, [...passColumns]);
        this.visited.add(v.nodeId); // Bug #1 fix: prevent re-encounter as neighbor of later focus
        if (boundary === 'none') {
          const delta = this.advanceFrontier(v.nodeId, passColumns, this.currentFocusDepth + 1); // Bug #3 fix: passthrough is +1 depth
          advanced += delta;
          this.log('debug', `Verdict: ${v.nodeId} = pass, columns=[${passColumns}] → queued ${delta} children`); // Bug #6 fix: log delta
        } else {
          this.log('debug', `Verdict: ${v.nodeId} = pass (boundary=${boundary}), columns=[${passColumns}] → terminal`);
        }
        continue;
      }

      // trace — push the node ITSELF to frontier as next focus hop (not its children)
      // Bug #4 fix: merge into existing chain entry for diamond/merge patterns instead of clobbering
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

    this._status = 'hopping'; // ready for next getHopContext()
    const relevant = params.verdicts.filter(v => v.verdict === 'trace').length;
    const removed = params.verdicts.filter(v => v.verdict === 'prune').length;
    const passthrough = params.verdicts.filter(v => v.verdict === 'pass').length;
    const pctDone = this.scopeSize > 0 ? Math.round((this.visited.size / this.scopeSize) * 100) : 0;
    this.log('info', `Verdicts: ${relevant} relevant, ${removed} removed, ${passthrough} passthrough | +${advanced} to frontier → ${this.frontier.length} remaining | visited ${this.visited.size}/${this.scopeSize} (${pctDone}%) | chain=${this.chain.size}`);
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
      return { error: `invalid_status: cannot get result in '${this._status}' state` };
    }
    if (this._status !== 'complete' && this.frontier.length > 0) {
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
      const idDdl = this.getNodeDdl(id);
      if (relevantIds.has(id) && SCRIPT_TYPES.has(node.type) && idDdl) {
        out.ddl = idDdl.length > this.maxDdlChars
          ? idDdl.slice(0, this.maxDdlChars) + `\n-- [truncated]`
          : idDdl;
      }
      const idCols = this.getNodeColumns(id);
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

  /** Estimate total DDL chars for all scriptable nodes in scope (for inline vs state machine decision). */
  estimateScopeDdlChars(): number {
    let total = 0;
    for (const nid of this.visited) {
      const node = this.nodeMap.get(nid);
      if (node && SCRIPT_TYPES.has(node.type)) {
        const ddl = this.getNodeDdl(nid);
        if (ddl) total += ddl.length;
      }
    }
    // Also include frontier nodes (not yet visited but in scope)
    for (const entry of this.frontier) {
      const node = this.nodeMap.get(entry.nodeId);
      if (node && SCRIPT_TYPES.has(node.type)) {
        const ddl = this.getNodeDdl(entry.nodeId);
        if (ddl) total += ddl.length;
      }
    }
    return total;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /** Get columns from ColumnStore (preferred) or inline node.columns (fallback for tests). */
  private getNodeColumns(nodeId: string): ColumnDef[] | undefined {
    return this.store?.getColumns(nodeId) ?? this.nodeMap.get(nodeId)?.columns;
  }

  /** Get DDL from ColumnStore (preferred) or inline node.bodyScript (fallback for tests). */
  private getNodeDdl(nodeId: string): string | undefined {
    return this.store?.getDdl(nodeId) ?? this.nodeMap.get(nodeId)?.bodyScript;
  }

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
    while (queue.length > 0) {
      const id = queue.shift()!;
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
