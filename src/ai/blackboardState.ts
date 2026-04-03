/**
 * Blackboard State Machine — Type 1: free-form exploration.
 *
 * Passive SM: AI drives traversal via sub-questions, SM stores findings,
 * manages agenda priority, and delivers data per hop (DDL, cols, FKs).
 *
 * Lifecycle: init() → getHopContext() ↔ submitFindings() loop → getResult()
 *
 * Grounded in: Blackboard Architecture (Erman 1980), MemGPT two-tier memory
 * (Packer 2023), Self-Ask decomposition (Press 2022).
 *
 * Zero VS Code imports. Logging via injected callback.
 *
 * @see tmp/ai-dataflow.md §3 SM Types
 */

import type { DatabaseModel, LineageNode, ColumnDef, ObjectType } from '../engine/types';
import type { ColumnStore } from '../engine/columnStore';
import type { SerializedFilterState } from '../engine/projectStore';
import { buildNodeMap, buildEdgeTypeMap, buildUnrelatedMap, SCRIPT_TYPES } from './tools';
import { presentNode, presentColumnCompact, presentFkCompact, strip, edgeApiType } from './aiPresenter';
import { normalizeBodyScript } from '../utils/sql';

// ─── Public types ──────────────────────────────────────────────────────────────

export type BlackboardStatus = 'created' | 'initialized' | 'exploring'
                              | 'awaiting_findings' | 'complete' | 'error';

export interface BlackboardNote {
  nodeId: string;
  schema: string;
  name: string;
  type: string;
  findings: string;          // full detailed analysis (long-term memory slot)
  summary: string;           // one-line digest (working memory)
  tags?: string[];           // optional categorization
}

export interface AgendaEntry {
  nodeId: string;
  question?: string;         // Self-Ask: what to investigate at this node
  priority: number;          // 0 = BFS default, 1 = neighbor of noted, 2 = question-boosted
  depth: number;             // BFS depth from origin
}

export interface BlackboardConfig {
  maxAgendaSize?: number;         // default 200 — cap, not truncation
  findingsHardLimit?: number;     // default 5000 chars — reject, never truncate
  summaryHardLimit?: number;      // default 500 chars — reject, never truncate
  activeFilter?: SerializedFilterState | null;  // user's active filter — for scope REPORTING, not filtering
}

export type LogFn = (level: 'info' | 'debug' | 'warn', msg: string) => void;

// ─── Internal types ────────────────────────────────────────────────────────────

type BoundaryFlag = 'none' | 'source' | 'sink' | 'external' | 'cycle';

interface HopNeighbor {
  id: string;
  s: string;
  n: string;
  t: string;
  edge_direction: 'upstream' | 'downstream';
  edge_type: string;
  boundary: BoundaryFlag;
  boundary_reason?: string;
  scope: 'in_scope' | 'available' | 'pruned' | 'external' | 'visited';
  in_filter: boolean;
  cols?: string[];
  fks?: string[];
  hasDdl: boolean;
}

interface WorkingMemory {
  user_question: string;
  all_summaries: Array<{ nodeId: string; summary: string }>;
  pending_questions: Array<{ nodeId: string; question: string }>;
  checklist: { noted: number; total: number; open: number; coveragePct: number };
  hint?: string;
}

interface MapOverview {
  nodes: Array<Record<string, unknown>>;
  edges: Array<[string, string, string]>;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_AGENDA = 200;
const DEFAULT_FINDINGS_HARD_LIMIT = 5000;
const DEFAULT_SUMMARY_HARD_LIMIT = 500;
const BFS_SCOPE_CAP = 10_000;

// ─── Class ─────────────────────────────────────────────────────────────────────

export class BlackboardState {
  private readonly model: DatabaseModel;
  private readonly store: ColumnStore | null;
  private readonly log: LogFn;
  private readonly maxAgendaSize: number;
  private readonly findingsHardLimit: number;
  private readonly summaryHardLimit: number;
  private readonly activeFilter: SerializedFilterState | null;
  private readonly filterSchemas: Set<string> | null;  // lowercased schema names from active filter

  // Lookup caches (built once in constructor)
  private readonly nodeMap: Map<string, LineageNode>;
  private readonly edgeTypeMap: Map<string, string>;
  private readonly unrelatedMap: Map<string, string[]>;

