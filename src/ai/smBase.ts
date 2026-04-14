/**
 * Abstract base class for hop-by-hop state machines (BB, CT).
 *
 * Owns all shared state: scope, visited, removed, node/edge maps, two-tier memory.
 * Subclasses provide queue management (agenda vs frontier) and submission logic.
 *
 * Two-tier memory model (MemGPT-inspired):
 *   - Short memory: incremental index — grows each hop, tracks what was loaded/found.
 *   - Detail memory: per-node analysis slots — grounded evidence, always delivered
 *     at full fidelity. SM is a data provider, never evicts or degrades evidence.
 *
 * Zero VS Code imports — pure logic for testability.
 */

import type Graph from 'graphology';
import type { DatabaseModel, LineageNode, ObjectType } from '../engine/types';
import type { ColumnStore } from '../engine/columnStore';
import type { SerializedFilterState } from '../engine/projectStore';
import { buildNodeMap, buildEdgeTypeMap, buildUnrelatedMap, SCRIPT_TYPES, getNodeColumns, getNodeDdl, buildHopFocusNode } from './tools';
import { presentColumnCompact, presentFkCompact, strip, edgeApiType } from './aiPresenter';
import { findBridgeNodes, bfsDepthMap, type LogFn } from './smGuards';
import { AiMemoryManager, type DetailSlot, type ShortMemory, type WorkingMemory } from './memoryManager';


// ─── Types ──────────────────────────────────────────────────────────────────

export type SmStatus = 'created' | 'initialized' | 'active' | 'awaiting' | 'complete' | 'error'
                      | 'exploring' | 'awaiting_findings'    // BB-specific
                      | 'hopping' | 'awaiting_verdicts';     // CT-specific

export type BoundaryFlag = 'none' | 'source' | 'sink' | 'external' | 'cycle';

export interface HopNeighbor {
  id: string;
  s: string;   // schema
  n: string;   // name
  t: string;   // type
  edge_direction: 'upstream' | 'downstream';
  edge_type: string;
  boundary: BoundaryFlag;
  boundary_reason?: string;
  scope?: 'in_scope' | 'available' | 'pruned' | 'external' | 'visited';
  in_filter?: boolean;
  cols?: string[];
  fks?: string[];
  hasDdl: boolean;
}

/** Base working memory — shared by BB and CT during hops. Subclasses extend with SM-specific fields. */
export interface BaseWorkingMemory extends WorkingMemory {
  // WorkingMemory provides all_summaries, pending_questions, and checklist
}

/** Shared result shape returned by getResult(). Subclasses extend with SM-specific fields. */
export interface SmResult {
  status: 'complete';
  progress_line: string;
  originNodeId: string;
  fullNodes: Array<Record<string, unknown>>;
  edges: Array<[string, string, string]>;
  suggested_labels: Array<{ node_id: string; text: string }>;
  suggested_notes: Array<{ node_id: string; text: string }>;
  suggested_sections: Array<{ label: string; node_ids: string[] }>;
  short_memory: ShortMemory;
  detail_slots: DetailSlot[];
  stats: Record<string, number>;
}

/**
 * Public caller contract for hop-by-hop state machines.
 */
export interface IHopStateMachine {
  readonly status: SmStatus;
  readonly slotCount: number;
  readonly coveragePct: number;
  readonly inlineMode: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const BFS_SCOPE_CAP = 10_000;
const DEFAULT_FINDINGS_LIMIT = 8000;
const DEFAULT_SUMMARY_LIMIT = 500;

// ─── Abstract Base ──────────────────────────────────────────────────────────

export abstract class HopStateMachine implements IHopStateMachine {

  // ── Shared readonly state ──
  protected readonly model: DatabaseModel;
  protected readonly graph: Graph;
  protected readonly store: ColumnStore | null;
  protected readonly log: LogFn;
  protected readonly nodeMap: Map<string, LineageNode>;
  protected readonly edgeTypeMap: Map<string, string>;
  protected readonly unrelatedMap: Map<string, string[]>;
  protected readonly activeFilter: SerializedFilterState | null;
  protected readonly filterSchemas: Set<string> | null;
  protected readonly findingsHardLimit: number;
  protected readonly summaryHardLimit: number;
  protected readonly memory: AiMemoryManager;

