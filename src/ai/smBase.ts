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
import type { DatabaseModel, LineageNode, ObjectType } from '../engine/types';
import type { ColumnStore } from '../engine/columnStore';
import type { SerializedFilterState } from '../engine/projectStore';
import { buildNodeMap, buildEdgeTypeMap, buildUnrelatedMap, SCRIPT_TYPES, getNodeColumns, getNodeDdl, buildHopFocusNode } from './tools';
import { presentColumnCompact, presentFkCompact, strip, edgeApiType } from './aiPresenter';
import { findBridgeNodes, bfsDepthMap, wouldOrphanNotedNode, bfsReachable, type LogFn } from './smGuards';
import { AiMemoryManager, type DetailSlot, type ShortMemory, type WorkingMemory } from './memoryManager';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SmMode = 'blackboard' | 'column_trace';
export type SmStatus = 'created' | 'initialized' | 'exploring' | 'awaiting_findings' | 'complete' | 'error';
export type BoundaryFlag = 'none' | 'source' | 'sink' | 'external' | 'cycle';

export interface AgendaEntry {
  nodeId: string;
  question: string;         // grounded reason for visiting
  priority: number;         // 0=BFS, 2=AI-requested
  depth: number;
  activeColumns?: string[]; // for CT mode
}

export interface HopNeighbor {
  id: string;
  s: string;   // schema
  n: string;   // name
  t: string;   // type
  edge_direction: 'upstream' | 'downstream';
  edge_type: string;
  boundary: BoundaryFlag;
  boundary_reason?: string;
  scope?: 'visited' | 'agenda' | 'pruned' | 'available' | 'external';
  cols?: string[];
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
  protected readonly memory: AiMemoryManager;
  protected readonly mode: SmMode;

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
    
    if (params.initial_summary) this.memory.updateSynthesis(`Initial: ${params.initial_summary}`);

    this.seedAgenda(originNode.id, params.direction || 'bidirectional', params.targetColumns);
    this.visited.add(originNode.id);
    this._status = 'initialized';

    return {
      ok: true,
      scopeSize: this.scopeNodeIds.size,
      agendaSize: this.agenda.length,
      originNode: buildHopFocusNode(originNode, this.nodeMap, new Map(), this.store ?? undefined, 'bb_ddl'),
    };
  }

  getHopContext(): any {
    let entry: AgendaEntry | undefined;
    while (this.agenda.length > 0) {
      const candidate = this.agenda.shift()!;
      this.agendaIds.delete(candidate.nodeId);
      if (!this.visited.has(candidate.nodeId)) { entry = candidate; break; }
    }

    if (!entry) { this._status = 'complete'; return { done: true }; }

    this.visited.add(entry.nodeId);
    this.hopCount++;
    this.currentFocusNodeId = entry.nodeId;

    const node = this.nodeMap.get(entry.nodeId)!;
    const focusNode = buildHopFocusNode(node, this.nodeMap, new Map(), this.store ?? undefined, 'bb_ddl');
    
    // Calculate path for grounding
    const path = bidirectional(this.graph, this.originNodeId!, entry.nodeId);
    const navPath = path ? path.map(id => this.nodeMap.get(id)?.name || id).join(' → ') : 'Direct';

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

  submitFindings(params: any): any {
    if (params.focusNodeId !== this.currentFocusNodeId) return { error: 'focus_mismatch' };

    // Selection Guard: Validate route requests against metadata
    if (params.route_requests) {
      const invalidRoutes = [];
      for (const req of params.route_requests) {
        const nNode = this.nodeMap.get(req.nodeId.toLowerCase());
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
      if (invalidRoutes.length > 0) {
        return { error: 'route_validation_failed', detail: invalidRoutes };
      }
    }

    this.memory.updateSynthesis(params.narrative_update);
    this.memory.storeDetail(this.nodeMap.get(params.focusNodeId)!, params.detail_analysis, params.summary, {
      badge_label: params.badge_label,
      note_caption: params.note_caption
    }, this._inlineMode);

    if (params.route_requests) {
      for (const req of params.route_requests) {
        if (!this.visited.has(req.nodeId) && !this.agendaIds.has(req.nodeId)) {
          this.agenda.push({ nodeId: req.nodeId, question: req.question, priority: 2, depth: 0, activeColumns: req.columns });
          this.agendaIds.add(req.nodeId);
        }
      }
    }

    this._status = 'exploring';
    if (params.complete) { this._status = 'complete'; return { ok: true, early_complete: this.getResult() }; }
    return { ok: true };
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
    const seen = new Set<string>([startId]);
    const queue = [{ id: startId, depth: 0 }];
    let idx = 0;
    while (idx < queue.length) {
      const { id, depth } = queue[idx++];
      if (depth >= maxDepth) continue;
      const neighbors = direction === 'upstream' ? this.graph.inNeighbors(id) : direction === 'downstream' ? this.graph.outNeighbors(id) : this.graph.neighbors(id);
      for (const nid of neighbors) {
        if (!seen.has(nid)) { seen.add(nid); queue.push({ id: nid, depth: depth + 1 }); }
      }
    }
    return seen;
  }

  private seedAgenda(originId: string, direction: string, targetCols?: string[]) {
    const neighbors = direction === 'upstream' ? this.graph.inNeighbors(originId) : direction === 'downstream' ? this.graph.outNeighbors(originId) : this.graph.neighbors(originId);
    for (const nid of neighbors) {
      if (this.scopeNodeIds.has(nid)) {
        this.agenda.push({ nodeId: nid, question: `Analyze relationship to ${originId}`, priority: 0, depth: 1, activeColumns: targetCols });
        this.agendaIds.add(nid);
      }
    }
  }

  private buildNeighborList(focusId: string): HopNeighbor[] {
    const ids = Array.from(new Set([...this.graph.inNeighbors(focusId), ...this.graph.outNeighbors(focusId)])) as string[];
    return ids.map(nid => {
      const n = this.nodeMap.get(nid)!;
      const cols = getNodeColumns(nid, this.nodeMap, this.store ?? undefined)?.map(c => c.name);
      return {
        id: nid, s: n.schema, n: n.name, t: n.type,
        edge_direction: (this.graph.inNeighbors(focusId) as string[]).includes(nid) ? 'upstream' : 'downstream' as any,
        edge_type: 'read', boundary: 'none', cols,
      };
    });
  }

  public getResult(): any {
    const mem = this.memory.getResult();
    const anchoredIds = new Set([...mem.detail_slots.map(s => s.nodeId), this.originNodeId!]);
    const edges: any[] = [];
    for (const e of this.model.edges) if (anchoredIds.has(e.source) && anchoredIds.has(e.target)) edges.push([e.source, e.target, edgeApiType(e.type)]);
    return {
      status: 'complete',
      originNodeId: this.originNodeId!,
      fullNodes: Array.from(anchoredIds).map(id => {
        const n = this.nodeMap.get(id)!;
        return { id: n.id, s: n.schema, n: n.name, t: n.type };
      }),
      edges,
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
  setInlineMode(val: boolean): void;
  getHopContext(): any;
  submitFindings(params: any): any;
  getResult(): any;
  toJSON(): any;
}
