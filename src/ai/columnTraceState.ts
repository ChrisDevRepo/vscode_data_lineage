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
import { buildNodeMap, buildEdgeTypeMap, buildUnrelatedMap, SCRIPT_TYPES, AI_CAPS } from './tools';
import { presentNode, presentColumn, strip, edgeApiType } from './aiPresenter';

// ─── Public types ──────────────────────────────────────────────────────────────

export type ColumnTraceDirection = 'up' | 'down' | 'both';
export type HopVerdict = 'relevant' | 'remove' | 'passthrough';
export type BoundaryFlag = 'none' | 'source' | 'sink' | 'external' | 'cycle';

export interface FrontierEntry {
  nodeId: string;
  activeColumns: string[];
  depth: number;
  parentNodeId: string | null;
}

export interface ChainEntry {
  nodeId: string;
  schema: string;
  name: string;
  type: string;
  columnsIn: string[];
  columnsOut: string[];
  summary: string;
  index?: string;
  boundaryFlag: BoundaryFlag;
}

export interface OutOfScopeEntry {
  nodeId: string;
  reason: string;
}

export interface ColumnTraceConfig {
  maxFrontierSize?: number;   // default 200
  maxDdlChars?: number;       // default AI_CAPS.MAX_DDL_CHARS
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
  cols?: Record<string, unknown>[];
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
  private visited = new Set<string>();
  private chain = new Map<string, ChainEntry>();
  private passthroughSet = new Set<string>();
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
    this.maxDdlChars = config?.maxDdlChars ?? AI_CAPS.MAX_DDL_CHARS;
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
    this.visited.clear();
    this.chain.clear();
    this.passthroughSet.clear();
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

