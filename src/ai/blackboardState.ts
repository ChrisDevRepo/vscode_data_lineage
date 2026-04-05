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

import type Graph from 'graphology';
import type { DatabaseModel, LineageNode, ObjectType } from '../engine/types';
import type { ColumnStore } from '../engine/columnStore';
import type { SerializedFilterState } from '../engine/projectStore';
import { buildNodeMap, buildEdgeTypeMap, buildUnrelatedMap, SCRIPT_TYPES, getNodeColumns, getNodeDdl, buildHopFocusNode } from './tools';
import { presentNode, presentColumnCompact, presentFkCompact, strip, edgeApiType } from './aiPresenter';
import { wouldOrphanNotedNode, countCascadeIfPruned, validateNodeIds, findBridgeNodes, bfsReachable } from './smGuards';

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
  activeFilter?: SerializedFilterState | null;  // user's active filter — applied as BFS schema boundary
  scopeDirection?: 'upstream' | 'downstream' | 'bidirectional';  // default 'bidirectional'; upstream=inNeighbors, downstream=outNeighbors
}

export type LogFn = (level: 'info' | 'debug' | 'warn' | 'trace', msg: string) => void;

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
  invalid_nodes?: Array<{ id: string; reason: 'not_in_model' | 'out_of_scope' | 'not_in_filter' }>;
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
const SCOPE_DIRECTION_GATE = 200;  // bidirectional scope above this requires explicit direction
const COVERAGE_HINT_THRESHOLD = 80;  // % — suggest finishing exploration above this
const CASCADE_REJECT_THRESHOLD = 0.5;  // reject prune if cascade removes >50% of remaining agenda

// ─── Class ─────────────────────────────────────────────────────────────────────

export class BlackboardState {
  private readonly model: DatabaseModel;
  private readonly graph: Graph;
  private readonly store: ColumnStore | null;
  private readonly log: LogFn;
  private readonly maxAgendaSize: number;
  private readonly findingsHardLimit: number;
  private readonly summaryHardLimit: number;
  private readonly activeFilter: SerializedFilterState | null;
  private readonly filterSchemas: Set<string> | null;  // lowercased schema names from active filter — applied as BFS boundary
  private readonly scopeDirection: 'upstream' | 'downstream' | 'bidirectional';

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
  private invalidNodeIds = new Map<string, 'not_in_model' | 'out_of_scope' | 'not_in_filter'>();

  constructor(
    model: DatabaseModel,
    graph: Graph,
    log: LogFn,
    config?: BlackboardConfig,
    store?: ColumnStore | null,
  ) {
    this.model = model;
    this.graph = graph;
    this.store = store ?? null;
    this.log = log;
    this.maxAgendaSize = config?.maxAgendaSize ?? DEFAULT_MAX_AGENDA;
    this.findingsHardLimit = config?.findingsHardLimit ?? DEFAULT_FINDINGS_HARD_LIMIT;
    this.summaryHardLimit = config?.summaryHardLimit ?? DEFAULT_SUMMARY_HARD_LIMIT;
    this.activeFilter = config?.activeFilter ?? null;
    this.filterSchemas = this.activeFilter?.schemas?.length
      ? new Set(this.activeFilter.schemas.map(s => s.toLowerCase()))
      : null;
    this.scopeDirection = config?.scopeDirection ?? 'bidirectional';
    this.nodeMap = buildNodeMap(model);
    this.edgeTypeMap = buildEdgeTypeMap(model);
    this.unrelatedMap = buildUnrelatedMap(model);
  }

  // ─── init ──────────────────────────────────────────────────────────────────

