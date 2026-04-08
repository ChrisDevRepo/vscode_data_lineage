/**
 * Blackboard State Machine — free-form exploration with priority agenda.
 *
 * Extends HopStateMachine (smBase.ts) for shared state, memory, and helpers.
 * BB-specific: agenda management, Self-Ask questions, scope expansion.
 *
 * Lifecycle: init() → getHopContext() ↔ submitFindings() loop → getResult()
 */

import type Graph from 'graphology';
import type { DatabaseModel, LineageNode } from '../engine/types';
import type { ColumnStore } from '../engine/columnStore';
import type { SerializedFilterState } from '../engine/projectStore';
import { buildHopFocusNode, SCRIPT_TYPES, getNodeDdl } from './tools';
import { presentNode, strip, edgeApiType } from './aiPresenter';
import { wouldOrphanNotedNode, countCascadeIfPruned, validateNodeIds, bfsReachable, type LogFn } from './smGuards';
import { HopStateMachine, type HopNeighbor, type SmResult, type DetailSlot } from './smBase';

// ─── Types ──────────────────────────────────────────────────────────────────

export type BlackboardStatus = 'created' | 'initialized' | 'exploring' | 'awaiting_findings' | 'complete' | 'error';

export interface AgendaEntry {
  nodeId: string;
  question?: string;
  priority: number;   // 0=BFS, 1=neighbor, 2=question-boosted, 3=mandatory
  depth: number;
}

export interface BlackboardConfig {
  maxAgendaSize?: number;
  findingsHardLimit?: number;
  summaryHardLimit?: number;
  activeFilter?: SerializedFilterState | null;
  scopeDirection?: 'upstream' | 'downstream' | 'bidirectional';
  maxInputTokens?: number;
}

interface WorkingMemory {
  user_question: string;
  all_summaries: Array<{ nodeId: string; summary: string }>;
  pending_questions: Array<{ nodeId: string; question: string }>;
  remaining_agenda: Array<{ id: string; name: string; type: string; priority: number }>;
  invalid_nodes?: Array<{ id: string; reason: string }>;
  checklist: { current_hop: number; noted: number; total: number; open: number; coveragePct: number };
}

interface MapOverview {
  nodes: Array<Record<string, unknown>>;
  edges: Array<[string, string, string]>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_AGENDA = 200;
const SCOPE_DIRECTION_GATE = 200;
const CASCADE_REJECT_THRESHOLD = 0.5;

// ─── Class ──────────────────────────────────────────────────────────────────

export class BlackboardState extends HopStateMachine {

  // BB-specific state
  private readonly maxAgendaSize: number;
  private readonly scopeDirection: 'upstream' | 'downstream' | 'bidirectional';
  private agenda: AgendaEntry[] = [];
  private agendaIds = new Set<string>();
  private questionLog: Array<{ nodeId: string; question: string; answered: boolean }> = [];
  private userQuestion = '';
  private invalidNodeIds = new Map<string, 'not_in_model' | 'out_of_scope' | 'not_in_filter'>();
  private _bbStatus: BlackboardStatus = 'created';

  constructor(
    model: DatabaseModel,
    graph: Graph,
    log: LogFn,
    config?: BlackboardConfig,
    store?: ColumnStore | null,
  ) {
    super(model, graph, log, {
      activeFilter: config?.activeFilter,
      findingsHardLimit: config?.findingsHardLimit,
      summaryHardLimit: config?.summaryHardLimit,
      maxInputTokens: config?.maxInputTokens,
    }, store);
    this.maxAgendaSize = config?.maxAgendaSize ?? DEFAULT_MAX_AGENDA;
    this.scopeDirection = config?.scopeDirection ?? 'bidirectional';
  }

  protected getScopeDirection(): 'upstream' | 'downstream' | 'bidirectional' {
    return this.scopeDirection;
  }

  // ── Public accessors ──

  override get status(): BlackboardStatus { return this._bbStatus; }
  get noteCount(): number { return this.detailSlots.size; }