    if (!targetColumns.length) {
      this._status = 'error';
      return { error: 'no_columns', hint: 'Provide at least one column name to trace.' };
    }

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
          hint: `${candidates.length} objects contain column "${targetColumns[0]}". Provide the origin object ID.`,
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
    ct_mode: 'hop_and_distill';
    hop: number;
    frontier_remaining: number;
    sub_question: string;
    path_so_far: Array<{ node_id: string; summary: string; columns_in: string[]; columns_out: string[] }>;
    focus_node: Record<string, unknown>;
    active_columns: string[];
    neighbors: HopNeighbor[];
    out_of_scope_so_far: OutOfScopeEntry[];
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
        this.log('debug', `Skipped visited node in frontier: ${candidate.nodeId}`);
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
      focusNode.cols = nodeCols.map(c => strip(presentColumn(c)));
    }

    // Attach unresolved refs
    const unrelKey = `${node.schema}.${node.name}`.toLowerCase();
    const unrel = this.unrelatedMap.get(unrelKey);
    if (unrel?.length) focusNode.unresolved_refs = unrel;

    // Build neighbor list
    const neighborIds = this.getDirectionalNeighbors(entry.nodeId);
    const neighbors: HopNeighbor[] = [];

    for (const nid of neighborIds) {
      const nNode = this.nodeMap.get(nid);
      if (!nNode) continue;

      const isUpstream = this.direction === 'up' || this.direction === 'both';
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
        neighbor.cols = nCols.map(c => strip(presentColumn(c)));
      }

      neighbors.push(neighbor);
    }

    // Build path summary (compact, from chain)
    const pathSoFar = [...this.chain.values()]
      .filter(e => e.nodeId !== this.originNodeId || e.columnsOut.length > 0)
      .map(e => ({
        node_id: e.nodeId,
        summary: e.summary,
        columns_in: e.columnsIn,
        columns_out: e.columnsOut,
      }));

    const subQuestion = `Analyze ${node.id} for columns [${entry.activeColumns.join(', ')}]. Which neighbors carry these columns?`;
    const pct = this.scopeSize > 0 ? Math.round((this.visited.size / this.scopeSize) * 100) : 0;
    this.log('info', `Hop ${this.hopCount} | ${node.id} | cols=[${entry.activeColumns}] | neighbors=${neighbors.length} | progress: ${this.visited.size}/${this.scopeSize} visited (${pct}%) | frontier=${this.frontier.length} | depth=${entry.depth}`);
    if (entry.depth >= 10) {
      this.log('warn', `Deep trace: depth=${entry.depth}, frontier=${this.frontier.length}, visited=${this.visited.size}/${this.scopeSize}`);
    }

    this._status = 'awaiting_verdicts';
    return {
      ct_mode: 'hop_and_distill',
      hop: this.hopCount,
      frontier_remaining: this.frontier.length,
      sub_question: subQuestion,
      path_so_far: pathSoFar,
      focus_node: strip(focusNode) as Record<string, unknown>,
      active_columns: entry.activeColumns,
      neighbors,
      out_of_scope_so_far: this.outOfScope,
    };
  }

  // ─── submitVerdicts ────────────────────────────────────────────────────────

  submitVerdicts(params: {
    focusNodeId: string;
    verdicts: Array<{
      nodeId: string;
      verdict: HopVerdict;
      columnsOut?: string[];
      summary?: string;
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
      if (v.verdict === 'relevant') {
        if (!v.columnsOut?.length) {
          return { error: 'missing_columns', hint: `Verdict "relevant" for ${v.nodeId} requires columnsOut.` };
        }
        // Column validation (skip if rejection cap reached)
        if (this.rejectionsThisHop < MAX_REJECTIONS_PER_HOP) {
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
    let advanced = 0;
    for (const v of params.verdicts) {
      const boundary = this.detectBoundary(v.nodeId);
      const neighbor = this.nodeMap.get(v.nodeId);

      if (v.verdict === 'remove') {
        this.removedSet.add(v.nodeId);
        this.outOfScope.push({ nodeId: v.nodeId, reason: v.summary ?? 'Removed by AI' });
        this.log('debug', `Verdict: ${v.nodeId} = remove ("${v.summary ?? ''}")`);
        continue;
      }

      if (v.verdict === 'passthrough') {
        this.passthroughSet.add(v.nodeId);
        // Passthrough uses verdict columnsOut if provided, else inherits current active columns
        const passColumns = v.columnsOut?.length ? v.columnsOut : this.currentFocusActiveColumns;
        this.log('debug', `Verdict: ${v.nodeId} = passthrough, columns=[${passColumns}]`);
        if (boundary === 'none') {
          advanced += this.advanceFrontier(v.nodeId, passColumns, this.currentFocusDepth);
        }
        continue;
      }

      // relevant
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
      this.log('debug', `Verdict: ${v.nodeId} = relevant, trace columns [${v.columnsOut}]`);

      // Advance frontier if not a terminal boundary
      if (boundary === 'none') {
        advanced += this.advanceFrontier(v.nodeId, v.columnsOut ?? [], this.currentFocusDepth);
      }
    }

    this._status = 'hopping'; // ready for next getHopContext()
    const relevant = params.verdicts.filter(v => v.verdict === 'relevant').length;
    const removed = params.verdicts.filter(v => v.verdict === 'remove').length;
    const passthrough = params.verdicts.filter(v => v.verdict === 'passthrough').length;
    const pctDone = this.scopeSize > 0 ? Math.round((this.visited.size / this.scopeSize) * 100) : 0;
    this.log('info', `Verdicts: ${relevant} relevant, ${removed} removed, ${passthrough} passthrough | +${advanced} to frontier → ${this.frontier.length} remaining | visited ${this.visited.size}/${this.scopeSize} (${pctDone}%) | chain=${this.chain.size}`);
    return { ok: true, advanced, frontierSize: this.frontier.length };
  }

  // ─── getResult ─────────────────────────────────────────────────────────────

  getResult(): {
    status: 'complete';
    chain: ChainEntry[];
    fullNodes: Record<string, unknown>[];
    edges: [string, string, string][];
    outOfScope: OutOfScopeEntry[];
    stats: { hops: number; examined: number; relevant: number; removed: number; passthrough: number };
    columnFlow: string;
  } | { error: string; hint?: string } {

    if (this._status === 'created' || this._status === 'error' || this._status === 'awaiting_verdicts') {
      return { error: `invalid_status: cannot get result in '${this._status}' state` };
    }
    if (this._status !== 'complete' && this.frontier.length > 0) {
      return { error: 'frontier_not_empty', hint: `${this.frontier.length} entries remain. Call getHopContext/submitVerdicts until done.` };
    }

    // Build chain array (Map insertion order = BFS order)
    const chainArr = [...this.chain.values()];
    for (let i = 0; i < chainArr.length; i++) {
      chainArr[i].index = `${i + 1}/${chainArr.length}`;
    }

    // Build fullNodes: DDL for relevant, columns for passthrough
    const relevantIds = new Set(this.chain.keys());
    const allIds = new Set([...relevantIds, ...this.passthroughSet]);
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

    // Build column flow string
    const columnFlow = chainArr
      .map(e => e.columnsIn.length > 0
        ? `${e.name}(${e.columnsIn.join(',')})`
        : `${e.name}`)
      .join(' ← ');

    const stats = {
      hops: this.hopCount,
      examined: this.visited.size,
      relevant: this.chain.size,
      removed: this.removedSet.size,
      passthrough: this.passthroughSet.size,
    };

    const pruneRate = this.scopeSize > 0 ? Math.round(((this.scopeSize - stats.examined) / this.scopeSize) * 100) : 0;
    this.log('info', `COMPLETE | ${stats.hops} hops | examined ${stats.examined}/${this.scopeSize} (${pruneRate}% pruned) | chain=${stats.relevant} relevant + ${stats.passthrough} passthrough | ${stats.removed} removed`);

    return { status: 'complete', chain: chainArr, fullNodes, edges, outOfScope: this.outOfScope, stats, columnFlow };
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
      if (this.visited.has(nid) || this.removedSet.has(nid)) continue;
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