  // ── Shared mutable state ──
  protected _status: SmStatus = 'created';
  protected _inlineMode = false;
  protected originNodeId: string | null = null;
  protected scopeNodeIds = new Set<string>();
  protected visited = new Set<string>();
  protected removedSet = new Set<string>();
  protected currentFocusNodeId: string | null = null;
  protected hopCount = 0;
  protected lastProgressLine = '';

  constructor(
    model: DatabaseModel,
    graph: Graph,
    log: LogFn,
    config: {
      activeFilter?: SerializedFilterState | null;
      findingsHardLimit?: number;
      summaryHardLimit?: number;
      memory?: AiMemoryManager;
    },
    store?: ColumnStore | null,
  ) {
    this.model = model;
    this.graph = graph;
    this.store = store ?? null;
    this.log = log;
    this.activeFilter = config.activeFilter ?? null;
    this.filterSchemas = this.activeFilter?.schemas?.length
      ? new Set(this.activeFilter.schemas.map(s => s.toLowerCase()))
      : null;
    this.findingsHardLimit = config.findingsHardLimit ?? DEFAULT_FINDINGS_LIMIT;
    this.summaryHardLimit = config.summaryHardLimit ?? DEFAULT_SUMMARY_LIMIT;
    this.nodeMap = buildNodeMap(model);
    this.edgeTypeMap = buildEdgeTypeMap(model);
    this.unrelatedMap = buildUnrelatedMap(model);
    
    // Use injected memory manager or create a fresh one (fallback for tests)
    this.memory = config.memory ?? new AiMemoryManager();
  }

  // ── Public accessors ──

  get status(): SmStatus { return this._status; }
  get slotCount(): number { return this.memory.slotCount; }
  get inlineMode(): boolean { return this._inlineMode; }

  get hopNumber(): number { return this.hopCount; }
  get visitedCount(): number { return this.visited.size; }
  get scopeSize(): number { return this.scopeNodeIds.size; }

  get coveragePct(): number {
    return this.scopeNodeIds.size > 0
      ? Math.round((this.memory.slotCount / this.scopeNodeIds.size) * 100)
      : 0;
  }

  /** Enable inline mode — AI gets all DDL upfront, memory overhead skipped. */
  setInlineMode(value: boolean): void {
    this._inlineMode = value;
    if (value) this.log('info', 'Inline mode enabled — memory storage skipped');
  }

  /** Return all scope nodes with DDL for inline delivery. */
  getAllScopeNodesWithDdl(): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    for (const id of this.scopeNodeIds) {
      const node = this.nodeMap.get(id);
      if (!node) continue;
      const ddl = getNodeDdl(id, this.nodeMap, this.store ?? undefined);
      result.push({
        id: node.id, s: node.schema, n: node.name, t: node.type,
        ...(ddl && { ddl }),
        ...(node.columns && { columns: node.columns }),
      });
    }
    return result;
  }

  // ── Two-tier memory management ──

  /**
   * Store a detail memory slot for a node.
   * Called by subclass submission handlers after the AI provides findings.
   */
  storeDetail(
    nodeId: string,
    analysis: string,
    summary: string,
    meta?: { tags?: string[]; badge_label?: string; note_caption?: string },
  ): void {
    const node = this.nodeMap.get(nodeId);
    if (!node) return;
    this.memory.storeDetail(node, analysis, summary, meta, this._inlineMode);
  }

  /**
   * Append a finding to short memory narrative.
   */
  updateShortMemory(hopSummary: string): string | null {
    if (this._inlineMode) return null;
    return this.memory.addNarrative(hopSummary, {
      noted: this.memory.slotCount,
      total: this.scopeNodeIds.size
    });
  }

  /**
   * Build a one-line progress summary after each successful submission.
   */
  protected buildProgressLine(
    nodeName: string,
    verdict: string,
    prunedCount: number,
    addedCount: number,
  ): void {
    let scopeChange = '';
    if (prunedCount > 0) scopeChange = ` · pruned ${prunedCount}`;
    if (addedCount > 0) scopeChange = ` · added ${addedCount}`;
    this.lastProgressLine = `Hop ${this.hopCount} · ${nodeName} → ${verdict}${scopeChange}`;
  }

  /** Build completion progress line. */
  protected buildCompletionLine(): void {
    this.lastProgressLine = `Complete · ${this.visited.size} nodes analyzed · ${this.coveragePct}% coverage`;
  }