  get filterBreakdown(): { in_filter: number; outside_filter: number; total: number } {
    if (!this.filterSchemas) return { in_filter: this.scopeNodeIds.size, outside_filter: 0, total: this.scopeNodeIds.size };
    let inFilter = 0;
    for (const id of this.scopeNodeIds) {
      if (this.isInFilter(id)) inFilter++;
    }
    return { in_filter: inFilter, outside_filter: this.scopeNodeIds.size - inFilter, total: this.scopeNodeIds.size };
  }

  schemaBreakdown(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const id of this.scopeNodeIds) {
      const node = this.nodeMap.get(id);
      if (node) counts[node.schema] = (counts[node.schema] || 0) + 1;
    }
    return counts;
  }

  // ─── init ─────────────────────────────────────────────────────────────────

  init(params: {
    question: string;
    origin: string;
  }): { ok: true; scopeSize: number; agendaSize: number; originNode: Record<string, unknown>; map: MapOverview }
     | { error: string; hint?: string; scope_size?: number; in_filter?: number; outside_filter?: number } {

    // Reset all state
    this.resetSharedState();
    this.agenda = [];
    this.agendaIds.clear();
    this.questionLog = [];
    this.userQuestion = '';
    this.invalidNodeIds.clear();
    this._bbStatus = 'created';

    const { question, origin } = params;
    this.userQuestion = question;

    // Resolve origin
    const originNode = this.nodeMap.get(origin.toLowerCase());
    if (!originNode) {
      this._bbStatus = 'error';
      this.log('debug', `BB INIT ERROR: origin "${origin}" not found`);
      return { error: 'origin_not_found', hint: `Object "${origin}" not found in loaded model.` };
    }

    this.originNodeId = originNode.id;

    // Compute scope
    const scopeIds = this.bfsScope(originNode.id, this.scopeDirection);
    this.scopeNodeIds = scopeIds;

    // Hard gate: bidirectional on large scope
    if (scopeIds.size > SCOPE_DIRECTION_GATE && this.scopeDirection === 'bidirectional') {
      this._bbStatus = 'error';
      const bd = this.filterBreakdown;
      this.log('warn', `BB INIT rejected — scope_too_broad | scope=${scopeIds.size}`);
      return {
        error: 'scope_too_broad',
        scope_size: scopeIds.size,
        in_filter: bd.in_filter,
        outside_filter: bd.outside_filter,
        hint: `Scope is ${scopeIds.size} nodes (bidirectional BFS). Resubmit with scope_direction='upstream' or 'downstream'.`,
      };
    }

    // Seed agenda
    this.seedAgenda(originNode.id);

    this._bbStatus = 'initialized';
    this.log('info', `BB INIT | origin=${originNode.id} | scope=${scopeIds.size} | agenda=${this.agenda.length} | direction=${this.scopeDirection}`);

    return {
      ok: true,
      scopeSize: scopeIds.size,
      agendaSize: this.agenda.length,
      originNode: buildHopFocusNode(originNode, this.nodeMap, this.unrelatedMap, this.store ?? undefined, 'bb_ddl'),
      map: this.buildMapOverview(),
    };
  }

  // ─── getHopContext ────────────────────────────────────────────────────────

