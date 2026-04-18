/**
 * Unified Navigation Engine — The core state machine for all exploration modes.
 * 
 * Consolidates Blackboard, Dependency, and Column Trace into a single grounded engine.
 * Implements a "Map & Router" architecture with:
 * - Topological Map: Managed by the engine (Visited, Current, Agenda).
 * - Navigation Path: Origin -> ... -> Current Focus for grounding.
 * - Incremental Blackboard: A dense narrative of insights updated by the AI.
 * - Selection-Inference Validation: Rejects hallucinations before the next hop.
 */

import type Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path/unweighted';
import { bfsFromNode } from 'graphology-traversal';
import type { DatabaseModel, LineageNode } from '../engine/types';
import type { ColumnStore } from '../engine/columnStore';
import type { SerializedFilterState } from '../engine/projectStore';
import { buildNodeMap, buildEdgeTypeMap, getNodeColumns, getNodeDdl, buildHopFocusNode } from './tools';
import { edgeApiType } from './aiPresenter';
import { findBridgeNodes, bfsDepthMap, wouldOrphanNotedNode, bfsReachable, countCascadeIfPruned, type LogFn } from './smGuards';
import { AiMemoryManager, type WorkingMemory } from './memoryManager';
import type { HopContext, HopNeighbor, HopSubmission, SmMode, SmResult, SmStatus, SubmitResult } from './smTypes';

// Re-export scalar types for callers that still import them from smBase
export type { SmMode, SmStatus, HopNeighbor, HopContext, HopSubmission, SmResult, SubmitResult } from './smTypes';
export type { BoundaryFlag } from './smTypes';


/**
 * Represents an entry in the navigation agenda.
 *
 * @remarks
 * The agenda tracks nodes that are scheduled for investigation. Each entry is grounded
 * with a specific question or reason for the visit, ensuring that the AI's traversal
 * remains focused on the user's original query.
 */
export interface AgendaEntry {
  /** The unique identifier of the node to visit. */
  nodeId: string;
  /** The grounded reason or sub-question driving this visit. */
  question: string;
  /**
   * The priority of this visit.
   * - 0: Default BFS discovery.
   * - 2: AI-requested detour.
   * - 3: Origin/Root node (highest).
   */
  priority: number;
  /** The topological depth relative to the origin node. */
  depth: number;
  /** Specific columns of interest for this node (primarily used in Column Trace mode). */
  activeColumns?: string[];
}

/**
 * Extends the base working memory with topological map data.
 *
 * @remarks
 * This interface provides the AI with a snapshot of the current navigation state,
 * including where it has been, where it is now, and what remains on the agenda.
 * This "map" is essential for grounding the AI's routing decisions.
 */
export interface NavigationWorkingMemory extends WorkingMemory {
  /** The current topological state of the exploration. */
  topological_map: {
    /** A human-readable path string showing the traversal (e.g., "Origin -> ... -> Focus"). */
    navigation_path: string;
    /** List of node IDs that have already been visited and analyzed. */
    visited_nodes: string[];
    /** The node ID currently under investigation. */
    current_focus: string;
    /** The current queue of nodes scheduled for future hops. */
    agenda: Array<{ id: string; name: string; question: string }>;
  };
}


/**
 * Unified Navigation Engine — The core state machine for all exploration modes.
 *
 * @remarks
 * This engine consolidates Blackboard, Dependency, and Column Trace modes into a single
 * grounded traversal logic. It implements a "Map & Router" architecture where the engine
 * maintains the topological map and the AI acts as the router.
 *
 * Key features:
 * - **Topological Map**: Tracks visited nodes, the current focus, and the agenda.
 * - **Navigation Path**: Maintains grounding by showing the path from the origin.
 * - **Selection-Inference Validation**: Rejects hallucinations by verifying AI route requests against the actual graph.
 * - **Cascade Pruning**: Automatically removes unreachable branches if a node is marked as irrelevant.
 */
export class NavigationEngine implements IHopStateMachine {