  /**
   * Get both memory tiers for the final result tool response.
   */
  getMemoryForSynthesis(): { short_memory: ShortMemory; detail_slots: DetailSlot[] } {
    return this.memory.getResult();
  }

  /**
   * Build base working memory — shared core fields for both BB and CT during hops.
   */
  protected buildBaseWorkingMemory(): BaseWorkingMemory {
    const work = this.memory.getWorkingMemory(this.hopCount, this.scopeNodeIds.size);
    return { ...work };
  }

  // ── Shared helpers (extracted from BB+CT duplication) ──

  /**
   * BFS scope computation — direction-aware, filter-respecting, depth-limited.
   * @param direction 'upstream' | 'downstream' | 'bidirectional'
   * @param maxDepth Maximum BFS depth from startId (undefined = unlimited)
   */
  protected bfsScope(startId: string, direction: 'upstream' | 'downstream' | 'bidirectional', maxDepth?: number): Set<string> {
    if (!this.graph.hasNode(startId)) return new Set([startId]);
    const seen = new Set<string>([startId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
    let idx = 0;
    while (idx < queue.length) {
      const { id, depth } = queue[idx++];
      if (maxDepth !== undefined && depth >= maxDepth) continue;
      const neighbors =
        direction === 'upstream'   ? this.graph.inNeighbors(id) :
        direction === 'downstream' ? this.graph.outNeighbors(id) :
                                     this.graph.neighbors(id);
      for (const nid of neighbors) {
        if (seen.has(nid)) continue;
        if (this.filterSchemas) {
          const schema = (this.nodeMap.get(nid)?.schema ?? '').toLowerCase();
          if (!this.filterSchemas.has(schema)) continue;
        }
        seen.add(nid);
        queue.push({ id: nid, depth: depth + 1 });
        if (seen.size >= BFS_SCOPE_CAP) return seen;
      }
    }
    return seen;
  }

  /** Detect boundary condition for a node. */
  protected detectBoundary(nodeId: string, direction: 'upstream' | 'downstream' | 'bidirectional' = 'bidirectional'): BoundaryFlag {
    const node = this.nodeMap.get(nodeId);
    if (!node) return 'external';
    if (node.type === 'external') return 'external';
    if (this.visited.has(nodeId)) return 'cycle';
    if (!this.graph.hasNode(nodeId)) return 'external';
    // Direction-aware source/sink detection
    if (direction !== 'downstream' && this.graph.inDegree(nodeId) === 0) return 'source';
    if (direction !== 'upstream' && this.graph.outDegree(nodeId) === 0) return 'sink';
    return 'none';
  }

  /** Human-readable boundary reason. */
  protected boundaryReason(flag: BoundaryFlag, node: LineageNode): string {
    switch (flag) {
      case 'source': return 'No upstream dependencies — source boundary';
      case 'sink': return 'No downstream consumers — sink boundary';
      case 'external': return `External reference (${node.externalType ?? 'unknown'}) — no DDL available`;
      case 'cycle': return 'Already visited — cycle detected';
      default: return '';
    }
  }

  /**
   * Build enriched neighbor list for a focus node.
   * Subclasses can override to add scope/filter info (BB) or direction filtering (CT).
   */
  protected buildNeighborList(focusId: string, neighborIds: string[], inSet: Set<string>): HopNeighbor[] {
    const neighbors: HopNeighbor[] = [];

    for (const nid of neighborIds) {
      const nNode = this.nodeMap.get(nid);
      if (!nNode) continue;

      const isUpstream = inSet.has(nid);
      const primaryKey = isUpstream ? `${nid}→${focusId}` : `${focusId}→${nid}`;
      const reverseKey = isUpstream ? `${focusId}→${nid}` : `${nid}→${focusId}`;
      const edgeType = this.edgeTypeMap.get(primaryKey) ?? this.edgeTypeMap.get(reverseKey) ?? 'read';

      const boundary = this.detectBoundary(nid, this.getScopeDirection());

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
      if (nNode.fks?.length) {
        neighbor.fks = nNode.fks.map(fk => presentFkCompact(fk));
      }

      neighbors.push(neighbor);
    }

    return neighbors;
  }

  /**
   * Build a fullNode record for result assembly.
   * Inline mode: includes columns (and DDL for script types) — AI has no detail memory.
   * Hop-by-hop mode: metadata only {id, s, n, t, role} — detail_slots are the primary evidence.
   */
  protected buildFullNode(nodeId: string, role?: string): Record<string, unknown> {
    const node = this.nodeMap.get(nodeId);
    if (!node) return { id: nodeId };
    const base: Record<string, unknown> = {
      id: node.id, s: node.schema, n: node.name, t: node.type,
    };
    if (role) base.role = role;
    if (this._inlineMode) {
      const ddl = getNodeDdl(nodeId, this.nodeMap, this.store ?? undefined);
      if (SCRIPT_TYPES.has(node.type) && ddl) {
        base.ddl = ddl;
      }
      const cols = getNodeColumns(nodeId, this.nodeMap, this.store ?? undefined);
      if (cols?.length) {
        base.cols = cols.map(c => presentColumnCompact(c));
      }
    }
    return strip(base) as Record<string, unknown>;
  }

  /**
   * Build shared result: fullNodes + edges + bridge injection + badges/notes + memory.
   * Subclasses call this and extend with SM-specific fields.
   */
  protected buildSharedResult(): SmResult {
    this._status = 'complete';

    const memory = this.memory.getResult();
    const slots = memory.detail_slots;
    const slotIds = new Set(slots.map(s => s.nodeId));

    // Anchored IDs = detail slots + origin (ensures hub/star edges include SP→origin)
    const anchoredIds = new Set([...slotIds, this.originNodeId!]);

    // Build fullNodes: origin first, then detail slot nodes
    const fullNodes: Array<Record<string, unknown>> = [];
    if (this.originNodeId && !slotIds.has(this.originNodeId)) {
      fullNodes.push(this.buildFullNode(this.originNodeId, 'origin'));
    }
    for (const slot of slots) {
      fullNodes.push(this.buildFullNode(slot.nodeId));
    }

    // Edges between anchored nodes
    const edges: Array<[string, string, string]> = [];
    for (const e of this.model.edges) {
      if (anchoredIds.has(e.source) && anchoredIds.has(e.target)) {
        edges.push([e.source, e.target, edgeApiType(e.type)]);
      }
    }

    // Bridge injection: reconnect orphan nodes via shortest path
    const bridgeResult = findBridgeNodes(this.graph, anchoredIds, edges, this.edgeTypeMap);
    if (bridgeResult.bridgeNodes.length > 0) {
      for (const bn of bridgeResult.bridgeNodes) {
        fullNodes.push(strip({ id: bn.id, s: bn.schema, n: bn.name, t: bn.type, role: 'bridge' }) as Record<string, unknown>);
      }
      edges.push(...bridgeResult.bridgeEdges);
      this.log('info', `[Bridge] orphans=${bridgeResult.orphanCount} | reconnected=${bridgeResult.reconnectedCount} | bridges=${bridgeResult.bridgeNodes.length} nodes, ${bridgeResult.bridgeEdges.length} edges`);
    }

    // Order slots by BFS depth from origin for suggested labels/notes
    const depthMap = bfsDepthMap(edges, this.originNodeId!);
    const orderedSlots = [...slots].sort(
      (a, b) => (depthMap.get(a.nodeId) ?? Infinity) - (depthMap.get(b.nodeId) ?? Infinity),
    );

    // Strip leading numbers from badge_label — system assigns via orderAndAssemble()
    const BADGE_NUMBER_PREFIX_RE = /^\d+[\.\s]+/;
    const stripNum = (s: string) => s.replace(BADGE_NUMBER_PREFIX_RE, '').trim();
    const suggested_labels = orderedSlots.map(s => ({
      node_id: s.nodeId,
      text: s.badge_label ? stripNum(s.badge_label) : s.name,
    }));
    const suggested_notes = orderedSlots.map(s => ({
      node_id: s.nodeId,
      text: s.note_caption ?? s.summary,
    }));

    // Group per-node labels into sections by shared badge_label, depth-ordered.
    // Nodes without badge_label are passthrough — excluded from sections.
    const sectionMap = new Map<string, string[]>();
    const sectionOrder: string[] = [];
    for (const slot of orderedSlots) {
      const label = slot.badge_label ? stripNum(slot.badge_label) : undefined;
      if (!label) continue;
      if (!sectionMap.has(label)) {
        sectionMap.set(label, []);
        sectionOrder.push(label);
      }
      sectionMap.get(label)!.push(slot.nodeId);
    }
    const suggested_sections = sectionOrder.map(label => ({
      label,
      node_ids: sectionMap.get(label)!,
    }));

    this.log('info', `[Result] notes=${slots.length} | edges=${edges.length} | scope=${this.scopeNodeIds.size} | coverage=${this.coveragePct}% | hops=${this.hopCount}`);
    if (edges.length > 0) {
      this.log('trace', `[Result] EDGES | ${edges.map(([s, t, tp]) => `${s}→${t}(${tp})`).join(', ')}`);
    }

    this.buildCompletionLine();

    return {
      status: 'complete',
      progress_line: this.lastProgressLine,
      originNodeId: this.originNodeId!,
      fullNodes,
      edges,
      suggested_labels,
      suggested_notes,
      suggested_sections,
      short_memory: memory.short_memory,
      detail_slots: memory.detail_slots,
      stats: {
        hops: this.hopCount,
        noted: slots.length,
        scopeSize: this.scopeNodeIds.size,
        coveragePct: this.coveragePct,
      },
    };
  }

  /** Check if a node is within the active filter. */
  isInFilter(nodeId: string): boolean {
    if (!this.filterSchemas) return true;
    const node = this.nodeMap.get(nodeId);
    if (!node) return false;
    return this.filterSchemas.has(node.schema.toLowerCase());
  }

  /** Estimate total DDL chars across scope (for token budget decisions). */
  estimateScopeDdlChars(): number {
    let total = 0;
    for (const id of this.scopeNodeIds) {
      const ddl = getNodeDdl(id, this.nodeMap, this.store ?? undefined);
      if (ddl) total += ddl.length;
    }
    return total;
  }

  /** Validate findings/summary length against hard limits. Returns error string or null. */
  protected validateSubmissionSize(findings: string, summary: string): string | null {
    if (findings.length > this.findingsHardLimit) {
      return `findings_too_long: ${findings.length} > ${this.findingsHardLimit}`;
    }
    if (summary.length > this.summaryHardLimit) {
      return `summary_too_long: ${summary.length} > ${this.summaryHardLimit}`;
    }
    return null;
  }

  /** Reset shared mutable state — called by subclass init(). */
  protected resetSharedState(): void {
    this._status = 'created';
    this.originNodeId = null;
    this.scopeNodeIds.clear();
    this.visited.clear();
    this.removedSet.clear();
    this.currentFocusNodeId = null;
    this.hopCount = 0;
    this.memory.reset();
  }

  // ── Lifecycle ──

  /** Force SM to complete state — used when session ends before natural completion (round/token exhaustion).
   *  Allows getResult() to extract partial results for enrich_view and "Show in Graph" button.
   *  All SM types inherit this — unified OOP concept. */
  forceComplete(): void {
    if (this._status !== 'created') {
      this.log('info', `Force complete: ${this._status} → complete`);
      this._status = 'complete';
    }
  }

  // ── State dump ──

  /** Serialize full SM state to a plain object — shared foundation for dump command and eval reports. */
  toJSON(): Record<string, unknown> {
    const memory = this.memory.getResult();
    return {
      type: this.constructor.name,
      status: this._status,
      originNodeId: this.originNodeId,
      inlineMode: this._inlineMode,
      hopCount: this.hopCount,
      scopeSize: this.scopeNodeIds.size,
      visitedCount: this.visited.size,
      removedCount: this.removedSet.size,
      currentFocusNodeId: this.currentFocusNodeId,
      lastProgressLine: this.lastProgressLine,
      shortMemory: {
        narrative: [...memory.short_memory.narrative],
        coverage: { ...memory.short_memory.coverage },
        pending_questions: memory.short_memory.pending_questions.map(q => ({ ...q })),
      },
      detailSlots: Object.fromEntries(
        memory.detail_slots.map(s => [s.nodeId, { ...s }])
      ),
      scopeNodeIds: [...this.scopeNodeIds],
      visited: [...this.visited],
      removedSet: [...this.removedSet],
    };
  }

  // ── Abstract methods — subclass-specific ──

  /** Return the scope direction for boundary detection. */
  protected abstract getScopeDirection(): 'upstream' | 'downstream' | 'bidirectional';
}

// Re-export types used by extension.ts
export type { LogFn } from './smGuards';