  getHopContext():
    | { bb_mode: 'exploring'; hop: number; focus_node: Record<string, unknown>;
        neighbors: HopNeighbor[];
        current_task: string; working_memory: WorkingMemory;
        agenda_remaining: number }
    | { done: true; nodes_outside_scope?: number; hint?: string }
    | { error: string } {

    if (this._bbStatus !== 'initialized' && this._bbStatus !== 'exploring') {
      return { error: `Cannot get hop context in status "${this._bbStatus}"` };
    }

    // Pop highest-priority unvisited entry
    const entry = this.popNextAgendaEntry();
    if (!entry) {
      this._bbStatus = 'complete';
      const outsideScope = this.scopeNodeIds.size - this.visited.size - this.removedSet.size;
      this.log('info', `BB COMPLETE | agenda exhausted | notes=${this.detailSlots.size}`);
      return {
        done: true,
        ...(outsideScope > 0 && {
          nodes_outside_scope: outsideScope,
          hint: 'All agenda nodes explored. More nodes available — ask a question to explore further.',
        }),
      };
    }

    const node = this.nodeMap.get(entry.nodeId);
    if (!node) return { error: `Node ${entry.nodeId} missing from model` };

    this.visited.add(entry.nodeId);
    this.hopCount++;
    this.currentFocusNodeId = entry.nodeId;

    const focusNode = buildHopFocusNode(node, this.nodeMap, this.unrelatedMap, this.store ?? undefined, 'bb_ddl');

    // Build neighbors with scope info
    const inIds = new Set<string>(this.graph.hasNode(entry.nodeId) ? this.graph.inNeighbors(entry.nodeId) as string[] : []);
    const outIds = new Set<string>(this.graph.hasNode(entry.nodeId) ? this.graph.outNeighbors(entry.nodeId) as string[] : []);
    const allNeighborIds = [...new Set<string>([...inIds, ...outIds])];
    const neighbors = this.buildNeighborList(entry.nodeId, allNeighborIds, inIds);

    // Add BB-specific scope info to neighbors
    for (const nb of neighbors) {
      nb.scope =
        this.visited.has(nb.id)     ? 'visited' :
        this.removedSet.has(nb.id)  ? 'pruned' :
        this.agendaIds.has(nb.id)   ? 'in_scope' :
        !this.nodeMap.has(nb.id)    ? 'external' :
                                      'available';
      nb.in_filter = this.isInFilter(nb.id);
    }

    const currentTask = entry.question
      ?? `Analyze ${node.id} — what is its role, business logic, and key data flows?`;

    const workingMemory = this.buildWorkingMemory();

    this._bbStatus = 'awaiting_findings';
    this.log('info', `BB Hop ${this.hopCount} | ${node.id} | neighbors=${neighbors.length} | agenda=${this.agenda.length}`);

    return {
      bb_mode: 'exploring',
      hop: this.hopCount,
      focus_node: focusNode,
      neighbors,
      current_task: currentTask,
      working_memory: workingMemory,
      agenda_remaining: this.agenda.length,
    };
  }

  // ─── submitFindings ───────────────────────────────────────────────────────

