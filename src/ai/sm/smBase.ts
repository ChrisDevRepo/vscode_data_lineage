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
import type { DatabaseModel, LineageNode } from '../../engine/types';
import type { ColumnStore } from '../../engine/columnStore';
import type { SerializedFilterState } from '../../engine/projectStore';
import { buildNodeMap, buildEdgeTypeMap, getNodeColumns, getNodeDdl, buildHopFocusNode, SCRIPT_TYPES } from '../tools/tools';
import { edgeApiType } from '../infra/aiPresenter';
import { bfsDepthMap, wouldOrphanNotedNode, firstDisconnectedRequiredNode, bfsReachable, type LogFn } from '../sm/smGuards';
import { trunc } from '../../utils/log';
import { AiMemoryManager, type DetailSlot, type WorkingMemory } from '../session/memoryManager';
import { resolveModelNodeId, sanitizeMissionBrief } from '../infra/inputNormalization';
import type { ApprovedBorder, ColumnAspect, ColumnEdge, DeferredQuestion, DiagnosticsSnapshot, HopContext, HopNeighbor, HopProgress, HopSubmission, RouteOutcome, ScopeSummary, ScopeSummaryLeaf, SmNodeAction, SmNodeState, SmNodeStateReason, SmNodeStateSource, SmResult, SmState, SmStatus, SubmitResult } from '../sm/smTypes';
import { estimateTokens } from '../infra/tokenBudget';

/** Depth-cap offset for `soft` mode — one level past the user-declared budget. */
const SOFT_DEPTH_HEADROOM = 1;
/** Depth-cap offset for `silent` mode — two levels past the cautious start so autoadd can follow legitimate branches. */
const SILENT_DEPTH_HEADROOM = 2;
/** Ring-buffer size for `recent_rejections` surfaced in working memory. */
const RECENT_REJECTION_CAP = 5;


export type { SmStatus, HopNeighbor, HopContext, HopSubmission, SmResult, SubmitResult } from '../sm/smTypes';
export type { BoundaryFlag } from '../sm/smTypes';

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
  /** Active depth budget at session start (omitted when unbounded). */
  depth_budget?: number;
  /** How the depth budget is enforced. */
  depth_enforcement?: 'strict' | 'soft' | 'silent';
  /** Effective depth ceiling including mode headroom and any session extensions. */
  depth_cap?: number | null;
  /** Per-node scope-expansion records (soft/silent mode only). */
  budget_expansions?: Array<{ nodeId: string; depth: number; atHop: number }>;
  /** Border the user approved at session start — present in SM mode only. */
  approved_border?: ApprovedBorder;
  /** Count of out-of-scope routes deferred to the post-session review list. */
  deferred_count?: number;
  /** Column-trace aspect, present when the session has `targetColumns`. */
  column_aspect?: ColumnAspect;
}

/**
 * Defines the core interface for the state machine handling exploration modes.
 */
export interface IHopStateMachine {
  /** The current status of the state machine. */
  readonly status: SmStatus;
  /** The size of the current exploration scope. */
  readonly scopeSize: number;
  /** Count of bodied (view/proc/function) nodes in scope — the true hop denominator. */
  readonly bodiedScopeSize: number;
  /** The percentage of nodes in scope that have been covered. */
  readonly coveragePct: number;
  /** The active column-tracing aspect, if any. */
  readonly columnAspect: ColumnAspect | null;
  /** Out-of-approved-scope routes deferred during the SM session. */
  readonly deferredQuestions: ReadonlyArray<DeferredQuestion>;
  /** Current focus node id (node the AI must analyse this hop) — null before the first hop. */
  readonly currentFocus: string | null;
  /** Live hop progress: completed AI hops, queued nodes, and total acknowledged nodes. */
  readonly hopProgress: HopProgress;

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
   * Derives column lineage sub-questions from edges accumulated in the most recent hop (CT only).
   *
   * @remarks
   * Called after a successful `submitFindings` to generate engine-side lineage questions
   * for the next hop. Each question names a non-terminal upstream source that still needs
   * tracing. Returns an empty array when CT is inactive or the hop produced no trackable edges.
   */
  getColumnLineageQuestions(): string[];

  /** Every captured detail slot in insertion order — diagnostics / telemetry use. */
  getDetailSlots(): DetailSlot[];

  /** Cumulative detail + summary char count across all hops. */
  getArchiveChars(): number;

  /**
   * Extends a completed exploration with additional nodes for analysis.
   *
   * @remarks
   * Used by the follow-up phase (post-synthesis). Only callable when
   * `status === 'complete'` and at least one bodied id is supplied. The engine
   * re-enters `awaiting_findings` and new `DetailSlot` entries merge into the
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
  /** The active column-tracing aspect, initialized if targetColumns are provided. */
  protected _columnAspect: ColumnAspect | null = null;
  /** ID of the initial or root node for navigation. */
  protected originNodeId: string | null = null;
  /** Set of node identifiers within the active scope. */
  protected scopeNodeIds = new Set<string>();
  /** Set of node identifiers that have already been explored. */
  protected visited = new Set<string>();
  /** CT auto-pruned node ids: dequeued but had no active columns — skipped without an AI call. */
  protected ctAutoPrunedNodeIds = new Set<string>();
  /** Set of node identifiers excluded during exploration cascades. */
  protected removedSet = new Set<string>();
  /** Engine-owned lifecycle state for nodes; detail slots are content storage only. */
  protected nodeStates = new Map<string, SmNodeState>();
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
  /** Count of bodied (view/proc/function) nodes in scope — maintained incrementally. */
  private _bodiedScopeSize = 0;
  /** Total acknowledged bodied nodes: initialised to bodiedScopeSize at gate approval, +1 on out-of-scope expansion, −1 on prune. */
  private _totalNodes = 0;
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
  /** Schemas (lower-cased) the user asked to exclude; pruned from scope at init. */
  protected excludedSchemas: Set<string> = new Set();
  /** Specific node ids (lower-cased) the user asked to exclude; pruned from scope at init. */
  protected excludedNodeIds: Set<string> = new Set();
  /** Object types hidden by the GUI filter at session start. Advisory only — diagnostic logs flag whether the AI honored them via `excludeTypes`. */
  protected guiHiddenTypes: Set<string> = new Set();
  /**
   * Specific node ids (lower-cased) the user asked to keep in scope but skip analysis on.
   * The hop dispatcher detects these on dequeue and auto-emits `verdict:'pass'` — topology
   * is preserved so descendants stay reachable.
   */
  protected passNodeIds: Set<string> = new Set();
  /** Last `init` params kept for refine re-run — origin/direction/depth/etc survive across the gate cycle. */
  protected initSnapshot: { question: string; origin: string; targetColumns?: string[]; direction: 'upstream' | 'downstream' | 'bidirectional'; depth?: number; upstream_depth?: number; downstream_depth?: number; depth_enforcement?: 'strict' | 'soft' | 'silent'; mission_brief?: string } | null = null;

  /**
   * Compressed AI-composed memo of the discovery walk's findings + user-stated
   * semantic constraints, composed once after gate approval and rendered into
   * every hop's stable prefix as `<discovery_summary>` (alongside
   * `<mission_brief>` and the sliding `<short_term_memory>`).
   *
   * @remarks
   * Captures the user-stated intent that **cannot** be expressed in the
   * structural approval fields (origin / direction / excludeNodeIds /
   * excludeSchemas / excludeTypes / passNodeIds / classification): things like
   * *"ignore audit-related processing"*, *"focus on the revenue computation
   * chain"*, *"the report must answer how X impacts Y"*. These are semantic
   * constraints that need to ride with the AI across every hop because the
   * AI may meet a relevant node mid-walk that wasn't pre-listable.
   *
   * Set once by the post-approval composition round in
   * {@link lineageParticipant.ts}; never wiped by sliding-memory rotations.
   * Cleared only when a fresh engine is constructed (i.e. a new
   * `start_exploration` from `idle`). Read by the prompt assembler via
   * {@link getDiscoverySummary}.
   */
  protected _discoverySummary: string | null = null;
  /** Extra depth levels the user has confirmed mid-session beyond the mode-cap. 0 = no extension. */
  protected extendedDepthCap = 0;
  /** Last per-hop snapshot of detail/summary chars, used for diagnostics. */
  protected lastHopDetailChars = 0;
  /** Last per-hop summary-char count. */
  protected lastHopSummaryChars = 0;
  /** Last per-hop verdict — surfaced in `[AI] [Hop N]` log line. */
  protected lastHopVerdict: 'analyze' | 'pass' | 'prune' | null = null;
  /** Cumulative archive chars across the whole session. */
  protected archiveChars = 0;
  /** Route requests accepted during the most recent submit, for diagnostics. */
  protected lastRoutedNew = 0;
  /** Route requests rejected during the most recent submit, for diagnostics. */
  protected lastRoutedRejected = 0;
  /** Route requests deferred during the most recent submit (SM mode), for diagnostics. */
  protected lastRoutedDeferred = 0;
  /** column_flow entries submitted this hop (CT only — 0 when CT not active). */
  protected lastHopColumnFlowEntries = 0;
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

