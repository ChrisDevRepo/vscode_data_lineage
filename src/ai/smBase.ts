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
import { buildNodeMap, buildEdgeTypeMap, getNodeColumns, getNodeDdl, buildHopFocusNode, SCRIPT_TYPES } from './tools';
import { edgeApiType } from './aiPresenter';
import { bfsDepthMap, wouldOrphanNotedNode, bfsReachable, type LogFn } from './smGuards';
import { AiMemoryManager, type WorkingMemory } from './memoryManager';
import type { ActionRequiredGate, ApprovedBorder, ColumnAspect, DeferredQuestion, DiagnosticsSnapshot, HopContext, HopNeighbor, HopSubmission, RouteOutcome, SmResult, SmState, SmStatus, SubmitResult } from './smTypes';

/** Depth-cap offset for `soft` mode — one level past the user-declared budget. */
const SOFT_DEPTH_HEADROOM = 1;
/** Depth-cap offset for `silent` mode — two levels past the cautious start so autoadd can follow legitimate branches. */
const SILENT_DEPTH_HEADROOM = 2;
/** Ring-buffer size for `recent_rejections` surfaced in working memory. */
const RECENT_REJECTION_CAP = 5;

export type { SmStatus, HopNeighbor, HopContext, HopSubmission, SmResult, SubmitResult } from './smTypes';
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
    /** The node ID currently under investigation. */
    current_focus: string;
  };
}

/**
 * Defines the core interface for the state machine handling exploration modes.
 */
export interface IHopStateMachine {
  /** The current status of the state machine. */
  readonly status: SmStatus;
  /** The size of the current exploration scope. */
  readonly scopeSize: number;
  /** The percentage of nodes in scope that have been covered. */
  readonly coveragePct: number;
  /** Indicates whether the state machine is operating in inline mode. */
  readonly inlineMode: boolean;
  /** The active column-tracing aspect, if any. */
  readonly columnAspect: ColumnAspect | null;
  /** Out-of-approved-scope routes deferred during the SM session (empty in inline mode). */
  readonly deferredQuestions: ReadonlyArray<DeferredQuestion>;

  /**
   * Toggles the inline operating mode.
   *
   * @param val - Boolean flag indicating inline mode status.
   */
  setInlineMode(val: boolean): void;

  /**
   * Retrieves the current hop context for the engine.
   *
   * @returns The contextual data needed for the next exploration step.
   */
  getHopContext(): HopContext;

  /**
   * Submits the findings for the current step and calculates the next state.
   *
   * @param params - The details of the hop submission.
   * @returns The result of the submission.
   */
  submitFindings(params: HopSubmission): SubmitResult;

  /**
   * Retrieves the final result of the exploration session.
   *
   * @returns The generated exploration result.
   */
  getResult(): SmResult;

  /**
   * Serializes the current state machine data to JSON format.
   *
   * @returns The serialized state object.
   */
  toJSON(): SmState;

  /** The sub-question assigned to the current focus node; empty when no hop is in progress. */
  getCurrentTask(): string;

  /** Current hop index (1-based; 0 before the first hop). */
  readonly currentHop: number;

  /** Snapshot of per-hop diagnostics (focus, depth, routing counts, tally). */
  getHopDiagnostics(): DiagnosticsSnapshot;

  /**
   * Extends a completed exploration with additional nodes for analysis.
   *
   * @remarks
   * Used by the follow-up phase (post-synthesis). Only callable when
   * `status === 'complete'` and at least one bodied id is supplied. The engine
   * re-enters `awaiting_findings`, `inlineMode` is forced to `true` so the
   * subsequent loop runs one-shot, and new `DetailSlot` entries merge into the
   * existing `AiMemoryManager` without resetting prior analysis.
   *
   * @param nodeIds - Node ids to append to the agenda. Non-bodied (table, external)
   *   ids follow the existing bipartite contraction rule (`enqueueHop`) — they
   *   forward the authored question to bodied neighbors rather than landing on
   *   the agenda themselves. Ids outside the graph are dropped.
   * @returns Counts of ids that were agendaed, contracted, or skipped (unknown / duplicate).
   */
  supplementAgenda(nodeIds: string[]): { ok: true; agendaed: number; contracted: number; skipped: number } | { error: string; hint?: string };
}

/**
 * Unified Navigation Engine — The core state machine for all exploration modes.
 *
 * @remarks
 * This engine consolidates Blackboard, Dependency, and Column Trace modes into a single
 * grounded traversal logic. It implements a "Map & Router" architecture where the engine
 * maintains the topological map and the AI acts as the router.
 */
export class NavigationEngine implements IHopStateMachine {
  /** The database model containing nodes and edges. */
  protected readonly model: DatabaseModel;
  /** The graphology instance for topological operations. */
  protected readonly graph: Graph;
  /** Optional column store for deep column-level metadata. */
  protected readonly store: ColumnStore | null;
  /** Logging function for tracing engine activity. */
  protected readonly log: LogFn;
  /** Map of node identifiers to LineageNode instances. */
  protected readonly nodeMap: Map<string, LineageNode>;
  /** Map for resolving edge types based on connected node schemas. */
  protected readonly edgeTypeMap: Map<string, string>;
  /** Memory manager for state retention. */
  protected readonly memory: AiMemoryManager;