  submitFindings(params: {
    focusNodeId: string;
    findings: string;
    summary: string;
    tags?: string[];
    questions?: Array<{ nodeId: string; question: string }>;
    verdict: 'relevant' | 'noted' | 'irrelevant';
    pruneIds?: string[];
    addIds?: string[];
    complete?: boolean;
    badge_label?: string;
    note_caption?: string;
  }): { ok: true; advanced: number; agendaSize: number; pruned?: number;
        rejected_prune_ids?: Array<{ id: string; reason: string; hint?: string }>;
        invalid_questions?: Array<{ node_id: string; question: string; reason: string }>;
        complete_rejected?: { nodes: string[]; names: string[]; hint: string };
        early_complete?: ReturnType<BlackboardState['getResult']> }
     | { error: string; limit?: number; hint?: string } {

    if (this._bbStatus !== 'awaiting_findings') {
      return { error: `Cannot submit findings in status "${this._bbStatus}"` };
    }

    const { focusNodeId, findings, summary, questions, verdict } = params;

    // Coerce AI inputs
    const tags = Array.isArray(params.tags) ? params.tags
      : typeof params.tags === 'string' ? (params.tags as string).split(',').map(t => t.trim())
      : undefined;
    const pruneIds = Array.isArray(params.pruneIds) ? params.pruneIds
      : typeof params.pruneIds === 'string' ? [params.pruneIds as string]
      : undefined;

    // Validate focus node
    if (focusNodeId !== this.currentFocusNodeId) {
      return { error: `Focus node mismatch: expected "${this.currentFocusNodeId}", got "${focusNodeId}"` };
    }
    if (this.removedSet.has(focusNodeId)) {
      return { error: 'node_pruned', hint: `${focusNodeId} was cascade-removed.` };
    }

    // Hard limits — reject, never truncate
    const sizeErr = this.validateSubmissionSize(findings, summary);
    if (sizeErr) return { error: sizeErr };

    // Store detail memory slot
    this.storeDetail(focusNodeId, verdict === 'irrelevant' ? summary : findings, summary, {
      tags,
      badge_label: params.badge_label,
      note_caption: params.note_caption,
    });

    // Update short memory
    this.updateShortMemory(`${this.nodeMap.get(focusNodeId)?.name ?? focusNodeId}: ${summary}`);

    // Mark pending questions as answered
    for (const q of this.questionLog) {
      if (q.nodeId === focusNodeId && !q.answered) q.answered = true;
    }

    let advanced = 0;
    let pruned = 0;

    // Verdict: cascade-prune on 'irrelevant'
    if (verdict === 'irrelevant') {
      pruned = this.cascadePrune(focusNodeId);
      this.log('info', `BB PRUNE | ${focusNodeId} | cascade=${pruned}`);
    }

    // Process questions (Self-Ask)
    const invalidQuestions: Array<{ node_id: string; question: string; reason: string }> = [];
    if (questions?.length) {
      const { valid, invalid } = validateNodeIds(
        this.nodeMap,
        questions.map(q => ({ nodeId: q.nodeId, question: q.question })),
      );
      for (const inv of invalid) {
        invalidQuestions.push({ node_id: inv.nodeId, question: inv.question, reason: inv.reason });
        this.invalidNodeIds.set(inv.nodeId, 'not_in_model');
      }
      for (const q of valid) {
        if (this.removedSet.has(q.nodeId)) continue;
        this.addQuestion(q.nodeId, q.question);
        advanced++;
      }
    }

    // Auto-add nodes
    if (params.addIds?.length) {
      for (const addId of params.addIds) {
        if (!this.nodeMap.has(addId)) continue;
        if (this.visited.has(addId) || this.removedSet.has(addId)) continue;
        this.addQuestion(addId, '(auto-added)');
        advanced++;
      }
    }

    // Prune specific nodes with guards
    const rejectedPrunes: Array<{ id: string; reason: string; hint?: string }> = [];
    if (pruneIds?.length) {
      const originDirectNeighborIds: Set<string> = this.originNodeId ? new Set([
        ...(this.scopeDirection !== 'downstream' ? this.graph.inNeighbors(this.originNodeId) : []),
        ...(this.scopeDirection !== 'upstream'   ? this.graph.outNeighbors(this.originNodeId) : []),
      ]) : new Set();

      const notedIdSet = new Set(this.detailSlots.keys());
      for (const pruneId of pruneIds) {
        if (pruneId === this.originNodeId || this.visited.has(pruneId) || this.removedSet.has(pruneId)) continue;

        // Guard 0: direct neighbor of origin
        if (originDirectNeighborIds.has(pruneId) && this.scopeNodeIds.has(pruneId)) {
          rejectedPrunes.push({ id: pruneId, reason: 'Direct neighbor of origin — visit instead.' });
          continue;
        }

        if (!this.scopeNodeIds.has(pruneId)) {
          const existsInModel = this.nodeMap.has(pruneId);
          let reason: 'not_in_model' | 'out_of_scope' | 'not_in_filter';
          if (!existsInModel) reason = 'not_in_model';
          else if (this.filterSchemas) {
            const n = this.nodeMap.get(pruneId)!;
            reason = this.filterSchemas.has(n.schema.toLowerCase()) ? 'out_of_scope' : 'not_in_filter';
          } else reason = 'out_of_scope';
          rejectedPrunes.push({ id: pruneId, reason });
          this.invalidNodeIds.set(pruneId, reason);
          continue;
        }

        // Guard 1: would orphan noted node
        const orphanedId = wouldOrphanNotedNode(this.graph, this.originNodeId!, this.removedSet, notedIdSet, pruneId);
        if (orphanedId) {
          rejectedPrunes.push({ id: pruneId, reason: `Would disconnect "${orphanedId}" from origin.` });
          continue;
        }

        // Guard 2: catastrophic cascade
        const cascadeCount = countCascadeIfPruned(this.graph, this.originNodeId!, this.removedSet, this.scopeNodeIds, this.agendaIds, pruneId);
        if (cascadeCount > this.agenda.length * CASCADE_REJECT_THRESHOLD) {
          rejectedPrunes.push({ id: pruneId, reason: `Cascade would remove ${cascadeCount} of ${this.agenda.length} nodes.` });
          continue;
        }

        pruned += this.cascadePrune(pruneId);
      }
    }

    this._bbStatus = 'exploring';
    this.log('info', `BB submit | ${focusNodeId} | verdict=${verdict} | agenda=${this.agenda.length}`);

    const base = {
      ok: true as const, advanced, agendaSize: this.agenda.length,
      ...(pruned > 0 && { pruned }),
      ...(rejectedPrunes.length > 0 && { rejected_prune_ids: rejectedPrunes }),
      ...(invalidQuestions.length > 0 && { invalid_questions: invalidQuestions }),
    };

    // Early completion
    if (params.complete) {
      const originDirectIds: Set<string> = this.originNodeId ? new Set([
        ...(this.scopeDirection !== 'downstream' ? this.graph.inNeighbors(this.originNodeId) : []),
        ...(this.scopeDirection !== 'upstream'   ? this.graph.outNeighbors(this.originNodeId) : []),
      ]) : new Set();
      const unvisitedDirect = [...originDirectIds].filter(id =>
        this.scopeNodeIds.has(id) && !this.visited.has(id) && !this.removedSet.has(id),
      );
      if (unvisitedDirect.length > 0) {
        for (const id of unvisitedDirect) {
          if (!this.agendaIds.has(id)) {
            this.agenda.push({ nodeId: id, priority: 3, depth: 1 });
            this.agendaIds.add(id);
          } else {
            const entry = this.agenda.find(e => e.nodeId === id);
            if (entry) entry.priority = 3;
          }
        }
        const names = unvisitedDirect.map(id => this.nodeMap.get(id)?.name ?? id);
        return { ...base, complete_rejected: { nodes: unvisitedDirect, names, hint: `Visit these direct neighbors first: ${names.join(', ')}` } };
      }
      return { ...base, early_complete: this.getResult() };
    }

    return base;
  }

