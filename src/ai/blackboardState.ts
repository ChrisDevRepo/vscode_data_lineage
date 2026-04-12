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

export interface AgendaEntry {
  nodeId: string;
  question?: string;
  priority: number;   // 0=BFS, 1=neighbor, 2=question-boosted, 3=mandatory (higher wins)
  depth: number;
}

export interface BlackboardConfig {
  maxAgendaSize?: number;
  findingsHardLimit?: number;
  summaryHardLimit?: number;
  activeFilter?: SerializedFilterState | null;
  scopeDirection?: 'upstream' | 'downstream' | 'bidirectional';
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
const BFS_SCOPE_CAP = 10_000;  // mirror smBase.ts for log message only

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
    }, store);
    this.maxAgendaSize = config?.maxAgendaSize ?? DEFAULT_MAX_AGENDA;
    this.scopeDirection = config?.scopeDirection ?? 'bidirectional';
  }

  protected getScopeDirection(): 'upstream' | 'downstream' | 'bidirectional' {
    return this.scopeDirection;
  }

  // ── Public accessors ──

  get noteCount(): number { return this.detailSlots.size; }
  get agendaRemaining(): number { return this.agenda.length; }
  get question(): string { return this.userQuestion; }

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
    depth?: number;
  }): { ok: true; scopeSize: number; agendaSize: number; originNode: Record<string, unknown>; map: MapOverview }
     | { error: string; hint?: string; scope_size?: number; in_filter?: number; outside_filter?: number } {

    // Reset all state
    this.resetSharedState();
    this.agenda = [];
    this.agendaIds.clear();
    this.questionLog = [];
    this.userQuestion = '';
    this.invalidNodeIds.clear();

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

    // Compute scope (depth-limited BFS — AI controls scope via depth + expand_frontier)
    const scopeIds = this.bfsScope(originNode.id, this.scopeDirection, params.depth);
    this.scopeNodeIds = scopeIds;

    // Hard gate: bidirectional on large scope
    if (scopeIds.size > SCOPE_DIRECTION_GATE && this.scopeDirection === 'bidirectional') {
      this._status = 'error';
      const bd = this.filterBreakdown;
      this.log('warn', `BB INIT rejected — scope_too_broad | scope=${scopeIds.size} | direction=bidirectional`);
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

    // Mark origin as visited (it's implicitly noted as the starting point)
    this.visited.add(originNode.id);

    // Build map overview
    const map = this.buildMapOverview();

    this._status = 'initialized';
    this.log('info', `BB INIT | origin=${originNode.id} | question="${question}" | direction=${this.scopeDirection} | depth=${params.depth ?? 'unlimited'} | scope=${scopeIds.size} | agenda=${this.agenda.length}`);
    this.log('debug', `BB INIT detail | origin=${originNode.id} (${originNode.type}) | direction=${this.scopeDirection} | depth=${params.depth ?? 'unlimited'} | bfs_scope=${scopeIds.size}${scopeIds.size >= BFS_SCOPE_CAP ? ' (CAPPED)' : ''} | agenda=${this.agenda.length} | map_nodes=${map.nodes.length} | map_edges=${map.edges.length}`);
    this.log('debug', `BB INIT scope nodes | [${[...scopeIds].map(id => this.nodeMap.get(id)?.name ?? id).join(', ')}]`);

    return {
      ok: true,
      scopeSize: scopeIds.size,
      agendaSize: this.agenda.length,
      originNode: buildHopFocusNode(originNode, this.nodeMap, this.unrelatedMap, this.store ?? undefined, 'bb_ddl'),
      map,
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

    if (this._status !== 'initialized' && this._status !== 'exploring') {
      this.log('debug', `BB getHopContext: invalid status "${this._status}"`);
      return { error: `Cannot get hop context in status "${this._status}"` };
    }

    // Pop highest-priority unvisited entry (iterative — no recursion)
    let entry: AgendaEntry | undefined;
    let node: LineageNode | undefined;
    while (true) {
      entry = this.popNextAgendaEntry();
      if (!entry) {
        this._status = 'complete';
        const outsideScope = this.scopeNodeIds.size - this.visited.size - this.removedSet.size;
        this.log('info', `BB COMPLETE | agenda exhausted | notes=${this.detailSlots.size} | visited=${this.visited.size} | pruned=${this.removedSet.size} | outside_scope=${Math.max(0, outsideScope)}`);
        return {
          done: true,
          ...(outsideScope > 0 && {
            nodes_outside_scope: outsideScope,
            hint: 'All agenda nodes explored. More nodes available in the model — ask a question to explore further.',
          }),
        };
      }
      node = this.nodeMap.get(entry.nodeId);
      if (!node) {
        this.log('debug', `BB node ${entry.nodeId} missing from model, skipping`);
        continue;
      }
      break;
    }

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

    this._status = 'awaiting_findings';
    this.log('info', `BB Hop ${this.hopCount} | ${node.id} | neighbors=${neighbors.length} | visited=${this.detailSlots.size} | pruned=${this.removedSet.size} | agenda=${this.agenda.length}`);
    this.log('debug', `BB Hop ${this.hopCount} detail | ${node.id} (${node.type}) | priority=${entry.priority} | task=${entry.question ? 'self-ask' : 'default'} | memory: ${workingMemory.all_summaries.length} summaries, ${workingMemory.pending_questions.length} pending Qs | coverage=${this.coveragePct}%`);
    if (this.agenda.length > 0) {
      this.log('trace', `BB Hop ${this.hopCount} remaining | [${this.agenda.map(e => this.nodeMap.get(e.nodeId)?.name ?? e.nodeId).join(', ')}]`);
    }

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
    verdict: 'relevant' | 'pass' | 'irrelevant';
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

    if (this._status !== 'awaiting_findings') {
      this.log('debug', `BB submitFindings: invalid status "${this._status}"`);
      return { error: `Cannot submit findings in status "${this._status}"` };
    }

    const { focusNodeId, findings, summary, questions } = params;

    // Coerce verdict — VS Code doesn't enforce JSON Schema enums on tool inputs
    const rawVerdict = params.verdict as string;
    const verdict: 'relevant' | 'pass' | 'irrelevant' =
      rawVerdict === 'relevant' || rawVerdict === 'pass' || rawVerdict === 'irrelevant' ? rawVerdict
      : rawVerdict === 'noted' ? 'pass'   // back-compat: treat legacy 'noted' as 'pass'
      : 'relevant';                        // unknown → default to relevant (safe)

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

    // Detail memory hard limits — reject, never truncate
    const sizeErr = this.validateSubmissionSize(findings, summary);
    if (sizeErr) {
      this.log('debug', `BB submitFindings: ${sizeErr}`);
      const isFindings = sizeErr.startsWith('findings');
      return { error: isFindings ? 'findings_too_long' : 'summary_too_long', limit: isFindings ? this.findingsHardLimit : this.summaryHardLimit };
    }

    // Store detail memory slot — relevant + pass store full findings; irrelevant stores summary only
    const useFullFindings = verdict !== 'irrelevant';
    this.storeDetail(focusNodeId, useFullFindings ? findings : summary, summary, {
      tags,
      badge_label: verdict === 'relevant' ? params.badge_label : undefined,
      note_caption: params.note_caption,
    });

    // Update short memory — base class validates soft/hard limits
    const smErr = this.updateShortMemory(`${this.nodeMap.get(focusNodeId)?.name ?? focusNodeId}: ${summary}`);
    if (smErr) return { error: 'summary_too_long', limit: this.shortMemoryHardLimit };

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

    // Auto-add nodes to agenda (scope expansion for available neighbors)
    let added = 0;
    if (params.addIds?.length) {
      for (const addId of params.addIds) {
        if (!this.nodeMap.has(addId)) { this.log('debug', `BB add_ids: ${addId} not in model, skipping`); continue; }
        if (this.visited.has(addId) || this.removedSet.has(addId)) { this.log('debug', `BB add_ids: ${addId} already visited/pruned, skipping`); continue; }
        this.addQuestion(addId, '(auto-added)');
        advanced++;
        added++;
        this.log('info', `BB AUTO-ADD | ${addId} | agenda=${this.agenda.length}`);
      }
    }

    // Prune specific neighbor nodes from agenda (+ cascade downstream) — with guards
    const rejectedPrunes: Array<{ id: string; reason: string; hint?: string }> = [];
    if (pruneIds?.length) {
      // Compute origin's direct neighbors once (direction-aware) for Guard 0
      const originDirectNeighborIds: Set<string> = this.originNodeId ? new Set([
        ...(this.scopeDirection !== 'downstream' ? this.graph.inNeighbors(this.originNodeId) : []),
        ...(this.scopeDirection !== 'upstream'   ? this.graph.outNeighbors(this.originNodeId) : []),
      ]) : new Set();

      const notedIdSet = new Set(this.detailSlots.keys());
      for (const pruneId of pruneIds) {
        if (pruneId === this.originNodeId) continue;
        if (this.visited.has(pruneId)) continue;
        if (this.removedSet.has(pruneId)) continue;

        // Guard 0: direct neighbor of origin cannot be pruned — reject
        if (originDirectNeighborIds.has(pruneId) && this.scopeNodeIds.has(pruneId)) {
          rejectedPrunes.push({ id: pruneId, reason: 'Direct neighbor of origin — cannot be pruned. Visit and analyze it instead.' });
          this.log('info', `BB PRUNE REJECTED | ${pruneId} | direct neighbor of origin`);
          continue;
        }

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
          const hint =
            reason === 'out_of_scope'  ? 'In model and in filter but outside BFS scope. Use add_ids to add if relevant.' :
            reason === 'not_in_filter' ? 'Outside user filter. Ask user in text if this schema should be included.' :
                                         'Not in the loaded model — external reference.';
          rejectedPrunes.push({ id: pruneId, reason, hint });
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
          this.log('debug', `BB PRUNE REJECTED | ${pruneId} | cascade=${cascadeCount} > 50% of agenda (${this.agenda.length})`);
          continue;
        }

        const beforeCount = this.agenda.length;
        const removedBefore = this.removedSet.size;
        pruned += this.cascadePrune(pruneId);
        const cascadedIds = [...this.removedSet].slice(removedBefore).filter(id => id !== pruneId);
        this.log('info', `BB PRUNE | ${pruneId} | cascade=${pruned} | agenda=${this.agenda.length}`);
        if (cascadedIds.length > 0) {
          this.log('debug', `BB PRUNE cascade removed | [${cascadedIds.map(id => this.nodeMap.get(id)?.name ?? id).join(', ')}]`);
        }
      }
    }

    this._status = 'exploring';
    this.log('info', `BB submit | ${focusNodeId} | verdict=${verdict} | findings=${findings.length}ch | questions=${questions?.length ?? 0} | pruned=${pruned} | agenda=${this.agenda.length}`);
    this.log('debug', `BB submit detail | ${focusNodeId} | summary=${summary.length}ch | tags=[${tags?.join(',') ?? ''}] | advanced=${advanced} | notes_total=${this.detailSlots.size} | coverage=${this.coveragePct}%`);

    const nodeName = this.nodeMap.get(focusNodeId)?.name ?? focusNodeId;
    this.buildProgressLine(nodeName, verdict, pruned, added);

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
        this.log('info', `BB COMPLETE REJECTED | unvisited direct neighbors: [${names.join(', ')}]`);
        return { ...base, complete_rejected: { nodes: unvisitedDirect, names, hint: `Visit or mark these direct neighbors before completing: ${names.join(', ')}` } };
      }
      this.log('info', `BB EARLY COMPLETE | notes=${this.detailSlots.size} | coverage=${this.coveragePct}% | agenda_remaining=${this.agenda.length}`);
      return { ...base, early_complete: this.getResult() };
    }

    return base;
  }

  // ─── submitBatch (inline mode) ──────────────────────────────────────────────

  /**
   * Batch submit all findings at once (inline mode only).
   * AI provides findings keyed by node ID. SM loops agenda internally:
   *   getHopContext() → match AI findings → submitFindings() → repeat
   * Stops on first rejection or when agenda is empty / complete accepted.
   */
  submitBatch(entries: Array<{
    nodeId: string;
    findings: string;
    summary: string;
    verdict: 'relevant' | 'pass' | 'irrelevant';
    badge_label?: string;
    note_caption?: string;
    prune_ids?: string[];
    add_ids?: string[];
    questions?: Array<{ node_id: string; question: string }>;
    complete?: boolean;
  }>): { ok: true; result: ReturnType<BlackboardState['getResult']> }
     | { error: string; hint?: string; processed: number; failed_node?: string } {

    if (!this._inlineMode) {
      return { error: 'batch_not_inline', hint: 'Batch submit is only available in inline mode.', processed: 0 };
    }

    const entryMap = new Map(entries.map(e => [e.nodeId.toLowerCase(), e]));
    let processed = 0;

    while (true) {
      // If already awaiting findings (first hop from init), use current focus.
      // Otherwise advance to next hop.
      if (this._status !== 'awaiting_findings') {
        const hop = this.getHopContext();
        if ('done' in hop) break;
        if ('error' in hop) return { error: (hop as { error: string }).error, hint: 'Internal hop error', processed, failed_node: this.currentFocusNodeId ?? undefined };
      }

      const focusId = this.currentFocusNodeId!;
      const entry = entryMap.get(focusId.toLowerCase());
      if (!entry) {
        return {
          error: 'missing_verdict',
          hint: `No verdict provided for focus node ${focusId}. Provide a verdict and resubmit.`,
          processed,
          failed_node: focusId,
        };
      }

      const result = this.submitFindings({
        focusNodeId: focusId,
        findings: entry.findings,
        summary: entry.summary,
        verdict: entry.verdict,
        tags: undefined,
        pruneIds: entry.prune_ids,
        addIds: entry.add_ids,
        questions: entry.questions?.map(q => ({ nodeId: q.node_id, question: q.question })),
        complete: entry.complete,
        badge_label: entry.badge_label,
        note_caption: entry.note_caption,
      });

      if ('error' in result) {
        return { error: result.error, hint: (result as { hint?: string }).hint, processed, failed_node: focusId };
      }
      processed++;

      // Check if early_complete was accepted
      if ('early_complete' in result && result.early_complete) {
        this.log('info', `Batch early complete: ${processed} hops processed`);
        return { ok: true, result: result.early_complete as ReturnType<BlackboardState['getResult']> };
      }
    }

    this.log('info', `Batch complete: ${processed} hops processed`);
    return { ok: true, result: this.getResult() };
  }

  // ─── getResult ────────────────────────────────────────────────────────────

  getResult(): SmResult & {
    question: string;
    notes: DetailSlot[];
    skipped_nodes?: Array<{ nodeId: string; name: string; type: string; unanswered_question?: string }>;
  } | { error: string } {

    if (this._status === 'created' || this._status === 'awaiting_findings') {
      this.log('debug', `BB getResult: invalid status "${this._status}"`);
      return { error: `Cannot get result in status "${this._status}"` };
    }

    // Build shared result (fullNodes, edges, bridges, labels, notes, memory)
    const shared = this.buildSharedResult();
    this._status = 'complete';

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

  // ─── Scope expansion ───────────────────────────────────────────────────────

  /**
   * Extend scope by N more BFS hops from the current boundary.
   * Frontier nodes = scope nodes with graph neighbors outside scope (not removed).
   * New nodes are added to both scopeNodeIds and agenda.
   */
  expandFrontier(extraHops: number): { added: number; agenda_size: number } {
    if (this._status !== 'initialized' && this._status !== 'exploring' && this._status !== 'awaiting_findings') {
      return { added: 0, agenda_size: this.agenda.length };
    }

    const hops = Math.max(1, Math.min(Math.round(extraHops), 5));

    // Find frontier: scope nodes whose graph neighbors include non-scope, non-removed nodes
    const frontierIds = new Set<string>();
    const neighborFn = (id: string): string[] =>
      this.scopeDirection === 'upstream'   ? this.graph.inNeighbors(id) :
      this.scopeDirection === 'downstream' ? this.graph.outNeighbors(id) :
                                             this.graph.neighbors(id);

    for (const id of this.scopeNodeIds) {
      if (this.removedSet.has(id)) continue;
      for (const nid of neighborFn(id)) {
        if (!this.scopeNodeIds.has(nid) && !this.removedSet.has(nid)) {
          frontierIds.add(id);
          break;
        }
      }
    }

    if (frontierIds.size === 0) {
      this.log('info', `BB EXPAND | no frontier nodes — scope fully explored`);
      return { added: 0, agenda_size: this.agenda.length };
    }

    // BFS from frontier for extraHops levels
    const newNodes = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [];
    for (const fid of frontierIds) {
      for (const nid of neighborFn(fid)) {
        if (!this.scopeNodeIds.has(nid) && !this.removedSet.has(nid) && !newNodes.has(nid)) {
          if (this.filterSchemas) {
            const schema = (this.nodeMap.get(nid)?.schema ?? '').toLowerCase();
            if (!this.filterSchemas.has(schema)) continue;
          }
          newNodes.add(nid);
          queue.push({ id: nid, depth: 1 });
        }
      }
    }

    let idx = 0;
    while (idx < queue.length) {
      const { id, depth } = queue[idx++];
      if (depth >= hops) continue;
      for (const nid of neighborFn(id)) {
        if (this.scopeNodeIds.has(nid) || this.removedSet.has(nid) || newNodes.has(nid)) continue;
        if (this.filterSchemas) {
          const schema = (this.nodeMap.get(nid)?.schema ?? '').toLowerCase();
          if (!this.filterSchemas.has(schema)) continue;
        }
        newNodes.add(nid);
        queue.push({ id: nid, depth: depth + 1 });
      }
    }

    // Add new nodes to scope + agenda
    let added = 0;
    for (const nid of newNodes) {
      if (!this.nodeMap.has(nid)) continue; // skip nodes not in model
      this.scopeNodeIds.add(nid);
      if (!this.visited.has(nid) && !this.agendaIds.has(nid) && this.agenda.length < this.maxAgendaSize) {
        this.agenda.push({ nodeId: nid, priority: 0, depth: 0 });
        this.agendaIds.add(nid);
        added++;
      }
    }

    this.log('info', `BB EXPAND | frontier=${frontierIds.size} | extra_hops=${hops} | new_scope=${newNodes.size} | added_to_agenda=${added} | agenda=${this.agenda.length}`);
    return { added, agenda_size: this.agenda.length };
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
      existing.priority = 2;
      existing.question = question;
    } else {
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

  private cascadePrune(prunedId: string): number {
    this.removedSet.add(prunedId);
    this.log('debug', `BB cascadePrune: ${prunedId} | BFS reachability from ${this.originNodeId}`);
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
    if (cascaded > 0) {
      this.log('debug', `BB cascadePrune: ${prunedId} | reachable=${reachable.size} | cascaded=${cascaded} agenda nodes removed`);
    }
    return cascaded;
  }

  private buildWorkingMemory(): WorkingMemory {
    const base = this.buildBaseWorkingMemory();

    // BB-specific: pending questions from questionLog (richer than base shortMemory.pending_questions)
    const pendingQuestions: Array<{ nodeId: string; question: string }> = [];
    for (const q of this.questionLog) {
      if (!q.answered) pendingQuestions.push({ nodeId: q.nodeId, question: q.question });
    }

    const sortedAgenda = [...this.agenda].sort((a, b) => b.priority - a.priority);
    const MAX_AGENDA_PREVIEW = 30;
    const remaining_agenda = sortedAgenda.slice(0, MAX_AGENDA_PREVIEW).map(e => {
      const n = this.nodeMap.get(e.nodeId);
      return { id: e.nodeId, name: n?.name ?? e.nodeId, type: n?.type ?? '?', priority: e.priority };
    });

    const wm: WorkingMemory = {
      user_question: this.userQuestion,
      all_summaries: base.all_summaries,
      pending_questions: pendingQuestions,
      remaining_agenda,
      checklist: { ...base.checklist, open: this.agenda.length },
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