  /** Optional session identifier for tracking logs across rounds. */
  public sessionId?: string;
  /** The operational status of the state machine. */
  protected _status: SmStatus = 'created';
  /** Indicator for whether inline mode is active. */
  protected _inlineMode = false;
  /** The active column-tracing aspect, initialized if targetColumns are provided. */
  protected _columnAspect: ColumnAspect | null = null;
  /** ID of the initial or root node for navigation. */
  protected originNodeId: string | null = null;
  /** Set of node identifiers within the active scope. */
  protected scopeNodeIds = new Set<string>();
  /** Set of node identifiers that have already been explored. */
  protected visited = new Set<string>();
  /** Set of node identifiers excluded during exploration cascades. */
  protected removedSet = new Set<string>();
  /** List representing the current navigation agenda. */
  protected agenda: AgendaEntry[] = [];
  /** Set tracking node identifiers currently in the agenda. */
  protected agendaIds = new Set<string>();
  /** Identifier of the node currently in focus. */
  protected currentFocusNodeId: string | null = null;
  /** Agenda-entry `question` captured at dequeue so it survives the splice and can label the slot. */
  protected currentFocusQuestion: string | null = null;
  /** Total number of hops executed. */
  protected hopCount = 0;
  /** Breadth-first search depth for nodes from the origin. */
  protected depthFromOrigin = new Map<string, number>();
  /** The configurable depth budget. */
  protected depthBudget: number | null = null;
  /** Determines how strictly depth budgets are enforced. */
  protected depthEnforcement: 'strict' | 'soft' | 'silent' = 'silent';
  /** History of out-of-budget expansions allowed in soft enforcement mode. */
  protected budgetExpansions: Array<{ nodeId: string; depth: number; atHop: number }> = [];
  /** Flag for enabling detail-length and premature-completion guards. */
  protected qualityGuards = true;

  /** Exploration direction set by `init`; consulted by `enqueueHop` when contracting reference nodes. */
  protected _direction: 'upstream' | 'downstream' | 'bidirectional' = 'bidirectional';

  /** Schemas (lower-cased) in the user's active filter — the initial allowlist for route validation. */
  protected userSchemas: Set<string> = new Set();
  /** Session-scoped schema allowlist. Starts as a copy of {@link userSchemas}; grows via {@link extendAllowedSchemas}. */
  protected sessionAllowedSchemas: Set<string> = new Set();
  /** Object types the user asked to exclude (e.g. ['view','function']); pruned from scope at init. */
  protected excludedTypes: Set<string> = new Set();
  /** Extra depth levels the user has confirmed mid-session beyond the mode-cap. 0 = no extension. */
  protected extendedDepthCap = 0;
  /** Last per-hop snapshot of detail/summary chars, used for diagnostics. */
  protected lastHopDetailChars = 0;
  /** Last per-hop summary-char count. */
  protected lastHopSummaryChars = 0;
  /** Cumulative archive chars across the whole session. */
  protected archiveChars = 0;
  /** Route requests accepted during the most recent submit, for diagnostics. */
  protected lastRoutedNew = 0;
  /** Route requests rejected during the most recent submit, for diagnostics. */
  protected lastRoutedRejected = 0;
  /** Route requests deferred during the most recent submit (SM mode), for diagnostics. */
  protected lastRoutedDeferred = 0;
  /**
   * Out-of-approved-scope routes captured during an SM session. Single encapsulated
   * bucket — all mutations flow through {@link deferQuestion}. Surfaced at synthesis
   * (as the "Unanswered" section) and to the user post-turn via the
   * `dataLineageViz.showDeferredQuestions` button.
   */
  private readonly _deferredQuestions: DeferredQuestion[] = [];

  /**
   * Initializes a new NavigationEngine.
   *
   * @param model - The database model containing nodes and edges.
   * @param graph - The graphology instance for topological operations.
   * @param log - A logging function for tracing engine activity.
   * @param config - Configuration including optional filters and an existing memory manager.
   * @param store - Optional column store for deep column-level metadata.
   */
  constructor(
    model: DatabaseModel,
    graph: Graph,
    log: LogFn,
    config: {
      activeFilter?: SerializedFilterState | null;
      memory?: AiMemoryManager;
      qualityGuards?: boolean;
    },
    store?: ColumnStore | null,
  ) {
    this.model = model;
    this.graph = graph;
    this.log = log;
    this.store = store ?? null;
    this.nodeMap = buildNodeMap(model);
    this.edgeTypeMap = buildEdgeTypeMap(model);
    this.memory = config.memory ?? new AiMemoryManager();
    if (config.qualityGuards === false) {
      this.qualityGuards = false;
    }
    const schemas = config.activeFilter?.schemas?.map(s => s.toLowerCase()) ?? [];
    this.userSchemas = new Set(schemas);
    this.sessionAllowedSchemas = new Set(schemas);
  }

  /**
   * Effective depth ceiling for route validation.
   *
   * @remarks
   * Combines the user-declared `depthBudget` with mode-specific headroom (strict=0,
   * soft=+1, silent=+2) plus any session-level extensions granted by user confirmation.
   * Returns `null` when no budget is in force.
   */
  protected computeDepthCap(): number | null {
    if (this.depthBudget === null) return null;
    const headroom = this.depthEnforcement === 'strict'
      ? 0
      : this.depthEnforcement === 'soft' ? SOFT_DEPTH_HEADROOM : SILENT_DEPTH_HEADROOM;
    return this.depthBudget + headroom + this.extendedDepthCap;
  }

  /**
   * Extends the session schema allowlist after the user confirms an out-of-filter route.
   *
   * @param schema - The schema to allow for the remainder of this session (case-insensitive).
   */
  public extendAllowedSchemas(schema: string): void {
    this.sessionAllowedSchemas.add(schema.toLowerCase());
  }

  /**
   * Extends the session depth cap by the given offset after the user confirms an out-of-budget route.
   *
   * @param offset - Additional depth levels to allow; passed verbatim from the gate envelope.
   */
  public extendAllowedDepth(offset: number): void {
    if (offset > 0) this.extendedDepthCap += offset;
  }

  /**
   * Read-only view of the SM deferred-questions bucket.
   *
   * @remarks
   * Consumed at synthesis (rendered as the "Unanswered" section) and surfaced
   * post-turn through the `dataLineageViz.showDeferredQuestions` button. Callers
   * cannot mutate the bucket through this accessor.
   */
  public get deferredQuestions(): ReadonlyArray<DeferredQuestion> {
    return this._deferredQuestions;
  }