    // GUI-hidden types captured for diagnostics. The BFS log shows whether the AI
    // honored or ignored them. Schemas already flow through `sessionAllowedSchemas`
    // (route deferral surface) so no parallel structure is needed for them.
    const ALL_OBJECT_TYPES = ['table', 'view', 'procedure', 'function', 'external'] as const;
    const guiActiveTypes = config.activeFilter?.types?.map(t => t.toLowerCase()) ?? [];
    if (guiActiveTypes.length > 0) {
      this.guiHiddenTypes = new Set(ALL_OBJECT_TYPES.filter(t => !guiActiveTypes.includes(t)));
    }
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
   * Records the process lifecycle state for a node.
   *
   * @remarks
   * This is the source of truth for whether a node was analyzed, passed through,
   * or pruned. `DetailSlot` remains only the text bucket. Stronger terminal
   * states replace weaker ones, so an AI-analyzed node is not later downgraded
   * by an incidental pass-through observation.
   */
  private markNodeState(
    nodeId: string,
    action: SmNodeAction,
    source: SmNodeStateSource,
    reason: SmNodeStateReason,
    meta: { columns?: string[]; viaNodeId?: string; atHop?: number } = {},
  ): void {
    const id = resolveModelNodeId(nodeId, this.nodeMap) ?? nodeId.toLowerCase();
    if (!this.nodeMap.has(id)) return;

    const rank = (a: SmNodeAction): number => {
      if (a === 'prune') return 3;
      if (a === 'analyze') return 2;
      return 1;
    };
    const existing = this.nodeStates.get(id);
    const mergedColumns = Array.from(new Set([...(existing?.columns ?? []), ...(meta.columns ?? [])]));
    if (existing && rank(existing.action) > rank(action)) {
      this.nodeStates.set(id, {
        ...existing,
        columns: mergedColumns.length > 0 ? mergedColumns : existing.columns,
      });
      return;
    }

    this.nodeStates.set(id, {
      nodeId: id,
      action,
      source,
      reason,
      ...(mergedColumns.length > 0 ? { columns: mergedColumns } : {}),
      ...(meta.viaNodeId ? { viaNodeId: meta.viaNodeId } : existing?.viaNodeId ? { viaNodeId: existing.viaNodeId } : {}),
      ...(typeof meta.atHop === 'number' ? { atHop: meta.atHop } : existing?.atHop !== undefined ? { atHop: existing.atHop } : {}),
    });
  }

