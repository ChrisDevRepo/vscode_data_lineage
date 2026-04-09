/**
 * Abstract base class for hop-by-hop state machines (BB, CT).
 *
 * Owns all shared state: scope, visited, removed, node/edge maps, two-tier memory.
 * Subclasses provide queue management (agenda vs frontier) and submission logic.
 *
 * Two-tier memory model (MemGPT-inspired):
 *   - Short memory: compressed narrative that grows each hop. Always fits context.
 *   - Detail memory: per-node analysis slots. Evictable under token pressure
 *     (oldest slots compress into short memory, freeing tokens for synthesis).
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
import { estimateTokens } from './tokenBudget';

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

/** Detail memory slot — per-node analysis stored during hops. */
export interface DetailSlot {
  nodeId: string;
  schema: string;
  name: string;
  type: string;
  analysis: string;       // AI's DDL findings (full text — never truncated)
  summary: string;        // one-line digest (AI's own compression)
  tags?: string[];
  badge_label?: string;   // semantic label for enrich_view badge
  note_caption?: string;  // 1-line caption for enrich_view note
}

/** Short memory — compressed narrative, always available. */
export interface ShortMemory {
  narrative: string[];                                     // key findings per hop
  coverage: { noted: number; total: number; pct: number };
  pending_questions: Array<{ nodeId: string; question: string }>;
}

/** Shared result shape returned by getResult(). Subclasses extend with SM-specific fields. */
export interface SmResult {
  status: 'complete';
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
 *
 * Both ColumnTraceState (CT) and BlackboardState (BB) satisfy this interface.
 * Callers that only need lifecycle checks (extension.ts phase logic) should
 * type against IHopStateMachine rather than the concrete subclass.
 *
 * Note: init(), getHopContext(), and the submission methods (submitVerdicts / submitFindings)
 * have SM-specific signatures and are NOT part of this shared interface.
 * Use the concrete subclass type for handlers that call those methods.
 */
export interface IHopStateMachine {
  readonly status: SmStatus;
  readonly slotCount: number;
  readonly coveragePct: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const BFS_SCOPE_CAP = 10_000;
const DEFAULT_FINDINGS_LIMIT = 5000;
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

  // ── Shared mutable state ──
  protected _status: SmStatus = 'created';
  protected originNodeId: string | null = null;
  protected scopeNodeIds = new Set<string>();
  protected visited = new Set<string>();
  protected removedSet = new Set<string>();
  protected currentFocusNodeId: string | null = null;
  protected hopCount = 0;

  // ── Two-tier memory ──
  protected shortMemory: ShortMemory = {
    narrative: [],
    coverage: { noted: 0, total: 0, pct: 0 },
    pending_questions: [],
  };
  protected detailSlots = new Map<string, DetailSlot>();