  // Lifecycle
  private _status: BlackboardStatus = 'created';

  // State
  private agenda: AgendaEntry[] = [];
  private agendaIds = new Set<string>();
  private visited = new Set<string>();
  private notes = new Map<string, BlackboardNote>();
  private questionLog: Array<{ nodeId: string; question: string; answered: boolean }> = [];
  private scopeNodeIds = new Set<string>();
  private originNodeId: string | null = null;
  private userQuestion = '';
  private currentFocusNodeId: string | null = null;
  private hopCount = 0;
  private removedSet = new Set<string>();  // pruned + cascade-removed nodes

  constructor(
    model: DatabaseModel,
    log: LogFn,
    config?: BlackboardConfig,
    store?: ColumnStore | null,
  ) {
    this.model = model;
    this.store = store ?? null;
    this.log = log;
    this.maxAgendaSize = config?.maxAgendaSize ?? DEFAULT_MAX_AGENDA;
    this.findingsHardLimit = config?.findingsHardLimit ?? DEFAULT_FINDINGS_HARD_LIMIT;
    this.summaryHardLimit = config?.summaryHardLimit ?? DEFAULT_SUMMARY_HARD_LIMIT;
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
    question: string;
    origin: string;
  }): { ok: true; scopeSize: number; originNode: Record<string, unknown>; map: MapOverview }
     | { error: string; hint?: string } {

    // Reset all mutable state (safe to re-init)
    this.agenda = [];
    this.agendaIds.clear();
    this.visited.clear();
    this.notes.clear();
    this.questionLog = [];
    this.scopeNodeIds.clear();
    this.originNodeId = null;
    this.currentFocusNodeId = null;
    this.hopCount = 0;
    this._status = 'created';

    const { question, origin } = params;
    this.userQuestion = question;

    // Resolve origin
    const originNode = this.nodeMap.get(origin.toLowerCase());
    if (!originNode) {
      this._status = 'error';
      return { error: 'origin_not_found', hint: `Object "${origin}" not found in loaded model.` };
    }

    this.originNodeId = originNode.id;

    // Compute scope via bidirectional BFS (Type 1 has no fixed direction)
    const scopeIds = this.bfsScope(originNode.id);
    this.scopeNodeIds = scopeIds;

    // Seed agenda with BFS-ordered nodes (origin first, then neighbors breadth-first)
    this.seedAgenda(originNode.id);

    // Mark origin as visited (it's implicitly noted as the starting point)
    this.visited.add(originNode.id);

    // Build map overview
    const map = this.buildMapOverview();

    this._status = 'initialized';
    this.log('info', `BB INIT | origin=${originNode.id} | question="${question}" | scope=${scopeIds.size} | agenda=${this.agenda.length}`);

    return {
      ok: true,
      scopeSize: scopeIds.size,
      originNode: strip(presentNode(originNode, this.model.neighborIndex)),
      map,
    };
  }

  // ─── getHopContext ─────────────────────────────────────────────────────────