  // ─── getResult ────────────────────────────────────────────────────────────

  getResult(): SmResult & {
    question: string;
    notes: DetailSlot[];
    skipped_nodes?: Array<{ nodeId: string; name: string; type: string; unanswered_question?: string }>;
  } | { error: string } {

    if (this._bbStatus === 'created' || this._bbStatus === 'awaiting_findings') {
      return { error: `Cannot get result in status "${this._bbStatus}"` };
    }

    // Build shared result (fullNodes, edges, bridges, badges, notes, memory)
    const shared = this.buildSharedResult();
    this._bbStatus = 'complete';

    // BB-specific: skipped nodes (remaining agenda)
    const skippedNodes = this.agenda.map(a => {
      const n = this.nodeMap.get(a.nodeId);
      return {
        nodeId: a.nodeId,
        name: n?.name ?? a.nodeId,
        type: n?.type ?? 'unknown',
        ...(a.question ? { unanswered_question: a.question } : {}),
      };
    });

    const questionsAsked = this.questionLog.length;
    const questionsAnswered = this.questionLog.filter(q => q.answered).length;

    this.log('info', `BB RESULT | slots=${shared.detail_slots.length} | edges=${shared.edges.length} | coverage=${this.coveragePct}%`);

    return {
      ...shared,
      question: this.userQuestion,
      notes: shared.detail_slots,
      ...(skippedNodes.length > 0 ? { skipped_nodes: skippedNodes } : {}),
      stats: {
        ...shared.stats,
        questionsAsked,
        questionsAnswered,
      },
    };
  }

  // ─── Private: Agenda management ───────────────────────────────────────────

  private seedAgenda(originId: string): void {
    if (!this.graph.hasNode(originId)) return;
    const queue: Array<{ id: string; depth: number }> = [];
    const seen = new Set<string>([originId]);

    const neighborFn = (id: string): string[] =>
      this.scopeDirection === 'upstream'   ? this.graph.inNeighbors(id) :
      this.scopeDirection === 'downstream' ? this.graph.outNeighbors(id) :
                                             this.graph.neighbors(id);

    for (const nid of neighborFn(originId)) {
      if (!seen.has(nid) && this.scopeNodeIds.has(nid)) {
        seen.add(nid);
        queue.push({ id: nid, depth: 1 });
      }
    }

    let idx = 0;
    while (idx < queue.length) {
      const { id, depth } = queue[idx++];
      if (this.agenda.length >= this.maxAgendaSize) break;
      this.agenda.push({ nodeId: id, priority: 0, depth });
      this.agendaIds.add(id);

      for (const nid of neighborFn(id)) {
        if (!seen.has(nid) && this.scopeNodeIds.has(nid)) {
          seen.add(nid);
          queue.push({ id: nid, depth: depth + 1 });
        }
      }
    }
  }