  private roleFromNodeState(nodeId: string): 'origin' | 'noted' | 'bridge' | 'pass' {
    if (nodeId === this.originNodeId) return 'origin';
    const state = this.nodeStates.get(nodeId);
    if (state?.action === 'analyze') return 'noted';
    if (state?.action === 'pass') return 'pass';
    return 'bridge';
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
      verdict: this.lastHopVerdict,
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
      ...(this._columnAspect ? {
        columnEdgeCount: this._columnAspect.edges.length,
        activeColumnCount: this._columnAspect.active_columns.length,
        columnFlowEntries: this.lastHopColumnFlowEntries,
      } : {}),
    };
  }

  /**
   * Derives column lineage sub-questions from the most recent hop's edges (CT only).
   *
   * @remarks
   * Groups edges by `from_node.from_col`; emits one question per unique non-terminal source.
   * `role='source'` edges are skipped — they are resolved terminals, no further tracing needed.
   * `filter_only` edges are already excluded from `_columnAspect.edges` at accumulation time.
   */
  public getColumnLineageQuestions(): string[] {
    if (!this._columnAspect || !this.currentFocusNodeId) return [];
    const focusId = this.currentFocusNodeId;
    const hopEdges = this._columnAspect.edges.filter(
      e => e.hop_node === focusId && e.hop === this.hopCount,
    );
    if (hopEdges.length === 0) return [];
    const questions: string[] = [];
    const seen = new Set<string>();
    for (const edge of hopEdges) {
      if (edge.role === 'source') continue;
      const key = `${edge.from_node}.${edge.from_col}`;
      if (seen.has(key)) continue;
      seen.add(key);
      questions.push(
        `Column \`${edge.to_col}\`: flows from \`${edge.from_node}.${edge.from_col}\` (${edge.role}) — trace its origin at \`${edge.from_node}\`.`,
      );
    }
    return questions;
  }

  /**
   * Returns every captured detail slot in insertion order.
   *
   * @remarks
   * Diagnostics accessor for telemetry / eval extraction. Mirrors
   * `getResult().detail_slots` but is callable mid-exploration without
   * forcing the synthesis-phase shape. Slot count equals the number of
   * nodes that produced at least one `submit_findings.sections[]` entry.
   */
   public getDetailSlots(): DetailSlot[] {    return this.memory.getResult().detail_slots;
  }

  /**
   * Cumulative char-count of detail + summary text written across all hops.
   *
   * @remarks
   * Mirrors {@link DiagnosticsSnapshot.archiveChars} but exposes the value
   * outside the per-hop diagnostics envelope so callers can audit memory
   * pressure without parsing a hop snapshot.
   */
  public getArchiveChars(): number {
    return this.archiveChars;
  }

  /** Gets the operational status. */
  public get status(): SmStatus {
    return this._status;
  }

  /** Gets the active column-tracing aspect, if any. */
  public get columnAspect(): ColumnAspect | null {
    return this._columnAspect;
  }

  /** Updates column-trace target columns for the current session. */
  public setColumnTargets(targetColumns: string[]): void {
    this._columnAspect = {
      target_columns: targetColumns,
      active_columns: targetColumns,
      edges: [],
    };
  }

  /** Gets the size of the active exploration scope. */
  public get scopeSize(): number {
    return this.scopeNodeIds.size;
  }

  /** Gets the count of bodied (view/proc/function) nodes in scope — the true hop denominator. */
  public get bodiedScopeSize(): number {
    return this._bodiedScopeSize;
  }

  /** Gets live hop progress: completed AI hops, queued nodes, and total acknowledged nodes. */
  public get hopProgress(): HopProgress {
    return { current: this.hopCount, open: this.agenda.length, total: this._totalNodes };
  }

  private set bodiedScopeSize(v: number) {
    this._bodiedScopeSize = v;
  }

  /** Gets the percentage of scope nodes covered. */
  public get coveragePct(): number {
    return this.scopeNodeIds.size > 0 ? Math.round((this.memory.slotCount / this.scopeNodeIds.size) * 100) : 0;
  }

  /** Origin id captured at the most recent {@link init}. Used by the refine path to re-init without re-asking the AI. */
  public get currentOrigin(): string | null {
    return this.initSnapshot?.origin ?? null;
  }

  /** Direction captured at {@link init}. */
  public get currentDirection(): 'upstream' | 'downstream' | 'bidirectional' {
    return this._direction;
  }

  /** Depth budget captured at {@link init} (null when unbounded). */
  public get currentDepth(): number | null {
    return this.depthBudget;
  }

  /** Asymmetric upstream depth captured at {@link init}, when set; otherwise null. */
  public get currentUpstreamDepth(): number | null {
    return this.initSnapshot?.upstream_depth ?? null;
  }

  /** Asymmetric downstream depth captured at {@link init}, when set; otherwise null. */
  public get currentDownstreamDepth(): number | null {
    return this.initSnapshot?.downstream_depth ?? null;
  }

  /** Depth-enforcement mode captured at {@link init}. */
  public get currentDepthEnforcement(): 'strict' | 'soft' | 'silent' {
    return this.depthEnforcement;
  }

  /** Original user question captured at {@link init}. */
  public get currentQuestion(): string {
    return this.initSnapshot?.question ?? '';
  }

  /** Mission brief captured at {@link init}. */
  public get currentMissionBrief(): string | null {
    return this.initSnapshot?.mission_brief ?? null;
  }

  /** Target columns captured at {@link init} (null when no column-trace aspect). */
  public get currentTargetColumns(): string[] | null {
    return this.initSnapshot?.targetColumns ?? null;
  }

  /**
   * Builds a one-shot snapshot of the proposed scope for the `confirm_sm_start` gate detail.
   *
   * @remarks
   * Single source of truth — the gate's "Scope: N" line and the rendered tree both come
   * from this object so the count and the tree never diverge. Cap is honoured per leaf
   * to keep gate detail under chat-message size limits; overflow surfaced as `omitted`.
   *
   * @param namesPerType - Cap on names listed under each (schema,type) pair. Default 8.
   */
  public getScopeSummary(namesPerType: number = 8): ScopeSummary {
    const bySchema: Record<string, { hops: number; scope: number; byType: Record<string, ScopeSummaryLeaf> }> = {};
    let hopCount = 0;

    for (const id of this.scopeNodeIds) {
      const n = this.nodeMap.get(id);
      if (!n) continue;
      const schema = n.schema;
      const type = n.type ?? 'external';
      const isBodied = SCRIPT_TYPES.has(n.type);
      if (isBodied) hopCount++;

      if (!bySchema[schema]) bySchema[schema] = { hops: 0, scope: 0, byType: {} };
      const sch = bySchema[schema];
      sch.scope++;
      if (isBodied) sch.hops++;

      if (!sch.byType[type]) sch.byType[type] = { hops: 0, scope: 0, nodeNames: [], omitted: 0 };
      const leaf = sch.byType[type];
      leaf.scope++;
      if (isBodied) leaf.hops++;
      if (leaf.nodeNames.length < namesPerType) leaf.nodeNames.push(n.name);
      else leaf.omitted++;
    }

    // Sort names alphabetically inside each leaf for stable rendering.
    for (const sch of Object.values(bySchema)) {
      for (const leaf of Object.values(sch.byType)) {
        leaf.nodeNames.sort((a, b) => a.localeCompare(b));
      }
    }

    const estimatedDdlChars = this.estimateScopeDdlChars();

    return {
      hopCount,
      scopeCount: this.scopeNodeIds.size,
      origin: this.originNodeId ?? '',
      depth: this.depthBudget,
      upstreamDepth: this.initSnapshot?.upstream_depth ?? null,
      downstreamDepth: this.initSnapshot?.downstream_depth ?? null,
      direction: this._direction,
      columnAspectActive: !!this._columnAspect,
      targetColumns: this._columnAspect?.target_columns,
      estimatedDdlChars,
      estimatedDdlTokens: estimateTokens(estimatedDdlChars),
      bySchema,
      activeFilters: {
        schemas: Array.from(this.excludedSchemas).sort(),
        types: Array.from(this.excludedTypes).sort(),
        nodeIds: Array.from(this.excludedNodeIds).sort(),
        passNodeIds: Array.from(this.passNodeIds).sort(),
      },
    };
  }

  /**
   * Classifies a list of candidate node ids into prunable vs must-pass-through.
   *
   * @remarks
   * A node is **prunable** when removing it from {@link scopeNodeIds} leaves every
   * other in-scope node still reachable from {@link originNodeId} along the active
   * direction. Otherwise it is **must-pass** — pruning would orphan in-scope
   * descendants the user did not ask to remove. The AI consumes this result to
   * pick between `excludeNodeIds` (prunable) and `passNodeIds` (must-pass).
   *
   * @param nodeIds - Candidate ids the AI is considering removing.
   */
  public classifyForRefine(nodeIds: string[]): { prunable: string[]; mustPass: string[] } {
    if (!this.originNodeId) return { prunable: [], mustPass: [] };
    const prunable: string[] = [];
    const mustPass: string[] = [];

    for (const raw of nodeIds) {
      const id = raw.toLowerCase();
      if (!this.scopeNodeIds.has(id) || id === this.originNodeId.toLowerCase()) {
        prunable.push(raw);
        continue;
      }
      // Pretend `id` is removed; check whether every other in-scope node is still
      // reachable from the origin within the current direction.
      const removed = new Set<string>([id]);
      const reachable = bfsReachable(this.graph, this.originNodeId, removed, undefined, this.scopeNodeIds);
      let orphaned = false;
      for (const sid of this.scopeNodeIds) {
        if (sid === id) continue;
        if (!reachable.has(sid)) { orphaned = true; break; }
      }
      if (orphaned) mustPass.push(raw); else prunable.push(raw);
    }

    return { prunable, mustPass };
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
    return ids.filter(id => !this.scopeNodeIds.has(id.toLowerCase()) || !directNeighbors.has(id.toLowerCase()));
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

  /** Current focus node id exposed for prompt builders — populates the `focus_node_id` line in `<mission_state>` so the AI sees its target in prose, not only in tool-result JSON. `null` before the first hop. */
  public get currentFocus(): string | null {
    return this.currentFocusNodeId;
  }

  /**
   * Returns the compressed discovery-summary memo composed at the post-approval
   * round, or `null` when none has been set (e.g. SM started without a prior
   * discovery walk because the user's first prompt asked directly for a graph
   * render). Read by the prompt assembler to render `<discovery_summary>` in
   * every hop's stable prefix.
   */
  public getDiscoverySummary(): string | null {
    return this._discoverySummary;
  }

  /**
   * Stores the AI-composed discovery summary. Called once by the participant
   * after gate approval and a single LM round produces the memo text. Empty /
   * whitespace-only inputs are coerced to `null` so the renderer can short-
   * circuit cleanly. The memo persists across all sliding-memory wipes inside
   * this engine's lifetime.
   *
   * @param text - The 2–4 sentence memo composed by the AI.
   */
  public setDiscoverySummary(text: string): void {
    const trimmed = text.trim();
    this._discoverySummary = trimmed.length > 0 ? trimmed : null;
  }

  /**
   * Detects a slot-hijack attempt where any captured section opens by naming a **different**
   * scope node than the declared `focus_node_id`.
   *
   * @remarks
   * Mechanical identifier-match contract — does NOT judge content quality. Scans the opening
   * (first 200 chars) of each section's text. Returns `null` when:
   * - No section contains a backticked identifier in its opening.
   * - The first identifier in every section matches the focus (normalised).
   * - The first identifier is not a known scope node (columns, external refs, SQL keywords pass through).
   *
   * Returns the mismatched scope-node id from the first offending section.
   *
   * @param focusNodeId - The declared focus from `submit_findings.focus_node_id`.
   * @param sections - The authored capture sections (may be empty for verdict=prune).
   * @returns The mismatched scope node id, or `null` when no mismatch.
   */
  /** Stores the current-task question at the moment a hop context is delivered. */
  private _lastCurrentTask = '';

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
    upstream_depth?: number;
    downstream_depth?: number;
    depth_enforcement?: 'strict' | 'soft' | 'silent';
    excludeTypes?: string[];
    excludeSchemas?: string[];
    excludeNodeIds?: string[];
    passNodeIds?: string[];
    mission_brief?: string;
  }): { ok: true; scopeSize: number; agendaSize: number; scopeSchemas: string[] } | { error: string; hint?: string; unresolved_excludeNodeIds?: string[]; unresolved_passNodeIds?: string[] } {
    // Refine detection: initSnapshot is null on first init, populated thereafter — survives status transitions.
    const wasRefine = this.initSnapshot !== null;
    const prevScopeSize = this.scopeNodeIds.size;
    this.visited.clear();
    this.agenda = [];
    this.agendaIds.clear();
    this.nodeStates.clear();
    this.memory.reset();
    this.memory.setUserQuestion(params.question);
    const sanitizedMission = params.mission_brief ? sanitizeMissionBrief(params.mission_brief) : null;
    if (sanitizedMission?.text) {
      this.memory.setMissionBrief(sanitizedMission.text);
      this.log('debug', `[Mission] brief=${trunc(sanitizedMission.text, 200)}`);
    }
    if (sanitizedMission?.changed) {
      this.log('debug', `[Mission] sanitized reasons=[${sanitizedMission.reasons.join(',')}] old_len=${params.mission_brief!.length} new_len=${sanitizedMission.text.length}`);
    }
    // Validate user-named identifier filters resolve to real graph nodes before storing.
    // Unknown ids would silently no-op at scope-build time (excludedNodeIds.has(id) returns
    // false for ids never present in the seen set), masking the AI inventing wrong-schema ids.
    const resolveId = (raw: string): string | null => resolveModelNodeId(raw, this.nodeMap);
    const partition = (raws: string[]): { resolved: string[]; unresolved: string[] } => {
      const resolved: string[] = [];
      const unresolved: string[] = [];
      for (const raw of raws) {
        const id = resolveId(raw);
        if (id) resolved.push(id); else unresolved.push(raw);
      }
      return { resolved, unresolved };
    };
    const excludeIds = partition(params.excludeNodeIds ?? []);
    const passIds = partition(params.passNodeIds ?? []);
    if (excludeIds.unresolved.length > 0 || passIds.unresolved.length > 0) {
      this.log('debug', `[AI] [NL] excludeNodeIds resolved=[${excludeIds.resolved.join(',')}] unresolved=[${excludeIds.unresolved.join(',')}] passNodeIds resolved=[${passIds.resolved.join(',')}] unresolved=[${passIds.unresolved.join(',')}]`);
      return {
        error: 'unknown_node_ids',
        hint: "These ids don't exist in the loaded model after bracket/case normalization. Call lineage_search_objects with each user-named identifier to resolve the canonical schema-qualified id, then re-call lineage_start_exploration with the corrected list.",
        unresolved_excludeNodeIds: excludeIds.unresolved,
        unresolved_passNodeIds: passIds.unresolved,
      };
    }
    if (excludeIds.resolved.length + passIds.resolved.length > 0) {
      this.log('debug', `[AI] [NL] excludeNodeIds resolved=[${excludeIds.resolved.join(',')}] passNodeIds resolved=[${passIds.resolved.join(',')}]`);
    }

    this.excludedTypes = new Set((params.excludeTypes ?? []).map(t => t.toLowerCase()));
    this.excludedSchemas = new Set((params.excludeSchemas ?? []).map(s => s.toLowerCase()));
    this.excludedNodeIds = new Set(excludeIds.resolved.map(s => s.toLowerCase()));
    this.passNodeIds = new Set(passIds.resolved.map(s => s.toLowerCase()));

    const resolvedOriginId = resolveModelNodeId(params.origin, this.nodeMap);
    const originNode = resolvedOriginId ? this.nodeMap.get(resolvedOriginId) : null;
    if (!originNode) {
      return {
        error: 'origin_not_found',
        hint: 'Verify the origin node id with search_objects or get_context first. Use the exact id returned by those tools (case-insensitive match against the loaded graph).',
      };
    }

    this.originNodeId = originNode.id;
    this.depthBudget = typeof params.depth === 'number' ? params.depth : null;
    this.depthEnforcement = params.depth_enforcement ?? 'silent';
    this.budgetExpansions = [];
    this.scopeNodeIds = this.computeBfsScope(
      originNode.id,
      params.direction || 'bidirectional',
      params.depth || 5,
      params.upstream_depth,
      params.downstream_depth,
    );

    // Initialize column aspect if target columns are provided
    if (params.targetColumns && params.targetColumns.length > 0) {
      this._columnAspect = {
        target_columns: params.targetColumns,
        active_columns: params.targetColumns,
        edges: [],
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
    this.bodiedScopeSize = (breakdown.view ?? 0) + (breakdown.procedure ?? 0) + (breakdown.function ?? 0);
    this._totalNodes = this._bodiedScopeSize;
    const annotateProvenance = (items: Set<string>, gui: Set<string>, nl: string[]): string => {
      if (items.size === 0) return 'none';
      const nlSet = new Set(nl.map(t => t.toLowerCase()));
      return Array.from(items).map(t => {
        const g = gui.has(t);
        const n = nlSet.has(t);
        const tag = g && n ? 'gui+nl' : g ? 'gui' : 'nl';
        return `${t} (${tag})`;
      }).join(', ');
    };
    const excludedTypesAnnotated = annotateProvenance(this.excludedTypes, this.guiHiddenTypes, params.excludeTypes ?? []);
    const guiHiddenIgnored = Array.from(this.guiHiddenTypes).filter(t => !this.excludedTypes.has(t));
    const guiHiddenLine = guiHiddenIgnored.length > 0 ? ` gui_hidden_in_scope=[${guiHiddenIgnored.join(',')}]` : '';
    const excludeNodeIdsLine = excludeIds.resolved.length > 0 ? ` excludeNodeIds=[${trunc(excludeIds.resolved, 10)}]` : '';
    if (wasRefine) {
      this.log('info', `[AI] [Engine] [BFS-refine] cause=user_refine origin=${originNode.id} dir=${params.direction || 'bidirectional'} depth=${params.depth ?? 'default'}${excludeNodeIdsLine} → scope=Δ (was=${prevScopeSize} now=${this.scopeNodeIds.size}) (tables=${breakdown.table}, views=${breakdown.view}, procs=${breakdown.procedure}, functions=${breakdown.function}) excludeTypes=[${excludedTypesAnnotated}]${guiHiddenLine}`);
    } else {
      this.log('info', `[AI] [Engine] [BFS] origin=${originNode.id} dir=${params.direction || 'bidirectional'} depth=${params.depth ?? 'default'} → scope=${this.scopeNodeIds.size} (tables=${breakdown.table}, views=${breakdown.view}, procs=${breakdown.procedure}, functions=${breakdown.function}) excludeTypes=[${excludedTypesAnnotated}]${excludeNodeIdsLine}${guiHiddenLine}`);
    }

    // [AI] [Contract] — emit a stable hash of the resolved scope contract so downstream hop logs
    // can be cross-referenced against the originating filter snapshot. Replaces the spec's
    // `getScopeContract().hash` since we don't model that as a separate object.
    const contractParts = [
      originNode.id,
      params.direction || 'bidirectional',
      String(params.depth ?? 'default'),
      Array.from(this.scopeNodeIds).sort().join(','),
      Array.from(this.excludedTypes).sort().join(','),
      Array.from(this.excludedSchemas).sort().join(','),
      Array.from(this.excludedNodeIds).sort().join(','),
      Array.from(this.passNodeIds).sort().join(','),
    ].join('|');
    let h = 5381; // DJB2 hash — standard seed
    for (let i = 0; i < contractParts.length; i++) h = ((h << 5) + h + contractParts.charCodeAt(i)) | 0;
    const contractHash = Math.abs(h).toString(16).padStart(8, '0').slice(0, 8);
    const filtersDigest = `excludeTypes=${this.excludedTypes.size},excludeSchemas=${this.excludedSchemas.size},excludeNodeIds=${this.excludedNodeIds.size},passNodeIds=${this.passNodeIds.size}`;
    const nlInterp = (params.excludeNodeIds?.length ?? 0) + (params.passNodeIds?.length ?? 0) > 0 ? 'identifiers→nodeIds' : 'none';
    this.log('debug', `[AI] [Contract] hash=${contractHash} origin=${originNode.id} scope=${this.scopeNodeIds.size} filters=${filtersDigest} nl_interp=${nlInterp}`);

    this._direction = params.direction || 'bidirectional';
    // Snapshot kept so the refine path (gate cycle) can re-run init with new filters
    // without the AI having to re-send origin / direction / depth / mission_brief.
    this.initSnapshot = {
      question: params.question,
      origin: originNode.id,
      targetColumns: params.targetColumns,
      direction: this._direction,
      depth: params.depth,
      upstream_depth: params.upstream_depth,
      downstream_depth: params.downstream_depth,
      depth_enforcement: params.depth_enforcement,
      mission_brief: sanitizedMission?.text || undefined,
    };
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
   * Only callable when `status === 'complete'`. Re-enters `awaiting_findings`,
   * and appends ids via {@link enqueueHop} so the bipartite rule still holds:
   * bodied nodes land on the agenda, non-bodied contract through to their
   * bodied neighbors in the exploration direction. Prior `DetailSlot` entries
   * survive — new slots merge in.
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
      if (!this.scopeNodeIds.has(id)) {
        this.scopeNodeIds.add(id);
        const node = this.nodeMap.get(id);
        if (node && SCRIPT_TYPES.has(node.type)) this.bodiedScopeSize++;
      }
      // Reset visited guard so the supplemented id can be analyzed even if it was
      // passed-through during the parent exploration.
      if (this.visited.has(id)) this.visited.delete(id);
      const existingDepth = this.depthFromOrigin.get(id);
      const depth = typeof existingDepth === 'number' ? existingDepth : 0;
      // CT: pass target columns so supplemented nodes are analyzed with column context.
      const supplementColumns = this._columnAspect?.target_columns;
      this.enqueueHop(id, `Supplement: investigate ${id} on user follow-up`, depth, 3, supplementColumns);
    }

    const agendaed = this.agenda.length - agendaBefore;
    const contracted = nodeIds.length - agendaed - skipped;

    this._status = 'awaiting_findings';

    const modeLabel = this._columnAspect ? 'sm (ct)' : 'sm';
    this.log('info', `[Supplement] added ${nodeIds.length} requested ids → agendaed=${agendaed} contracted=${contracted} skipped=${skipped}; mode=${modeLabel}, status=awaiting_findings`);

    return { ok: true, agendaed, contracted, skipped };
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

      if (this.visited.has(candidate.nodeId)) continue;

      // User-requested auto-pass: keep node in scope, skip the AI hop, contract through to
      // bodied neighbours so descendants stay reachable. Topology preserved; no analysis.
      if (this.passNodeIds.has(candidate.nodeId.toLowerCase())) {
        this.visited.add(candidate.nodeId);
        this.markNodeState(candidate.nodeId, 'pass', 'user', 'user_pass_filter', {
          columns: candidate.activeColumns,
          atHop: this.hopCount,
        });
        this.memory.recordVerdict('pass');
        this.contractThroughPassNode(candidate);
        continue;
      }

      // CT column derivation + auto-prune: when a route_request omitted `columns`, the
      // agenda entry has no activeColumns. Recover from accumulated edges (prior hops'
      // column_flow declared this node as a contributor with a specific from_col). If
      // no edges reach this node either, the node has no tracked columns and is pruned
      // automatically — only in CT mode.
      if (this._columnAspect) {
        const entryColumns = candidate.activeColumns ?? [];
        const activeColumns =
          entryColumns.length > 0
            ? entryColumns
            : Array.from(
                new Set(
                  this._columnAspect.edges
                    .filter(e => e.from_node === candidate.nodeId)
                    .map(e => e.from_col)
                    .filter((c): c is string => !!c),
                ),
              );
        if (activeColumns.length === 0) {
          this.visited.add(candidate.nodeId);
          this.ctAutoPrunedNodeIds.add(candidate.nodeId);
          this.markNodeState(candidate.nodeId, 'prune', 'engine', 'ct_no_active_columns', {
            atHop: this.hopCount,
          });
          this.memory.recordVerdict('prune');
          this._totalNodes--;
          this.log('debug', `[CT] auto-prune ${candidate.nodeId} — no active columns (total −1 → ${this._totalNodes})`);
          continue;
        }
        candidate.activeColumns = activeColumns;
      }

      entry = candidate;
      break;
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
    const focusNode = buildHopFocusNode(
      node, this.nodeMap, new Map(), this.store ?? undefined, 'bb_ddl',
      this.model.neighborIndex, this.edgeTypeMap,
    );

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
      workingMemory.depth_budget = this.depthBudget;
      workingMemory.depth_enforcement = this.depthEnforcement;
      workingMemory.depth_cap = this.computeDepthCap();
      if (this.budgetExpansions.length > 0) {
        workingMemory.budget_expansions = this.budgetExpansions.slice();
      }
    }

    workingMemory.approved_border = {
      schemas: Array.from(this.sessionAllowedSchemas).sort(),
      depth_cap: this.computeDepthCap(),
    };
    workingMemory.deferred_count = this._deferredQuestions.length;
    if (this._columnAspect) {
      workingMemory.column_aspect = this._columnAspect;
    }

    this._lastCurrentTask = entry.question;
    this._status = 'awaiting_findings';
    return {
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
   * @remarks
   * CT mode is route-or-pass only. AI prune commands are rejected centrally with
   * `ct_prune_forbidden`, and column continuity is enforced by requiring
   * `column_flow` on every CT finding.
   *
   * @param params - Submission details including focus, verdict, and routing data.
   * @returns Information summarizing the operation's outcome.
   */
  public submitFindings(params: HopSubmission): SubmitResult {
    if (this._status !== 'awaiting_findings') {
      const hint = this._status === 'complete'
        ? 'The engine already completed this exploration. Produce the synthesis output (chat prose + present_result) now — do not call submit_findings again.'
        : this._status === 'error'
          ? 'The engine is in an error state. Call start_exploration to begin a fresh exploration.'
          : `Engine is in status '${this._status}'. Expected 'awaiting_findings'. Wait for a hop context, or restart via start_exploration if the session was wiped.`;
      return { error: 'invalid_status', current_status: this._status, hint };
    }

    this.lastRoutedNew = 0;
    this.lastRoutedRejected = 0;
    this.lastRoutedDeferred = 0;
    this.lastHopColumnFlowEntries = 0;
    let totalCascadedCount = 0;

    const allInvalidRoutes: Array<{ id: string; reason: string; available_columns?: string[] }> = [];
    const routeOutcomes: RouteOutcome[] = [];
    const finding = params;
    const focusId = resolveModelNodeId(finding.focus_node_id, this.nodeMap) ?? finding.focus_node_id?.toLowerCase();
    if (focusId !== this.currentFocusNodeId) {
      return { error: 'focus_mismatch', expected: this.currentFocusNodeId ?? undefined, got: focusId };
    }
    if (!focusId || !this.nodeMap.has(focusId)) {
      return { error: 'invalid_focus_node', got: focusId };
    }
    // CT: prune_neighbors always rejected — topology safety.
    if (this._columnAspect && (finding.prune_neighbors?.length ?? 0) > 0) {
      return {
        error: 'ct_prune_forbidden',
        detail: 'CT mode does not accept `prune_neighbors`. Submit `column_flow` (or `column_flow: []` for no interaction) and let the engine handle pruning.',
      };
    }
    // CT: verdict=prune → silent auto-prune (engine owns pruning; no retry loop).
    if (this._columnAspect && finding.verdict === 'prune') {
      this.visited.add(focusId);
      this.ctAutoPrunedNodeIds.add(focusId);
      this.markNodeState(focusId, 'prune', 'engine', 'ct_no_column_flow', {
        columns: this._columnAspect.active_columns,
        atHop: this.hopCount,
      });
      this.memory.recordVerdict('prune');
      this._totalNodes--;
      this.log('debug', `[CT] auto-prune ${focusId} — AI submitted verdict=prune (converted silently)`);
      return { ok: true };
    }

    const acceptedNids = new Set<string>();
    const scopeAddNids = new Set<string>();
    const deferredRoutes: Array<{
      nodeId: string;
      schema: string;
      question: string;
      reason: 'schema' | 'depth' | 'schema_and_depth';
      depth: number | undefined;
    }> = [];
    const prunedNeighborNids = new Set<string>();
    let stagedSections: Parameters<AiMemoryManager['storeDetail']>[1] = [];
    let stagedDetailChars = 0;
    let stagedSummaryChars = 0;
    const stagedColumnEdges: ColumnEdge[] = [];

    if (finding.route_requests) {
      const depthCap = this.computeDepthCap();

      for (const req of finding.route_requests) {
        const nid = resolveModelNodeId(req.nodeId, this.nodeMap);
        const nNode = nid ? this.nodeMap.get(nid) : null;
        if (!nNode || !nid) {
          allInvalidRoutes.push({ id: req.nodeId, reason: 'Node absent from graph model — not a casing issue, retrying with variant casing will fail. Omit from route_requests.' });
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

        const depthBlocked = depthCap !== null && candidateDepth !== undefined && candidateDepth > depthCap;
        const strictScopeBlocked = this.depthEnforcement === 'strict' && !this.scopeNodeIds.has(nid);

        if (schemaBlocked || depthBlocked || strictScopeBlocked) {
          const scopeReason = depthBlocked || strictScopeBlocked;
          const deferReason: 'schema' | 'depth' | 'schema_and_depth' =
            schemaBlocked && scopeReason ? 'schema_and_depth' : schemaBlocked ? 'schema' : 'depth';
          deferredRoutes.push({
            nodeId: nNode.id,
            schema: nNode.schema,
            question: req.question ?? '',
            reason: deferReason,
            depth: candidateDepth,
          });
          routeOutcomes.push({ nodeId: nNode.id, accepted: false, deferred: true, reason: deferReason });
          continue;
        }

        acceptedNids.add(nid);
        routeOutcomes.push({ nodeId: nNode.id, accepted: true });
        if (!this.scopeNodeIds.has(nid)) scopeAddNids.add(nid);

        if (req.columns && this._columnAspect) {
          const validCols = new Set(getNodeColumns(nNode.id, this.nodeMap, this.store ?? undefined)?.map(c => c.name.toLowerCase()));
          const invalidCols = req.columns.filter((c: string) => !validCols.has(c.toLowerCase()));
          if (invalidCols.length > 0) {
            const available = Array.from(validCols).sort();
            allInvalidRoutes.push({
              id: req.nodeId,
              reason: `Columns not found: ${invalidCols.join(', ')}`,
              available_columns: available.length > 0 ? available : undefined,
            });
          }
        }
      }
    }

    // CT: column_flow field must be present — AI must make an explicit decision.
    // Empty array column_flow: [] = "no column interaction" → engine auto-prunes.
    if (this._columnAspect) {
      if (finding.column_flow === undefined || finding.column_flow === null) {
        const cols = this._columnAspect.active_columns;
        const exCol = cols[0] ?? '<col>';
        return {
          error: 'column_flow_required',
          hint:
            `CT active — column_flow field is missing for [${cols.join(', ')}].\n` +
            `Your sections/summary/verdict were received and are correct — ADD column_flow alongside them.\n` +
            `If columns interact: column_flow:[{out_col:"${exCol}",contributors:[{from_node:"<node>",from_col:"<col>",role:"formula|rename|source|..."}]}]\n` +
            `If no columns interact at this node: column_flow:[]  (engine auto-prunes — do not invent contributors)`,
        };
      }
      // Empty column_flow: [] = explicit "no interaction" signal → auto-prune, no error.
      // Route_requests computed above are intentionally discarded (non-contributing node should not route forward).
      if (finding.column_flow.length === 0) {
        this.visited.add(focusId);
        this.ctAutoPrunedNodeIds.add(focusId);
        this.markNodeState(focusId, 'prune', 'engine', 'ct_no_column_flow', {
          columns: this._columnAspect.active_columns,
          atHop: this.hopCount,
        });
        this.memory.recordVerdict('prune');
        this._totalNodes--;
        this.log('debug', `[CT] auto-prune ${focusId} — AI submitted column_flow: [] (no column interaction)`);
        return { ok: true };
      }
    }

    // Column Aspect Validation: column_flow structured JSON
    if (this._columnAspect && finding.column_flow) {
      const focusNode = this.nodeMap.get(focusId)!;
      const validFocusCols = new Set(getNodeColumns(focusNode.id, this.nodeMap, this.store ?? undefined)?.map(c => c.name.toLowerCase()));

      const activeLower = this._columnAspect.active_columns.map(c => c.toLowerCase());

      for (const entry of finding.column_flow) {
        // out_col must be one of the active CT columns
        if (!activeLower.includes(entry.out_col.toLowerCase())) {
          allInvalidRoutes.push({ id: focusId, reason: `column_flow_invalid: out_col "${entry.out_col}" is not in active_columns [${this._columnAspect.active_columns.join(', ')}]. Only declare column_flow for the tracked columns.` });
          continue;
        }

        // out_col must exist on the focus node when column metadata is available.
        // Procedures have no output-column metadata; size=0 skips the check.
        if (validFocusCols.size > 0 && !validFocusCols.has(entry.out_col.toLowerCase())) {
          allInvalidRoutes.push({ id: focusId, reason: `column_flow_validation_failed: column "${entry.out_col}" does not exist on focus node. Hint: If this node does not interact with the traced columns, submit verdict='pass' and do not route downstream from it.` });
          continue;
        }

        for (const cont of entry.contributors) {
          const neighborId = resolveModelNodeId(cont.from_node, this.nodeMap);
          const neighbor = neighborId ? this.nodeMap.get(neighborId) : null;
          if (!neighbor) {
            allInvalidRoutes.push({ id: cont.from_node, reason: `column_flow_validation_failed: contributor node "${cont.from_node}" not found in graph.` });
            continue;
          }
          if (neighbor.type === 'procedure') {
            // Procedures have no output-column metadata. Validate from_col against the procedure's
            // inbound source node columns instead (one-to-one: the column entering the SP must exist
            // on at least one of its data sources — the table or view that feeds it).
            const spInbound = this.model.neighborIndex[neighbor.id.toLowerCase()]?.in ?? [];
            const inboundCols = new Set<string>();
            for (const inId of spInbound) {
              getNodeColumns(inId, this.nodeMap, this.store ?? undefined)?.forEach(c => inboundCols.add(c.name.toLowerCase()));
            }
            if (inboundCols.size > 0 && !inboundCols.has(cont.from_col.toLowerCase())) {
              allInvalidRoutes.push({ id: cont.from_node, reason: `column_flow_validation_failed: contributor column "${cont.from_col}" does not exist in any inbound source of procedure "${cont.from_node}".` });
            }
          } else {
            // Tables, views, functions: validate from_col directly against their own column schemas.
            const validNeighborCols = new Set(getNodeColumns(neighbor.id, this.nodeMap, this.store ?? undefined)?.map(c => c.name.toLowerCase()));
            if (validNeighborCols.size > 0 && !validNeighborCols.has(cont.from_col.toLowerCase())) {
              allInvalidRoutes.push({ id: cont.from_node, reason: `column_flow_validation_failed: contributor column "${cont.from_col}" does not exist on node "${cont.from_node}".` });
            }
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

    // BB-only: explicitly prune adjacent neighbors requested by the AI.
    // Guardrail: never prune already-analyzed/visited nodes; synthesis must keep
    // slot node_ids grounded in the final result graph.
    if (finding.prune_neighbors && finding.prune_neighbors.length > 0) {
      const notedIds = new Set<string>(this.memory.notedNodeIds);
      const requiredConnectedIds = new Set<string>(notedIds);
      if (!prunable) requiredConnectedIds.add(focusId);
      const stagedRemoved = new Set<string>(this.removedSet);
      if (prunable) stagedRemoved.add(focusId);
      for (const nidRaw of finding.prune_neighbors) {
        const nid = nidRaw.toLowerCase();
        if (!this.nodeMap.has(nid)) {
          this.log('debug', `[AI] [Reject] prune_neighbor hop=${this.hopCount} id=${nidRaw} reason=unknown_node`);
          continue;
        }
        if (nid === this.originNodeId) {
          this.log('debug', `[AI] [Reject] prune_neighbor hop=${this.hopCount} id=${nid} reason=origin_forbidden`);
          continue;
        }
        if (this.visited.has(nid)) {
          this.log('debug', `[AI] [Reject] prune_neighbor hop=${this.hopCount} id=${nid} reason=already_visited`);
          continue;
        }
        if (notedIds.has(nid)) {
          this.log('debug', `[AI] [Reject] prune_neighbor hop=${this.hopCount} id=${nid} reason=already_analyzed`);
          continue;
        }
        const candidateRemoved = new Set<string>(stagedRemoved);
        candidateRemoved.add(nid);
        const disconnected = firstDisconnectedRequiredNode(
          this.graph,
          this.originNodeId!,
          candidateRemoved,
          requiredConnectedIds,
          this.scopeNodeIds,
        );
        if (disconnected) {
          this.log('debug', `[AI] [Reject] prune_neighbor hop=${this.hopCount} id=${nid} reason=would_orphan_noted disconnected=${disconnected}`);
          continue;
        }
        if (!prunedNeighborNids.has(nid)) {
          prunedNeighborNids.add(nid);
          stagedRemoved.add(nid);
        }
      }
    }

    if (!isPrune) {
      stagedSections = (finding.sections ?? []).map(s => ({
        ...s,
        text: s.text.replace(/\\n/g, '\n'),
      }));
      stagedDetailChars = stagedSections.reduce((sum, s) => sum + (s.text?.length ?? 0), 0);
      stagedSummaryChars = finding.summary?.length ?? 0;

      // Stage validated column lineage edges (filter_only excluded — not data flow)
      if (this._columnAspect && finding.column_flow) {
        this.lastHopColumnFlowEntries = finding.column_flow.length;
        for (const entry of finding.column_flow) {
          const toNode = entry.writes_to?.node ? (resolveModelNodeId(entry.writes_to.node, this.nodeMap) ?? entry.writes_to.node.toLowerCase()) : focusId;
          const toCol  = entry.writes_to?.col  ?? entry.out_col;
          const toNodeObj = this.nodeMap.get(toNode);
          if (toNodeObj && !SCRIPT_TYPES.has(toNodeObj.type)) {
            this.markNodeState(toNode, 'pass', 'engine', 'non_bodied_passthrough', {
              columns: [toCol],
              viaNodeId: focusId,
              atHop: this.hopCount,
            });
          }
          for (const cont of entry.contributors) {
            if (cont.role === 'filter_only') continue;
            const fromNode = resolveModelNodeId(cont.from_node, this.nodeMap) ?? cont.from_node.toLowerCase();
            const fromNodeObj = this.nodeMap.get(fromNode);
            if (fromNodeObj && !SCRIPT_TYPES.has(fromNodeObj.type)) {
              this.markNodeState(fromNode, 'pass', 'engine', 'non_bodied_passthrough', {
                columns: [cont.from_col],
                viaNodeId: focusId,
                atHop: this.hopCount,
              });
            }
            stagedColumnEdges.push({
              hop_node:  focusId,
              hop:       this.hopCount,
              from_node: fromNode,
              from_col:  cont.from_col,
              to_node:   toNode,
              to_col:    toCol,
              role:      cont.role,
            });
          }
        }
      }
    }

    if (allInvalidRoutes.length > 0) {
      this.lastRoutedRejected = allInvalidRoutes.length;
      for (const r of allInvalidRoutes) this.memory.recordRejection(r.id, r.reason, this.hopCount);
      // Partition reasons so the AI gets a corrective signal naming the
      // right next-action tool, mirroring the `unknown_node_ids` envelope on
      // start_exploration. Unknown-id rejections are the most common and
      // most actionable failure mode — without a structured hint here the AI
      // typically loops on the same focus and the exploration stalls
      // (observed in bb-q1-employee bridge JSONL 2026-04-27).
      const unknownIds = allInvalidRoutes
        .filter(r => /not found/i.test(r.reason))
        .map(r => r.id);
      const otherReasons = allInvalidRoutes.filter(r => !/not found/i.test(r.reason));
      const hint = unknownIds.length > 0
        ? `${unknownIds.map(id => `\`${id}\``).join(', ')} ${unknownIds.length === 1 ? 'is' : 'are'} absent from the loaded graph model (not a casing error — retrying with variant casing will fail). Omit ${unknownIds.length === 1 ? 'it' : 'them'} from route_requests and note ${unknownIds.length === 1 ? 'it' : 'them'} as unresolved upstream references in sections[].text.`
        : 'One or more route_requests / column references failed validation. Inspect `detail` for the per-id reason and re-submit with corrections.';
      return {
        error: 'route_validation_failed',
        hint,
        unresolved_route_target_ids: unknownIds,
        detail: otherReasons.length > 0 ? otherReasons : allInvalidRoutes,
      };
    }

    // Commit route deferrals + scope growth only after full validation passes.
    for (const deferred of deferredRoutes) {
      this.deferQuestion({
        nodeId: deferred.nodeId,
        schema: deferred.schema,
        fromFocusNodeId: focusId,
        question: deferred.question,
        reason: deferred.reason,
        depth: deferred.depth,
        atHop: this.hopCount,
      });
      this.lastRoutedDeferred++;
    }
    for (const nid of scopeAddNids) {
      this.scopeNodeIds.add(nid);
      const focusDepth = this.depthFromOrigin.get(focusId) ?? 0;
      if (!this.depthFromOrigin.has(nid)) this.depthFromOrigin.set(nid, focusDepth + 1);
      if (this.depthBudget !== null && this.depthEnforcement !== 'strict') {
        this.budgetExpansions.push({ nodeId: nid, depth: focusDepth + 1, atHop: this.hopCount });
      }
    }

    for (const nid of prunedNeighborNids) {
      this.removedSet.add(nid);
      this.markNodeState(nid, 'prune', 'ai', 'bb_prune_neighbor', {
        viaNodeId: focusId,
        atHop: this.hopCount,
      });
      if (SCRIPT_TYPES.has(this.nodeMap.get(nid)!.type) && this.scopeNodeIds.has(nid)) {
        this._totalNodes--;
        this.log('debug', `[AI] [CT] prune_neighbor ${nid} — bodied scope node (total −1 → ${this._totalNodes})`);
      }
      this.log('debug', `[AI] [CT] prune_neighbor hop=${this.hopCount}: ${nid}`);
    }
    if (!isPrune) {
      this.memory.storeDetail(this.nodeMap.get(focusId)!, stagedSections, finding.summary, {
        badge_label: finding.badge_label,
        note_caption: finding.note_caption,
        reason_for_visit: this.currentFocusQuestion || 'Historical path investigation',
      });
      this.lastHopDetailChars = stagedDetailChars;
      this.lastHopSummaryChars = stagedSummaryChars;
      this.archiveChars += this.lastHopDetailChars + this.lastHopSummaryChars;

      if (this._columnAspect && stagedColumnEdges.length > 0) {
        this._columnAspect.edges.push(...stagedColumnEdges);
        this.log('debug', `[CT] column_flow hop=${this.hopCount} focus=${focusId} entries=${this.lastHopColumnFlowEntries} total_edges=${this._columnAspect.edges.length} active_cols=${this._columnAspect.active_columns.join(',')}`);
      }
    }

    this.memory.recordVerdict(finding.verdict);
    this.lastHopVerdict = finding.verdict;
    this.markNodeState(
      focusId,
      finding.verdict,
      'ai',
      finding.verdict === 'analyze'
        ? 'submitted_analyze'
        : finding.verdict === 'pass'
          ? 'submitted_pass'
          : 'submitted_prune',
      {
        columns: this._columnAspect?.active_columns,
        atHop: this.hopCount,
      },
    );

    if (prunable || prunedNeighborNids.size > 0) {
      if (prunable) this.removedSet.add(focusId);
      const reachable = bfsReachable(this.graph, this.originNodeId!, this.removedSet, undefined, this.scopeNodeIds);
      const before = this.agenda.length;
      this.agenda = this.agenda.filter(e => reachable.has(e.nodeId));
      this.agendaIds = new Set(this.agenda.map(e => e.nodeId));
      totalCascadedCount += (before - this.agenda.length);
    }

    if (finding.route_requests) {
      for (const req of finding.route_requests) {
        const nid = resolveModelNodeId(req.nodeId, this.nodeMap) ?? req.nodeId.toLowerCase();
        if (!acceptedNids.has(nid)) continue;

        // Route enqueue funnels through the bipartite rule. For bodied targets
        // the funnel merges into existing entries (task aggregation) or pushes
        // a new entry. For non-bodied targets (tables, externals) it contracts
        // the edge and forwards the proc's authored question to the target's
        // bodied neighbors in the exploration direction.
        const agendaSizeBefore = this.agenda.length;
        const targetNode = this.nodeMap.get(nid);
        const targetIsBodied = !!targetNode && SCRIPT_TYPES.has(targetNode.type);
        const wasAlreadyVisited = this.visited.has(nid);
        this.enqueueHop(nid, req.question, 0, 2, req.columns);
        const added = this.agenda.length - agendaSizeBefore;
        this.lastRoutedNew += Math.max(0, added);

        // Transparency: if the route passed acceptance checks but contraction
        // dropped the forward (non-bodied target with no bodied neighbour in
        // scope), downgrade the previously-pushed `accepted: true` to a
        // deferred outcome so the AI can distinguish "accepted and routed"
        // from "accepted but no new hop enqueued".
        if (added === 0 && !targetIsBodied && !wasAlreadyVisited) {
          for (let i = routeOutcomes.length - 1; i >= 0; i--) {
            if (routeOutcomes[i].nodeId === nid && routeOutcomes[i].accepted) {
              routeOutcomes[i] = { nodeId: nid, accepted: false, deferred: true, reason: 'depth_contracted_beyond_budget' };
              break;
            }
          }
        }
      }
    }

    this._status = 'exploring';
    const outcomes = routeOutcomes.length > 0 ? { route_outcomes: routeOutcomes } : {};

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
   * @param maxDepth - The bounding maximum depth (used as the symmetric default).
   * @param upstreamDepth - Optional override for upstream direction (only honored when `direction='bidirectional'`).
   * @param downstreamDepth - Optional override for downstream direction (only honored when `direction='bidirectional'`).
   * @returns A set of valid node identifiers reachable within the depth parameters.
   */
  private computeBfsScope(
    startId: string,
    direction: string,
    maxDepth: number,
    upstreamDepth?: number,
    downstreamDepth?: number,
  ): Set<string> {
    const seen = new Set<string>();
    this.depthFromOrigin.clear();

    const hasAsymmetric = direction === 'bidirectional' && (upstreamDepth !== undefined || downstreamDepth !== undefined);
    if (hasAsymmetric) {
      const upCap = upstreamDepth ?? maxDepth;
      const downCap = downstreamDepth ?? maxDepth;
      if (upCap > 0) {
        bfsFromNode(this.graph, startId, (key, _attr, depth) => {
          seen.add(key);
          if (!this.depthFromOrigin.has(key)) this.depthFromOrigin.set(key, depth);
          return depth >= upCap;
        }, { mode: 'inbound' });
      }
      if (downCap > 0) {
        bfsFromNode(this.graph, startId, (key, _attr, depth) => {
          seen.add(key);
          if (!this.depthFromOrigin.has(key)) this.depthFromOrigin.set(key, depth);
          return depth >= downCap;
        }, { mode: 'outbound' });
      }
      // Origin is always anchored even when both depth caps are 0.
      seen.add(startId);
      if (!this.depthFromOrigin.has(startId)) this.depthFromOrigin.set(startId, 0);
    } else {
      const mode = direction === 'upstream' ? 'inbound' : direction === 'downstream' ? 'outbound' : 'directed';
      bfsFromNode(this.graph, startId, (key, _attr, depth) => {
        seen.add(key);
        if (!this.depthFromOrigin.has(key)) this.depthFromOrigin.set(key, depth);
        return depth >= maxDepth;
      }, { mode });
    }

    // Three orthogonal exclusion axes — origin is never dropped (it anchors the trace).
    const hasFilters = this.excludedTypes.size > 0 || this.excludedSchemas.size > 0 || this.excludedNodeIds.size > 0;
    if (hasFilters) {
      for (const id of Array.from(seen)) {
        if (id === startId) continue;
        const node = this.nodeMap.get(id);
        if (!node) continue;
        const t = node.type?.toLowerCase();
        if (t && this.excludedTypes.has(t)) { seen.delete(id); continue; }
        if (this.excludedSchemas.has(node.schema.toLowerCase())) { seen.delete(id); continue; }
        if (this.excludedNodeIds.has(id.toLowerCase())) { seen.delete(id); continue; }
      }
    }

    return seen;
  }

  /** Returns directional graph neighbors based on the active exploration direction. */
  private directionalNeighbors(nodeId: string, direction: 'upstream' | 'downstream' | 'bidirectional'): string[] {
    if (direction === 'upstream') return this.graph.inNeighbors(nodeId) as string[];
    if (direction === 'downstream') return this.graph.outNeighbors(nodeId) as string[];
    return this.graph.neighbors(nodeId) as string[];
  }

  /**
   * Seeds the initial agenda based on the requested traversal parameters.
   *
   * @param originId - Identifies the starting node to build the agenda from.
   * @param direction - Edge traversal direction.
   * @param targetCols - Array of target column names for detailed tracking.
   */
  private seedAgenda(originId: string, direction: 'upstream' | 'downstream' | 'bidirectional', targetCols?: string[]): void {
    for (const nid of this.directionalNeighbors(originId, direction)) {
      this.enqueueHop(nid, `Analyze relationship to ${originId}`, 1, 0, targetCols);
    }
  }

  /**
   * Forwards a pass-tagged node's intent to its in-direction bodied neighbours.
   *
   * @remarks
   * Mirrors `enqueueHop`'s non-bodied contraction branch: when a node is in
   * {@link passNodeIds} the AI is not asked to analyse it, but we still want its
   * descendants reachable. Walk in-direction neighbours and re-enqueue each via
   * `enqueueHop` (which respects scope, visited, and the bipartite rule).
   */
  private contractThroughPassNode(entry: AgendaEntry): void {
    for (const nid of this.directionalNeighbors(entry.nodeId, this._direction)) {
      this.enqueueHop(nid, entry.question, entry.depth + 1, entry.priority, entry.activeColumns);
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
      if (!this.scopeNodeIds.has(targetId)) {
        this._totalNodes++;
        this.log('debug', `[AI] [Agenda] enqueue ${targetId} — out-of-scope expansion (total +1 → ${this._totalNodes})`);
      }
      return;
    }

    // Origin push for a non-bodied starting point: lift the bipartite
    // contraction so the user's chosen origin gets its own agenda slot.
    // Middle tables (priority 2 routed calls) stay contracted — the AI's
    // routing intent still passes through them to their bodied neighbours
    // via the block below.
    if (priority === 3) {
      this.agenda.push({ nodeId: targetId, question, priority, depth, activeColumns: columns });
      this.agendaIds.add(targetId);
      return;
    }

    // Non-bodied (table, external). Contract the edge: forward the authored
    // question to the target's bodied neighbors in the exploration direction.
    if (visitedRefs.has(targetId)) return;
    visitedRefs.add(targetId);
    this.markNodeState(targetId, 'pass', 'engine', 'non_bodied_passthrough', {
      columns,
      viaNodeId: this.currentFocusNodeId ?? this.originNodeId ?? undefined,
      atHop: this.hopCount,
    });
    for (const nid of this.directionalNeighbors(targetId, this._direction)) {
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
    const inSet = new Set(this.graph.inNeighbors(focusId) as string[]);
    const outSet = new Set(this.graph.outNeighbors(focusId) as string[]);
    const ids = Array.from(new Set([...inSet, ...outSet]));
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
        edge_direction: inSet.has(nid) ? 'upstream' : 'downstream',
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

    // CT mode: restrict BFS scope to only nodes that appear in a column_flow edge.
    // Non-CT scope nodes are excluded by limiting traversal, not by mutating removedSet.
    let scopeForBfs = this.scopeNodeIds;
    if (this._columnAspect) {
      const ctNodes = new Set<string>([this.originNodeId!]);
      for (const e of this._columnAspect.edges) {
        ctNodes.add(e.hop_node);
        ctNodes.add(e.from_node);
        ctNodes.add(e.to_node);
      }
      scopeForBfs = ctNodes;
    }
    const reachableNodeIds = bfsReachable(this.graph, this.originNodeId!, this.removedSet, undefined, scopeForBfs);
    const finalNodeIds = new Set<string>(reachableNodeIds);
    finalNodeIds.add(this.originNodeId!);

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
        return { id: n.id, s: n.schema, n: n.name, t: n.type, role: this.roleFromNodeState(id) };
      }),
      edges: finalEdges,
      suggested_sections: sections,
      detail_slots: mem.detail_slots.filter(slot => finalNodeIds.has(slot.nodeId)),
      node_states: Array.from(this.nodeStates.values()),
      columnAspect: this._columnAspect,
      ...(this._columnAspect ? { ctPrunedNodeIds: Array.from(this.ctAutoPrunedNodeIds) } : {}),
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
      visited: Array.from(this.visited),
      removedSet: Array.from(this.removedSet),
      nodeStates: Array.from(this.nodeStates.values()),
      agendaSize: this.agenda.length,
      agenda: this.agenda.map(a => ({
        nodeId: a.nodeId,
        priority: a.priority,
        question: a.question,
      })),
      currentFocusNodeId: this.currentFocusNodeId,
      memory: this.memory.toJSON(),
      ...(this._columnAspect ? {
        lineageQuestionsLastHop: this.getColumnLineageQuestions(),
        ctPrunedNodeIds: Array.from(this.ctAutoPrunedNodeIds),
      } : {}),
    };
  }
}