  getHopContext():
    | { bb_mode: 'exploring'; hop: number; focus_node: Record<string, unknown>;
        cascade_if_irrelevant: number; neighbors: HopNeighbor[];
        current_task: string; working_memory: WorkingMemory;
        agenda_remaining: number }
    | { done: true; nodes_outside_scope?: number; hint?: string }
    | { error: string } {

    if (this._status !== 'initialized' && this._status !== 'exploring') {
      return { error: `Cannot get hop context in status "${this._status}"` };
    }

    // Pop highest-priority unvisited entry from agenda (iterative — no recursion)
    let entry: AgendaEntry | undefined;
    let node: LineageNode | undefined;
    while (true) {
      entry = this.popNextAgendaEntry();
      if (!entry) {
        this._status = 'complete';
        const outsideScope = this.scopeNodeIds.size - this.visited.size - this.removedSet.size;
        this.log('info', `BB COMPLETE | agenda exhausted | notes=${this.notes.size} | visited=${this.visited.size} | pruned=${this.removedSet.size} | outside_scope=${Math.max(0, outsideScope)}`);
        return {
          done: true,
          ...(outsideScope > 0 && {
            nodes_outside_scope: outsideScope,
            hint: 'All agenda nodes explored. More nodes available in the model — ask a question to explore further.',
          }),
        };
      }
      node = this.nodeMap.get(entry.nodeId);
      if (node) break;
      this.log('warn', `BB node ${entry.nodeId} missing from model, skipping`);
    }

    this.visited.add(entry.nodeId);
    this.hopCount++;
    this.currentFocusNodeId = entry.nodeId;

    // Build focus node detail (same pattern as ColumnTraceState.getHopContext)
    const focusNode = this.buildFocusNode(node);

    // Build neighbor list
    const neighbors = this.buildNeighborList(node.id);

    // Current task: Self-Ask question or default
    const currentTask = entry.question
      ?? `Analyze ${node.id} — what is its role, business logic, and key data flows?`;

    // Build working memory
    const workingMemory = this.buildWorkingMemory();

    this._status = 'awaiting_findings';
    const pct = this.scopeNodeIds.size > 0
      ? Math.round((this.notes.size / this.scopeNodeIds.size) * 100) : 0;
    this.log('info', `BB Hop ${this.hopCount} | ${node.id} | neighbors=${neighbors.length} | notes=${this.notes.size}/${this.scopeNodeIds.size} (${pct}%) | agenda=${this.agenda.length}`);

    // Cascade preview: show consequence of marking this node irrelevant
    const cascadePreview = this.countCascadeIfIrrelevant(entry.nodeId);

    return {
      bb_mode: 'exploring',
      hop: this.hopCount,
      focus_node: focusNode,
      cascade_if_irrelevant: cascadePreview,
      neighbors,
      current_task: currentTask,
      working_memory: workingMemory,
      agenda_remaining: this.agenda.length,
    };
  }

  // ─── submitFindings ────────────────────────────────────────────────────────

  submitFindings(params: {
    focusNodeId: string;
    findings: string;
    summary: string;
    tags?: string[];
    questions?: Array<{ nodeId: string; question: string }>;
    verdict: 'relevant' | 'noted' | 'irrelevant';
  }): { ok: true; advanced: number; agendaSize: number; pruned?: number }
     | { error: string; limit?: number; hint?: string } {

    if (this._status !== 'awaiting_findings') {
      return { error: `Cannot submit findings in status "${this._status}"` };
    }

    const { focusNodeId, findings, summary, tags, questions, verdict } = params;

    // Validate focus node
    if (focusNodeId !== this.currentFocusNodeId) {
      return { error: `Focus node mismatch: expected "${this.currentFocusNodeId}", got "${focusNodeId}"` };
    }

    // Reject if node was already pruned (cascade edge case)
    if (this.removedSet.has(focusNodeId)) {
      return { error: 'node_pruned', hint: `${focusNodeId} was cascade-removed. It cannot be analyzed.` };
    }

    // Hard limits — reject, never truncate
    if (findings.length > this.findingsHardLimit) {
      return { error: 'findings_too_long', limit: this.findingsHardLimit };
    }
    if (summary.length > this.summaryHardLimit) {
      return { error: 'summary_too_long', limit: this.summaryHardLimit };
    }

    // Store note (long-term memory slot) — even for 'irrelevant' (minimal note)
    const node = this.nodeMap.get(focusNodeId);
    if (node) {
      this.notes.set(focusNodeId, {
        nodeId: focusNodeId,
        schema: node.schema,
        name: node.name,
        type: node.type,
        findings: verdict === 'irrelevant' ? summary : findings,
        summary,
        tags,
      });
    }

    // Mark any pending questions for this node as answered
    for (const q of this.questionLog) {
      if (q.nodeId === focusNodeId && !q.answered) {
        q.answered = true;
      }
    }

    let advanced = 0;
    let pruned = 0;

    // Verdict: cascade-prune on 'irrelevant'
    if (verdict === 'irrelevant') {
      pruned = this.cascadePrune(focusNodeId);
      this.log('info', `BB PRUNE | ${focusNodeId} | verdict=irrelevant | cascade=${pruned} | agenda=${this.agenda.length}`);
    }

    // Process questions (Self-Ask: boost/add nodes to agenda)
    if (questions?.length) {
      for (const q of questions) {
        // Reject questions targeting pruned nodes
        if (this.removedSet.has(q.nodeId)) {
          this.log('debug', `BB question for pruned ${q.nodeId}, ignoring`);
          continue;
        }
        this.addQuestion(q.nodeId, q.question);
        advanced++;
      }
    }

    this._status = 'exploring';
    this.log('info', `BB submit | ${focusNodeId} | verdict=${verdict} | findings=${findings.length}ch | questions=${questions?.length ?? 0} | pruned=${pruned} | agenda=${this.agenda.length}`);

    return { ok: true, advanced, agendaSize: this.agenda.length, ...(pruned > 0 && { pruned }) };
  }