  private popNextAgendaEntry(): AgendaEntry | undefined {
    while (this.agenda.length > 0) {
      let bestIdx = 0;
      for (let i = 1; i < this.agenda.length; i++) {
        if (this.agenda[i].priority > this.agenda[bestIdx].priority) bestIdx = i;
      }
      const entry = this.agenda[bestIdx];
      this.agenda.splice(bestIdx, 1);
      this.agendaIds.delete(entry.nodeId);
      if (!this.visited.has(entry.nodeId) && this.nodeMap.has(entry.nodeId)) return entry;
    }
    return undefined;
  }

  private addQuestion(nodeId: string, question: string): void {
    this.questionLog.push({ nodeId, question, answered: false });
    if (!this.nodeMap.has(nodeId) || this.visited.has(nodeId)) return;

    const existing = this.agenda.find(e => e.nodeId === nodeId);
    if (existing) {
      existing.priority = 2;
      existing.question = question;
    } else {
      if (!this.scopeNodeIds.has(nodeId)) this.scopeNodeIds.add(nodeId);
      if (this.agenda.length < this.maxAgendaSize) {
        this.agenda.push({ nodeId, question, priority: 2, depth: 0 });
        this.agendaIds.add(nodeId);
      }
    }
  }

  private cascadePrune(prunedId: string): number {
    this.removedSet.add(prunedId);
    const reachable = bfsReachable(this.graph, this.originNodeId!, this.removedSet, undefined, this.scopeNodeIds);
    let cascaded = 0;
    for (let i = this.agenda.length - 1; i >= 0; i--) {
      if (!reachable.has(this.agenda[i].nodeId)) {
        this.removedSet.add(this.agenda[i].nodeId);
        this.agendaIds.delete(this.agenda[i].nodeId);
        this.agenda.splice(i, 1);
        cascaded++;
      }
    }
    return cascaded;
  }

  private buildWorkingMemory(): WorkingMemory {
    const allSummaries: Array<{ nodeId: string; summary: string }> = [];
    for (const slot of this.detailSlots.values()) {
      allSummaries.push({ nodeId: slot.nodeId, summary: slot.summary });
    }

    const pendingQuestions: Array<{ nodeId: string; question: string }> = [];
    for (const q of this.questionLog) {
      if (!q.answered) pendingQuestions.push({ nodeId: q.nodeId, question: q.question });
    }

    const sortedAgenda = [...this.agenda].sort((a, b) => b.priority - a.priority);
    const remaining_agenda = sortedAgenda.slice(0, 30).map(e => {
      const n = this.nodeMap.get(e.nodeId);
      return { id: e.nodeId, name: n?.name ?? e.nodeId, type: n?.type ?? '?', priority: e.priority };
    });

    const wm: WorkingMemory = {
      user_question: this.userQuestion,
      all_summaries: allSummaries,
      pending_questions: pendingQuestions,
      remaining_agenda,
      checklist: { current_hop: this.hopCount, noted: this.detailSlots.size, total: this.scopeNodeIds.size, open: this.agenda.length, coveragePct: this.coveragePct },
    };

    if (this.invalidNodeIds.size > 0) {
      wm.invalid_nodes = [...this.invalidNodeIds.entries()].map(([id, reason]) => ({ id, reason }));
    }

    return wm;
  }

  private buildMapOverview(): MapOverview {
    const nodes: Array<Record<string, unknown>> = [];
    for (const id of this.scopeNodeIds) {
      const node = this.nodeMap.get(id);
      if (node) nodes.push(strip(presentNode(node, this.model.neighborIndex)));
    }
    const edges: Array<[string, string, string]> = [];
    for (const e of this.model.edges) {
      if (this.scopeNodeIds.has(e.source) && this.scopeNodeIds.has(e.target)) {
        edges.push([e.source, e.target, edgeApiType(e.type)]);
      }
    }
    return { nodes, edges };
  }
}