  protected readonly model: DatabaseModel;
  protected readonly graph: Graph;
  protected readonly store: ColumnStore | null;
  protected readonly log: LogFn;
  protected readonly nodeMap: Map<string, LineageNode>;
  protected readonly edgeTypeMap: Map<string, string>;
  protected readonly memory: AiMemoryManager;
  /** The active exploration mode (e.g., 'blackboard', 'column_trace'). */
  public readonly mode: SmMode;

  /** Optional session identifier for tracking logs across rounds. */
  public sessionId?: string;
  protected _status: SmStatus = 'created';
  protected _inlineMode = false;
  protected originNodeId: string | null = null;
  protected scopeNodeIds = new Set<string>();
  protected visited = new Set<string>();
  protected removedSet = new Set<string>();
  protected agenda: AgendaEntry[] = [];
  protected agendaIds = new Set<string>();
  protected currentFocusNodeId: string | null = null;
  protected hopCount = 0;
  /** Depth of each in-scope node from origin (BFS distance). Populated during computeBfsScope. */
  protected depthFromOrigin = new Map<string, number>();
  /** User-specified depth budget (from start_exploration.depth). null when unset (default 5 was used). */
  protected depthBudget: number | null = null;
  /** How strictly to enforce the depth budget. 'silent' is default; 'soft' surfaces awareness; 'strict' rejects out-of-scope routes. */
  protected depthEnforcement: 'strict' | 'soft' | 'silent' = 'silent';
  /** Record of out-of-budget routes the AI chose to expand into — surfaced next hop only in 'soft' mode. */
  protected budgetExpansions: Array<{ nodeId: string; depth: number; atHop: number }> = [];

  /**
   * Initializes a new NavigationEngine.
   *
   * @param model - The database model containing nodes and edges.
   * @param graph - The graphology instance for topological operations.
   * @param log - A logging function for tracing engine activity.
   * @param mode - The exploration mode to use.
   * @param config - Configuration including optional filters and an existing memory manager.
   * @param store - Optional column store for deep column-level metadata.
   */
  protected qualityGuards = true;

  constructor(
    model: DatabaseModel,
    graph: Graph,
    log: LogFn,
    mode: SmMode,
    config: {
      activeFilter?: SerializedFilterState | null;
      memory?: AiMemoryManager;
      /** When false, skip the detail-length and premature-complete quality guards. Tests set this
       *  to false so short fixture strings don't trigger production guards. Default: true. */
      qualityGuards?: boolean;
    },
    store?: ColumnStore | null,
  ) {
    this.model = model;
    this.graph = graph;
    this.log = log;
    this.mode = mode;
    this.store = store ?? null;
    this.nodeMap = buildNodeMap(model);
    this.edgeTypeMap = buildEdgeTypeMap(model);
    this.memory = config.memory ?? new AiMemoryManager();
    if (config.qualityGuards === false) this.qualityGuards = false;
  }

  get status(): SmStatus { return this._status; }
  get scopeSize(): number { return this.scopeNodeIds.size; }
  get coveragePct(): number {
    return this.scopeNodeIds.size > 0 ? Math.round((this.memory.slotCount / this.scopeNodeIds.size) * 100) : 0;
  }
  get inlineMode(): boolean { return this._inlineMode; }
  setInlineMode(val: boolean) { this._inlineMode = val; }

  init(params: {
    question: string;
    origin: string;
    targetColumns?: string[];
    direction?: 'upstream' | 'downstream' | 'bidirectional';
    depth?: number;
    depth_enforcement?: 'strict' | 'soft' | 'silent';
  }): any {
    this.visited.clear();
    this.agenda = [];
    this.agendaIds.clear();
    this.memory.reset();
    this.memory.setUserQuestion(params.question);

    const originNode = this.nodeMap.get(params.origin.toLowerCase());
    if (!originNode) {
      return {
        error: 'origin_not_found',
        hint: 'Verify the origin node id with search_objects or get_context first. Use the exact id returned by those tools (case-insensitive match against the loaded graph).',
      } as any;
    }

    this.originNodeId = originNode.id;
    this.depthBudget = typeof params.depth === 'number' ? params.depth : null;
    this.depthEnforcement = params.depth_enforcement ?? 'silent';
    this.budgetExpansions = [];
    this.scopeNodeIds = this.computeBfsScope(originNode.id, params.direction || 'bidirectional', params.depth || 5);

    this.agenda.push({
      nodeId: originNode.id,
      question: `Root Question: ${params.question}`,
      priority: 3,
      depth: 0,
      activeColumns: params.targetColumns
    });
    this.agendaIds.add(originNode.id);

    this.seedAgenda(originNode.id, params.direction || 'bidirectional', params.targetColumns);
    this._status = 'initialized';

    return {
      ok: true,
      scopeSize: this.scopeNodeIds.size,
      agendaSize: this.agenda.length,
    };
  }

