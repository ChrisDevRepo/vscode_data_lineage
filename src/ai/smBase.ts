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
import { findBridgeNodes, bfsDepthMap, wouldOrphanNotedNode, bfsReachable, type LogFn } from './smGuards';
import { AiMemoryManager, type WorkingMemory } from './memoryManager';
import type { ActionRequiredGate, ApprovedBorder, DeferredQuestion, DiagnosticsSnapshot, HopContext, HopNeighbor, HopSubmission, SmMode, SmResult, SmStatus, SubmitResult } from './smTypes';

/** Depth-cap offset for `soft` mode — one level past the user-declared budget. */
const SOFT_DEPTH_HEADROOM = 1;
/** Depth-cap offset for `silent` mode — two levels past the cautious start so autoadd can follow legitimate branches. */
const SILENT_DEPTH_HEADROOM = 2;
/** Ring-buffer size for `recent_rejections` surfaced in working memory. */
const RECENT_REJECTION_CAP = 5;
/** Defensive ceiling on the SM deferred-questions bucket — prevents a pathological session from flooding the final report. */
const MAX_DEFERRED = 50;

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
  /** The exploration mode type. */
  readonly mode: SmMode;
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
  toJSON(): unknown;
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
  /** The active exploration mode (e.g., 'blackboard', 'column_trace'). */
  public readonly mode: SmMode;

  /** Optional session identifier for tracking logs across rounds. */
  public sessionId?: string;
  /** The operational status of the state machine. */
  protected _status: SmStatus = 'created';
  /** Indicator for whether inline mode is active. */
  protected _inlineMode = false;
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

  /** Schemas (lower-cased) in the user's active filter — the initial allowlist for route validation. */
  protected userSchemas: Set<string> = new Set();
  /** Session-scoped schema allowlist. Starts as a copy of {@link userSchemas}; grows via {@link extendAllowedSchemas}. */
  protected sessionAllowedSchemas: Set<string> = new Set();
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
   * and seeded into the optional `confirm_scope_extension` envelope.
   */
  private readonly _deferredQuestions: DeferredQuestion[] = [];

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
  constructor(
    model: DatabaseModel,
    graph: Graph,
    log: LogFn,
    mode: SmMode,
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
    this.mode = mode;
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
   * Consumed at synthesis (rendered as the "Unanswered" section) and when priming the
   * post-synthesis `confirm_scope_extension` envelope. Callers cannot mutate the bucket
   * through this accessor.
   */
  public get deferredQuestions(): ReadonlyArray<DeferredQuestion> {
    return this._deferredQuestions;
  }

  /**
   * Records a deferred route — the sole entry point for mutating the bucket.
   *
   * @remarks
   * Deduplicates on `(nodeId, fromFocusNodeId)`: a later deferral for the same pair
   * replaces the earlier one (latest `atHop` and `question` win). Hard-capped at
   * {@link MAX_DEFERRED}; beyond the cap new entries are dropped and a log line is
   * emitted. Also records a rejection in memory so `recent_rejections` reflects the
   * same event — DRY with the inline gate path.
   *
   * @param entry - Fully-populated deferral record. Internal callers pass typed values;
   *   the participant boundary validates external payloads via `DeferredQuestionSchema`.
   * @returns The index of the stored entry (new or replaced), or `-1` if dropped at the ceiling.
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
    if (this._deferredQuestions.length >= MAX_DEFERRED) {
      this.log('warn', `[deferQuestion] MAX_DEFERRED=${MAX_DEFERRED} reached; dropping ${entry.nodeId}`);
      return -1;
    }
    this._deferredQuestions.push(entry);
    this.memory.recordRejection(entry.nodeId, `deferred: out of approved scope (${entry.reason})`, entry.atHop);
    return this._deferredQuestions.length - 1;
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

  /**
   * Gets the details for the next scheduled navigation hop.
   *
   * @returns Context data mapped for the AI router.
   */
  public getHopContext(): HopContext {
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

    // Always surface depth_from_origin when a budget is in force — visibility required for self-correction
    // regardless of enforcement mode. Hiding depth in silent mode was the inverse of the "start small, autoadd
    // carefully" intent (see plan §A.2).
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
      visited_nodes: Array.from(this.visited),
      current_focus: entry.nodeId,
      agenda: this.agenda.map(a => ({ id: a.nodeId, name: this.nodeMap.get(a.nodeId)?.name ?? a.nodeId, question: a.question })),
    };

    if (this.depthBudget !== null) {
      (workingMemory as any).depth_budget = this.depthBudget;
      (workingMemory as any).depth_enforcement = this.depthEnforcement;
      (workingMemory as any).depth_cap = this.computeDepthCap();
      if (this.budgetExpansions.length > 0) {
        (workingMemory as any).budget_expansions = this.budgetExpansions.slice();
      }
    }

    // SM closed-loop signals: the AI reads the locked border every hop plus the running
    // deferred tally, so it can self-correct routing without seeing the full deferred list
    // (preserved for synthesis where it matters for the final report).
    if (!this._inlineMode) {
      const border: ApprovedBorder = {
        schemas: Array.from(this.sessionAllowedSchemas).sort(),
        depth_cap: this.computeDepthCap(),
      };
      (workingMemory as any).approved_border = border;
      (workingMemory as any).deferred_count = this._deferredQuestions.length;
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

  /**
   * Processes the findings from a completed hop and adjusts the agenda.
   *
   * @param params - Submission details including focus, verdict, and routing data.
   * @returns Information summarizing the operation's outcome.
   */
  public submitFindings(params: HopSubmission): SubmitResult {
    if (this._status !== 'awaiting_findings') {
      const hint = this._status === 'complete'
        ? 'The engine already completed this exploration. Produce the synthesis output (chat prose + enrich_view) now — do not call submit_findings again.'
        : this._status === 'error'
          ? 'The engine is in an error state. Call start_exploration to begin a fresh exploration.'
          : `Engine is in status '${this._status}'. Expected 'awaiting_findings'. Wait for a hop context, or restart via start_exploration if the session was wiped.`;
      return { error: 'invalid_status', current_status: this._status, hint } as any;
    }

    const focusId = params.focus_node_id?.toLowerCase();
    if (focusId !== this.currentFocusNodeId) {
      return { error: 'focus_mismatch', expected: this.currentFocusNodeId ?? undefined, got: focusId };
    }

    // Route validation proceeds in three layers:
    //   1. Hard invalid routes — unknown node ids, bad columns → `route_validation_failed`.
    //   2. Inline-mode consent gates — schema/depth violations accumulate into one `action_required`
    //      envelope that pauses the active loop until the user replies.
    //   3. SM-mode deferrals — out-of-approved-scope routes are recorded in `_deferredQuestions`
    //      (via `deferQuestion`) and surfaced at synthesis; the loop continues without pausing.
    this.lastRoutedNew = 0;
    this.lastRoutedRejected = 0;
    this.lastRoutedDeferred = 0;
    if (params.route_requests) {
      const invalidRoutes: Array<{ id: string; reason: string }> = [];
      const depthCap = this.computeDepthCap();
      const gateClasses = new Set<string>();
      const gateNodeIds: string[] = [];
      const gateDetails: string[] = [];
      let gateHasSchema = false;
      let gateHasDepth = false;

      for (const req of params.route_requests) {
        const nid = req.nodeId?.toLowerCase();
        const nNode = nid ? this.nodeMap.get(nid) : null;
        if (!nNode || !nid) {
          invalidRoutes.push({ id: req.nodeId, reason: 'Node not found.' });
          continue;
        }

        // Schema blocked — route targets a schema outside the session allowlist.
        const schemaLower = nNode.schema.toLowerCase();
        const schemaBlocked = this.sessionAllowedSchemas.size > 0 && !this.sessionAllowedSchemas.has(schemaLower);

        // Depth blocked — target beyond the effective cap. Memoize shortest-path depth so repeat
        // routes to the same out-of-scope node don't recompute.
        let candidateDepth = this.depthFromOrigin.get(nid);
        if (candidateDepth === undefined && this.originNodeId) {
          const path = bidirectional(this.graph, this.originNodeId, nid);
          candidateDepth = Array.isArray(path) ? path.length - 1 : undefined;
          if (candidateDepth !== undefined) this.depthFromOrigin.set(nid, candidateDepth);
        }
        const depthBlocked = depthCap !== null && candidateDepth !== undefined && candidateDepth > depthCap;

        if (schemaBlocked || depthBlocked) {
          if (this._inlineMode) {
            // Inline: consent-gate flow (unchanged).
            gateNodeIds.push(req.nodeId);
            if (schemaBlocked) {
              gateHasSchema = true;
              gateClasses.add(`schema:${schemaLower}`);
              gateDetails.push(`\`${req.nodeId}\` is in schema \`${nNode.schema}\`, outside the active filter`);
            }
            if (depthBlocked) {
              gateHasDepth = true;
              const extraOffset = candidateDepth! - depthCap!;
              gateClasses.add(`depth:+${extraOffset}`);
              gateDetails.push(`\`${req.nodeId}\` is at depth ${candidateDepth}, beyond the current cap ${depthCap}`);
            }
          } else {
            // SM: defer, keep the closed-loop invariant. `deferQuestion` owns dedup + rejection record.
            this.deferQuestion({
              nodeId: req.nodeId,
              schema: nNode.schema,
              fromFocusNodeId: this.currentFocusNodeId!,
              question: req.question ?? '',
              reason: schemaBlocked && depthBlocked ? 'schema_and_depth' : schemaBlocked ? 'schema' : 'depth',
              depth: candidateDepth,
              atHop: this.hopCount,
            });
            this.lastRoutedDeferred++;
          }
          continue;
        }

        // Accept the route. Soft/silent mode may expand the scope to include in-cap out-of-scope nodes.
        if (!this.scopeNodeIds.has(nid)) {
          this.scopeNodeIds.add(nid);
          const focusDepth = this.depthFromOrigin.get(this.currentFocusNodeId!) ?? 0;
          if (!this.depthFromOrigin.has(nid)) this.depthFromOrigin.set(nid, focusDepth + 1);
          if (this.depthBudget !== null && this.depthEnforcement !== 'strict') {
            this.budgetExpansions.push({ nodeId: nid, depth: focusDepth + 1, atHop: this.hopCount });
          }
        }
        if (req.columns) {
          if (this.mode !== 'column_trace') {
            req.columns = undefined;
          } else {
            const validCols = new Set(getNodeColumns(nNode.id, this.nodeMap, this.store ?? undefined)?.map(c => c.name.toLowerCase()));
            const invalidCols = req.columns.filter((c: string) => !validCols.has(c.toLowerCase()));
            if (invalidCols.length > 0) invalidRoutes.push({ id: req.nodeId, reason: `Columns not found: ${invalidCols.join(', ')}` });
          }
        }
      }

      if (invalidRoutes.length > 0) {
        this.lastRoutedRejected = invalidRoutes.length;
        for (const r of invalidRoutes) this.memory.recordRejection(r.id, r.reason, this.hopCount);
        return { error: 'route_validation_failed', detail: invalidRoutes };
      }

      // Invariant: reached only in inline mode. SM routes through `deferQuestion` above.
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
    }

    const isIrrelevant = params.verdict === 'irrelevant';
    const prunable = isIrrelevant && this.currentFocusNodeId !== this.originNodeId;
    if (prunable) {
      // Topological protection only — don't orphan already-analyzed (noted) nodes.
      // We do NOT second-guess the AI's verdict with numeric cascade thresholds: the AI has the
      // only content view (read the DDL, emitted one of relevant|pass|irrelevant). SM is
      // content-blind and owns execution, not judgment. If a session over-prunes, fix the
      // `irrelevant` rubric in the prompt (smPrompts.ts BLOCK.verdictCategories).
      const notedIds = new Set<string>(this.memory.notedNodeIds);
      const orphan = wouldOrphanNotedNode(this.graph, this.originNodeId!, this.removedSet, notedIds, this.currentFocusNodeId!);
      if (orphan) {
        return { error: 'prune_would_orphan_noted', detail: `Marking ${this.currentFocusNodeId} irrelevant would orphan already-analyzed node "${orphan}". Use verdict='pass' to skip without pruning.` };
      }
    }

    if (!isIrrelevant) {
      this.memory.storeDetail(this.nodeMap.get(this.currentFocusNodeId!)!, params.detail_analysis, params.summary, {
        badge_label: params.badge_label,
        note_caption: params.note_caption
      }, this._inlineMode);
      this.lastHopDetailChars = params.detail_analysis?.length ?? 0;
      this.lastHopSummaryChars = params.summary?.length ?? 0;
      this.archiveChars += this.lastHopDetailChars + this.lastHopSummaryChars;
    } else {
      this.lastHopDetailChars = 0;
      this.lastHopSummaryChars = 0;
    }

    // Record the verdict AFTER guards passed so the tally reflects accepted submissions only.
    this.memory.recordVerdict(params.verdict);

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
          this.lastRoutedNew++;
        }
      }
    }

    this._status = 'exploring';

    if (params.complete && this._inlineMode) {
      this._status = 'complete';
      return { ok: true, done: true, result: this.getResult() };
    }

    return cascadedCount > 0 ? { ok: true, cascaded_count: cascadedCount } : { ok: true };
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
      if (this.scopeNodeIds.has(nid) && !this.agendaIds.has(nid)) {
        this.agenda.push({ nodeId: nid, question: `Analyze relationship to ${originId}`, priority: 0, depth: 1, activeColumns: targetCols });
        this.agendaIds.add(nid);
      }
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
      const cols = getNodeColumns(nid, this.nodeMap, this.store ?? undefined)?.map(c => c.name);
      const neighbor: HopNeighbor = {
        id: nid, s: n.schema, n: n.name, t: n.type,
        edge_direction: (this.graph.inNeighbors(focusId) as string[]).includes(nid) ? 'upstream' : 'downstream',
        edge_type: 'read', boundary, cols,
      };

      const d = this.depthFromOrigin.get(nid);
      if (d !== undefined) neighbor.depth_from_origin = d;
      if (this.depthBudget !== null) neighbor.in_budget = this.scopeNodeIds.has(nid) && (depthCap === null || d === undefined || d <= depthCap);

      if (hasSchemaFilter) neighbor.in_approved_scope = this.sessionAllowedSchemas.has(n.schema.toLowerCase());

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
    
    const edges: Array<[string, string, string]> = [];
    for (const e of this.model.edges) {
      if (this.scopeNodeIds.has(e.source) && this.scopeNodeIds.has(e.target)
          && !this.removedSet.has(e.source) && !this.removedSet.has(e.target)) {
        edges.push([e.source, e.target, edgeApiType(e.type)]);
      }
    }

    const bridge = findBridgeNodes(this.graph, notedIds, edges, this.edgeTypeMap);
    const finalEdges = [...edges, ...bridge.bridgeEdges];
    const finalNodeIds = new Set([...Array.from(notedIds), ...bridge.bridgeNodes.map(n => n.id), this.originNodeId!]);

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
  public toJSON(): unknown {
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