  init(params: {
    question: string;
    origin: string;
  }): { ok: true; scopeSize: number; agendaSize: number; originNode: Record<string, unknown>; map: MapOverview }
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
      this.log('debug', `BB INIT ERROR: origin "${origin}" not found`);
      return { error: 'origin_not_found', hint: `Object "${origin}" not found in loaded model.` };
    }

    this.originNodeId = originNode.id;

    // Compute scope — direction-aware BFS + filter boundary
    const scopeIds = this.bfsScope(originNode.id);
    this.scopeNodeIds = scopeIds;

    // Hard gate: bidirectional BFS on a large scope requires explicit direction declaration.
    // Without a direction the AI gets a huge noisy map (e.g. 661 nodes for a central table).
    // scopeNodeIds is set above so filterBreakdown is available.
    if (scopeIds.size > SCOPE_DIRECTION_GATE && this.scopeDirection === 'bidirectional') {
      this._status = 'error';
      const bd = this.filterBreakdown;
      this.log('warn', `BB INIT rejected — scope_too_broad | scope=${scopeIds.size} | direction=bidirectional`);
      return {
        error: 'scope_too_broad',
        scope_size: scopeIds.size,
        in_filter: bd.in_filter,
        outside_filter: bd.outside_filter,
        hint: `Scope is ${scopeIds.size} nodes (bidirectional BFS). Resubmit start_exploration with scope_direction='upstream' for source/ancestor queries or scope_direction='downstream' for impact/consumer queries.`,
      } as unknown as ReturnType<BlackboardState['init']>;
    }

    // Seed agenda with BFS-ordered nodes, respecting direction
    this.seedAgenda(originNode.id);

    // Mark origin as visited (it's implicitly noted as the starting point)
    this.visited.add(originNode.id);

    // Build map overview
    const map = this.buildMapOverview();

    this._status = 'initialized';
    this.log('info', `BB INIT | origin=${originNode.id} | question="${question}" | direction=${this.scopeDirection} | scope=${scopeIds.size} | agenda=${this.agenda.length}`);
    this.log('debug', `BB INIT detail | origin=${originNode.id} (${originNode.type}) | direction=${this.scopeDirection} | bfs_scope=${scopeIds.size}${scopeIds.size >= BFS_SCOPE_CAP ? ' (CAPPED)' : ''} | agenda=${this.agenda.length} | map_nodes=${map.nodes.length} | map_edges=${map.edges.length}`);

    return {
      ok: true,
      scopeSize: scopeIds.size,
      agendaSize: this.agenda.length,
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
      this.log('debug', `BB getHopContext: invalid status "${this._status}"`);
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
    const focusNode = buildHopFocusNode(node, this.nodeMap, this.unrelatedMap, this.store ?? undefined, 'bb_ddl');

    // Build neighbor list
    const neighbors = this.buildNeighborList(node.id);

    // Current task: Self-Ask question or default
    const currentTask = entry.question
      ?? `Analyze ${node.id} — what is its role, business logic, and key data flows?`;

    // Build working memory
    const workingMemory = this.buildWorkingMemory();

    this._status = 'awaiting_findings';
    this.log('info', `BB Hop ${this.hopCount} | ${node.id} | neighbors=${neighbors.length} | visited=${this.notes.size} | pruned=${this.removedSet.size} | agenda=${this.agenda.length}`);
    this.log('debug', `BB Hop ${this.hopCount} detail | ${node.id} (${node.type}) | priority=${entry.priority} | task=${entry.question ? 'self-ask' : 'default'} | memory: ${workingMemory.all_summaries.length} summaries, ${workingMemory.pending_questions.length} pending Qs | coverage=${this.coveragePct}%`);

    // Cascade preview: show consequence of marking this node irrelevant
    const cascadePreview = this.countCascadeIfIrrelevant(entry.nodeId);
    if (cascadePreview > 0) {
      this.log('debug', `BB Hop ${this.hopCount} cascade preview | if irrelevant → ${cascadePreview} nodes would be pruned`);
    }

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
    pruneIds?: string[];
    complete?: boolean;
  }): { ok: true; advanced: number; agendaSize: number; pruned?: number;
        rejected_prune_ids?: Array<{ id: string; reason: string }>;
        invalid_questions?: Array<{ node_id: string; question: string; reason: string }>;
        early_complete?: ReturnType<BlackboardState['getResult']> }
     | { error: string; limit?: number; hint?: string } {

    if (this._status !== 'awaiting_findings') {
      this.log('debug', `BB submitFindings: invalid status "${this._status}"`);
      return { error: `Cannot submit findings in status "${this._status}"` };
    }

    const { focusNodeId, findings, summary, questions, verdict } = params;

    // Coerce AI inputs — VS Code doesn't enforce JSON Schema types on tool inputs
    const tags = Array.isArray(params.tags) ? params.tags
      : typeof params.tags === 'string' ? (params.tags as string).split(',').map(t => t.trim())
      : undefined;
    const pruneIds = Array.isArray(params.pruneIds) ? params.pruneIds
      : typeof params.pruneIds === 'string' ? [params.pruneIds as string]
      : undefined;

    // Validate focus node
    if (focusNodeId !== this.currentFocusNodeId) {
      this.log('debug', `BB submitFindings: focus mismatch — expected="${this.currentFocusNodeId}", got="${focusNodeId}"`);
      return { error: `Focus node mismatch: expected "${this.currentFocusNodeId}", got "${focusNodeId}"` };
    }

    // Reject if node was already pruned (cascade edge case)
    if (this.removedSet.has(focusNodeId)) {
      this.log('debug', `BB submitFindings: node already pruned via cascade — ${focusNodeId}`);
      return { error: 'node_pruned', hint: `${focusNodeId} was cascade-removed. It cannot be analyzed.` };
    }

    // Hard limits — reject, never truncate
    if (findings.length > this.findingsHardLimit) {
      this.log('debug', `BB submitFindings: findings too long (${findings.length} > ${this.findingsHardLimit})`);
      return { error: 'findings_too_long', limit: this.findingsHardLimit };
    }
    if (summary.length > this.summaryHardLimit) {
      this.log('debug', `BB submitFindings: summary too long (${summary.length} > ${this.summaryHardLimit})`);
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

    // Process questions (Self-Ask: boost/add nodes to agenda) — validate node existence first
    const invalidQuestions: Array<{ node_id: string; question: string; reason: string }> = [];
    if (questions?.length) {
      const { valid, invalid } = validateNodeIds(
        this.nodeMap,
        questions.map(q => ({ nodeId: q.nodeId, question: q.question })),
      );
      for (const inv of invalid) {
        invalidQuestions.push({ node_id: inv.nodeId, question: inv.question, reason: inv.reason });
        this.log('info', `BB QUESTION REJECTED | ${inv.nodeId} | ${inv.reason}`);
        this.invalidNodeIds.set(inv.nodeId, 'not_in_model');
      }
      for (const q of valid) {
        if (this.removedSet.has(q.nodeId)) {
          this.log('debug', `BB question for pruned ${q.nodeId}, skipping`);
          continue;
        }
        this.addQuestion(q.nodeId, q.question);
        advanced++;
      }
    }

    // Prune specific neighbor nodes from agenda (+ cascade downstream) — with guards
    const rejectedPrunes: Array<{ id: string; reason: string }> = [];
    if (pruneIds?.length) {
      const notedIdSet = new Set(this.notes.keys());
      for (const pruneId of pruneIds) {
        if (pruneId === this.originNodeId) continue;
        if (this.visited.has(pruneId)) continue;
        if (this.removedSet.has(pruneId)) continue;
        if (!this.scopeNodeIds.has(pruneId)) {
          const existsInModel = this.nodeMap.has(pruneId);
          let reason: 'not_in_model' | 'out_of_scope' | 'not_in_filter';
          if (!existsInModel) {
            reason = 'not_in_model';
          } else if (this.filterSchemas !== null) {
            const nodeForFilter = this.nodeMap.get(pruneId)!;
            reason = this.filterSchemas.has(nodeForFilter.schema.toLowerCase()) ? 'out_of_scope' : 'not_in_filter';
          } else {
            reason = 'out_of_scope';
          }
          rejectedPrunes.push({ id: pruneId, reason });
          this.invalidNodeIds.set(pruneId, reason);
          this.log('info', `BB PRUNE REJECTED | ${pruneId} | ${reason}`);
          continue;
        }

        // Guard 1: would orphan a noted node from origin?
        const orphanedId = wouldOrphanNotedNode(this.graph, this.originNodeId!, this.removedSet, notedIdSet, pruneId);
        if (orphanedId) {
          rejectedPrunes.push({ id: pruneId, reason: `Would disconnect "${orphanedId}" from origin. Use a different prune target.` });
          this.log('info', `BB PRUNE REJECTED | ${pruneId} | would orphan ${orphanedId}`);
          continue;
        }

        // Guard 2: catastrophic cascade? (>50% of remaining agenda)
        const cascadeCount = countCascadeIfPruned(this.graph, this.originNodeId!, this.removedSet, this.scopeNodeIds, this.agendaIds, pruneId);
        if (cascadeCount > this.agenda.length * CASCADE_REJECT_THRESHOLD) {
          rejectedPrunes.push({ id: pruneId, reason: `Cascade would remove ${cascadeCount} of ${this.agenda.length} remaining agenda nodes (>${50}%). Explore more nodes first or use a narrower prune.` });
          this.log('warn', `BB PRUNE REJECTED | ${pruneId} | cascade=${cascadeCount} > 50% of agenda (${this.agenda.length})`);
          continue;
        }

        pruned += this.cascadePrune(pruneId);
        this.log('info', `BB PRUNE | ${pruneId} | cascade=${pruned} | agenda=${this.agenda.length}`);
      }
    }

    this._status = 'exploring';
    this.log('info', `BB submit | ${focusNodeId} | verdict=${verdict} | findings=${findings.length}ch | questions=${questions?.length ?? 0} | pruned=${pruned} | agenda=${this.agenda.length}`);
    this.log('debug', `BB submit detail | ${focusNodeId} | summary=${summary.length}ch | tags=[${tags?.join(',') ?? ''}] | advanced=${advanced} | notes_total=${this.notes.size} | coverage=${this.coveragePct}%`);

    const base = {
      ok: true as const, advanced, agendaSize: this.agenda.length,
      ...(pruned > 0 && { pruned }),
      ...(rejectedPrunes.length > 0 && { rejected_prune_ids: rejectedPrunes }),
      ...(invalidQuestions.length > 0 && { invalid_questions: invalidQuestions }),
    };

    // Early completion: AI signals it has enough findings to answer the question
    if (params.complete) {
      this.log('info', `BB EARLY COMPLETE | notes=${this.notes.size} | coverage=${this.coveragePct}% | agenda_remaining=${this.agenda.length}`);
      return { ...base, early_complete: this.getResult() };
    }

    return base;
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
      this.log('debug', `BB getResult: invalid status "${this._status}"`);
      return { error: `Cannot get result in status "${this._status}"` };
    }

    this._status = 'complete';

    const allNotes = [...this.notes.values()];
    const notedIds = new Set(this.notes.keys());

    // anchoredIds = noted nodes + origin — ensures hub/star edges (SP→origin) are included
    // and bridge injection always has a connected anchor even when no noted-to-noted edges exist
    const anchoredIds = new Set([...notedIds, this.originNodeId!]);

    // Full nodes: origin first (role='origin'), then noted nodes with DDL/columns
    const fullNodes: Array<Record<string, unknown>> = [];
    const originNode = this.nodeMap.get(this.originNodeId!);
    if (originNode) {
      fullNodes.push(strip({ id: originNode.id, s: originNode.schema, n: originNode.name, t: originNode.type, role: 'origin' }));
    }
    for (const noteEntry of allNotes) {
      const node = this.nodeMap.get(noteEntry.nodeId);
      if (!node) continue;
      const base: Record<string, unknown> = {
        id: node.id, s: node.schema, n: node.name, t: node.type,
      };
      if (SCRIPT_TYPES.has(node.type)) {
        const ddl = getNodeDdl(node.id, this.nodeMap, this.store ?? undefined);
        if (ddl) base.ddl = ddl;
      }
      const cols = getNodeColumns(node.id, this.nodeMap, this.store ?? undefined);
      if (cols?.length) {
        base.cols = cols.map(c => presentColumnCompact(c));
      }
      fullNodes.push(strip(base));
    }

    // Edges: include all edges where both endpoints are in anchoredIds (noted nodes + origin)
    // This captures SP→origin edges in hub/star topologies that notedIds-only filtering dropped
    const edges: Array<[string, string, string]> = [];
    for (const e of this.model.edges) {
      if (anchoredIds.has(e.source) && anchoredIds.has(e.target)) {
        edges.push([e.source, e.target, edgeApiType(e.type)]);
      }
    }

    // Bridge injection: reconnect orphan noted nodes via shortest path through graph
    // anchoredIds ensures origin serves as anchor — edgeParticipants is never empty
    const bridgeResult = findBridgeNodes(this.graph, anchoredIds, edges, this.edgeTypeMap);
    if (bridgeResult.bridgeNodes.length > 0) {
      for (const bn of bridgeResult.bridgeNodes) {
        fullNodes.push(strip({ id: bn.id, s: bn.schema, n: bn.name, t: bn.type, role: 'bridge' }));
      }
      edges.push(...bridgeResult.bridgeEdges);
      this.log('info', `BB BRIDGE | orphans=${bridgeResult.orphanCount} | reconnected=${bridgeResult.reconnectedCount} | bridges=${bridgeResult.bridgeNodes.length} nodes, ${bridgeResult.bridgeEdges.length} edges`);
    }

    const questionsAsked = this.questionLog.length;
    const questionsAnswered = this.questionLog.filter(q => q.answered).length;

    this.log('info', `BB RESULT | notes=${allNotes.length} | edges=${edges.length} | scope=${this.scopeNodeIds.size} | coverage=${this.coveragePct}% | hops=${this.hopCount} | questions=${questionsAnswered}/${questionsAsked}`);
    this.log('debug', `BB RESULT detail | fullNodes=${fullNodes.length} | bridges=${bridgeResult.bridgeNodes.length} | model_edges=${this.model.edges.length} | pruned=${this.removedSet.size} | visited=${this.visited.size}`);
    if (edges.length > 0) {
      this.log('trace', `BB EDGES | ${edges.map(([s, t, tp]) => `${s}→${t}(${tp})`).join(', ')}`);
    }

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
        coveragePct: this.coveragePct,
        questionsAsked,
        questionsAnswered,
      },
    };
  }

  // ─── Public accessors ──────────────────────────────────────────────────────

  get status(): BlackboardStatus { return this._status; }
  get noteCount(): number { return this.notes.size; }
  private get coveragePct(): number {
    return this.scopeNodeIds.size > 0
      ? Math.round((this.notes.size / this.scopeNodeIds.size) * 100) : 0;
  }

  /** Estimate total DDL chars in scope (for token budget gate in extension.ts). */
  estimateScopeDdlChars(): number {
    let total = 0;
    for (const id of this.scopeNodeIds) {
      const node = this.nodeMap.get(id);
      if (node && SCRIPT_TYPES.has(node.type)) {
        const ddl = getNodeDdl(id, this.nodeMap, this.store ?? undefined);
        if (ddl) total += ddl.length;
      }
    }
    return total;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /** Bidirectional BFS from origin to compute reachable scope.
   *  Uses graphology Graph (built from model.edges — filtered to selected schemas).
   *  neighborIndex is NOT used here — it contains cross-schema phantom edges. */
  /** BFS scope from startId using scopeDirection (upstream/downstream/bidirectional).
   *  Filter constraint: if filterSchemas is set, nodes outside the filter schemas are skipped —
   *  the user's active GUI filter acts as a BFS boundary, not just a reporting tag. */
  private bfsScope(startId: string): Set<string> {
    if (!this.graph.hasNode(startId)) return new Set([startId]);
    const seen = new Set<string>([startId]);
    const queue = [startId];
    let idx = 0;
    while (idx < queue.length) {
      const id = queue[idx++];
      const neighbors =
        this.scopeDirection === 'upstream'   ? this.graph.inNeighbors(id) :
        this.scopeDirection === 'downstream' ? this.graph.outNeighbors(id) :
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

  /** Seed agenda with BFS-ordered nodes from origin, respecting scopeDirection. */
  private seedAgenda(originId: string): void {
    if (!this.graph.hasNode(originId)) return;
    const queue: Array<{ id: string; depth: number }> = [];
    const seen = new Set<string>([originId]);

    const neighborFn = (id: string): string[] =>
      this.scopeDirection === 'upstream'   ? this.graph.inNeighbors(id) :
      this.scopeDirection === 'downstream' ? this.graph.outNeighbors(id) :
                                             this.graph.neighbors(id);

    // Start with origin's neighbors
    for (const nid of neighborFn(originId)) {
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

      for (const nid of neighborFn(id)) {
        if (!seen.has(nid) && this.scopeNodeIds.has(nid)) {
          seen.add(nid);
          queue.push({ id: nid, depth: depth + 1 });
        }
      }
    }
  }

  /** Pop the highest-priority unvisited entry from agenda. O(n) scan, no sort. */
  private popNextAgendaEntry(): AgendaEntry | undefined {
    while (this.agenda.length > 0) {
      // Find highest-priority entry (FIFO within same priority: pick lowest index)
      let bestIdx = 0;
      for (let i = 1; i < this.agenda.length; i++) {
        if (this.agenda[i].priority > this.agenda[bestIdx].priority) {
          bestIdx = i;
        }
      }
      const entry = this.agenda[bestIdx];
      this.agenda.splice(bestIdx, 1);
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

  /** Build neighbor list with edge info, boundary detection, compact cols/FKs. */
  private buildNeighborList(focusId: string): HopNeighbor[] {
    if (!this.graph.hasNode(focusId)) return [];
    const inIds = new Set(this.graph.inNeighbors(focusId));
    const outIds = new Set(this.graph.outNeighbors(focusId));
    const allNeighborIds = [...new Set([...inIds, ...outIds])];
    const neighbors: HopNeighbor[] = [];

    for (const nid of allNeighborIds) {
      const nNode = this.nodeMap.get(nid);
      if (!nNode) continue;

      const isUpstream = inIds.has(nid);
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

  private detectBoundary(nodeId: string): BoundaryFlag {
    const node = this.nodeMap.get(nodeId);
    if (!node) return 'external';
    if (node.type === 'external') return 'external';
    if (this.visited.has(nodeId)) return 'cycle';
    if (!this.graph.hasNode(nodeId)) return 'external';
    // Bidirectional: source = no incoming, sink = no outgoing
    if (this.graph.inDegree(nodeId) === 0) return 'source';
    if (this.graph.outDegree(nodeId) === 0) return 'sink';
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

    const wm: WorkingMemory = {
      user_question: this.userQuestion,
      all_summaries: allSummaries,
      pending_questions: pendingQuestions,
      checklist: { noted: this.notes.size, total: this.scopeNodeIds.size, open: this.agenda.length, coveragePct: this.coveragePct },
    };

    if (this.invalidNodeIds.size > 0) {
      wm.invalid_nodes = [...this.invalidNodeIds.entries()].map(([id, reason]) => ({ id, reason }));
    }

    if (this.coveragePct >= COVERAGE_HINT_THRESHOLD) {
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
    this.log('debug', `BB cascadePrune: ${prunedId} | BFS reachability from ${this.originNodeId}`);
    // prunedId is already in removedSet — bfsReachable excludes all of removedSet (mode: mixed = undirected)
    const reachable = bfsReachable(this.graph, this.originNodeId!, this.removedSet, undefined, this.scopeNodeIds);
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
    if (cascaded > 0) {
      this.log('debug', `BB cascadePrune: ${prunedId} | reachable=${reachable.size} | cascaded=${cascaded} agenda nodes removed`);
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
    let idx = 0;
    while (idx < queue.length) {
      const id = queue[idx++];
      if (!this.graph.hasNode(id)) continue;
      for (const nid of this.graph.neighbors(id)) {
        if (!reachable.has(nid) && !tempRemoved.has(nid) && this.scopeNodeIds.has(nid)) {
          reachable.add(nid);
          queue.push(nid);
        }
      }
    }
    return this.agenda.filter(e => !reachable.has(e.nodeId)).length;
  }

  // ─── Scope reporting ────────────────────────────────────────────────────────

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