  // ─── getResult ─────────────────────────────────────────────────────────────

  getResult(): {
    status: 'complete';
    question: string;
    notes: BlackboardNote[];
    fullNodes: Array<Record<string, unknown>>;
    edges: Array<[string, string, string]>;
    stats: {
      hops: number; noted: number; scopeSize: number; coveragePct: number;
      questionsAsked: number; questionsAnswered: number;
    };
  } | { error: string } {

    if (this._status === 'created' || this._status === 'awaiting_findings') {
      return { error: `Cannot get result in status "${this._status}"` };
    }

    this._status = 'complete';

    const allNotes = [...this.notes.values()];
    const notedIds = new Set(this.notes.keys());

    // Full nodes: DDL for script types, columns for tables (same as CT getResult)
    const fullNodes: Array<Record<string, unknown>> = [];
    for (const noteEntry of allNotes) {
      const node = this.nodeMap.get(noteEntry.nodeId);
      if (!node) continue;
      const base: Record<string, unknown> = {
        id: node.id, s: node.schema, n: node.name, t: node.type,
      };
      if (SCRIPT_TYPES.has(node.type)) {
        const ddl = this.getNodeDdl(node.id);
        if (ddl) base.ddl = ddl;
      }
      const cols = this.getNodeColumns(node.id);
      if (cols?.length) {
        base.cols = cols.map(c => presentColumnCompact(c));
      }
      fullNodes.push(strip(base));
    }

    // Edges between noted nodes
    const edges: Array<[string, string, string]> = [];
    for (const e of this.model.edges) {
      if (notedIds.has(e.source) && notedIds.has(e.target)) {
        edges.push([e.source, e.target, edgeApiType(e.type)]);
      }
    }

    const questionsAsked = this.questionLog.length;
    const questionsAnswered = this.questionLog.filter(q => q.answered).length;
    const coveragePct = this.scopeNodeIds.size > 0
      ? Math.round((this.notes.size / this.scopeNodeIds.size) * 100) : 0;

    this.log('info', `BB RESULT | notes=${allNotes.length} | scope=${this.scopeNodeIds.size} | coverage=${coveragePct}% | hops=${this.hopCount} | questions=${questionsAnswered}/${questionsAsked}`);

    return {
      status: 'complete',
      question: this.userQuestion,
      notes: allNotes,
      fullNodes,
      edges,
      stats: {
        hops: this.hopCount,
        noted: allNotes.length,
        scopeSize: this.scopeNodeIds.size,
        coveragePct,
        questionsAsked,
        questionsAnswered,
      },
    };
  }

  // ─── Public accessors ──────────────────────────────────────────────────────

  get status(): BlackboardStatus { return this._status; }
  get noteCount(): number { return this.notes.size; }