  getHopContext(): HopContext {
    let entry: AgendaEntry | undefined;
    while (this.agenda.length > 0) {
      const nextIdx = this.agenda.reduce((best, curr, i, arr) => curr.priority > arr[best].priority ? i : best, 0);
      const candidate = this.agenda.splice(nextIdx, 1)[0];
      this.agendaIds.delete(candidate.nodeId);

      if (!this.visited.has(candidate.nodeId)) {
        entry = candidate;
        break;
      }
    }

    if (!entry) {
      this._status = 'complete';
      return { done: true };
    }

    this.visited.add(entry.nodeId);
    this.hopCount++;
    this.currentFocusNodeId = entry.nodeId;

    const node = this.nodeMap.get(entry.nodeId)!;
    const focusNode = buildHopFocusNode(node, this.nodeMap, new Map(), this.store ?? undefined, 'bb_ddl');
    // Surface depth awareness only in strict/soft modes — silent mode means no budget talk reaches the AI.
    const surfaceDepth = this.depthBudget !== null && this.depthEnforcement !== 'silent';
    if (surfaceDepth) {
      const d = this.depthFromOrigin.get(entry.nodeId);
      if (d !== undefined) focusNode.depth_from_origin = d;
    }

    const path = bidirectional(this.graph, this.originNodeId!, entry.nodeId);
    const navPath = path ? (path as string[]).map(id => this.nodeMap.get(id)?.name || id).join(' → ') : 'Direct';

    const workingMemory = this.memory.getWorkingMemory(this.hopCount, this.scopeNodeIds.size) as NavigationWorkingMemory;
    workingMemory.topological_map = {
      navigation_path: navPath,
      visited_nodes: Array.from(this.visited),
      current_focus: entry.nodeId,
      agenda: this.agenda.map(a => ({ id: a.nodeId, name: this.nodeMap.get(a.nodeId)?.name ?? a.nodeId, question: a.question })),
    };
    if (surfaceDepth) {
      (workingMemory as any).depth_budget = this.depthBudget;
      (workingMemory as any).depth_enforcement = this.depthEnforcement; // 'strict' or 'soft'
      if (this.depthEnforcement === 'soft' && this.budgetExpansions.length > 0) {
        (workingMemory as any).budget_expansions = this.budgetExpansions.slice();
      }
    }

    this._status = 'awaiting_findings';
    return {
      sm_status: 'awaiting_findings' as const,
      hop: this.hopCount,
      agenda_remaining: this.agenda.length,
      focus_node: focusNode,
      neighbors: this.buildNeighborList(entry.nodeId),
      current_task: entry.question,
      working_memory: workingMemory,
    };
  }

