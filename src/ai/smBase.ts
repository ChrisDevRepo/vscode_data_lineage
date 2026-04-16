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

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgendaEntry {
  nodeId: string;
  question: string;         // grounded reason for visiting
  priority: number;         // 0=BFS, 2=AI-requested, 3=Origin
  depth: number;
  activeColumns?: string[]; // for CT mode
}

export interface NavigationWorkingMemory extends WorkingMemory {
  topological_map: {
    navigation_path: string;       // Origin -> ... -> Focus
    visited_nodes: string[];
    current_focus: string;
    agenda: Array<{ id: string; name: string; question: string }>;
  };
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export class NavigationEngine implements IHopStateMachine {

  protected readonly model: DatabaseModel;
  protected readonly graph: Graph;
  protected readonly store: ColumnStore | null;
  protected readonly log: LogFn;
  protected readonly nodeMap: Map<string, LineageNode>;
  protected readonly edgeTypeMap: Map<string, string>;
  protected readonly memory: AiMemoryManager;
  public readonly mode: SmMode;

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

  constructor(
    model: DatabaseModel,
    graph: Graph,
    log: LogFn,
    mode: SmMode,
    config: {
      activeFilter?: SerializedFilterState | null;
      memory?: AiMemoryManager;
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
    initial_summary?: string;
  }): any {
    this.visited.clear();
    this.agenda = [];
    this.agendaIds.clear();
    this.memory.reset();

    const originNode = this.nodeMap.get(params.origin.toLowerCase());
    if (!originNode) return { error: 'origin_not_found' };
    
    this.originNodeId = originNode.id;
    this.scopeNodeIds = this.computeBfsScope(originNode.id, params.direction || 'bidirectional', params.depth || 5);
    
    if (params.initial_summary) {
      this.memory.updateSynthesis(`Background: ${params.initial_summary}`);
    }

    // MANDATORY: Push origin as the first task
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
    
    const path = bidirectional(this.graph, this.originNodeId!, entry.nodeId);
    const navPath = path ? (path as string[]).map(id => this.nodeMap.get(id)?.name || id).join(' → ') : 'Direct';

    const workingMemory = this.memory.getWorkingMemory(this.hopCount, this.scopeNodeIds.size) as NavigationWorkingMemory;
    workingMemory.topological_map = {
      navigation_path: navPath,
      visited_nodes: Array.from(this.visited),
      current_focus: entry.nodeId,
      agenda: this.agenda.map(a => ({ id: a.nodeId, name: this.nodeMap.get(a.nodeId)?.name ?? a.nodeId, question: a.question })),
    };

    this._status = 'awaiting_findings';
    return {
      hop: this.hopCount,
      focus_node: focusNode,
      neighbors: this.buildNeighborList(entry.nodeId),
      current_question: entry.question,
      working_memory: workingMemory,
    };
  }

  submitFindings(params: HopSubmission): SubmitResult {
    if (this._status !== 'awaiting_findings') return { error: 'invalid_status', current_status: this._status };

    // Normalize and check focus
    const focusId = params.focus_node_id?.toLowerCase();
    if (focusId !== this.currentFocusNodeId) {
      return { error: 'focus_mismatch', expected: this.currentFocusNodeId ?? undefined, got: focusId };
    }

    // Selection Guard
    if (params.route_requests) {
      const invalidRoutes = [];
      for (const req of params.route_requests) {
        const nid = req.nodeId?.toLowerCase();
        const nNode = nid ? this.nodeMap.get(nid) : null;
        if (!nNode) {
          invalidRoutes.push({ id: req.nodeId, reason: 'Node not found.' });
          continue;
        }
        if (req.columns) {
          const validCols = new Set(getNodeColumns(nNode.id, this.nodeMap, this.store ?? undefined)?.map(c => c.name.toLowerCase()));
          const invalidCols = req.columns.filter((c: string) => !validCols.has(c.toLowerCase()));
          if (invalidCols.length > 0) {
            invalidRoutes.push({ id: req.nodeId, reason: `Columns not found: ${invalidCols.join(', ')}` });
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
        return { error: 'orphan_rejection', detail: `Marking ${this.currentFocusNodeId} irrelevant would orphan noted node "${orphan}". Use verdict='pass' to skip without pruning.` };
      }
      const agendaNodeIdSet = new Set(this.agenda.map(a => a.nodeId));
      const cascadeCount = countCascadeIfPruned(this.graph, this.originNodeId!, this.removedSet, this.scopeNodeIds, agendaNodeIdSet, this.currentFocusNodeId!);
      if (this.agenda.length > 2 && cascadeCount * 2 > this.agenda.length) {
        return { error: 'cascade_too_wide', detail: `Pruning ${this.currentFocusNodeId} would cascade-remove ${cascadeCount}/${this.agenda.length} agenda nodes. Use verdict='pass' to preserve scope.` };
      }
    }

    const synthesisErr = this.memory.updateSynthesis(params.narrative_update);
    if (synthesisErr) return { error: synthesisErr };

    // Store detail for relevant/pass; irrelevant nodes keep only the narrative trace
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
    if (params.complete) { this._status = 'complete'; return { ok: true, early_complete: this.getResult() }; }
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
    bfsFromNode(this.graph, startId, (key, _attr, depth) => {
      seen.add(key);
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
    return ids.map(nid => {
      const n = this.nodeMap.get(nid)!;
      const boundary = this.visited.has(nid) ? 'cycle' : 'none';
      const cols = getNodeColumns(nid, this.nodeMap, this.store ?? undefined)?.map(c => c.name);
      return {
        id: nid, s: n.schema, n: n.name, t: n.type,
        edge_direction: (this.graph.inNeighbors(focusId) as string[]).includes(nid) ? 'upstream' : 'downstream',
        edge_type: 'read', boundary, cols,
      };
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
      short_memory: mem.short_memory,
      detail_slots: mem.detail_slots,
    };
  }

  public toJSON() { return { mode: this.mode, hopCount: this.hopCount, visited: Array.from(this.visited) }; }
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