  constructor(
    model: DatabaseModel,
    graph: Graph,
    log: LogFn,
    config: {
      activeFilter?: SerializedFilterState | null;
      findingsHardLimit?: number;
      summaryHardLimit?: number;
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
  }

  // ── Public accessors ──

  get status(): SmStatus { return this._status; }
  get slotCount(): number { return this.detailSlots.size; }

  get coveragePct(): number {
    return this.scopeNodeIds.size > 0
      ? Math.round((this.detailSlots.size / this.scopeNodeIds.size) * 100)
      : 0;
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
    this.detailSlots.set(nodeId, {
      nodeId,
      schema: node.schema,
      name: node.name,
      type: node.type,
      analysis,
      summary,
      tags: meta?.tags,
      badge_label: meta?.badge_label,
      note_caption: meta?.note_caption,
    });
  }

  /**
   * Append a finding to short memory narrative.
   * Called after each hop to maintain the compressed thread.
   */
  updateShortMemory(hopSummary: string): void {
    this.shortMemory.narrative.push(hopSummary);
    this.shortMemory.coverage = {
      noted: this.detailSlots.size,
      total: this.scopeNodeIds.size,
      pct: this.coveragePct,
    };
  }

  /**
   * Check if detail memory exceeds budget.
   * Used by getResult() to decide presentation: full analysis vs summary-only for oldest slots.
   * The system stores everything — this only affects what we INCLUDE in the tool response.
   * No data is ever lost; the AI already analyzed DDL during each hop.
   */
  protected isDetailMemoryOverBudget(): boolean {
    const totalChars = [...this.detailSlots.values()]
      .reduce((sum, s) => sum + s.analysis.length + s.summary.length, 0);
    return estimateTokens(totalChars) > this.detailMemoryBudget;
  }

  /**
   * Get both memory tiers for the final result tool response.
   *
   * Presentation decision (not data loss):
   * - Under budget: all slots include full analysis text.
   * - Over budget: oldest slots are presented with summary only in the response.
   *   Full analysis is still stored in our state — the AI already saw it during hops.
   */
  getMemoryForSynthesis(): { short_memory: ShortMemory; detail_slots: DetailSlot[] } {
    this.shortMemory.coverage = {
      noted: this.detailSlots.size,
      total: this.scopeNodeIds.size,
      pct: this.coveragePct,
    };

    const allSlots = [...this.detailSlots.values()];

    if (!this.isDetailMemoryOverBudget()) {
      return { short_memory: { ...this.shortMemory }, detail_slots: allSlots };
    }

    // Over budget: present oldest slots as summary-only in the response.
    // This is a delivery-mode decision (like shouldInline for BFS),
    // not data loss — AI already analyzed DDL per hop.
    let runningTokens = 0;
    const presented: DetailSlot[] = [];
    // Reverse order: newest first (most relevant for synthesis)
    const reversed = [...allSlots].reverse();
    for (const slot of reversed) {
      const slotTokens = estimateTokens(slot.analysis.length + slot.summary.length);
      if (runningTokens + slotTokens <= this.detailMemoryBudget) {
        presented.unshift(slot); // keep full
        runningTokens += slotTokens;
      } else {
        // Summary-only presentation for oldest slots
        presented.unshift({ ...slot, analysis: slot.summary });
        runningTokens += estimateTokens(slot.summary.length * 2);
      }
    }

    this.log('info', `[Memory] Over budget — ${allSlots.length - presented.filter(s => s.analysis !== s.summary).length} slot(s) presented as summary-only`);
    return { short_memory: { ...this.shortMemory }, detail_slots: presented };
  }

  // ── Shared helpers (extracted from BB+CT duplication) ──

  /**
   * BFS scope computation — direction-aware, filter-respecting.
   * @param direction 'upstream' | 'downstream' | 'bidirectional'
   */
  protected bfsScope(startId: string, direction: 'upstream' | 'downstream' | 'bidirectional'): Set<string> {
    if (!this.graph.hasNode(startId)) return new Set([startId]);
    const seen = new Set<string>([startId]);
    const queue = [startId];
    let idx = 0;
    while (idx < queue.length) {
      const id = queue[idx++];
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
        queue.push(nid);
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
   * Includes columns always. DDL only if includeAnalysis is true and node is a script type.
   */
  protected buildFullNode(nodeId: string, role?: string): Record<string, unknown> {
    const node = this.nodeMap.get(nodeId);
    if (!node) return { id: nodeId };
    const base: Record<string, unknown> = {
      id: node.id, s: node.schema, n: node.name, t: node.type,
    };
    if (role) base.role = role;
    const cols = getNodeColumns(nodeId, this.nodeMap, this.store ?? undefined);
    if (cols?.length) {
      base.cols = cols.map(c => presentColumnCompact(c));
    }
    return strip(base) as Record<string, unknown>;
  }

  /**
   * Build shared result: fullNodes + edges + bridge injection + badges/notes + memory.
   * Subclasses call this and extend with SM-specific fields.
   */
  protected buildSharedResult(): SmResult {
    this._status = 'complete';

    const slots = [...this.detailSlots.values()];
    const slotIds = new Set(this.detailSlots.keys());

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

    // Attach both memory tiers
    const memory = this.getMemoryForSynthesis();

    this.log('info', `[Result] notes=${slots.length} | edges=${edges.length} | scope=${this.scopeNodeIds.size} | coverage=${this.coveragePct}% | hops=${this.hopCount}`);
    this.log('debug', `[Result] detail | fullNodes=${fullNodes.length} | bridges=${bridgeResult.bridgeNodes.length} | model_edges=${this.model.edges.length} | pruned=${this.removedSet.size} | visited=${this.visited.size}`);
    if (edges.length > 0) {
      this.log('trace', `[Result] EDGES | ${edges.map(([s, t, tp]) => `${s}→${t}(${tp})`).join(', ')}`);
    }

    return {
      status: 'complete',
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
    this.shortMemory = { narrative: [], coverage: { noted: 0, total: 0, pct: 0 }, pending_questions: [] };
    this.detailSlots.clear();
  }

  // ── Abstract methods — subclass-specific ──

  /** Return the scope direction for boundary detection. */
  protected abstract getScopeDirection(): 'upstream' | 'downstream' | 'bidirectional';
}

// Re-export types used by extension.ts
export type { LogFn } from './smGuards';