  submitFindings(params: HopSubmission): SubmitResult {
    if (this._status !== 'awaiting_findings') {
      const hint = this._status === 'complete'
        ? 'The engine already completed this exploration. Produce the synthesis output (chat prose + enrich_view) now — do not call submit_findings again.'
        : this._status === 'error'
          ? 'The engine is in an error state. Call start_exploration to begin a fresh exploration.'
          : `Engine is in status '${this._status}'. Expected 'awaiting_findings'. Wait for a hop context, or restart via start_exploration if the session was wiped.`;
      return { error: 'invalid_status', current_status: this._status, hint } as any;
    }

    // Normalize and check focus
    const focusId = params.focus_node_id?.toLowerCase();
    if (focusId !== this.currentFocusNodeId) {
      return { error: 'focus_mismatch', expected: this.currentFocusNodeId ?? undefined, got: focusId };
    }

    if (params.route_requests) {
      const invalidRoutes = [];
      for (const req of params.route_requests) {
        const nid = req.nodeId?.toLowerCase();
        const nNode = nid ? this.nodeMap.get(nid) : null;
        if (!nNode) {
          invalidRoutes.push({ id: req.nodeId, reason: 'Node not found.' });
          continue;
        }
        // Depth handling — three modes, driven by how the user expressed the depth:
        //   strict  → slash command set depth; reject out-of-scope routes (hard rule)
        //   soft    → user expressed depth in chat; allow expansion but track + surface (advisory)
        //   silent  → AI chose a cautious starting scope on a large graph; expand freely, no awareness
        if (nid && !this.scopeNodeIds.has(nid)) {
          if (this.depthEnforcement === 'strict' && this.depthBudget !== null) {
            const nodeDepth = this.depthFromOrigin.get(nid);
            invalidRoutes.push({
              id: req.nodeId,
              reason: `Node is outside the user-requested depth budget (${this.depthBudget} from origin${nodeDepth !== undefined ? `; this node is at depth ${nodeDepth}` : ''}). Omit this route, or reference the node in analysis prose without routing to it.`,
            });
            continue;
          }
          // soft + silent: expand scope in-place so the node can be visited and appears in the result graph
          this.scopeNodeIds.add(nid);
          const focusDepth = this.depthFromOrigin.get(this.currentFocusNodeId!) ?? 0;
          if (!this.depthFromOrigin.has(nid)) this.depthFromOrigin.set(nid, focusDepth + 1);
          if (this.depthEnforcement === 'soft' && this.depthBudget !== null) {
            this.budgetExpansions.push({ nodeId: nid, depth: focusDepth + 1, atHop: this.hopCount });
          }
        }
        if (req.columns) {
          if (this.mode !== 'column_trace') {
            req.columns = undefined;
          } else {
            const validCols = new Set(getNodeColumns(nNode.id, this.nodeMap, this.store ?? undefined)?.map(c => c.name.toLowerCase()));
            const invalidCols = req.columns.filter((c: string) => !validCols.has(c.toLowerCase()));
            if (invalidCols.length > 0) {
              invalidRoutes.push({ id: req.nodeId, reason: `Columns not found: ${invalidCols.join(', ')}` });
            }
          }
        }
      }
      if (invalidRoutes.length > 0) return { error: 'route_validation_failed', detail: invalidRoutes };
    }

    // Irrelevant-verdict cascade-prune guards (before any state mutation)
    const isIrrelevant = params.verdict === 'irrelevant';
    const prunable = isIrrelevant && this.currentFocusNodeId !== this.originNodeId;
    if (prunable) {
      const notedIds = new Set<string>(this.memory.notedNodeIds);
      const orphan = wouldOrphanNotedNode(this.graph, this.originNodeId!, this.removedSet, notedIds, this.currentFocusNodeId!);
      if (orphan) {
        return { error: 'prune_would_orphan_noted', detail: `Marking ${this.currentFocusNodeId} irrelevant would orphan already-analyzed node "${orphan}". Use verdict='pass' to skip without pruning.` };
      }
      const agendaNodeIdSet = new Set(this.agenda.map(a => a.nodeId));
      const cascadeCount = countCascadeIfPruned(this.graph, this.originNodeId!, this.removedSet, this.scopeNodeIds, agendaNodeIdSet, this.currentFocusNodeId!);
      if (this.agenda.length > 2 && cascadeCount * 2 > this.agenda.length) {
        return { error: 'prune_cascade_too_wide', detail: `Pruning ${this.currentFocusNodeId} would cascade-remove ${cascadeCount}/${this.agenda.length} agenda nodes. Use verdict='pass' to preserve scope.` };
      }
    }

    // Store detail for relevant/pass; irrelevant nodes keep only the summary trace
    if (!isIrrelevant) {
      this.memory.storeDetail(this.nodeMap.get(this.currentFocusNodeId!)!, params.detail_analysis, params.summary, {
        badge_label: params.badge_label,
        note_caption: params.note_caption
      }, this._inlineMode);
    }

    // Commit cascade prune for irrelevant (after guards passed)
    let cascadedCount = 0;
    if (prunable) {
      this.removedSet.add(this.currentFocusNodeId!);
      const reachable = bfsReachable(this.graph, this.originNodeId!, this.removedSet, undefined, this.scopeNodeIds);
      const before = this.agenda.length;
      this.agenda = this.agenda.filter(e => reachable.has(e.nodeId));
      this.agendaIds = new Set(this.agenda.map(e => e.nodeId));
      cascadedCount = before - this.agenda.length;
    }

    if (params.route_requests) {
      for (const req of params.route_requests) {
        const nid = req.nodeId.toLowerCase();
        if (!this.visited.has(nid) && !this.agendaIds.has(nid) && !this.removedSet.has(nid)) {
          this.agenda.push({ nodeId: nid, question: req.question, priority: 2, depth: 0, activeColumns: req.columns });
          this.agendaIds.add(nid);
        }
      }
    }

    this._status = 'exploring';

    // `complete: true` is inline-mode only. In sliding-memory mode the engine owns termination
    // via natural agenda drain (getHopContext sets status='complete' when agenda is empty);
    // surfacing AI-driven completion would give the AI a self-exit path, which breaks the
    // Map-&-Router invariant. If set in SM mode, silently ignore.
    if (params.complete && this._inlineMode) {
      this._status = 'complete';
      return { ok: true, done: true, result: this.getResult() };
    }

    return cascadedCount > 0 ? { ok: true, cascaded_count: cascadedCount } : { ok: true };
  }