  /** Estimate total DDL chars in scope (for token budget gate in extension.ts). */
  estimateScopeDdlChars(): number {
    let total = 0;
    for (const id of this.scopeNodeIds) {
      const node = this.nodeMap.get(id);
      if (node && SCRIPT_TYPES.has(node.type)) {
        const ddl = this.getNodeDdl(id);
        if (ddl) total += ddl.length;
      }
    }
    return total;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private getNodeColumns(nodeId: string): ColumnDef[] | undefined {
    return this.store?.getColumns(nodeId) ?? this.nodeMap.get(nodeId)?.columns;
  }

  private getNodeDdl(nodeId: string): string | undefined {
    const raw = this.store?.getDdl(nodeId) ?? this.nodeMap.get(nodeId)?.bodyScript;
    return raw ? normalizeBodyScript(raw) : undefined;
  }

  /** Bidirectional BFS from origin to compute reachable scope. */
  private bfsScope(startId: string): Set<string> {
    const seen = new Set<string>([startId]);
    const queue = [startId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const nb = this.model.neighborIndex[id] ?? { in: [], out: [] };
      const allNeighbors = [...new Set([...nb.in, ...nb.out])];
      for (const nid of allNeighbors) {
        if (!seen.has(nid)) {
          seen.add(nid);
          queue.push(nid);
          if (seen.size >= BFS_SCOPE_CAP) return seen;
        }
      }
    }
    return seen;
  }

  /** Seed agenda with BFS-ordered nodes from origin (bidirectional). */
  private seedAgenda(originId: string): void {
    const queue: Array<{ id: string; depth: number }> = [];
    const seen = new Set<string>([originId]);

    // Start with origin's neighbors
    const nb = this.model.neighborIndex[originId] ?? { in: [], out: [] };
    const neighbors = [...new Set([...nb.in, ...nb.out])];
    for (const nid of neighbors) {
      if (!seen.has(nid) && this.scopeNodeIds.has(nid)) {
        seen.add(nid);
        queue.push({ id: nid, depth: 1 });
      }
    }

    // BFS to fill agenda
    let idx = 0;
    while (idx < queue.length) {
      const { id, depth } = queue[idx++];
      if (this.agenda.length >= this.maxAgendaSize) {
        this.log('warn', `BB agenda cap (${this.maxAgendaSize}) reached during seed`);
        break;
      }
      this.agenda.push({ nodeId: id, priority: 0, depth });
      this.agendaIds.add(id);

      const nbInner = this.model.neighborIndex[id] ?? { in: [], out: [] };
      const innerNeighbors = [...new Set([...nbInner.in, ...nbInner.out])];
      for (const nid of innerNeighbors) {
        if (!seen.has(nid) && this.scopeNodeIds.has(nid)) {
          seen.add(nid);
          queue.push({ id: nid, depth: depth + 1 });
        }
      }
    }
  }

  /** Pop the highest-priority unvisited entry from agenda. */
  private popNextAgendaEntry(): AgendaEntry | undefined {
    while (this.agenda.length > 0) {
      // Sort by priority descending (stable: FIFO within same priority via insertion order)
      this.agenda.sort((a, b) => b.priority - a.priority);
      const entry = this.agenda.shift()!;
      this.agendaIds.delete(entry.nodeId);
      if (!this.visited.has(entry.nodeId) && this.nodeMap.has(entry.nodeId)) {
        return entry;
      }
    }
    return undefined;
  }

  /** Add a Self-Ask question, boosting the target node's agenda priority. */
  private addQuestion(nodeId: string, question: string): void {
    this.questionLog.push({ nodeId, question, answered: false });

    if (!this.nodeMap.has(nodeId)) {
      this.log('debug', `BB question for unknown node ${nodeId}, ignoring`);
      return;
    }

    if (this.visited.has(nodeId)) {
      this.log('debug', `BB question for already-visited ${nodeId}, skipping agenda boost`);
      return;
    }

    const existing = this.agenda.find(e => e.nodeId === nodeId);
    if (existing) {
      // Boost priority and attach question
      existing.priority = 2;
      existing.question = question;
    } else {
      // Auto-expand scope if needed
      if (!this.scopeNodeIds.has(nodeId)) {
        this.scopeNodeIds.add(nodeId);
        this.log('debug', `BB auto-expanded scope: ${nodeId}`);
      }
      if (this.agenda.length < this.maxAgendaSize) {
        this.agenda.push({ nodeId, question, priority: 2, depth: 0 });
        this.agendaIds.add(nodeId);
      } else {
        this.log('warn', `BB agenda cap — question for ${nodeId} dropped`);
      }
    }
  }

  /** Build focus node detail with DDL/cols/FKs (same data as ColumnTraceState). */
  private buildFocusNode(node: LineageNode): Record<string, unknown> {
    const focusNode: Record<string, unknown> = {
      id: node.id,
      s: node.schema,
      n: node.name,
      t: node.type,
    };

    const nodeDdl = this.getNodeDdl(node.id);
    const nodeCols = this.getNodeColumns(node.id);
    if (SCRIPT_TYPES.has(node.type) && nodeDdl) {
      focusNode.bb_ddl = nodeDdl; // Full DDL — never truncated
    } else if (nodeCols?.length) {
      focusNode.cols = nodeCols.map(c => presentColumnCompact(c));
    }

    // FK info
    if (node.fks?.length) {
      focusNode.fks = node.fks.map(fk => presentFkCompact(fk));
    }

    // Unresolved refs
    const unrelKey = `${node.schema}.${node.name}`.toLowerCase();
    const unrel = this.unrelatedMap.get(unrelKey);
    if (unrel?.length) focusNode.unresolved_refs = unrel;

    return strip(focusNode) as Record<string, unknown>;
  }

  /** Build neighbor list with edge info, boundary detection, compact cols/FKs. */
  private buildNeighborList(focusId: string): HopNeighbor[] {
    const nb = this.model.neighborIndex[focusId] ?? { in: [], out: [] };
    const allNeighborIds = [...new Set([...nb.in, ...nb.out])];
    const inSet = new Set(nb.in);
    const neighbors: HopNeighbor[] = [];

    for (const nid of allNeighborIds) {
      const nNode = this.nodeMap.get(nid);
      if (!nNode) continue;

      const isUpstream = inSet.has(nid);
      const primaryKey = isUpstream ? `${nid}→${focusId}` : `${focusId}→${nid}`;
      const reverseKey = isUpstream ? `${focusId}→${nid}` : `${nid}→${focusId}`;
      let edgeType = this.edgeTypeMap.get(primaryKey) ?? this.edgeTypeMap.get(reverseKey) ?? 'read';

      const boundary = this.detectBoundary(nid);

      // Scope status: what is this neighbor's status in the exploration?
      const scopeStatus: HopNeighbor['scope'] =
        this.visited.has(nid)       ? 'visited' :
        this.removedSet.has(nid)    ? 'pruned' :
        this.agendaIds.has(nid)     ? 'in_scope' :
        !this.nodeMap.has(nid)      ? 'external' :
                                      'available';

      const neighbor: HopNeighbor = {
        id: nid,
        s: nNode.schema,
        n: nNode.name,
        t: nNode.type,
        edge_direction: isUpstream ? 'upstream' : 'downstream',
        edge_type: edgeType,
        boundary,
        scope: scopeStatus,
        in_filter: this.isInFilter(nid),
        hasDdl: SCRIPT_TYPES.has(nNode.type) && !!this.getNodeDdl(nid),
      };

      if (boundary !== 'none') {
        neighbor.boundary_reason = this.boundaryReason(boundary, nNode);
      }

      const nCols = this.getNodeColumns(nid);
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

  private detectBoundary(nodeId: string): BoundaryFlag {
    const node = this.nodeMap.get(nodeId);
    if (!node) return 'external';
    if (node.type === 'external') return 'external';
    if (this.visited.has(nodeId)) return 'cycle';
    const nb = this.model.neighborIndex[nodeId] ?? { in: [], out: [] };
    // Bidirectional: source = no incoming, sink = no outgoing
    if (nb.in.length === 0) return 'source';
    if (nb.out.length === 0) return 'sink';
    return 'none';
  }

  private boundaryReason(flag: BoundaryFlag, node: LineageNode): string {
    switch (flag) {
      case 'source': return 'No upstream dependencies — source boundary';
      case 'sink': return 'No downstream consumers — sink boundary';
      case 'external': return `External reference (${node.externalType ?? 'unknown'}) — no DDL available`;
      case 'cycle': return 'Already visited — cycle detected';
      default: return '';
    }
  }

  /** Build working memory snapshot: ALL summaries, ALL pending questions, checklist. */
  private buildWorkingMemory(): WorkingMemory {
    const allSummaries: Array<{ nodeId: string; summary: string }> = [];
    for (const note of this.notes.values()) {
      allSummaries.push({ nodeId: note.nodeId, summary: note.summary });
    }

    const pendingQuestions: Array<{ nodeId: string; question: string }> = [];
    for (const q of this.questionLog) {
      if (!q.answered) {
        pendingQuestions.push({ nodeId: q.nodeId, question: q.question });
      }
    }

    const noted = this.notes.size;
    const total = this.scopeNodeIds.size;
    const open = this.agenda.length;
    const coveragePct = total > 0 ? Math.round((noted / total) * 100) : 0;

    const wm: WorkingMemory = {
      user_question: this.userQuestion,
      all_summaries: allSummaries,
      pending_questions: pendingQuestions,
      checklist: { noted, total, open, coveragePct },
    };

    if (coveragePct >= 80) {
      wm.hint = 'High coverage — consider finishing exploration if you have enough information.';
    }

    return wm;
  }

  /** Build map overview for init response. */
  private buildMapOverview(): MapOverview {
    const nodes: Array<Record<string, unknown>> = [];
    for (const id of this.scopeNodeIds) {
      const node = this.nodeMap.get(id);
      if (node) {
        nodes.push(strip(presentNode(node, this.model.neighborIndex)));
      }
    }

    // Edges between scope nodes only
    const edges: Array<[string, string, string]> = [];
    for (const e of this.model.edges) {
      if (this.scopeNodeIds.has(e.source) && this.scopeNodeIds.has(e.target)) {
        edges.push([e.source, e.target, edgeApiType(e.type)]);
      }
    }

    return { nodes, edges };
  }

  // ─── Cascade pruning via BFS reachability ──────────────────────────────────

  /** Cascade-remove agenda nodes unreachable from origin after pruning a node. */
  private cascadePrune(prunedId: string): number {
    this.removedSet.add(prunedId);
    // BFS from origin through live nodes (not removed, in scope)
    const reachable = new Set<string>();
    const queue = [this.originNodeId!];
    reachable.add(this.originNodeId!);
    while (queue.length > 0) {
      const id = queue.shift()!;
      const nb = this.model.neighborIndex[id] ?? { in: [], out: [] };
      for (const nid of [...new Set([...nb.in, ...nb.out])]) {
        if (!reachable.has(nid) && !this.removedSet.has(nid) && this.scopeNodeIds.has(nid)) {
          reachable.add(nid);
          queue.push(nid);
        }
      }
    }
    // Remove unreachable agenda nodes
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

  /** Preview: how many agenda nodes would be cascade-removed if this node were pruned. */
  countCascadeIfIrrelevant(nodeId: string): number {
    // Simulate: temporarily add nodeId to removed, BFS, count unreachable agenda nodes
    const tempRemoved = new Set(this.removedSet);
    tempRemoved.add(nodeId);
    const reachable = new Set<string>();
    const queue = [this.originNodeId!];
    reachable.add(this.originNodeId!);
    while (queue.length > 0) {
      const id = queue.shift()!;
      const nb = this.model.neighborIndex[id] ?? { in: [], out: [] };
      for (const nid of [...new Set([...nb.in, ...nb.out])]) {
        if (!reachable.has(nid) && !tempRemoved.has(nid) && this.scopeNodeIds.has(nid)) {
          reachable.add(nid);
          queue.push(nid);
        }
      }
    }
    return this.agenda.filter(e => !reachable.has(e.nodeId)).length;
  }

  // ─── Scope reporting (information only — never filters or constrains) ────────

  /** Check if a node's schema matches the user's active filter. */
  isInFilter(nodeId: string): boolean {
    if (!this.filterSchemas) return true; // no filter = everything matches
    const node = this.nodeMap.get(nodeId);
    return !!node && this.filterSchemas.has(node.schema.toLowerCase());
  }

  /** Count agenda/scope nodes per schema — for scope preview. */
  schemaBreakdown(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const id of this.scopeNodeIds) {
      const node = this.nodeMap.get(id);
      if (node) counts[node.schema] = (counts[node.schema] || 0) + 1;
    }
    return counts;
  }

  /** Count scope nodes matching vs outside user filter — for scope preview. */
  get filterBreakdown(): { in_filter: number; outside_filter: number; total: number } {
    if (!this.filterSchemas) return { in_filter: this.scopeNodeIds.size, outside_filter: 0, total: this.scopeNodeIds.size };
    let inFilter = 0;
    for (const id of this.scopeNodeIds) {
      if (this.isInFilter(id)) inFilter++;
    }
    return { in_filter: inFilter, outside_filter: this.scopeNodeIds.size - inFilter, total: this.scopeNodeIds.size };
  }
}