  /**
   * Records a deferred route — the sole entry point for mutating the bucket.
   *
   * @remarks
   * Deduplicates on `(nodeId, fromFocusNodeId)`: a later deferral for the same pair
   * replaces the earlier one (latest `atHop` and `question` win). Otherwise appends
   * unconditionally — no ceiling. Also records a rejection in memory so
   * `recent_rejections` reflects the same event — DRY with the inline gate path.
   *
   * @param entry - Fully-populated deferral record. Internal callers pass typed values;
   *   the participant boundary validates external payloads via `DeferredQuestionSchema`.
   * @returns The index of the stored entry (new or replaced).
   */
  protected deferQuestion(entry: DeferredQuestion): number {
    const existing = this._deferredQuestions.findIndex(
      d => d.nodeId === entry.nodeId && d.fromFocusNodeId === entry.fromFocusNodeId,
    );
    if (existing >= 0) {
      this._deferredQuestions[existing] = entry;
      this.memory.recordRejection(entry.nodeId, `deferred: out of approved scope (${entry.reason})`, entry.atHop);
      return existing;
    }
    this._deferredQuestions.push(entry);
    this.memory.recordRejection(entry.nodeId, `deferred: out of approved scope (${entry.reason})`, entry.atHop);
    return this._deferredQuestions.length - 1;
  }

  /**
   * Emits a session-end diagnostic summarizing badge_label diversity across analyzed verdicts.
   * Low diversity (e.g. 20 analyzed nodes all tagged "Transform") indicates the AI is not distinguishing
   * functional roles — the final view won't group variants usefully.
   */
  private logLabelDiversity(): void {
    const labels: string[] = [];
    for (const slot of this.memory.getResult().detail_slots) {
      if (slot.badge_label && slot.badge_label.trim().length > 0) labels.push(slot.badge_label);
    }
    if (labels.length === 0) return;
    const distinct = new Set(labels).size;
    const diversity = distinct / labels.length;
    const flag = diversity < 0.3 ? ' (low — variants not distinguished)' : '';
    this.log('info', `[Labels] distinct=${distinct} labeled=${labels.length} diversity=${diversity.toFixed(2)}${flag}`);
  }

  /**
   * Per-hop diagnostic snapshot for structured logging and AI-visible fields.
   *
   * @returns A point-in-time view of depth, schema, tally, and routing counters — safe to log.
   */
  public getHopDiagnostics(): DiagnosticsSnapshot {
    const focusId = this.currentFocusNodeId ?? '';
    const focus = this.nodeMap.get(focusId);
    return {
      hop: this.hopCount,
      focus: focusId,
      schema: focus?.schema ?? '',
      depth: this.depthFromOrigin.get(focusId) ?? 0,
      depthBudget: this.depthBudget,
      depthEnforcement: this.depthEnforcement,
      inSchema: focus ? this.sessionAllowedSchemas.size === 0 || this.sessionAllowedSchemas.has(focus.schema.toLowerCase()) : true,
      detailChars: this.lastHopDetailChars,
      summaryChars: this.lastHopSummaryChars,
      archiveChars: this.archiveChars,
      routedNew: this.lastRoutedNew,
      routedRejected: this.lastRoutedRejected,
      routedDeferred: this.lastRoutedDeferred,
      deferredQueued: this._deferredQuestions.length,
      agendaRemaining: this.agenda.length,
      tally: this.memory.getVerdictCounts(),
      scopeExpansions: this.budgetExpansions.length,
      allowedSchemaCount: this.sessionAllowedSchemas.size,
    };
  }

  /** Gets the operational status. */
  public get status(): SmStatus {
    return this._status;
  }

  /** Gets the active column-tracing aspect, if any. */
  public get columnAspect(): ColumnAspect | null {
    return this._columnAspect;
  }

  /** Gets the size of the active exploration scope. */
  public get scopeSize(): number {
    return this.scopeNodeIds.size;
  }

  /** Gets the percentage of scope nodes covered. */
  public get coveragePct(): number {
    return this.scopeNodeIds.size > 0 ? Math.round((this.memory.slotCount / this.scopeNodeIds.size) * 100) : 0;
  }

  /** Gets the inline mode toggle flag. */
  public get inlineMode(): boolean {
    return this._inlineMode;
  }

  /**
   * Validates that the given node ids are legitimate targets for neighbor-column
   * inspection (the `get_neighbor_columns` tool).
   *
   * @remarks
   * Enforces the mechanical contract that pruning verification only inspects
   * **direct neighbors of the current focus node that are also within the active
   * BFS scope.** Out-of-scope ids or non-neighbor ids are returned as the
   * "invalid" subset so the caller can emit a structured error. This keeps the
   * tool from becoming a backdoor for out-of-scope exploration.
   *
   * @param ids - Candidate neighbor ids supplied by the AI.
   * @returns Subset of `ids` that fail the scope+neighbor check; empty array iff all pass.
   */
  public validateNeighborIds(ids: string[]): string[] {
    const focusId = this.currentFocusNodeId ?? '';
    const neighborIndex = this.model.neighborIndex[focusId] ?? { in: [], out: [] };
    const directNeighbors = new Set<string>([...neighborIndex.in, ...neighborIndex.out]);
    return ids.filter(id => !this.scopeNodeIds.has(id) || !directNeighbors.has(id));
  }

  /**
   * Returns the sub-question assigned to the current focus node.
   *
   * @remarks
   * Used by prompt builders to populate the `<current_task>` block in the system
   * prompt so the AI sees its per-node assignment as structured text rather than
   * buried JSON. Returns an empty string when no hop is in progress.
   */
  public getCurrentTask(): string {
    if (!this.currentFocusNodeId) return '';
    const entry = this.visited.has(this.currentFocusNodeId)
      ? undefined
      : this.agenda.find(e => e.nodeId === this.currentFocusNodeId);
    // After a node enters focus it's already in visited; find the stored question
    // from the most-recently committed agenda entry via the hop context's last value.
    return entry?.question ?? this._lastCurrentTask ?? '';
  }

  /** Current hop index exposed for prompt builders (read-only alias of the protected `hopCount` field). */
  public get currentHop(): number {
    return this.hopCount;
  }

  /** Stores the current-task question at the moment a hop context is delivered. */
  private _lastCurrentTask = '';

  /**
   * Toggles the inline operating mode.
   *
   * @param val - Boolean flag to activate inline mode.
   */
  public setInlineMode(val: boolean): void {
    this._inlineMode = val;
  }