  public estimateScopeDdlChars(): number {
    let total = 0;
    for (const nid of this.scopeNodeIds) {
      const ddl = getNodeDdl(nid, this.nodeMap, this.store ?? undefined);
      if (ddl) total += ddl.length;
    }
    return total;
  }

  private computeBfsScope(startId: string, direction: string, maxDepth: number): Set<string> {
    const mode = direction === 'upstream' ? 'inbound' : direction === 'downstream' ? 'outbound' : 'directed';
    const seen = new Set<string>();
    // Record BFS distance per node so route validation + hop payloads can reason about depth.
    this.depthFromOrigin.clear();
    bfsFromNode(this.graph, startId, (key, _attr, depth) => {
      seen.add(key);
      if (!this.depthFromOrigin.has(key)) this.depthFromOrigin.set(key, depth);
      return depth >= maxDepth; // stop traversing past this node
    }, { mode });
    return seen;
  }

  private seedAgenda(originId: string, direction: string, targetCols?: string[]) {
    const neighbors = direction === 'upstream' ? this.graph.inNeighbors(originId) : direction === 'downstream' ? this.graph.outNeighbors(originId) : this.graph.neighbors(originId);
    for (const nid of neighbors as string[]) {
      if (this.scopeNodeIds.has(nid) && !this.agendaIds.has(nid)) {
        this.agenda.push({ nodeId: nid, question: `Analyze relationship to ${originId}`, priority: 0, depth: 1, activeColumns: targetCols });
        this.agendaIds.add(nid);
      }
    }
  }

  private buildNeighborList(focusId: string): HopNeighbor[] {
    const ids = Array.from(new Set([...(this.graph.inNeighbors(focusId) as string[]), ...(this.graph.outNeighbors(focusId) as string[])])) as string[];
    // Only surface in-budget flags in strict/soft modes. In silent mode the scope grows transparently
    // and the AI should not see any budget talk — it would cause confusion on cautious-start explorations.
    const surfaceDepth = this.depthBudget !== null && this.depthEnforcement !== 'silent';
    return ids.map(nid => {
      const n = this.nodeMap.get(nid)!;
      const boundary = this.visited.has(nid) ? 'cycle' : 'none';
      const cols = getNodeColumns(nid, this.nodeMap, this.store ?? undefined)?.map(c => c.name);
      const neighbor: HopNeighbor = {
        id: nid, s: n.schema, n: n.name, t: n.type,
        edge_direction: (this.graph.inNeighbors(focusId) as string[]).includes(nid) ? 'upstream' : 'downstream',
        edge_type: 'read', boundary, cols,
      };
      if (surfaceDepth && !this.scopeNodeIds.has(nid)) {
        (neighbor as any).in_budget = false;
        const d = this.depthFromOrigin.get(nid);
        if (d !== undefined) (neighbor as any).depth_from_origin = d;
      }
      return neighbor;
    });
  }

  public getResult(): SmResult {
    const mem = this.memory.getResult();
    const notedIds = new Set(mem.detail_slots.map(s => s.nodeId));
    
    // Core edges between all nodes in the scope (minus cascade-pruned)
    const edges: Array<[string, string, string]> = [];
    for (const e of this.model.edges) {
      if (this.scopeNodeIds.has(e.source) && this.scopeNodeIds.has(e.target)
          && !this.removedSet.has(e.source) && !this.removedSet.has(e.target)) {
        edges.push([e.source, e.target, edgeApiType(e.type)]);
      }
    }

    // Bridge Node Injection: Reconnect orphaned noted nodes
    const bridge = findBridgeNodes(this.graph, notedIds, edges, this.edgeTypeMap);
    const finalEdges = [...edges, ...bridge.bridgeEdges];
    const finalNodeIds = new Set([...Array.from(notedIds), ...bridge.bridgeNodes.map(n => n.id), this.originNodeId!]);

    // Data-flow sorting for sections
    const depthMap = bfsDepthMap(finalEdges, this.originNodeId!);
    const sortedIds = Array.from(finalNodeIds).sort((a, b) => (depthMap.get(a) ?? 999) - (depthMap.get(b) ?? 999));

    // Suggested sections based on depth
    const sections: Array<{ label: string; node_ids: string[] }> = [];
    const maxDepth = Math.max(...Array.from(depthMap.values()), 0);
    for (let i = 0; i <= maxDepth; i++) {
      const idsAtDepth = sortedIds.filter(id => depthMap.get(id) === i);
      if (idsAtDepth.length > 0) {
        sections.push({ label: i === 0 ? 'Origin' : `Stage ${i}`, node_ids: idsAtDepth });
      }
    }

    return {
      status: 'complete',
      originNodeId: this.originNodeId!,
      fullNodes: Array.from(finalNodeIds).map(id => {
        const n = this.nodeMap.get(id)!;
        return { id: n.id, s: n.schema, n: n.name, t: n.type, role: id === this.originNodeId ? 'origin' : notedIds.has(id) ? 'noted' : 'bridge' };
      }),
      edges: finalEdges,
      suggested_sections: sections,
      detail_slots: mem.detail_slots,
    };
  }

  public toJSON() {
    return {
      mode: this.mode,
      status: this._status,
      hopCount: this.hopCount,
      scopeSize: this.scopeNodeIds.size,
      scopeNodeIds: Array.from(this.scopeNodeIds),
      inlineMode: this._inlineMode,
      visited: Array.from(this.visited),
      removedSet: Array.from(this.removedSet),
      agendaSize: this.agenda.length,
      agenda: this.agenda.map(a => ({
        nodeId: a.nodeId,
        priority: a.priority,
        question: a.question,
      })),
      currentFocusNodeId: this.currentFocusNodeId,
      memory: this.memory.toJSON(),
    };
  }
}

export interface IHopStateMachine {
  readonly status: SmStatus;
  readonly scopeSize: number;
  readonly coveragePct: number;
  readonly inlineMode: boolean;
  readonly mode: SmMode;
  setInlineMode(val: boolean): void;
  getHopContext(): HopContext;
  submitFindings(params: HopSubmission): SubmitResult;
  getResult(): SmResult;
  toJSON(): unknown;
}