  /**
   * Sets up the navigation map to prepare for traversal.
   *
   * @param params - Initialization parameters like question, origin, depth.
   * @returns An object indicating initialization success and agenda details.
   */
  public init(params: {
    question: string;
    origin: string;
    targetColumns?: string[];
    direction?: 'upstream' | 'downstream' | 'bidirectional';
    depth?: number;
    depth_enforcement?: 'strict' | 'soft' | 'silent';
    excludeTypes?: string[];
    mission_brief?: string;
  }): { ok: true; scopeSize: number; agendaSize: number; scopeSchemas: string[] } | { error: string; hint?: string } {
    this.visited.clear();
    this.agenda = [];
    this.agendaIds.clear();
    this.memory.reset();
    this.memory.setUserQuestion(params.question);
    if (params.mission_brief) {
      this.memory.setMissionBrief(params.mission_brief);
      this.log('debug', `[Mission] brief=${params.mission_brief.slice(0, 200)}${params.mission_brief.length > 200 ? ` [+${params.mission_brief.length - 200} chars]` : ''}`);
    }
    this.excludedTypes = new Set((params.excludeTypes ?? []).map(t => t.toLowerCase()));

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

    // Initialize column aspect if target columns are provided
    if (params.targetColumns && params.targetColumns.length > 0) {
      this._columnAspect = {
        target_columns: params.targetColumns,
        done_columns: [],
        active_columns: params.targetColumns,
      };
    } else {
      this._columnAspect = null;
    }

    const breakdown = { table: 0, view: 0, procedure: 0, function: 0, external: 0 } as Record<string, number>;
    const scopeSchemas = new Set<string>();
    for (const id of this.scopeNodeIds) {
      const n = this.nodeMap.get(id);
      if (n) {
        scopeSchemas.add(n.schema);
        const t = n.type?.toLowerCase() ?? 'external';
        breakdown[t] = (breakdown[t] ?? 0) + 1;
      }
    }
    const excluded = Array.from(this.excludedTypes).join(',') || 'none';
    this.log('debug', `[BFS] origin=${originNode.id} dir=${params.direction || 'bidirectional'} depth=${params.depth ?? 'default'} → scope=${this.scopeNodeIds.size} (tables=${breakdown.table}, views=${breakdown.view}, procs=${breakdown.procedure}, functions=${breakdown.function}) excludeTypes=[${excluded}]`);

    this._direction = params.direction || 'bidirectional';
    // Bipartite agenda rule: `enqueueHop` is the only code path that writes to the agenda.
    // It pushes bodied nodes directly and contracts body-less nodes through to their bodied
    // neighbors in the current exploration direction. Invariant holds by construction.
    this.enqueueHop(originNode.id, `Root Question: ${params.question}`, 0, 3, params.targetColumns);
    this.seedAgenda(originNode.id, this._direction, params.targetColumns);
    this._status = 'initialized';

    return {
      ok: true,
      scopeSize: this.scopeNodeIds.size,
      agendaSize: this.agenda.length,
      scopeSchemas: Array.from(scopeSchemas).sort(),
    };
  }

  /**
   * Extends a completed exploration with additional nodes for analysis.
   *
   * @remarks
   * Only callable when `status === 'complete'`. Re-enters `awaiting_findings`, forces
   * inline mode (supplements are small by construction), and appends ids via
   * {@link enqueueHop} so the bipartite rule still holds: bodied nodes land on the
   * agenda, non-bodied contract through to their bodied neighbors in the exploration
   * direction. Prior `DetailSlot` entries survive — new slots merge in.
   *
   * Unknown ids are reported in the `skipped` count, not raised as errors, so a
   * partial supplement still proceeds.
   *
   * @param nodeIds - Ids to append to the agenda.
   * @returns Counts of agendaed / contracted / skipped, or a structured error.
   */
  public supplementAgenda(nodeIds: string[]): { ok: true; agendaed: number; contracted: number; skipped: number } | { error: string; hint?: string } {
    if (this._status !== 'complete') {
      return {
        error: 'supplement_requires_complete_engine',
        hint: `supplementAgenda is only valid after the prior exploration has completed (status === 'complete'). Current status: ${this._status}.`,
      };
    }
    if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
      return { error: 'supplement_empty', hint: 'supplementAgenda requires at least one node id.' };
    }

    const agendaBefore = this.agenda.length;
    let skipped = 0;
    for (const raw of nodeIds) {
      const id = this.nodeMap.has(raw) ? raw : this.nodeMap.has(raw.toLowerCase()) ? raw.toLowerCase() : null;
      if (!id) { skipped++; continue; }
      if (!this.scopeNodeIds.has(id)) this.scopeNodeIds.add(id);
      // Reset visited guard so the supplemented id can be analyzed even if it was
      // passed-through during the parent exploration.
      if (this.visited.has(id)) this.visited.delete(id);
      const existingDepth = this.depthFromOrigin.get(id);
      const depth = typeof existingDepth === 'number' ? existingDepth : 0;
      this.enqueueHop(id, `Supplement: investigate ${id} on user follow-up`, depth, 3);
    }

    const agendaed = this.agenda.length - agendaBefore;
    const contracted = nodeIds.length - agendaed - skipped;

    this._inlineMode = true;
    this._status = 'awaiting_findings';

    this.log('info', `[Supplement] added ${nodeIds.length} requested ids → agendaed=${agendaed} contracted=${contracted} skipped=${skipped}; inlineMode=true, status=awaiting_findings`);

    return { ok: true, agendaed, contracted, skipped };
  }

  /**
   * Gets the details for the next scheduled navigation hop.
   *
   * @returns Context data mapped for the AI router.
   */
  public getHopContext(): HopContext {
    if (this._inlineMode) {
      // TRUE INLINE MODE: Drain the entire agenda into a single batch delivery.
      const batchEntries: AgendaEntry[] = [];
      while (this.agenda.length > 0) {
        const candidate = this.agenda.shift()!;
        this.agendaIds.delete(candidate.nodeId);
        if (!this.visited.has(candidate.nodeId)) {
          batchEntries.push(candidate);
          this.visited.add(candidate.nodeId);
        }
      }

      if (batchEntries.length === 0) {
        this._status = 'complete';
        this.logLabelDiversity();
        return { done: true };
      }

      this.hopCount++;
      // In inline mode, focus is the batch of nodes. We pick the first as the primary "focus" for state-machine
      // consistency, but the AI receives the full list.
      this.currentFocusNodeId = batchEntries[0].nodeId;
      this.currentFocusQuestion = batchEntries[0].question ?? null;

      const nodes = batchEntries.map(e => {
        const n = this.nodeMap.get(e.nodeId)!;
        const fn = buildHopFocusNode(n, this.nodeMap, new Map(), this.store ?? undefined, 'bb_ddl');
        if (this.depthBudget !== null) {
          const d = this.depthFromOrigin.get(e.nodeId);
          if (d !== undefined) (fn as any).depth_from_origin = d;
        }
        return fn;
      });

      const workingMemory = this.memory.getWorkingMemory(this.hopCount, this.scopeNodeIds.size, {
        rounds_used: this.hopCount,
        scope_growth: this.budgetExpansions.length,
        active_schemas: Array.from(this.sessionAllowedSchemas),
      }) as NavigationWorkingMemory;
      
      workingMemory.topological_map = {
        navigation_path: 'Full Graph (Inline)',
        current_focus: 'batch_delivery',
      };

      this._status = 'awaiting_findings';
      return {
        mode: 'inline' as const,
        sm_status: 'awaiting_findings' as const,
        hop: this.hopCount,
        agenda_remaining: 0,
        focus_node: nodes,
        working_memory: workingMemory,
      };
    }

    // SLIDING MEMORY MODE (Isolated Hop)
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
      this.logLabelDiversity();
      return { done: true };
    }

    this.visited.add(entry.nodeId);
    this.hopCount++;
    this.currentFocusNodeId = entry.nodeId;
    this.currentFocusQuestion = entry.question ?? null;

    // Synchronize the Column Aspect to only show columns relevant to this specific path
    if (this._columnAspect) {
      this._columnAspect.active_columns = entry.activeColumns || [];
    }

    const node = this.nodeMap.get(entry.nodeId)!;
    const focusNode = buildHopFocusNode(node, this.nodeMap, new Map(), this.store ?? undefined, 'bb_ddl');

    if (this.depthBudget !== null) {
      const d = this.depthFromOrigin.get(entry.nodeId);
      if (d !== undefined) focusNode.depth_from_origin = d;
    }

    const path = bidirectional(this.graph, this.originNodeId!, entry.nodeId);
    const navPath = path ? (path as string[]).map(id => this.nodeMap.get(id)?.name || id).join(' → ') : 'Direct';

    const workingMemory = this.memory.getWorkingMemory(this.hopCount, this.scopeNodeIds.size, {
      rounds_used: this.hopCount,
      scope_growth: this.budgetExpansions.length,
      active_schemas: Array.from(this.sessionAllowedSchemas),
    }) as NavigationWorkingMemory;
    workingMemory.topological_map = {
      navigation_path: navPath,
      current_focus: entry.nodeId,
    };

    if (this.depthBudget !== null) {
      (workingMemory as any).depth_budget = this.depthBudget;
      (workingMemory as any).depth_enforcement = this.depthEnforcement;
      (workingMemory as any).depth_cap = this.computeDepthCap();
      if (this.budgetExpansions.length > 0) {
        (workingMemory as any).budget_expansions = this.budgetExpansions.slice();
      }
    }

    if (!this._inlineMode) {
      const border: ApprovedBorder = {
        schemas: Array.from(this.sessionAllowedSchemas).sort(),
        depth_cap: this.computeDepthCap(),
      };
      (workingMemory as any).approved_border = border;
      (workingMemory as any).deferred_count = this._deferredQuestions.length;
      if (this._columnAspect) {
        (workingMemory as any).column_aspect = this._columnAspect;
      }
    }

    this._lastCurrentTask = entry.question;
    this._status = 'awaiting_findings';
    return {
      mode: 'sm' as const,
      sm_status: 'awaiting_findings' as const,
      hop: this.hopCount,
      agenda_remaining: this.agenda.length,
      focus_node: focusNode,
      neighbors: this.buildNeighborList(entry.nodeId),
      working_memory: workingMemory,
    };
  }

  /**
   * Processes the findings from a completed hop and adjusts the agenda.
   *
   * @param params - Submission details including focus, verdict, and routing data.
   * In True Inline Mode, this can be an array of findings for batch processing.
   * @returns Information summarizing the operation's outcome.
   */
  public submitFindings(params: HopSubmission): SubmitResult {
    if (this._status !== 'awaiting_findings') {
      const hint = this._status === 'complete'
        ? 'The engine already completed this exploration. Produce the synthesis output (chat prose + present_result) now — do not call submit_findings again.'
        : this._status === 'error'
          ? 'The engine is in an error state. Call start_exploration to begin a fresh exploration.'
          : `Engine is in status '${this._status}'. Expected 'awaiting_findings'. Wait for a hop context, or restart via start_exploration if the session was wiped.`;
      return { error: 'invalid_status', current_status: this._status, hint } as any;
    }

    const findings = Array.isArray(params) ? params : [params];
    if (findings.length === 0) return { error: 'empty_submission' };

    this.lastRoutedNew = 0;
    this.lastRoutedRejected = 0;
    this.lastRoutedDeferred = 0;
    let totalCascadedCount = 0;
    let forceComplete = false;

    const allInvalidRoutes: Array<{ id: string; reason: string }> = [];
    const gateNodeIds: string[] = [];
    const gateClasses = new Set<string>();
    const gateDetails: string[] = [];
    let gateHasSchema = false;
    let gateHasDepth = false;
    const routeOutcomes: RouteOutcome[] = [];

    for (const finding of findings) {
      const focusId = finding.focus_node_id?.toLowerCase();
      if (!this._inlineMode && focusId !== this.currentFocusNodeId) {
        return { error: 'focus_mismatch', expected: this.currentFocusNodeId ?? undefined, got: focusId };
      }
      if (!focusId || !this.nodeMap.has(focusId)) {
        return { error: 'invalid_focus_node', got: focusId };
      }

      const acceptedNids = new Set<string>();
      if (finding.route_requests) {
        const depthCap = this.computeDepthCap();

        for (const req of finding.route_requests) {
          const nid = req.nodeId?.toLowerCase();
          const nNode = nid ? this.nodeMap.get(nid) : null;
          if (!nNode || !nid) {
            allInvalidRoutes.push({ id: req.nodeId, reason: 'Node not found.' });
            continue;
          }

          const schemaLower = nNode.schema.toLowerCase();
          const schemaBlocked = this.sessionAllowedSchemas.size > 0 && !this.sessionAllowedSchemas.has(schemaLower);

          let candidateDepth = this.depthFromOrigin.get(nid);
          if (candidateDepth === undefined && this.originNodeId) {
            const path = bidirectional(this.graph, this.originNodeId, nid);
            candidateDepth = Array.isArray(path) ? path.length - 1 : undefined;
          }
          if (candidateDepth === undefined) {
            const focusDepth = this.depthFromOrigin.get(focusId) ?? 0;
            candidateDepth = focusDepth + 1;
          }
          if (candidateDepth !== undefined) this.depthFromOrigin.set(nid, candidateDepth);
          
          const depthBlocked = depthCap !== null && candidateDepth !== undefined && candidateDepth > depthCap;
          const strictScopeBlocked = this.depthEnforcement === 'strict' && !this.scopeNodeIds.has(nid);

          if (schemaBlocked || depthBlocked || strictScopeBlocked) {
            const scopeReason = depthBlocked || strictScopeBlocked;
            if (this._inlineMode) {
              gateNodeIds.push(req.nodeId);
              if (schemaBlocked) {
                gateHasSchema = true;
                gateClasses.add(`schema:${schemaLower}`);
                gateDetails.push(`\`${req.nodeId}\` is in schema \`${nNode.schema}\`, outside the active filter`);
              }
              if (scopeReason) {
                gateHasDepth = true;
                if (depthBlocked) {
                  const extraOffset = candidateDepth! - depthCap!;
                  gateClasses.add(`depth:+${extraOffset}`);
                  gateDetails.push(`\`${req.nodeId}\` is at depth ${candidateDepth}, beyond the current cap ${depthCap}`);
                } else {
                  gateClasses.add('scope:strict');
                  gateDetails.push(`\`${req.nodeId}\` is outside the initial approved scope (strict mode)`);
                }
              }
            } else {
              const deferReason: 'schema' | 'depth' | 'schema_and_depth' =
                schemaBlocked && scopeReason ? 'schema_and_depth' : schemaBlocked ? 'schema' : 'depth';
              this.deferQuestion({
                nodeId: req.nodeId,
                schema: nNode.schema,
                fromFocusNodeId: focusId,
                question: req.question ?? '',
                reason: deferReason,
                depth: candidateDepth,
                atHop: this.hopCount,
              });
              this.lastRoutedDeferred++;
              routeOutcomes.push({ nodeId: req.nodeId, accepted: false, deferred: true, reason: deferReason });
            }
            continue;
          }

          acceptedNids.add(nid);
          routeOutcomes.push({ nodeId: req.nodeId, accepted: true });
          if (!this.scopeNodeIds.has(nid)) {
            this.scopeNodeIds.add(nid);
            const focusDepth = this.depthFromOrigin.get(focusId) ?? 0;
            if (!this.depthFromOrigin.has(nid)) this.depthFromOrigin.set(nid, focusDepth + 1);
            if (this.depthBudget !== null && this.depthEnforcement !== 'strict') {
              this.budgetExpansions.push({ nodeId: nid, depth: focusDepth + 1, atHop: this.hopCount });
            }
          }
          if (req.columns && this._columnAspect) {
            const validCols = new Set(getNodeColumns(nNode.id, this.nodeMap, this.store ?? undefined)?.map(c => c.name.toLowerCase()));
            const invalidCols = req.columns.filter((c: string) => !validCols.has(c.toLowerCase()));
            if (invalidCols.length > 0) {
              allInvalidRoutes.push({ id: req.nodeId, reason: `Columns not found: ${invalidCols.join(', ')}` });
            }
          }
        }
      }

      // Column Aspect Validation: column_flow structured JSON
      if (this._columnAspect && finding.column_flow) {
        const focusNode = this.nodeMap.get(focusId)!;
        const validFocusCols = new Set(getNodeColumns(focusNode.id, this.nodeMap, this.store ?? undefined)?.map(c => c.name.toLowerCase()));

        for (const entry of finding.column_flow) {
          if (!validFocusCols.has(entry.out_col.toLowerCase())) {
            allInvalidRoutes.push({ id: focusId, reason: `column_flow_validation_failed: column "${entry.out_col}" does not exist on focus node. Hint: If this node does not interact with the traced columns, submit verdict='prune'.` });
            continue;
          }

          for (const cont of entry.contributors) {
            const neighbor = this.nodeMap.get(cont.from_node.toLowerCase());
            if (!neighbor) {
              allInvalidRoutes.push({ id: cont.from_node, reason: `column_flow_validation_failed: contributor node "${cont.from_node}" not found in graph.` });
              continue;
            }
            const validNeighborCols = new Set(getNodeColumns(neighbor.id, this.nodeMap, this.store ?? undefined)?.map(c => c.name.toLowerCase()));
            if (!validNeighborCols.has(cont.from_col.toLowerCase())) {
              allInvalidRoutes.push({ id: cont.from_node, reason: `column_flow_validation_failed: contributor column "${cont.from_col}" does not exist on node "${cont.from_node}".` });
            }
          }
        }
      }

      const isPrune = finding.verdict === 'prune';
      const prunable = isPrune && focusId !== this.originNodeId;
      if (prunable) {
        const notedIds = new Set<string>(this.memory.notedNodeIds);
        const orphan = wouldOrphanNotedNode(this.graph, this.originNodeId!, this.removedSet, notedIds, focusId);
        if (orphan) {
          return { error: 'prune_would_orphan_noted', detail: `Marking ${focusId} prune would orphan already-analyzed node "${orphan}". Use verdict='pass' to skip without pruning.` };
        }
      }

      // Explicitly prune adjacent neighbors requested by the AI
      if (finding.prune_neighbors && finding.prune_neighbors.length > 0) {
        for (const nidRaw of finding.prune_neighbors) {
          const nid = nidRaw.toLowerCase();
          if (this.nodeMap.has(nid) && nid !== this.originNodeId) {
            this.removedSet.add(nid);
          }
        }
      }

      if (!isPrune) {
        this.memory.storeDetail(this.nodeMap.get(focusId)!, finding.detail_analysis, finding.summary, {
          badge_label: finding.badge_label,
          note_caption: finding.note_caption,
          reason_for_visit: this._inlineMode ? 'True Inline Analysis' : (this.currentFocusQuestion || 'Historical path investigation')
        }, this._inlineMode);
        this.lastHopDetailChars = finding.detail_analysis?.length ?? 0;
        this.lastHopSummaryChars = finding.summary?.length ?? 0;
        this.archiveChars += this.lastHopDetailChars + this.lastHopSummaryChars;
      }

      this.memory.recordVerdict(finding.verdict);

      if (prunable || (finding.prune_neighbors && finding.prune_neighbors.length > 0)) {
        if (prunable) this.removedSet.add(focusId);
        const reachable = bfsReachable(this.graph, this.originNodeId!, this.removedSet, undefined, this.scopeNodeIds);
        const before = this.agenda.length;
        this.agenda = this.agenda.filter(e => reachable.has(e.nodeId));
        this.agendaIds = new Set(this.agenda.map(e => e.nodeId));
        totalCascadedCount += (before - this.agenda.length);
      }

      if (finding.route_requests) {
        for (const req of finding.route_requests) {
          const nid = req.nodeId.toLowerCase();
          if (!acceptedNids.has(nid)) continue;

          // Route enqueue funnels through the bipartite rule. For bodied targets
          // the funnel merges into existing entries (task aggregation) or pushes
          // a new entry. For non-bodied targets (tables, externals) it contracts
          // the edge and forwards the proc's authored question to the target's
          // bodied neighbors in the exploration direction.
          const agendaSizeBefore = this.agenda.length;
          this.enqueueHop(nid, req.question, 0, 2, req.columns);
          this.lastRoutedNew += Math.max(0, this.agenda.length - agendaSizeBefore);
        }
      }

      if (finding.complete && this._inlineMode) forceComplete = true;
    }

    if (allInvalidRoutes.length > 0) {
      this.lastRoutedRejected = allInvalidRoutes.length;
      for (const r of allInvalidRoutes) this.memory.recordRejection(r.id, r.reason, this.hopCount);
      return { error: 'route_validation_failed', detail: allInvalidRoutes };
    }

    if (gateNodeIds.length > 0) {
      this.lastRoutedRejected = gateNodeIds.length;
      for (const id of gateNodeIds) this.memory.recordRejection(id, 'blocked by user-confirmation gate', this.hopCount);
      const gate: ActionRequiredGate = {
        error: 'action_required',
        gate: gateHasSchema && gateHasDepth ? 'schema_and_depth' : gateHasSchema ? 'schema_out_of_filter' : 'depth_cap_exceeded',
        classes: Array.from(gateClasses),
        nodeIds: gateNodeIds,
        detail: `Route requires user confirmation: ${gateDetails.slice(0, 3).join('; ')}${gateDetails.length > 3 ? ` (+${gateDetails.length - 3} more)` : ''}. Reply 'yes' to allow for this session or 'no' to pause and refine the question.`,
        hint: 'Wait for the user to reply. Do not re-submit the same route until the gate is resolved.',
      };
      return gate;
    }

    this._status = 'exploring';
    const outcomes = routeOutcomes.length > 0 ? { route_outcomes: routeOutcomes } : {};
    if (forceComplete) {
      this._status = 'complete';
      this.logLabelDiversity();
      return { ok: true, done: true, result: this.getResult(), ...outcomes };
    }

    return totalCascadedCount > 0
      ? { ok: true, cascaded_count: totalCascadedCount, ...outcomes }
      : { ok: true, ...outcomes };
  }

  /**
   * Calculates the approximate number of DDL characters required by the scope.
   *
   * @returns The total character count.
   */
  public estimateScopeDdlChars(): number {
    let total = 0;
    for (const nid of this.scopeNodeIds) {
      const ddl = getNodeDdl(nid, this.nodeMap, this.store ?? undefined);
      if (ddl) {
        total += ddl.length;
      }
    }
    return total;
  }

  /**
   * Evaluates the breadth-first search reachability for initializing traversal scope.
   *
   * @param startId - Starting node identifier.
   * @param direction - Direction of graph traversal ('upstream', 'downstream', 'bidirectional').
   * @param maxDepth - The bounding maximum depth.
   * @returns A set of valid node identifiers reachable within the depth parameters.
   */
  private computeBfsScope(startId: string, direction: string, maxDepth: number): Set<string> {
    const mode = direction === 'upstream' ? 'inbound' : direction === 'downstream' ? 'outbound' : 'directed';
    const seen = new Set<string>();

    this.depthFromOrigin.clear();
    bfsFromNode(this.graph, startId, (key, _attr, depth) => {
      seen.add(key);
      if (!this.depthFromOrigin.has(key)) {
        this.depthFromOrigin.set(key, depth);
      }
      return depth >= maxDepth;
    }, { mode });

    if (this.excludedTypes.size > 0) {
      for (const id of Array.from(seen)) {
        if (id === startId) continue;
        const t = this.nodeMap.get(id)?.type?.toLowerCase();
        if (t && this.excludedTypes.has(t)) seen.delete(id);
      }
    }

    return seen;
  }

  /**
   * Seeds the initial agenda based on the requested traversal parameters.
   *
   * @param originId - Identifies the starting node to build the agenda from.
   * @param direction - Edge traversal direction.
   * @param targetCols - Array of target column names for detailed tracking.
   */
  private seedAgenda(originId: string, direction: string, targetCols?: string[]): void {
    const neighbors = direction === 'upstream' ? this.graph.inNeighbors(originId) : direction === 'downstream' ? this.graph.outNeighbors(originId) : this.graph.neighbors(originId);
    for (const nid of neighbors as string[]) {
      this.enqueueHop(nid, `Analyze relationship to ${originId}`, 1, 0, targetCols);
    }
  }

  /**
   * Single funnel for all writes to the agenda.
   *
   * @remarks
   * Enforces the **bipartite agenda rule** by construction: only bodied nodes
   * (view / procedure / function) enter the agenda. Non-bodied nodes (tables,
   * externals) are *contracted* — the authored question flows through them to
   * their bodied neighbors in the current exploration direction, preserving the
   * caller's intent.
   *
   * Cycle guard: `visitedRefs` prevents infinite recursion on graphs with
   * reference-to-reference edges (e.g. a table that references another table).
   *
   * @param targetId - Node to enqueue (or contract).
   * @param question - Authored reason / sub-question for the visit. Preserved verbatim when forwarded.
   * @param depth - Topological depth relative to origin.
   * @param priority - Agenda priority (0 = BFS, 2 = routed, 3 = origin).
   * @param columns - Optional columns of interest (column-trace mode).
   * @param visitedRefs - Internal cycle guard for the recursive contraction step.
   */
  private enqueueHop(
    targetId: string,
    question: string,
    depth: number,
    priority: number,
    columns?: string[],
    visitedRefs: Set<string> = new Set(),
  ): void {
    if (!this.scopeNodeIds.has(targetId) && priority !== 3) return;
    if (this.visited.has(targetId) || this.removedSet.has(targetId)) return;
    const node = this.nodeMap.get(targetId);
    if (!node) return;

    if (SCRIPT_TYPES.has(node.type)) {
      // Bodied node — push directly (or merge into existing entry).
      const existing = this.agenda.find(e => e.nodeId === targetId);
      if (existing) {
        if (!existing.question.includes(question)) existing.question += ` | ${question}`;
        if (columns) existing.activeColumns = Array.from(new Set([...(existing.activeColumns ?? []), ...columns]));
        return;
      }
      this.agenda.push({ nodeId: targetId, question, priority, depth, activeColumns: columns });
      this.agendaIds.add(targetId);
      return;
    }

    // Non-bodied (table, external). Contract the edge: forward the authored
    // question to the target's bodied neighbors in the exploration direction.
    if (visitedRefs.has(targetId)) return;
    visitedRefs.add(targetId);
    const dir = this._direction;
    const next = dir === 'upstream'
      ? (this.graph.inNeighbors(targetId) as string[])
      : dir === 'downstream'
        ? (this.graph.outNeighbors(targetId) as string[])
        : (this.graph.neighbors(targetId) as string[]);
    for (const nid of next) {
      this.enqueueHop(nid, question, depth + 1, priority, columns, visitedRefs);
    }
  }

  /**
   * Collects neighboring node attributes for evaluation during hop routing.
   *
   * @param focusId - Central node identifier to derive neighbor connections from.
   * @returns Array of metadata structures matching neighbor hop properties.
   */
  private buildNeighborList(focusId: string): HopNeighbor[] {
    const ids = Array.from(new Set([...(this.graph.inNeighbors(focusId) as string[]), ...(this.graph.outNeighbors(focusId) as string[])])) as string[];
    const depthCap = this.computeDepthCap();
    const hasSchemaFilter = this.sessionAllowedSchemas.size > 0;
    return ids.map(nid => {
      const n = this.nodeMap.get(nid)!;
      const boundary = this.visited.has(nid) ? 'cycle' : 'none';
      // Column aspect active -> surface all available columns for the AI to choose from
      const cols = this._columnAspect
        ? getNodeColumns(nid, this.nodeMap, this.store ?? undefined)?.map(c => c.name)
        : undefined;
      const neighbor: HopNeighbor = {
        id: nid, s: n.schema, n: n.name, t: n.type,
        edge_direction: (this.graph.inNeighbors(focusId) as string[]).includes(nid) ? 'upstream' : 'downstream',
        edge_type: 'read', boundary, ...(cols?.length ? { cols } : {}),
      };

      const d = this.depthFromOrigin.get(nid);
      if (d !== undefined) neighbor.depth_from_origin = d;
      if (this.depthBudget !== null) neighbor.in_budget = this.scopeNodeIds.has(nid) && (depthCap === null || d === undefined || d <= depthCap);

      if (hasSchemaFilter) neighbor.in_approved_scope = this.sessionAllowedSchemas.has(n.schema.toLowerCase());

      const typeBlocked = this.excludedTypes.size > 0 && this.excludedTypes.has(n.type.toLowerCase());
      if (typeBlocked) {
        neighbor.in_approved_scope = false;
        neighbor.would_trigger_action_required = true;
      }

      const schemaBlocked = hasSchemaFilter && neighbor.in_approved_scope === false;
      const depthBlocked = depthCap !== null && d !== undefined && d > depthCap;
      if (schemaBlocked || depthBlocked) neighbor.would_trigger_action_required = true;
      return neighbor;
    });
  }

  /**
   * Packages exploration records into the final presentation topology.
   *
   * @returns Detailed analysis metrics matching the outcome format.
   */
  public getResult(): SmResult {
    const mem = this.memory.getResult();
    const notedIds = new Set(mem.detail_slots.map(s => s.nodeId));
    
    // The final graph consists of all nodes in the background scope that are still
    // reachable from the origin after pruning. This naturally includes passive
    // tables that the engine contracted over.
    const finalNodeIds = bfsReachable(this.graph, this.originNodeId!, this.removedSet, undefined, this.scopeNodeIds);

    const finalEdges: Array<[string, string, string]> = [];
    for (const e of this.model.edges) {
      if (finalNodeIds.has(e.source) && finalNodeIds.has(e.target)) {
        finalEdges.push([e.source, e.target, edgeApiType(e.type)]);
      }
    }

    const depthMap = bfsDepthMap(finalEdges, this.originNodeId!);
    const sortedIds = Array.from(finalNodeIds).sort((a, b) => (depthMap.get(a) ?? 999) - (depthMap.get(b) ?? 999));

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

  /**
   * JSON serialization override to emit the active map state.
   *
   * @returns Plain object suitable for JSON output routines.
   */
  public toJSON(): SmState {
    return {
      columnAspect: this._columnAspect,
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
