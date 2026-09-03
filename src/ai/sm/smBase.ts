import { DEFAULT_SM_START_DEPTH, EngineAspectMode, InvalidRoute, type DepthIntent } from './smTypes';
import { buildRouteValidationRejection, isAbsentKind, ROUTE_REJECTION_DIRECTIVE } from './smRouteValidation';
import { buildIncompleteRejection } from './smCompleteness';
import { checkActiveScopeAdmission } from '../support/tokenBudget';
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
import { ASYMMETRIC_DEPTH_REQUIRES_BIDIRECTIONAL } from '../../engine/shared/explorationDepthContract';
import type { SerializedFilterState } from '../../engine/projectStore';
import { buildNodeMap, buildEdgeTypeMap, getNodeColumns, getNodeDdl, buildHopFocusNode, SCRIPT_TYPES } from '../tools/tools';
import { buildPassthroughReAnchor } from '../prompting/smPrompts';
import { edgeApiType } from '../support/aiPresenter';
import { bfsDepthMap, firstDisconnectedRequiredNode, bfsReachable, type LogFn } from '../../engine/graphGuards';
import { trunc, LOG_TRUNC_CONTENT } from '../../utils/log';
import { normalizeColName } from '../../utils/sql';
import { AiMemoryManager, type DetailSlot, type WorkingMemory } from '../session/memoryManager';
import type { ClassificationValue } from '../session/classification';
import { RepairDraftStore } from '../support/repairDraftStore';
import { resolveModelNodeId } from '../support/inputNormalization';
import { evaluateCurrentHopActionPolicy } from './currentHopActionPolicy';
import type { ApprovedBorder, ColumnAspect, ColumnEdge, DeferredQuestion, DiagnosticsSnapshot, EngineInitSnapshot, EngineInternalsSnapshot, HopContext, HopNeighbor, HopProgress, HopSubmission, InvestigationTask, NavigationInitParams, PendingLead, RouteOutcome, ScopeSummary, ScopeSummaryLeaf, SmNodeAction, SmNodeState, SmNodeStateReason, SmNodeStateSource, SmResult, SmState, SmStatus, SubmitResult, SupplementSkip } from '../sm/smTypes';
import { estimateTokens } from '../support/tokenBudget';
import { ColumnTracer } from "./columnTracer";
import { AgendaManager, type AgendaEntry } from './agendaManager';
import { TaskLedger } from './taskLedger';
import { INavigationStrategy, BbStrategy, CtStrategy } from './strategies';
import { parseNavigationSnapshot, InvalidEngineCheckpointError } from './navigationSnapshotSchema';

/**
 * Extends the base working memory with topological map data.
 *
 * @remarks
 * This interface provides the AI with a snapshot of the current navigation state,
 * including where it has been, where it is now, and what remains on the agenda.
 * This "map" is essential for grounding the AI's routing decisions.
 */
interface NavigationWorkingMemory extends WorkingMemory {
  /** The current topological state of the exploration. */
  topological_map: {
    /** A human-readable path string showing the traversal (e.g., "Origin -> ... -> Focus"). */
    navigation_path: string;
    /** The node ID currently under investigation. */
    current_focus: string;
  };
  /** Active depth budget at session start (omitted when unbounded). */
  depth_budget?: number;
  /** Checkpoint projection of the live enforcement mode — `strict` for an explicit/asymmetric depth intent, `silent` otherwise. */
  depth_enforcement?: 'strict' | 'soft' | 'silent';
  /** Initial reviewed seed depth retained for diagnostics; never a route ceiling. */
  depth_cap?: number | null;
  /** Per-node explicit AI expansions beyond the initial seed. */
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
  /** Typed investigation tasks owned by the engine. */
  readonly investigationTasks: ReadonlyArray<InvestigationTask>;
  /** Valuable out-of-scope routes available for a later user-approved supplement. */
  readonly pendingLeads: ReadonlyArray<PendingLead>;
  /** Current focus node id (node the AI must analyse this hop) — null before the first hop. */
  readonly currentFocus: string | null;
  /** Live hop progress: completed AI hops, queued nodes, and total acknowledged nodes. */
  readonly hopProgress: HopProgress;

  /** Publishes validated isolated engine memory into the session's stable memory object. */
  publishMemoryTo(target: AiMemoryManager): void;

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

  /** Structured tasks assigned to the current focus node. */
  getCurrentTasks(): ReadonlyArray<InvestigationTask>;

  /** Current hop index (1-based; 0 before the first hop). */
  readonly currentHop: number;

  /** Snapshot of per-hop diagnostics (focus, depth, routing counts, tally). */
  getHopDiagnostics(): DiagnosticsSnapshot;

  /** Every captured detail slot in insertion order — diagnostics / telemetry use. */
  getDetailSlots(): DetailSlot[];

  /** Cumulative detail + summary char count across all hops. */
  getArchiveChars(): number;

  /**
   * Extends a completed exploration with additional nodes for analysis.
   *
   * @remarks
   * Only callable when `status === 'complete'` and at least one bodied id is supplied. The engine
   * re-enters `awaiting_findings` and new `DetailSlot` entries merge into the
   * existing `AiMemoryManager` without resetting prior analysis.
   *
   * @param nodeIds - Node ids to append to the agenda. Non-bodied (table, external)
   *   ids follow the existing bipartite contraction rule (`enqueueHop`) — they
   *   forward the authored question to bodied neighbors rather than landing on
   *   the agenda themselves. Ids outside the graph are dropped.
   * @param leadIds - Host-selected pending lead identifiers to schedule.
   * @returns Counts of ids that were agendaed, contracted, or skipped (unknown / duplicate),
   *   plus `skippedDetails` naming which id was dropped and why.
   */
  supplementAgenda(nodeIds: string[], leadIds?: string[]): { ok: true; agendaed: number; contracted: number; skipped: number; skippedDetails: SupplementSkip[] } | { error: string; hint?: string };
}

/**
 * The write path a border test serves. Each purpose fixes which of the three axes
 * (exclusion sets, approved-direction reachability, schema allowlist) participate — so
 * every call site consults an identical, self-documenting axis profile.
 *
 * @remarks
 * - `route` / `ct_contraction` — full border: exclusion sets + direction + allowlist.
 * - `supplement` — exclusion sets + allowlist (the follow-up pill click is the user consent
 *   that pre-extends the allowlist; direction is not re-tested for an already-surfaced lead).
 * - `seed_bfs` — exclusion sets ONLY; the allowlist is deliberately skipped so out-of-allowlist
 *   reachables survive the seed and become `schema:` gate classes the user can approve.
 * - `display` — allowlist + type exclusions only (neighbor-list annotation, not a hard gate).
 */
type BorderPurpose = 'route' | 'ct_contraction' | 'supplement' | 'seed_bfs' | 'display';

/**
 * First failing border axis for a candidate node, or `in_border` when it clears every
 * participating axis. A discriminated verdict (not a boolean bag) so a caller can route each
 * outcome distinctly — e.g. the route path rejects `excluded`/`out_of_direction` but *defers*
 * `out_of_allowlist`.
 */
type BorderVerdict =
  | { kind: 'in_border' }
  | { kind: 'excluded' }
  | { kind: 'out_of_direction' }
  | { kind: 'out_of_allowlist' };

/** Prose spelling of a deferral reason, for the user-facing lead text. */
const DEFERRAL_BOUNDARY_LABEL: Readonly<Record<DeferredQuestion['reason'], string>> = {
  schema: 'schema',
  depth: 'depth',
  schema_and_depth: 'schema and depth',
};

/** Copies an agenda entry so a snapshot and the live agenda never share an array. */
function cloneAgendaEntry(entry: AgendaEntry): AgendaEntry {
  return {
    taskIds: [...entry.taskIds],
    nodeId: entry.nodeId,
    priority: entry.priority,
    depth: entry.depth,
    ...(entry.activeColumns ? { activeColumns: entry.activeColumns } : {}),
    ...(entry.lineageQuestions ? { lineageQuestions: entry.lineageQuestions } : {}),
  };
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
  protected memory: AiMemoryManager;

  /** Optional session identifier for tracking logs across rounds. */
  public sessionId?: string;
  /**
   * Gate-locked mission-type classification (`business`|`technical`|`both`) — the AI's own verdict,
   * declared as a required field on the `start_exploration` proposal and Zod-validated before the
   * gate can approve.
   *
   * @remarks
   * Set by the caller immediately after construction, the same way as {@link sessionId} — not a
   * constructor param, and deliberately excluded from {@link toJSON}'s checkpoint; the caller
   * re-applies it from `AiSession.classification` (the single source of truth) on restore.
   */
  public classification?: ClassificationValue;
  /** The operational status of the state machine. */
  protected _status: SmStatus = 'created';
  /** Active exploration mode and, for CT, the live column aspect state exposed to prompt builders. */
  public mode: EngineAspectMode = { kind: 'bb' };
  protected tracer: ColumnTracer | null = null;
  /** ID of the initial or root node for navigation. */
  protected originNodeId: string | null = null;
  /** Set of node identifiers within the active scope. */
  protected scopeNodeIds = new Set<string>();
  /** Set of node identifiers that have already been explored. */
  protected visited = new Set<string>();
  /** Set of node identifiers excluded during exploration cascades. */
  protected removedSet = new Set<string>();
  /** Focus nodes the AI pruned via `verdict=prune` in CT mode. Surfaced as `ctPrunedNodeIds`. */
  protected ctPrunedFocusIds = new Set<string>();
  /** Engine-owned lifecycle state for nodes; detail slots are content storage only. */
  protected nodeStates = new Map<string, SmNodeState>();
  /** List representing the current navigation agenda. */
  protected _agenda = new AgendaManager();
  /** Structured source of truth for questions and follow-up leads. */
  private readonly taskLedger = new TaskLedger();
  protected get strategy(): INavigationStrategy {
    return this.mode.kind === 'ct' ? new CtStrategy() : new BbStrategy();
  }
  /** Identifier of the node currently in focus. */
  protected currentFocusNodeId: string | null = null;
  /** Active task-ledger question captured at dequeue so it can label the detail slot. */
  protected currentFocusQuestion: string | null = null;
  /** Stable tasks currently being answered by the focus node's single hop. */
  protected currentFocusTaskIds: string[] = [];
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
  /**
   * Both sides unbounded — the default depth ceiling. Never mutated in place (only ever
   * reassigned wholesale), so instances may safely share this one frozen object.
   */
  private static readonly UNBOUNDED_DEPTH_LIMITS: { upstream: number; downstream: number } = Object.freeze({
    upstream: Number.POSITIVE_INFINITY,
    downstream: Number.POSITIVE_INFINITY,
  });
  /**
   * Per-side depth ceilings from the approved intent; `Infinity` where that side is unbounded.
   *
   * @remarks
   * Kept alongside {@link depthBudget} because a single scalar cannot express an asymmetric ask:
   * collapsing `{upstream: 2, downstream: 1}` to its maximum enforces 2 on both sides, admitting
   * a node the user capped out. Only consulted when {@link depthEnforcement} is `'strict'`.
   */
  protected depthLimits: { upstream: number; downstream: number } = NavigationEngine.UNBOUNDED_DEPTH_LIMITS;
  /**
   * Whether the approved depth is a hard border (`'strict'`) or an initial seed the model may grow
   * (`'silent'`). Set from the AI's own `depthIntent`: a level count the AI copied from the user's
   * question binds; an omitted depth does not.
   */
  protected depthEnforcement: 'strict' | 'soft' | 'silent' = 'silent';
  /**
   * Directed distance from the origin to every reachable node, per side; cleared whenever the BFS
   * seed is recomputed and refilled on the next depth read ({@link ensureDirectedDepths}).
   *
   * @remarks
   * Both sides are kept because a border can be asymmetric: a node reachable upstream and
   * downstream is judged against each side's own ceiling, and collapsing it to one number would
   * pick the ceiling the user did not set for that path. A side is absent when no directed path
   * reaches the node on it.
   */
  private directedDepths = new Map<string, { upstream?: number; downstream?: number }>();
  /** Whether {@link directedDepths} holds the current seed's walk; false until the next fill. */
  private directedDepthsFilled = false;
  /** History of explicit AI expansions beyond the initial BFS seed. */
  protected budgetExpansions: Array<{ nodeId: string; depth: number; atHop: number }> = [];

  /**
   * Submission held only after route/column incompleteness so a retry with empty sections can reuse
   * already-valid authored prose. Other validation failures never establish held state.
   */
  private readonly heldFindingDraft = new RepairDraftStore<HopSubmission, HopSubmission>();

  /** Exploration direction set by `init`; consulted by `enqueueHop` when contracting reference nodes. */
  protected _direction: 'upstream' | 'downstream' | 'bidirectional' = 'bidirectional';

  /** Schemas (lower-cased) in the user's active filter — the initial allowlist for route validation. */
  protected userSchemas: Set<string> = new Set();
  /** Session-scoped schema allowlist. Starts as a copy of {@link userSchemas}; grows via {@link extendAllowedSchemas}. */
  protected sessionAllowedSchemas: Set<string> = new Set();
  /**
   * Node ids (lower-cased) the user named in a follow-up, admitted one by one.
   *
   * @remarks
   * The narrow half of the allowlist axis: naming an object admits that object, never its schema
   * siblings. Grows only through {@link admitSupplementTargets}; read by {@link checkBorder}
   * alongside {@link sessionAllowedSchemas}.
   */
  protected sessionAllowedNodeIds: Set<string> = new Set();
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
   * The hop dispatcher detects these on dequeue and auto-emits `verdict:'passthrough'` — topology
   * is preserved so descendants stay reachable.
   */
  protected passNodeIds: Set<string> = new Set();
  /** Last `init` params kept for refine re-run — origin/direction/depth/etc survive across the gate cycle. */
  protected initSnapshot: EngineInitSnapshot | null = null;

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
   * Set once by the post-approval composition round; never wiped by sliding-memory rotations.
   * Cleared only when a fresh engine is constructed (i.e. a new
   * `start_exploration` from `idle`). Read by the prompt assembler via
   * {@link getDiscoverySummary}.
   */
  protected _discoverySummary: string | null = null;
  /** Legacy checkpoint field retained for snapshot compatibility; no longer affects routing. */
  protected extendedDepthCap = 0;
  /** Last per-hop snapshot of detail/summary chars, used for diagnostics. */
  protected lastHopDetailChars = 0;
  /** Last per-hop summary-char count. */
  protected lastHopSummaryChars = 0;
  /** Last per-hop verdict — surfaced in `[AI] [Hop N]` log line. */
  protected lastHopVerdict: 'analyze' | 'passthrough' | 'prune' | null = null;
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
  /** CT lineage-continuation questions for the hop currently in flight, set at dispatch in {@link getHopContext} from that hop's own {@link AgendaEntry.lineageQuestions} — never a different node's. */
  protected _pendingLineageQuestions: string[] = [];
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
   * Publishes this validated engine's memory while preserving the session memory object identity.
   *
   * @param target - Session memory object that must retain its identity.
   */
  public publishMemoryTo(target: AiMemoryManager): void {
    target.restoreFromJSON(this.memory.toJSON());
    this.memory = target;
  }

  /** Initial approved BFS seed depth used for diagnostics, never route authorization. */
  protected computeDepthCap(): number | null {
    return this.depthBudget;
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
   * Canonical focus id of a currently-held finding, or `null` when none is held.
   *
   * @remarks
   * Non-null means the prior `submit_findings` failed only route/column completeness.
   */
  public get heldFindingFocus(): string | null {
    const held = this.heldFindingDraft.get();
    if (!held) return null;
    return resolveModelNodeId(held.focus_node_id, this.nodeMap)
      ?? held.focus_node_id.toLowerCase()
      ?? null;
  }

  /**
   * Restores held prose only when an incompleteness retry keeps the focus and sends no sections.
   * A retry with authored sections is a deliberate replacement and remains unchanged.
   *
   * @param incoming - Strict full BB/CT submission from the dispatcher boundary.
   * @returns The submission that must run through the normal atomic validation pipeline.
   */
  public applyHeldContent(incoming: HopSubmission): HopSubmission {
    const held = this.heldFindingDraft.get();
    if (!held) return incoming;
    const heldFocus = resolveModelNodeId(held.focus_node_id, this.nodeMap) ?? held.focus_node_id.toLowerCase();
    const inFocus = resolveModelNodeId(incoming.focus_node_id, this.nodeMap) ?? incoming.focus_node_id.toLowerCase();
    if (heldFocus !== inFocus || inFocus !== this.currentFocusNodeId) return incoming;
    if (incoming.sections.length > 0) return incoming;
    // Prose only. `verdict` and `badge_label` are decisions the retry may legitimately change, and
    // restoring them would silently discard what the model just submitted.
    return this.heldFindingDraft.merge(incoming, (draft, patch) => {
      return {
        ...patch,
        sections: draft.sections,
        summary: draft.summary,
      };
    }) ?? incoming;
  }

  /** Compatibility projection of unresolved scope-boundary leads for synthesis. */
  public get deferredQuestions(): ReadonlyArray<DeferredQuestion> {
    return this.taskLedger.pendingLeads.flatMap(lead => {
      if (lead.status !== 'pending' || (lead.reason !== 'schema_boundary' && lead.reason !== 'depth_boundary')) return [];
      const task = this.taskLedger.getTask(lead.taskId);
      if (!task) return [];
      return [{
        nodeId: lead.nodeId,
        schema: lead.schema ?? this.nodeMap.get(lead.nodeId)?.schema ?? '',
        fromFocusNodeId: lead.fromNodeId,
        question: task.question,
        reason: lead.reason === 'schema_boundary' ? 'schema' as const : 'depth' as const,
        ...(lead.depth !== undefined ? { depth: lead.depth } : {}),
        atHop: lead.createdHop,
      }];
    });
  }

  /** Read-only typed task ledger used by prompts, diagnostics, and checkpointing. */
  public get investigationTasks(): ReadonlyArray<InvestigationTask> {
    return this.taskLedger.investigationTasks;
  }

  /** Unresolved post-run leads; dismissed and resolved leads are retained in snapshots only. */
  public get pendingLeads(): ReadonlyArray<PendingLead> {
    return this.taskLedger.pendingLeads.filter(lead => lead.status === 'pending');
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
   * @param entry - Fully-populated deferral record produced by internal route validation.
   */
  protected deferQuestion(entry: DeferredQuestion): void {
    this.recordPendingLead(entry);
    this.memory.recordRejection(entry.nodeId, `deferred: out of approved scope (${entry.reason})`, entry.atHop);
  }

  /**
   * Records the structured task and lead corresponding to an accepted scope-boundary deferral.
   *
   * @remarks
   * `'schema_and_depth'` reports as `'schema_boundary'`: the allowlist is the stricter of the two
   * gates, and the breaching depth still rides the lead's own `depth` field, so nothing about the
   * deferral is lost. The lead reason is deliberately NOT widened to a composite member —
   * `PendingLead['reason']` is persisted as a `z.enum` in `navigationSnapshotSchema`, and a new
   * member would make records written by this build unreadable by an older one.
   */
  private recordPendingLead(entry: DeferredQuestion): void {
    const task = this.ensureDeferredTask(entry.nodeId, entry.question, entry.atHop);
    this.taskLedger.ensureLead({
      taskId: task.id,
      nodeId: entry.nodeId,
      fromNodeId: entry.fromFocusNodeId,
      reason: entry.reason === 'depth' ? 'depth_boundary' : 'schema_boundary',
      schema: entry.schema,
      ...(entry.depth !== undefined ? { depth: entry.depth } : {}),
      valueToUser: entry.question
        ? `Continue at ${entry.nodeId} to answer: ${entry.question}`
        : `Continue at ${entry.nodeId} beyond the approved ${DEFERRAL_BOUNDARY_LABEL[entry.reason]} boundary.`,
      createdHop: entry.atHop,
    });
  }

  /** Records an accepted non-bodied route whose contraction produced no analyzable hop. */
  private recordContractedLead(nodeId: string, fromNodeId: string, question: string): void {
    const task = this.ensureDeferredTask(nodeId, question, this.hopCount);
    this.taskLedger.ensureLead({
      taskId: task.id,
      nodeId,
      fromNodeId,
      reason: 'contracted_scope',
      valueToUser: question
        ? `Continue beyond ${nodeId} to answer: ${question}`
        : `Continue beyond ${nodeId} to inspect the contracted branch.`,
      createdHop: this.hopCount,
    });
  }

  /** Creates a structurally mode-valid deferred task without changing agenda state. */
  private ensureDeferredTask(nodeId: string, question: string, createdHop: number): InvestigationTask {
    const common = {
      source: 'model' as const,
      question,
      nodeId,
      parentTaskId: this.currentFocusTaskIds[0],
      status: 'deferred' as const,
      createdHop,
    };
    if (this.mode.kind === 'ct') {
      const columns = this.tracer?.activeColumns.length
        ? this.tracer.activeColumns
        : this.tracer?.targetColumns;
      if (!columns?.length) throw new Error('CT deferred tasks require at least one active column');
      return this.taskLedger.ensureTask({
        ...common,
        kind: 'column_lineage',
        activeColumns: [...columns] as [string, ...string[]],
      });
    }
    return this.taskLedger.ensureTask({ ...common, kind: 'analytical' });
  }

  /** Completes executable tasks and resolves any scheduled follow-up leads they own. */
  private completeTasks(taskIds: ReadonlyArray<string>): void {
    for (const taskId of taskIds) {
      this.taskLedger.setTaskStatus(taskId, 'resolved', this.hopCount);
      this.taskLedger.resolveTaskLeads(taskId);
    }
  }

  /**
   * Records the process lifecycle state for a node.
   *
   * @remarks
   * This is the source of truth for whether a node was analyzed, passed through,
   * or pruned (an engine/neighbor action — a node never prunes itself). `DetailSlot`
   * remains only the text bucket. Stronger terminal
   * states replace weaker ones, so an AI-analyzed node is not later downgraded
   * by an incidental pass-through observation.
   *
   * @param nodeId - The node id.
   * @param action - The action taken on the node.
   * @param source - The source of the action.
   * @param reason - The reason for the action.
   * @param meta - Optional metadata for the action.
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
    this.log('debug', `[Labels] distinct=${distinct} labeled=${labels.length} diversity=${diversity.toFixed(2)}${flag}`);
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
      deferredQueued: this.deferredQuestions.length,
      agendaRemaining: this._agenda.length,
      tally: { ...this.memory.getVerdictCounts(), prune: this.hopProgress.pruned },
      scopeExpansions: this.budgetExpansions.length,
      allowedSchemaCount: this.sessionAllowedSchemas.size,
      ...(this.mode.kind === 'ct' && this.tracer ? {
        columnEdgeCount: this.tracer.edges.length,
        activeColumnCount: this.tracer.activeColumns.length,
        columnFlowEntries: this.lastHopColumnFlowEntries,
      } : {}),
    };
  }

  /**
   * Continuation questions carried on the dequeued {@link AgendaEntry} for the hop currently in
   * flight — set at dispatch in {@link getHopContext}, from that entry's own `lineageQuestions`,
   * never from whichever node happened to commit most recently. Both the live per-hop worker message
   * and {@link toJSON} read this, so a restored engine resumes on the questions it was dumped with.
   */
  public get pendingLineageQuestions(): string[] {
    return this._pendingLineageQuestions;
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
   * Returns every self-pruned node's retained content, in insertion order.
   *
   * @remarks
   * Diagnostics accessor for telemetry / eval extraction (A31). Distinct from
   * {@link getDetailSlots} — a pruned node's content never enters the synthesis-visible archive.
   */
  public getPrunedDetails(): DetailSlot[] {
    return this.memory.getPrunedDetails();
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
    return this.tracer?.state ?? null;
  }

  /**
   * Engine code for a CT target list that names objects instead of columns. Single owner — emitted
   * by both CT-target adoption sites ({@link init} and {@link setColumnTargets}) so the reject and
   * its hint cannot drift between them.
   */
  private static readonly TARGET_COLUMNS_NAME_OBJECTS = 'target_columns_name_objects';

  /**
   * CT target entries that resolve to loaded-model node ids — object references, never columns.
   *
   * @remarks
   * The same boundary class as the Zod wildcard reject in `ColumnIdentifierSchema`: a value that
   * is an object id locks an unwinnable CT session — the object id becomes an active tracked
   * column, so every real column the model submits is rejected `out_col_not_on_node` while the
   * only accepted `out_col` would be the object id itself. Detection is exact, not heuristic:
   * {@link resolveModelNodeId} only matches schema-qualified two-part object spellings
   * (`[s].[o]`, `s.o`), so bare column names and three-part column spellings never match.
   */
  private nodeRefColumnTargets(columns: readonly string[]): string[] {
    return columns.filter((column) => resolveModelNodeId(column, this.nodeMap) !== null);
  }

  /**
   * Reject envelope for a CT target list containing object references. Verb-led, with both
   * legitimate alternatives built in so the model never has to guess: BB for the object, real
   * columns for CT.
   */
  private rejectNodeRefColumnTargets(nodeRefs: string[]): { error: string; hint: string } {
    return {
      error: NavigationEngine.TARGET_COLUMNS_NAME_OBJECTS,
      hint: `targetColumns [${trunc(nodeRefs.join(', '), 200)}] resolve to objects in the loaded model, not columns. To trace an object, resend without targetColumns and analysisMode "bb". To trace columns, name the user-named columns of the origin instead.`,
    };
  }

  /**
   * Reports the rejection a CT target list would earn for naming objects instead of columns,
   * without adopting anything.
   *
   * @remarks
   * Lets a caller refuse the whole request before it commits any other state — the supplement
   * path widens the allowlist and extends the agenda before it applies follow-up context, so
   * asking {@link setColumnTargets} would only surface the reject after those mutations landed.
   *
   * @param targetColumns - Column names the caller is about to adopt.
   * @returns A rejection envelope when a target names an object, otherwise `null`.
   */
  public checkColumnTargets(targetColumns: readonly string[]): { error: string; hint: string } | null {
    const nodeRefs = this.nodeRefColumnTargets(targetColumns);
    return nodeRefs.length > 0 ? this.rejectNodeRefColumnTargets(nodeRefs) : null;
  }

  /**
   * Updates column-trace target columns for the current session.
   *
   * @remarks
   * Refuses target entries that resolve to node ids — the engine never adopts an object
   * reference as a column, whatever the calling path. Side-effect-free on reject: the tracer
   * and mode are untouched, so a rejected follow-up leaves the completed session exactly as it
   * was.
   *
   * @param targetColumns - Column names to trace from this point forward.
   * @returns A rejection envelope when a target names an object, otherwise `null`.
   */
  public setColumnTargets(targetColumns: string[]): { error: string; hint: string } | null {
    const reject = this.checkColumnTargets(targetColumns);
    if (reject) return reject;
    this.tracer = new ColumnTracer(targetColumns);
    this.mode = { kind: 'ct' };
    return null;
  }

  /**
   * Bounds CT active columns to the focus node's declared columns when the node has a column
   * surface. Procedures/functions may write columns elsewhere, so absence of local columns is not
   * proof that the target is absent there.
   */
  private resolveActiveColumnsForNode(nodeId: string, columns?: string[]): string[] | undefined {
    if (!columns) return undefined;
    if (columns.length === 0) return [];
    const nodeColumns = getNodeColumns(nodeId, this.nodeMap, this.store ?? undefined) ?? [];
    if (nodeColumns.length === 0) return columns;
    const byNorm = new Map<string, string>(nodeColumns.map((c) => [normalizeColName(c.name), c.name]));
    const resolved: string[] = [];
    for (const requested of columns) {
      // Models qualify freely ("ai.FactSalesReport.TotalRevenue", "[t].[Col]") — resolve by exact
      // name first, then by the last dot-segment, returning the DECLARED name so downstream
      // set-difference checks compare canonical identifiers, never the request spelling.
      const exact = byNorm.get(normalizeColName(requested));
      const lastSegment = requested.split('.').pop() ?? requested;
      const suffix = exact === undefined ? byNorm.get(normalizeColName(lastSegment)) : undefined;
      const match = exact ?? suffix;
      if (match !== undefined && !resolved.includes(match)) resolved.push(match);
    }
    return resolved;
  }

  /**
   * Whether per-hop DDL minification must retain physical-storage detail (indexes, CLUSTERED,
   * WITH(...) options) for the focus node.
   *
   * @remarks
   * Driven off {@link classification} — the AI's own `business`/`technical`/`both` verdict, locked
   * at gate approval before any hop dispatches — never off mission-brief prose: guessing "wants
   * physical detail" from free text is exactly the intent-guessing the engine must not do.
   * `technical` and `both` preserve; `business` minifies. `classification` is set by the caller
   * before the first hop (the gate requires it on every fresh `start_exploration` proposal), so the
   * unset case is a defensive fallback for a wiring gap — it preserves conservatively rather than
   * risk stripping detail, never a prose heuristic.
   */
  private shouldPreserveTechContext(): boolean {
    if (!this.classification) return true;
    return this.classification === 'technical' || this.classification === 'both';
  }

  /**
   * Collapses `this._direction` plus an asymmetric depth's per-side `0` into the single traversal
   * direction actually approved for later hop growth.
   *
   * @remarks
   * A fixed `direction: 'upstream'|'downstream'` already fully restricts (asymmetric depth cannot
   * pair with a non-bidirectional direction — enforced at the Zod boundary), so this only narrows
   * a `'bidirectional'` session. An asymmetric side of exactly `0` is the AI/user's explicit,
   * permanent exclusion of that direction (see {@link AsymmetricExplorationDepthSchema}) — distinct
   * from merely starting the BFS seed without it — so it collapses `'bidirectional'` down to the
   * other side for every later route/contraction admission, not just the initial seed. Both sides
   * `0` cannot reach here (rejected at the Zod boundary before `init()`).
   */
  private effectiveDirection(): 'upstream' | 'downstream' | 'bidirectional' {
    if (this._direction !== 'bidirectional') return this._direction;
    const depthIntent = this.currentDepthIntent;
    if (depthIntent.kind === 'asymmetric') {
      if (depthIntent.upstream === 0) return 'downstream';
      if (depthIntent.downstream === 0) return 'upstream';
    }
    return 'bidirectional';
  }

  /**
   * Directed distance from the origin to `targetId`, and which side of the origin it lies on.
   *
   * @remarks
   * The lineage question is directional: "three levels upstream" counts edges the data actually
   * flows along. An undirected shortest path can route around through a shared sink — an audit or
   * logging table every procedure writes to — and report a node as nearer than it is, which would
   * enforce a border in the wrong place. Returns `null` when no directed path exists on either
   * side; callers then fall back to their local hop-relative estimate.
   *
   * @param targetId - Node to measure.
   * @returns The directed depth and side, or `null` when the node is unreachable directionally.
   */
  private directedDepthFromOrigin(targetId: string): { depth: number; side: 'upstream' | 'downstream' } | null {
    if (!this.originNodeId) return null;
    if (targetId === this.originNodeId) return { depth: 0, side: 'downstream' };
    const sides = this.directedDepthsFor(targetId);
    if (!sides) return null;
    const { upstream, downstream } = sides;
    if (upstream !== undefined && (downstream === undefined || upstream <= downstream)) {
      return { depth: upstream, side: 'upstream' };
    }
    return downstream !== undefined ? { depth: downstream, side: 'downstream' } : null;
  }

  /**
   * Per-side directed distances from the origin to `targetId`, or `undefined` when unreachable.
   *
   * @param targetId - Node to measure.
   * @returns The resolved sides, or `undefined` when no directed path reaches the node.
   */
  private directedDepthsFor(targetId: string): { upstream?: number; downstream?: number } | undefined {
    if (!this.originNodeId) return undefined;
    this.ensureDirectedDepths();
    return this.directedDepths.get(targetId);
  }

  /**
   * Fills {@link directedDepths} with one walk per side, unless the current seed already filled it.
   *
   * @remarks
   * Two traversals answer every node's distance, so the cost of enforcing a border is fixed per
   * scope seed rather than paid per candidate. A callback returning `true` in `bfsFromNode` prunes
   * that node's neighbours and does not abort the walk, so a per-candidate search was always a
   * whole traversal per side. The first depth recorded for a node is its shortest on that side —
   * breadth-first order guarantees it.
   */
  private ensureDirectedDepths(): void {
    if (this.directedDepthsFilled || !this.originNodeId) return;
    this.directedDepthsFilled = true;
    for (const [mode, side] of [['inbound', 'upstream'], ['outbound', 'downstream']] as const) {
      bfsFromNode(this.graph, this.originNodeId, (key, _attr, depth) => {
        const entry = this.directedDepths.get(key);
        if (!entry) this.directedDepths.set(key, { [side]: depth });
        else if (entry[side] === undefined) entry[side] = depth;
        return false;
      }, { mode });
    }
  }

  /**
   * Whether admitting `targetId` would cross a depth border the user fixed.
   *
   * @remarks
   * Only ever true under `'strict'` enforcement — i.e. only when the AI reported that the user
   * stated a level count. An omitted depth leaves the seed growable exactly as before.
   *
   * A node is inside the border when **either** side's distance fits that side's own ceiling: under
   * `{upstream:1, downstream:5}` a node three levels up and four levels down is a node the user
   * asked for on the downstream path, and judging it on the upstream ceiling refuses work that was
   * requested. Only when no side fits is it a breach, reported at the smallest resolved distance —
   * the nearest way in, and the number the deferred lead and the border log quote.
   *
   * @param targetId - Candidate node.
   * @param fallbackDepth - Hop-relative depth to judge by when no directed path resolves.
   * @returns The breaching depth when the border is crossed, otherwise `null`.
   */
  private depthBorderBreach(targetId: string, fallbackDepth: number | undefined): number | null {
    if (this.depthEnforcement !== 'strict') return null;
    const sides = this.directedDepthsFor(targetId);
    const resolved: number[] = [];
    for (const side of ['upstream', 'downstream'] as const) {
      const depth = sides?.[side];
      if (depth === undefined) continue;
      if (depth <= this.depthLimits[side]) return null;
      resolved.push(depth);
    }
    if (resolved.length > 0) return Math.min(...resolved);
    if (fallbackDepth === undefined) return null;
    // Without a resolved side the node is judged against the tighter of the two ceilings: a border
    // the user fixed must not be crossed by a node whose side we could not establish.
    const limit = Math.min(this.depthLimits.upstream, this.depthLimits.downstream);
    return fallbackDepth > limit ? fallbackDepth : null;
  }

  /** True when a route target is reachable from the origin within the approved traversal direction. */
  private isReachableInApprovedDirection(targetId: string): boolean {
    const direction = this.effectiveDirection();
    if (direction === 'bidirectional' || !this.originNodeId) return true;
    if (targetId === this.originNodeId) return true;
    const seen = new Set<string>([this.originNodeId]);
    const queue = [this.originNodeId];
    let idx = 0;
    while (idx < queue.length) {
      const id = queue[idx++];
      for (const nid of this.directionalNeighbors(id, direction)) {
        if (seen.has(nid)) continue;
        if (nid === targetId) return true;
        seen.add(nid);
        queue.push(nid);
      }
    }
    return false;
  }

  /**
   * The single scope-border test — is `node` inside the approved border for the given write path?
   *
   * @remarks
   * Consolidates the exclusion-set / approved-direction / schema-allowlist checks that every write
   * path shares, so no site can drift on axes or check order. Axes are selected by `purpose`
   * ({@link BorderPurpose}); the check order is fixed (exclusions → direction → allowlist) to match
   * the route path's first-failure semantics. Purely a read over locked session state — never
   * interprets intent. All identifiers are compared case-folded.
   *
   * The allowlist axis has two grants and one test: a schema the user filtered on
   * ({@link sessionAllowedSchemas}) or a single node the user named in a follow-up
   * ({@link sessionAllowedNodeIds}). Either admits the node; neither admits its siblings.
   *
   * @param nodeId - Canonical node id (any case; folded internally).
   * @param node - The resolved node, supplying `type` and `schema`.
   * @param purpose - Which write path is asking, fixing the participating axes.
   */
  private checkBorder(nodeId: string, node: LineageNode, purpose: BorderPurpose): BorderVerdict {
    // Only the display annotation ignores schema/node exclusions (it flags type-hidden neighbors only).
    const excludeAllSets = purpose !== 'display';
    const checkDirection = purpose === 'route' || purpose === 'ct_contraction';
    // seed_bfs deliberately omits the allowlist so out-of-allowlist reachables become gate classes.
    const checkAllowlist = purpose !== 'seed_bfs';

    if (this.excludedTypes.has(node.type.toLowerCase())) return { kind: 'excluded' };
    if (excludeAllSets) {
      if (this.excludedSchemas.has(node.schema.toLowerCase())) return { kind: 'excluded' };
      if (this.excludedNodeIds.has(nodeId.toLowerCase())) return { kind: 'excluded' };
    }
    if (checkDirection && !this.isReachableInApprovedDirection(nodeId)) return { kind: 'out_of_direction' };
    if (checkAllowlist
      && this.sessionAllowedSchemas.size > 0
      && !this.sessionAllowedSchemas.has(node.schema.toLowerCase())
      && !this.sessionAllowedNodeIds.has(nodeId.toLowerCase())) {
      return { kind: 'out_of_allowlist' };
    }
    return { kind: 'in_border' };
  }

  /** Gets the size of the active exploration scope. */
  public get scopeSize(): number {
    return this.scopeNodeIds.size;
  }

  /** Gets the count of bodied (view/proc/function) nodes in scope — the true hop denominator. */
  public get bodiedScopeSize(): number {
    return this._bodiedScopeSize;
  }

  /** Gets live hop progress: completed AI hops, queued nodes, display-safe total work, cumulative prunes, and the last hop's newly-routed (added) count. */
  public get hopProgress(): HopProgress {
    // Every prune path (verdict=prune, BB prune_neighbor) marks node-state 'prune', so counting them is
    // the single source for the cumulative prune tally surfaced in the chat status. `added` mirrors it
    // with the per-hop new-route count (`lastRoutedNew`, reset each submit) for the symmetric "+N added".
    let pruned = 0;
    for (const s of this.nodeStates.values()) if (s.action === 'prune') pruned++;
    const open = this._agenda.length;
    const total = Math.max(this._totalNodes, this.hopCount + open);
    return { current: this.hopCount, open, total, pruned, added: this.lastRoutedNew };
  }

  private set bodiedScopeSize(v: number) {
    this._bodiedScopeSize = v;
  }

  /** Gets the percentage of scope nodes covered. */
  public get coveragePct(): number {
    return this.scopeNodeIds.size > 0 ? Math.round((this.memory.slotCount / this.scopeNodeIds.size) * 100) : 0;
  }

  /** Origin id captured at the most recent {@link init}; cached so the refine path can re-init without re-asking the AI. */
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

  /** AI-owned depth verdict captured at {@link init}; the refine path re-seeds from this. */
  public get currentDepthIntent(): DepthIntent {
    return this.initSnapshot?.depthIntent ?? { kind: 'default_start' };
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

  /** Explicit analysis mode captured at {@link init}. */
  public get currentAnalysisMode(): 'bb' | 'ct' {
    return this.initSnapshot?.analysisMode ?? (this.mode.kind === 'ct' ? 'ct' : 'bb');
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
  public getScopeSummary(namesPerType = 8): ScopeSummary {
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
      const schemaEntry = bySchema[schema];
      schemaEntry.scope++;
      if (isBodied) schemaEntry.hops++;
      if (!schemaEntry.byType[type]) {
        schemaEntry.byType[type] = { hops: 0, scope: 0, nodeNames: [], omitted: 0 };
      }
      const leaf = schemaEntry.byType[type];
      leaf.scope++;
      if (isBodied) leaf.hops++;
      if (leaf.nodeNames.length < namesPerType) leaf.nodeNames.push(n.name);
      else leaf.omitted++;
    }

    // Sort names alphabetically inside each leaf for stable rendering.
    for (const schemaEntry of Object.values(bySchema)) {
      for (const leaf of Object.values(schemaEntry.byType)) {
        leaf.nodeNames.sort((a, b) => a.localeCompare(b));
      }
    }

    const estimatedDdlChars = this.estimateScopeDdlChars();
    const originNode = this.originNodeId ? this.nodeMap.get(this.originNodeId) : undefined;
    const originLabel = originNode ? `${originNode.schema}.${originNode.name}` : (this.originNodeId ?? '');
    const canonicalNodeId = (id: string): string => resolveModelNodeId(id, this.nodeMap) ?? id;

    return {
      hopCount,
      scopeCount: this.scopeNodeIds.size,
      origin: this.originNodeId ?? '',
      originLabel,
      depth: this.depthBudget,
      depthIntent: this.currentDepthIntent,
      direction: this._direction,
      analysisMode: this.currentAnalysisMode,
      columnAspectActive: this.mode.kind === 'ct',
      targetColumns: this.tracer?.targetColumns,
      estimatedDdlChars,
      estimatedDdlTokens: estimateTokens(estimatedDdlChars),
      bySchema,
      scopeNotes: this.memory.getScopeNotes(),
      classification: this.classification,
      activeFilters: {
        schemas: Array.from(this.excludedSchemas).sort(),
        types: Array.from(this.excludedTypes).sort(),
        nodeIds: Array.from(this.excludedNodeIds, canonicalNodeId).sort(),
        passNodeIds: Array.from(this.passNodeIds, canonicalNodeId).sort(),
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
      // Directional reachability prevents backward cross-edges from hiding true chokepoints.
      const removed = new Set<string>([id]);
      const reachable = this.directionalReachable(this.originNodeId, removed, this.scopeNodeIds);
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
   * Renders the current node's sub-question as the `<current_task>` block so the AI
   * sees its per-node assignment as structured text rather than buried JSON.
   * Returns an empty string when no hop is in progress.
   */
  public getCurrentTasks(): ReadonlyArray<InvestigationTask> {
    if (!this.currentFocusNodeId) return [];
    return this.currentFocusTaskIds
      .map(taskId => this.taskLedger.getTask(taskId))
      .filter((task): task is InvestigationTask => task !== undefined);
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
   * Stores the discovery-handoff memo composed at proposal time (`composeDiscoverySummaryText`)
   * and cached on the reviewed proposal — set verbatim at gate approval, never recomposed. Empty
   * or whitespace-only input becomes `null`; the memo persists for the engine lifetime.
   *
   * @param text - The reviewed 2–4 sentence memo.
   */
  public setDiscoverySummary(text: string): void {
    const trimmed = text.trim();
    this._discoverySummary = trimmed.length > 0 ? trimmed : null;
  }

  /** Stores the current-task question at the moment a hop context is delivered. */
  private _lastCurrentTask = '';

  /**
   * Sets up the navigation map to prepare for traversal.
   *
   * @param params - Initialization parameters like question, origin, depth.
   * @returns An object indicating initialization success and agenda details.
   */
  public init(params: NavigationInitParams): { ok: true; scopeSize: number; agendaSize: number; scopeSchemas: string[] } | { error: string; hint?: string; unresolved_excludeNodeIds?: string[]; unresolved_passNodeIds?: string[] } {
    if (params.depthIntent?.kind === 'asymmetric' && (params.direction ?? 'bidirectional') !== 'bidirectional') {
      return {
        error: ASYMMETRIC_DEPTH_REQUIRES_BIDIRECTIONAL,
        hint: 'Asymmetric depths require direction "bidirectional" — this refine kept a single direction from the prior proposal. Resend with direction "bidirectional", or use one direction with a symmetric depth.',
      };
    }
    if (params.analysisMode === 'ct' && (!params.targetColumns || params.targetColumns.length === 0)) {
      return {
        error: 'target_columns_required_for_ct',
        hint: 'Provide at least one named targetColumns value for CT, or change analysisMode to "bb".',
      };
    }
    if (params.analysisMode === 'bb' && params.targetColumns !== undefined) {
      return {
        error: 'ct_field_forbidden_in_bb',
        hint: 'Omit targetColumns and resubmit the BB specification. If the provider emits an empty array, the encoding boundary normalizes it automatically.',
      };
    }
    // Refine detection: initSnapshot is null on first init, populated thereafter — survives status transitions.
    const wasRefine = this.initSnapshot !== null;
    const prevScopeSize = this.scopeNodeIds.size;

    // Phase 1 — validate every payload reference against the model before touching any state, so a
    // rejected refine (which re-inits the live engine) leaves it exactly as it was: reject is side-effect-free.
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
      this.log('debug', `[NL] excludeNodeIds resolved=[${excludeIds.resolved.join(',')}] unresolved=[${excludeIds.unresolved.join(',')}] passNodeIds resolved=[${passIds.resolved.join(',')}] unresolved=[${passIds.unresolved.join(',')}]`);
      return {
        error: 'unknown_node_ids',
        hint: "These ids don't exist in the loaded model after bracket/case normalization. Call lineage_search_objects with each user-named identifier to resolve the canonical schema-qualified id, then re-call lineage_start_exploration with the corrected list.",
        unresolved_excludeNodeIds: excludeIds.unresolved,
        unresolved_passNodeIds: passIds.unresolved,
      };
    }
    if (excludeIds.resolved.length + passIds.resolved.length > 0) {
      this.log('debug', `[NL] excludeNodeIds resolved=[${excludeIds.resolved.join(',')}] passNodeIds resolved=[${passIds.resolved.join(',')}]`);
    }

    const resolvedOriginId = resolveModelNodeId(params.origin, this.nodeMap);
    const originNode = resolvedOriginId ? this.nodeMap.get(resolvedOriginId) : null;
    if (!originNode) {
      return {
        error: 'origin_not_found',
        hint: 'Verify the origin node id with lineage_search_objects first. Use the exact id it returns (case-insensitive match against the loaded graph).',
      };
    }

    const analysisMode: 'bb' | 'ct' = params.analysisMode ?? ((params.targetColumns?.length ?? 0) > 0 ? 'ct' : 'bb');
    const effectiveTargetColumns = analysisMode === 'ct' ? params.targetColumns : undefined;
    // Resolve CT columns against the origin's DDL now; store in a local so the tracer is built in
    // phase 2 only after this (and every other) validation has passed.
    let resolvedActiveColumns: string[] = [];
    if (analysisMode === 'ct' && effectiveTargetColumns && effectiveTargetColumns.length > 0) {
      // Object references are rejected before any resolution: a node id can never be a column of
      // the origin, whatever the origin's own column surface. Side-effect-free like every phase-1
      // reject — a refused fresh/refine proposal leaves the live engine exactly as it was.
      const nodeRefs = this.nodeRefColumnTargets(effectiveTargetColumns);
      if (nodeRefs.length > 0) {
        this.log('debug', `[AI] [CT] target columns [${trunc(nodeRefs.join(','), 120)}] resolve to objects, not columns — rejecting start`);
        return this.rejectNodeRefColumnTargets(nodeRefs);
      }
      const resolved = this.resolveActiveColumnsForNode(originNode.id, effectiveTargetColumns) ?? [];
      // No fallback: CT target columns must exist on the origin, or the model must choose BB.
      if (resolved.length === 0) {
        const declared = getNodeColumns(originNode.id, this.nodeMap, this.store ?? undefined) ?? [];
        const declaredNames = declared.map((c) => c.name);
        this.log('debug', `[AI] [CT] requested columns [${effectiveTargetColumns.join(',')}] not found on origin ${originNode.id} — rejecting (no zero-trace fallback)`);
        return {
          error: 'unknown_columns',
          hint: declaredNames.length > 0
            ? `targetColumns [${effectiveTargetColumns.join(', ')}] are not columns on ${originNode.id}. Its columns are: [${trunc(declaredNames.join(', '), 300)}]. Provide valid columns, ask the user to clarify, or switch analysisMode to "bb".`
            : `${originNode.id} exposes no column metadata to trace. Ask the user to clarify or switch analysisMode to "bb".`,
        };
      }
      resolvedActiveColumns = resolved;
    }

    // Phase 2 — every reference validated; commit engine + memory state.
    this.visited.clear();
    this._agenda.clear();
    this.taskLedger.clear();
    this.currentFocusNodeId = null;
    this.currentFocusQuestion = null;
    this.currentFocusTaskIds = [];
    this._lastCurrentTask = '';
    this._pendingLineageQuestions = [];
    this.nodeStates.clear();
    this.heldFindingDraft.clear();
    this.memory.reset();
    this.memory.setUserQuestion(params.question);
    if (params.mission_brief !== undefined) {
      this.memory.setMissionBrief(params.mission_brief);
      this.log('debug', `[Mission] provenance=engine_init len=${params.mission_brief.length}`);
    }
    if (params.scopeNotes?.length) {
      this.memory.setScopeNotes(params.scopeNotes);
      this.log('debug', `[Mission] scope_notes count=${params.scopeNotes.length}`);
    }

    this.excludedTypes = new Set((params.excludeTypes ?? []).map(t => t.toLowerCase()));
    this.excludedSchemas = new Set((params.excludeSchemas ?? []).map(s => s.toLowerCase()));
    this.excludedNodeIds = new Set(excludeIds.resolved.map(s => s.toLowerCase()));
    this.passNodeIds = new Set(passIds.resolved.map(s => s.toLowerCase()));

    this.originNodeId = originNode.id;
    // Depth is AI-owned intent, consumed mechanically from the Zod-validated `depthIntent`.
    const direction = params.direction || 'bidirectional';
    const depthIntent: DepthIntent = params.depthIntent ?? { kind: 'default_start' };
    let seedDepth: number;
    let depthLabel: string;
    switch (depthIntent.kind) {
      case 'explicit':
        this.depthBudget = depthIntent.levels;
        // The AI reported a level count copied from the user's question: a hard border.
        this.depthEnforcement = 'strict';
        this.depthLimits = { upstream: depthIntent.levels, downstream: depthIntent.levels };
        seedDepth = depthIntent.levels;
        depthLabel = String(seedDepth);
        break;
      case 'full_frontier':
        this.depthBudget = null;
        this.depthEnforcement = 'silent';
        this.depthLimits = NavigationEngine.UNBOUNDED_DEPTH_LIMITS;
        seedDepth = Number.POSITIVE_INFINITY;
        depthLabel = 'all';
        break;
      case 'asymmetric': {
        // Each side keeps its own ceiling — `'all'` unbounds only the side it was given, and the
        // scalar budget stays a display/checkpoint summary, never the enforcement value.
        const sideLimit = (value: number | 'all'): number =>
          value === 'all' ? Number.POSITIVE_INFINITY : value;
        this.depthLimits = {
          upstream: sideLimit(depthIntent.upstream),
          downstream: sideLimit(depthIntent.downstream),
        };
        // The scalar summary is null unless BOTH sides are capped: reporting the finite side as the
        // one budget would state a ceiling for a side that has none.
        const bothFinite = Number.isFinite(this.depthLimits.upstream)
          && Number.isFinite(this.depthLimits.downstream);
        this.depthBudget = bothFinite
          ? Math.max(this.depthLimits.upstream, this.depthLimits.downstream)
          : null;
        // An asymmetric ask is still user-stated, so it binds on both sides independently.
        this.depthEnforcement = 'strict';
        seedDepth = Math.max(this.depthLimits.upstream, this.depthLimits.downstream);
        depthLabel = `up=${depthIntent.upstream} down=${depthIntent.downstream}`;
        break;
      }
      case 'default_start':
        this.depthBudget = DEFAULT_SM_START_DEPTH;
        this.depthEnforcement = 'silent';
        this.depthLimits = NavigationEngine.UNBOUNDED_DEPTH_LIMITS;
        seedDepth = DEFAULT_SM_START_DEPTH;
        depthLabel = `default:${DEFAULT_SM_START_DEPTH}`;
        this.log('debug', `[Depth] default applied levels=${DEFAULT_SM_START_DEPTH} reason=ai_and_user_omitted_depth`);
        break;
      default: {
        const _exhaustive: never = depthIntent;
        throw new Error(`unhandled depth intent: ${JSON.stringify(_exhaustive)}`);
      }
    }
    this.budgetExpansions = [];
    this.scopeNodeIds = this.computeBfsScope(originNode.id, direction, depthIntent);

    // Initialize column aspect if target columns are provided. Requested target columns stay in
    // target_columns for auditability; active_columns is the DDL-resolved set for the origin hop.
    let initialActiveColumns = effectiveTargetColumns;
    if (analysisMode === 'ct' && effectiveTargetColumns && effectiveTargetColumns.length > 0) {
      this.tracer = new ColumnTracer(effectiveTargetColumns);
      initialActiveColumns = resolvedActiveColumns;
      this.tracer.setActiveColumns(initialActiveColumns);
      this.mode = { kind: 'ct' };
    } else {
      this.tracer = null;
      this.mode = { kind: 'bb' };
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
    // Seed the denominator with the approved bodied scope size so the user sees the true "contract"
    // denominator (e.g. "Hop 1 of 27") right from the first hop, instead of a dynamically growing number.
    this._totalNodes = this.bodiedScopeSize;
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
      this.log('info', `[BFS-refine] cause=user_refine origin=${originNode.id} dir=${direction} depth=${depthLabel}${excludeNodeIdsLine} → scope=Δ (was=${prevScopeSize} now=${this.scopeNodeIds.size}) (tables=${breakdown.table}, views=${breakdown.view}, procs=${breakdown.procedure}, functions=${breakdown.function}) excludeTypes=[${excludedTypesAnnotated}]${guiHiddenLine}`);
    } else {
      this.log('info', `[BFS] origin=${originNode.id} dir=${direction} depth=${depthLabel} → scope=${this.scopeNodeIds.size} (tables=${breakdown.table}, views=${breakdown.view}, procs=${breakdown.procedure}, functions=${breakdown.function}) excludeTypes=[${excludedTypesAnnotated}]${excludeNodeIdsLine}${guiHiddenLine}`);
    }

    // [AI] [Contract] — emit a stable hash of the resolved scope contract so downstream hop logs
    // can be cross-referenced against the originating filter snapshot. Replaces the spec's
    // `getScopeContract().hash` since we don't model that as a separate object.
    const contractParts = [
      originNode.id,
      params.direction || 'bidirectional',
      depthIntent.kind === 'explicit' ? `explicit:${depthIntent.levels}` : depthIntent.kind,
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
    this.log('debug', `[Contract] hash=${contractHash} origin=${originNode.id} scope=${this.scopeNodeIds.size} filters=${filtersDigest} nl_interp=${nlInterp}`);

    this._direction = params.direction || 'bidirectional';
    // Snapshot kept so the refine path (gate cycle) can re-run init with new filters without the
    // AI re-sending origin / direction / depth / mission_brief. The depth verdict is stored
    // verbatim so a refine round locks to the same intent unless the user corrects it at the gate.
    this.initSnapshot = {
      question: params.question,
      origin: originNode.id,
      analysisMode,
      ...(analysisMode === 'ct' && effectiveTargetColumns?.length
        ? { targetColumns: [...effectiveTargetColumns] as [string, ...string[]] }
        : {}),
      direction: this._direction,
      depthIntent,
      mission_brief: params.mission_brief,
    };
    // Bipartite agenda rule: `enqueueHop` is the only code path that writes to the agenda.
    // It pushes bodied nodes directly and contracts body-less nodes through to their bodied
    // neighbors in the current exploration direction. Invariant holds by construction.
    const rootTask = this.mode.kind === 'ct'
      ? this.taskLedger.ensureTask({
          kind: 'column_lineage',
          source: 'mission',
          question: params.question,
          nodeId: originNode.id,
          activeColumns: initialActiveColumns as [string, ...string[]],
          createdHop: 0,
        })
      : this.taskLedger.ensureTask({
          kind: 'root',
          source: 'mission',
          question: params.question,
          nodeId: originNode.id,
          createdHop: 0,
        });
    this.enqueueHop(originNode.id, params.question, 0, 3, { columns: initialActiveColumns, existingTaskId: rootTask.id });
    if (this.mode.kind !== 'ct' || (initialActiveColumns?.length ?? 0) > 0) {
      this.seedAgenda(originNode.id, this._direction, initialActiveColumns, rootTask.id);
    }
    this._status = 'initialized';

    return {
      ok: true,
      scopeSize: this.scopeNodeIds.size,
      agendaSize: this._agenda.length,
      scopeSchemas: Array.from(scopeSchemas).sort(),
    };
  }

  /**
   * Admits the named follow-up targets through the allowlist, one id at a time.
   *
   * @remarks
   * The consent step the host runs *before* {@link supplementAgenda}, which stays a side-effect-free
   * reject — the same extend-then-supplement ordering the approve-gate path uses. Naming a node in a
   * follow-up is the user consent that reaches it; without this step a `schema_boundary` lead was a
   * dead end, because nothing on the supplement path ever widened the allowlist and the target came
   * straight back as `out_of_allowlist`.
   *
   * Id-scoped, never schema-scoped: "also look at object X" is consent for X. Admitting X's whole
   * schema would open every sibling in it on the model's say-so, and a sibling that used to ride
   * along now defers as its own lead — visible, and approvable on its own. Admission is monotonic,
   * so repeated follow-ups can only widen.
   *
   * {@link checkBorder} carries no depth axis for any purpose, so an approved target is admitted at
   * any depth and each node beyond it defers as its own lead — one explicit approval per node.
   *
   * Exclusion sets are untouched — those are the user's own removals and stay a hard wall in
   * {@link checkBorder}.
   *
   * @param nodeIds - Follow-up targets, canonical or free-cased; unresolvable ids are ignored.
   * @returns The canonical ids actually admitted, so the reply can name them.
   */
  public admitSupplementTargets(nodeIds: readonly string[]): string[] {
    const admitted: string[] = [];
    for (const raw of nodeIds) {
      const id = this.nodeMap.has(raw) ? raw : this.nodeMap.has(raw.toLowerCase()) ? raw.toLowerCase() : null;
      const node = id ? this.nodeMap.get(id) : undefined;
      if (!node || this.excludedNodeIds.has(node.id.toLowerCase())) continue;
      this.sessionAllowedNodeIds.add(node.id.toLowerCase());
      admitted.push(node.id);
    }
    if (admitted.length > 0) this.log('info', `[Border] supplement admit ids=[${admitted.join(',')}]`);
    return admitted;
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
   *
   * Side-effect-free on reject: a target outside the border is reported in `skippedDetails` and
   * nothing is mutated. Widening the border is the caller's step, via
   * {@link admitSupplementTargets}, so consent stays a host decision.
   *
   * @param nodeIds - Node ids to append to the agenda or contract through.
   * @param leadIds - Host-selected pending leads; never accepted from a model tool payload.
   * @returns Counts for agendaed, contracted, and skipped ids, plus per-node `skippedDetails`
   *   naming which id was dropped and why (`excluded` | `unresolved`), or a structured error.
   */
  public supplementAgenda(nodeIds: string[], leadIds: string[] = []): { ok: true; agendaed: number; contracted: number; skipped: number; skippedDetails: SupplementSkip[] } | { error: string; hint?: string } {
    if (this._status !== 'complete') {
      return {
        error: 'supplement_requires_complete_engine',
        hint: `supplementAgenda is only valid after the prior exploration has completed (status === 'complete'). Current status: ${this._status}.`,
      };
    }
    if ((!Array.isArray(nodeIds) || nodeIds.length === 0) && (!Array.isArray(leadIds) || leadIds.length === 0)) {
      return { error: 'supplement_empty', hint: 'supplementAgenda requires at least one node id or pending lead id.' };
    }

    const leadEntries = leadIds.map(leadId => {
      const lead = this.taskLedger.pendingLeads.find(item => item.id === leadId && item.status === 'pending');
      const task = lead ? this.taskLedger.getTask(lead.taskId) : undefined;
      return lead && task ? { lead, task } : null;
    });
    if (leadEntries.some(entry => !entry)) {
      return {
        error: 'invalid_pending_lead',
        hint: 'Use an unresolved pending lead id from the completed exploration, or provide explicit supplement nodeIds.',
      };
    }

    const requested = [
      ...nodeIds.map(nodeId => ({ nodeId, question: `Supplement: investigate ${nodeId} on user follow-up`, taskId: undefined as string | undefined, leadId: undefined as string | undefined })),
      ...leadEntries.map(entry => ({ nodeId: entry!.lead.nodeId, question: entry!.task.question, taskId: entry!.task.id, leadId: entry!.lead.id })),
    ];

    // A pruned node is structurally not a valid supplement target: enqueueHop's removed-guard
    // would silently drop it while scheduleLead has already fired, stranding a permanently zombie
    // lead. Validate the whole batch here — before any scheduleLead/scope/visited mutation — so a
    // corrected retry can drop the pruned id (mutations below assume every target is enqueueable).
    for (const request of requested) {
      const raw = request.nodeId;
      const id = this.nodeMap.has(raw) ? raw : this.nodeMap.has(raw.toLowerCase()) ? raw.toLowerCase() : null;
      if (id && this.removedSet.has(id)) {
        return {
          error: 'supplement_target_pruned',
          hint: `Node "${id}" was pruned from the completed exploration and cannot be supplemented. Drop it from the supplement request (start a fresh exploration to re-include it).`,
        };
      }
    }

    const agendaBefore = this._agenda.length;
    let skipped = 0;
    const skippedDetails: SupplementSkip[] = [];
    for (const request of requested) {
      const raw = request.nodeId;
      const id = this.nodeMap.has(raw) ? raw : this.nodeMap.has(raw.toLowerCase()) ? raw.toLowerCase() : null;
      if (!id) {
        this.log('debug', `[Supplement] refuse hop=${this.hopCount} id=${raw} reason=unresolved`);
        skippedDetails.push({ nodeId: raw, reason: 'unresolved' });
        skipped++;
        continue;
      }
      // A user-excluded or out-of-allowlist node is a hard wall on the supplement write path — the
      // border only widens through user consent ({@link admitSupplementTargets}, called by the host
      // before this), never through an AI-initiated supplement re-adding what the user removed.
      const supNode = this.nodeMap.get(id);
      const supBorder = supNode ? this.checkBorder(id, supNode, 'supplement') : null;
      if (supBorder && supBorder.kind !== 'in_border') {
        const reason = supBorder.kind === 'out_of_allowlist' ? 'out_of_allowlist' : 'excluded';
        this.log('debug', `[Supplement] refuse hop=${this.hopCount} id=${id} reason=${reason}`);
        skippedDetails.push({ nodeId: id, reason });
        skipped++;
        continue;
      }
      // Captured BEFORE mutation so enqueueHop can credit _totalNodes correctly: scope/visited
      // membership below would otherwise always read back as "already known" by the time it checks.
      const wasNewToScope = !this.scopeNodeIds.has(id);
      const wasVisited = this.visited.has(id);
      if (wasNewToScope) {
        this.scopeNodeIds.add(id);
        const node = this.nodeMap.get(id);
        if (node && SCRIPT_TYPES.has(node.type)) this.bodiedScopeSize++;
      }
      // Reset visited guard so the supplemented id can be analyzed even if it was
      // passed-through during the parent exploration.
      if (wasVisited) this.visited.delete(id);
      const existingDepth = this.depthFromOrigin.get(id);
      const depth = typeof existingDepth === 'number' ? existingDepth : 0;
      // CT: pass target columns so supplemented nodes are analyzed with column context.
      const supplementColumns = this.tracer?.targetColumns;
      if (request.leadId) this.taskLedger.scheduleLead(request.leadId);
      this.enqueueHop(id, request.question, depth, 3, {
        columns: supplementColumns,
        freshScopeExpansion: wasNewToScope,
        reactivated: wasVisited,
        existingTaskId: request.taskId,
      });
    }

    const agendaed = this._agenda.length - agendaBefore;
    const contracted = requested.length - agendaed - skipped;

    this._status = 'awaiting_findings';

    const modeLabel = this.mode.kind === 'ct' ? 'sm (ct)' : 'sm';
    this.log('info', `[Supplement] added ${requested.length} requested tasks → agendaed=${agendaed} contracted=${contracted} skipped=${skipped}; mode=${modeLabel}, status=awaiting_findings`);

    return { ok: true, agendaed, contracted, skipped, skippedDetails };
  }

  /**
   * Gets the details for the next scheduled navigation hop.
   *
   * @returns Context data mapped for the AI router.
   */
  public getHopContext(): HopContext {
    let entry: AgendaEntry | undefined;
    while (this._agenda.length > 0) {
      const candidate = this._agenda.dequeue();
        if (!candidate) break;

      if (this.visited.has(candidate.nodeId)) {
        // Sound only because enqueueHop's visited-guard blocks queueing new questions onto an
        // already-visited node — if that guard is relaxed, this would resolve unanswered questions.
        this.completeTasks(candidate.taskIds);
        continue;
      }

      // User-requested auto-pass: keep node in scope, skip the AI hop, contract through to
      // bodied neighbours so descendants stay reachable. Topology preserved; no analysis.
      if (this.passNodeIds.has(candidate.nodeId.toLowerCase())) {
        this.visited.add(candidate.nodeId);
        this.markNodeState(candidate.nodeId, 'passthrough', 'user', 'user_pass_filter', {
          columns: candidate.activeColumns,
          atHop: this.hopCount,
        });
        this.memory.recordVerdict('passthrough');
        this.contractThroughPassNode(candidate);
        this.completeTasks(candidate.taskIds);
        this._totalNodes--;
        continue;
      }

      // CT: recover active columns from accumulated edges; empty sets still dispatch to the AI.
      if (this.mode.kind === 'ct' && this.tracer) {
        candidate.activeColumns = this.tracer.determineActiveColumnsForCandidate(
          candidate.nodeId,
          candidate.activeColumns ?? [],
        );
        candidate.activeColumns = this.resolveActiveColumnsForNode(candidate.nodeId, candidate.activeColumns) ?? [];
      }

      entry = candidate;
      break;
    }

    if (!entry) {
      this._status = 'complete';
      this._totalNodes = this.hopCount;
      this.logLabelDiversity();
      return { done: true };
    }

    this.visited.add(entry.nodeId);
    this.hopCount++;
    if (this.currentFocusNodeId !== entry.nodeId) this.heldFindingDraft.clear();
    this.currentFocusNodeId = entry.nodeId;
    this.currentFocusTaskIds = [...entry.taskIds];
    for (const taskId of entry.taskIds) this.taskLedger.setTaskStatus(taskId, 'active');
    this.currentFocusQuestion = this.taskLedger.getTask(entry.taskIds[0])?.question ?? null;

    // Synchronize the Column Aspect to only show columns relevant to this specific path
    if (this.mode.kind === 'ct' && this.tracer) {
      this.tracer.setActiveColumns(entry.activeColumns || []);
    }
    // Read continuation questions from THIS entry, not a global cache last written by whichever
    // hop committed most recently — the render site must see only the questions opened for the
    // node actually being dispatched.
    this._pendingLineageQuestions = entry.lineageQuestions ? [...entry.lineageQuestions] : [];

    const node = this.nodeMap.get(entry.nodeId)!;

    const preserveTechContext = this.shouldPreserveTechContext();
    const rawDdl = (typeof this.store?.getDdl === 'function' ? this.store.getDdl(node.id) : undefined)
      ?? node.bodyScript;
    const focusNode = buildHopFocusNode(
      node, this.nodeMap, new Map(), this.store ?? undefined, 'bb_ddl',
      this.model.neighborIndex, this.edgeTypeMap, preserveTechContext,
    );
    const originalChars = rawDdl?.length ?? 0;
    const minifiedChars = typeof focusNode.bb_ddl === 'string' ? focusNode.bb_ddl.length : 0;
    const reducedPct = originalChars > 0
      ? (Math.max(0, originalChars - minifiedChars) / originalChars) * 100
      : 0;
    this.log(
      'debug',
      `[DDL] Applying hop-by-hop minification (preserveTechContext=${preserveTechContext}, reduced=${reducedPct.toFixed(1)}%)`,
    );

    if (this.depthBudget !== null) {
      const d = this.depthFromOrigin.get(entry.nodeId);
      if (d !== undefined) focusNode.depth_from_origin = d;
    }

    const path = bidirectional(this.graph, this.originNodeId!, entry.nodeId);
    const navPath = path ? (path).map(id => this.nodeMap.get(id)?.name || id).join(' → ') : 'Direct';

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
      // Named-node consent is the other half of the allowlist axis; without it here the border the
      // model reads would still refuse an object the user has already asked for by name.
      ...(this.sessionAllowedNodeIds.size > 0 ? { node_ids: Array.from(this.sessionAllowedNodeIds).sort() } : {}),
      depth_cap: this.computeDepthCap(),
    };
    workingMemory.deferred_count = this.deferredQuestions.length;
    if (this.mode.kind === 'ct' && this.tracer) {
      workingMemory.column_aspect = this.tracer.state;
    }

    this._lastCurrentTask = this.currentFocusQuestion ?? '';
    this._status = 'awaiting_findings';
    return {
      sm_status: 'awaiting_findings' as const,
      hop: this.hopCount,
      agenda_remaining: this._agenda.length,
      focus_node: focusNode,
      neighbors: this.buildNeighborList(entry.nodeId),
      working_memory: workingMemory,
    };
  }

  /**
   * In-scope, unvisited, un-queued directional neighbors of `focusId` — the exact set the BB
   * required-nodes guard demands an account for on the next submit.
   *
   * @remarks Single source for that set: the guard callback and the per-hop envelope render
   * ({@link buildActiveHopInstruction}) both read it, so the rendered checklist can never drift
   * from what the engine enforces. CT ignores it (column_flow drives CT routing).
   *
   * @param focusId - Current focus node id.
   * @returns Directional neighbor ids that must be routed or accounted for before BB can advance.
   */
  public requiredNeighborIds(focusId: string): string[] {
    return Array.from(this.directionalNeighbors(focusId, this._direction))
      .filter(nid => this.scopeNodeIds.has(nid) && !this.visited.has(nid) && !this._agenda.has(nid) && !this.removedSet.has(nid));
  }

  /**
   * Re-renders the current focus hop context without advancing the agenda.
   *
   * @returns The current focus context, or `null` when no focus is active.
   */
  public peekHopContext(): HopContext | null {
    const focusId = this.currentFocusNodeId;
    if (!focusId) return null;
    const node = this.nodeMap.get(focusId);
    if (!node) return null;
    const preserveTechContext = this.shouldPreserveTechContext();

    const focusNode = buildHopFocusNode(
      node, this.nodeMap, new Map(), this.store ?? undefined, 'bb_ddl',
      this.model.neighborIndex, this.edgeTypeMap, preserveTechContext,
    );
    if (this.depthBudget !== null) {
      const d = this.depthFromOrigin.get(focusId);
      if (d !== undefined) focusNode.depth_from_origin = d;
    }
    return {
      sm_status: this._status,
      hop: this.hopCount,
      agenda_remaining: this._agenda.length,
      focus_node: focusNode,
      neighbors: this.buildNeighborList(focusId),
      current_task: this.currentFocusQuestion ?? this._lastCurrentTask ?? undefined,
    };
  }

  /**
   * Processes the findings from a completed hop and adjusts the agenda.
   *
   * @remarks
   * Pruning is AI-decided in both modes (1.4b): a `verdict=prune` submission executes through
   * the topology-safe don't-orphan path with reason `submitted_prune`; CT focus prunes are also
   * surfaced as `ctPrunedNodeIds`. Strict mode schemas reject BB-only `prune_neighbors` in CT.
   * Column continuity is enforced after the strict CT boundary requires `column_flow`.
   *
   * Route/column validation classifies failures into a structural {@link InvalidRouteKind}.
   * *Content* errors (real node, wrong column — CT-only) hard-reject via
   * {@link buildRouteValidationRejection}. Absent route/contributor references and refused no-op
   * prunes are recorded notices; content, completeness, conflict, origin, and topology failures
   * reject atomically. Loaded routes may be transitively reachable in the approved direction; the
   * engine does not impose a direct-current-neighbor rule. Hints remain mode-pure.
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

    try {
      // A prior hold can survive only through applyHeldContent immediately before this call.
      this.heldFindingDraft.clear();
    const invalidRoutes: InvalidRoute[] = [];
    const routeOutcomes: RouteOutcome[] = [];
    const finding = params;
    const rawFocusId = finding.focus_node_id;
    const focusId = resolveModelNodeId(rawFocusId, this.nodeMap) ?? rawFocusId?.toLowerCase();
    if (!focusId || !this.nodeMap.has(focusId)) {
      return { error: 'invalid_focus_node', got: rawFocusId, expected: this.currentFocusNodeId ?? undefined };
    }
    if (focusId !== this.currentFocusNodeId) {
      return { error: 'focus_mismatch', expected: this.currentFocusNodeId ?? undefined, got: focusId };
    }
    if (finding.verdict === 'prune') {
      if (focusId === this.originNodeId) {
        return {
          error: 'prune_origin_forbidden',
          hint: 'The exploration origin is immutable. Submit a complete analyze or passthrough finding for this focus.',
        };
      }
      const requiredConnectedIds = this.committedConnectedIds();
      const disconnected = this.firstDisconnectedAfterPrune(focusId, requiredConnectedIds);

      if (disconnected) {
        return {
          error: 'prune_would_orphan_noted',
          hint: `Marking [${focusId}] prune would orphan committed node [${disconnected}] (already analyzed or still queued). Use verdict='passthrough' to keep it without pruning.`
        };
      }

      // Pruning is AI-decided in both modes, then engine-executed via the topology-safe path above.
      this.lastRoutedNew = 0;
      this.lastRoutedRejected = 0;
      this.lastRoutedDeferred = 0;
      this.lastHopColumnFlowEntries = 0;
      this._pendingLineageQuestions = [];
      if (this.mode.kind === 'ct') this.ctPrunedFocusIds.add(focusId);
      this.removedSet.add(focusId);
      this.visited.add(focusId);
      this.markNodeState(
        focusId,
        'prune',
        'ai',
        'submitted_prune',
        { columns: this.tracer?.activeColumns, atHop: this.hopCount },
      );
      this.memory.storePrunedDetail(
        this.nodeMap.get(focusId)!,
        finding.sections ?? [],
        finding.summary ?? '',
        { badge_label: finding.badge_label, reason_for_visit: this.currentFocusQuestion || 'Historical path investigation' },
      );
      this.memory.recordVerdict('prune');
      this.lastHopVerdict = 'prune';
      this.completeTasks(this.currentFocusTaskIds);
      this._status = 'exploring';
      // Focus took an AI hop, so it counts towards hopCount. Do not decrement _totalNodes,
      // which ensures x never exceeds y.
      this.log('debug', `[Self-Prune] hop=${this.hopCount} id=${focusId} mode=${this.mode.kind}`);
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
    // Populated at commit, keyed by upstream node id, so each routed hop's own AgendaEntry (not
    // the next node to dequeue, whichever it turns out to be) carries only the questions opened
    // for it.
    let lineageQuestionsByNode: Map<string, string[]> | undefined;
    let stagedSections: Parameters<AiMemoryManager['storeDetail']>[1] = [];
    let stagedDetailChars = 0;
    let stagedSummaryChars = 0;
    const stagedColumnEdges: ColumnEdge[] = [];
    const stagedCtNodeStates: Array<{
      nodeId: string;
      action: SmNodeAction;
      source: SmNodeStateSource;
      reason: SmNodeStateReason;
      meta: { columns?: string[]; viaNodeId?: string; atHop?: number };
    }> = [];
    const stagedColumnFlowEntries = this.mode.kind === 'ct'
      ? finding.column_flow?.length ?? 0
      : 0;
    const routeColumnsByNode = new Map<string, Set<string>>();
    const routeQuestionsByNode = new Map<string, string>();
    const routeRequests = [...(finding.route_requests ?? [])];

    if (this.mode.kind === 'ct' && finding.column_flow) {
      for (const entry of finding.column_flow) {
        for (const ref of entry.upstream_columns) {
          const nid = resolveModelNodeId(ref.node, this.nodeMap) ?? ref.node.toLowerCase();
          if (!routeColumnsByNode.has(nid)) routeColumnsByNode.set(nid, new Set());
          routeColumnsByNode.get(nid)!.add(ref.col);
          if (!routeQuestionsByNode.has(nid)) {
            routeQuestionsByNode.set(nid, `Trace ${ref.col} as upstream input for ${entry.out_col}.`);
          }
        }
      }
      const routed = new Set(routeRequests.map(req => (resolveModelNodeId(req.nodeId, this.nodeMap) ?? req.nodeId.toLowerCase())));
      for (const [nid, question] of routeQuestionsByNode) {
        if (!routed.has(nid)) routeRequests.push({ nodeId: nid, question });
      }
    }

    const routeTargets: Array<{ raw: string; resolved: string | null; path: string }> = [];
    for (let index = 0; index < (finding.route_requests ?? []).length; index++) {
      const raw = finding.route_requests![index].nodeId;
      routeTargets.push({ raw, resolved: resolveModelNodeId(raw, this.nodeMap), path: `route_requests.${index}.nodeId` });
    }
    const pruneTargets = (finding.prune_neighbors ?? []).map((raw, index) => ({
      raw,
      resolved: resolveModelNodeId(raw, this.nodeMap),
      path: `prune_neighbors.${index}`,
    }));
    const requiredNodeIds = this.requiredNeighborIds(focusId);
    const actionPolicy = evaluateCurrentHopActionPolicy({
      originId: this.originNodeId!,
      routeTargets,
      pruneTargets,
      scopeNodeIds: this.scopeNodeIds,
      requiredNeighborIds: new Set(requiredNodeIds),
      visitedIds: this.visited,
      removedIds: this.removedSet,
      notedIds: new Set(this.memory.notedNodeIds),
    });
    invalidRoutes.push(...actionPolicy.fatalErrors);

    if (routeRequests.length > 0) {
      for (const req of routeRequests) {
        if (this.mode.kind === 'ct' && this.tracer?.activeColumns.length === 0) {
          const nid = resolveModelNodeId(req.nodeId, this.nodeMap) ?? req.nodeId;
          routeOutcomes.push({ nodeId: nid, accepted: false, reason: 'no_active_columns' });
          continue;
        }

        const nid = resolveModelNodeId(req.nodeId, this.nodeMap);
        const nNode = nid ? this.nodeMap.get(nid) : null;
        if (!nid || !nNode) continue; // Recorded as a nonfatal unresolved notice above.
        const routeBorder = this.checkBorder(nid, nNode, 'route');
        if (routeBorder.kind === 'excluded') {
          routeOutcomes.push({ nodeId: nNode.id, accepted: false, reason: 'excluded' });
          this.log('debug', `[Agenda] route ignore hop=${this.hopCount} id=${nNode.id} ← ${focusId} reason=excluded`);
          continue;
        }
        if (routeBorder.kind === 'out_of_direction') {
          routeOutcomes.push({ nodeId: nNode.id, accepted: false, reason: 'out_of_direction' });
          this.log('debug', `[Agenda] route ignore hop=${this.hopCount} id=${nNode.id} ← ${focusId} reason=out_of_direction direction=${this._direction}`);
          continue;
        }

        const schemaBlocked = routeBorder.kind === 'out_of_allowlist';

        let candidateDepth = this.depthFromOrigin.get(nid) ?? this.directedDepthFromOrigin(nid)?.depth;
        if (candidateDepth === undefined) {
          const focusDepth = this.depthFromOrigin.get(focusId) ?? 0;
          candidateDepth = focusDepth + 1;
        }

        // An omitted depth leaves the approved depth an initial BFS seed the model may grow. A
        // user-stated level count is a border: the route is still recorded, but as a deferred
        // follow-up rather than an admission — exactly what the active-hop protocol promises.
        const depthBreach = this.depthBorderBreach(nid, candidateDepth);
        if (schemaBlocked || depthBreach !== null) {
          const deferReason: 'schema' | 'depth' | 'schema_and_depth' = schemaBlocked
            ? (depthBreach !== null ? 'schema_and_depth' : 'schema')
            : 'depth';
          deferredRoutes.push({
            nodeId: nNode.id,
            schema: nNode.schema,
            question: req.question ?? '',
            reason: deferReason,
            depth: depthBreach ?? candidateDepth,
          });
          routeOutcomes.push({ nodeId: nNode.id, accepted: false, deferred: true, reason: deferReason });
          if (depthBreach !== null) {
            this.log(
              'debug',
              `[Depth] border reached hop=${this.hopCount} id=${nNode.id} ← ${focusId} `
              + `depth=${depthBreach} cap=up:${this.depthLimits.upstream}/down:${this.depthLimits.downstream}`,
            );
          }
          continue;
        }

        acceptedNids.add(nid);
        routeOutcomes.push({ nodeId: nNode.id, accepted: true });
        if (!this.scopeNodeIds.has(nid)) scopeAddNids.add(nid);
        // Symmetric with the prune/defer logs: record every neighbour ADD (kept in the chain) so the
        // debug trace shows both sides of the agenda decision, not just rejections.
        this.log('debug', `[Agenda] route accept hop=${this.hopCount} id=${nNode.id} ← ${focusId} subq=${req.question ? trunc(req.question, 80) : '(none)'}`);

      }
    }
    // Column Aspect validation + completeness is delegated to ColumnTracer and pure set-difference checks.
    if (this.mode.kind === 'ct' && this.tracer) {
      const valResult = this.tracer.validateColumnFlow(focusId, finding, this.nodeMap, this.model, this.store ?? null);
      if (valResult.error) {
        return valResult.error;
      }

      invalidRoutes.push(...valResult.invalidRoutes);
      // Single edge-staging source: validateColumnFlow stages every upstream real column.
      for (const e of valResult.stagedEdges) e.hop = this.hopCount;
      stagedColumnEdges.push(...valResult.stagedEdges);
    }

    // The pure policy selects only out-of-scope prune targets; topology conservation is
    // the final guard, and all mutations stay staged until completeness also passes.
    if (actionPolicy.acceptedPruneIds.length > 0) {
      const requiredConnectedIds = this.committedConnectedIds();
      requiredConnectedIds.add(focusId);
      const stagedRemoved = new Set<string>(this.removedSet);
      // Fast path: one reachability walk with EVERY candidate removed at once. Reachability is
      // monotone in the removal set, so a safe all-removed graph proves each sequential
      // per-candidate check would also pass — the whole batch commits on a single BFS instead of
      // one full walk per id (prune_neighbors is capped at 500; per-candidate walks made a wide
      // submit O(batch × scope) on every hop). Guarded to candidate sets disjoint from the
      // required set: a required candidate would be skipped by the batch's removed-set rule but
      // NOT by the earlier sequential steps, so only the disjoint case is provably equivalent.
      const candidateIsRequired = actionPolicy.acceptedPruneIds.some((nid) => requiredConnectedIds.has(nid));
      let batchSafe = false;
      if (!candidateIsRequired) {
        const allRemoved = new Set<string>(stagedRemoved);
        for (const nid of actionPolicy.acceptedPruneIds) allRemoved.add(nid);
        batchSafe = firstDisconnectedRequiredNode(
          this.graph,
          this.originNodeId!,
          allRemoved,
          requiredConnectedIds,
          this.scopeNodeIds,
        ) === null;
      }
      if (batchSafe) {
        for (const nid of actionPolicy.acceptedPruneIds) {
          if (!prunedNeighborNids.has(nid)) {
            prunedNeighborNids.add(nid);
            stagedRemoved.add(nid);
          }
        }
      } else {
        // Slow path when the batch is unsafe or a candidate is required: the per-candidate walks
        // attribute the exact offending prune and preserve the original order semantics.
        for (const nid of actionPolicy.acceptedPruneIds) {
          const disconnected = this.firstDisconnectedAfterPrune(nid, requiredConnectedIds, stagedRemoved);
          if (disconnected) {
            this.log('debug', `[Reject] prune_neighbor hop=${this.hopCount} id=${nid} reason=would_orphan_noted disconnected=${disconnected}`);
            invalidRoutes.push({ kind: 'prune_would_orphan', id: nid, reason: `Pruning \`${nid}\` would orphan committed node \`${disconnected}\` from the origin.` });
            continue;
          }
          if (!prunedNeighborNids.has(nid)) {
            prunedNeighborNids.add(nid);
            stagedRemoved.add(nid);
          }
        }
      }
    }

    // analyze/pass path: commit the detail slot + CT edges (prune exits early above) — stage its sections + CT passthrough roles.
    {
      stagedSections = finding.sections ?? [];
      stagedDetailChars = stagedSections.reduce((sum, s) => sum + (s.text?.length ?? 0), 0);
      stagedSummaryChars = finding.summary?.length ?? 0;

      // Mark non-bodied to/from nodes as pass-through without re-staging column edges.
      if (this.mode.kind === 'ct' && this.tracer && finding.column_flow) {
        for (const entry of finding.column_flow) {
          const toNode = entry.writes_to?.node ? (resolveModelNodeId(entry.writes_to.node, this.nodeMap) ?? entry.writes_to.node.toLowerCase()) : focusId;
          const toCol  = entry.writes_to?.col  ?? entry.out_col;
          const toNodeObj = this.nodeMap.get(toNode);
          if (toNodeObj && !SCRIPT_TYPES.has(toNodeObj.type)) {
            stagedCtNodeStates.push({
              nodeId: toNode,
              action: 'passthrough',
              source: 'engine',
              reason: 'non_bodied_passthrough',
              meta: { columns: [toCol], viaNodeId: focusId, atHop: this.hopCount },
            });
          }
          for (const ref of entry.upstream_columns) {
            const fromNode = resolveModelNodeId(ref.node, this.nodeMap);
            if (!fromNode) continue;
            const fromNodeObj = this.nodeMap.get(fromNode);
            if (fromNodeObj && !SCRIPT_TYPES.has(fromNodeObj.type)) {
              stagedCtNodeStates.push({
                nodeId: fromNode,
                action: 'passthrough',
                source: 'engine',
                reason: 'non_bodied_passthrough',
                meta: { columns: [ref.col], viaNodeId: focusId, atHop: this.hopCount },
              });
            }
          }
        }
      }
    }

    // BB completeness guard: every in-scope directional neighbor must be routed before advance.
    this.strategy.runRequiredNodesGuard(
      focusId,
      finding,
      acceptedNids,
      prunedNeighborNids,
      invalidRoutes,
      requiredNodeIds
    );

    // Content errors (real node, wrong column) are correctable → hard-reject with a mode-pure,
    // per-kind hint built from the locked classification's reachable kinds. Every content kind
    // arises only under columnAspect (CT), so a BB session never produces a route hard-reject.
    const contentErrors = invalidRoutes.filter(r => !isAbsentKind(r.kind));
    if (contentErrors.length > 0) {
      this.lastRoutedRejected = contentErrors.length;
      for (const r of contentErrors) this.memory.recordRejection(r.id, r.reason, this.hopCount);
      // Only pure neighbor incompleteness retains prose for the established sections:[] retry.
      if (contentErrors.every(r => r.kind === 'missing_required_route')) {
        this.heldFindingDraft.hold(structuredClone(finding));
      }
      return buildRouteValidationRejection(contentErrors);
    }

    // CT completeness guard: every active tracked column must be continued or marked terminal.
    if (this.mode.kind === 'ct' && this.tracer) {
      const unaccounted = this.tracer.unaccountedActiveColumns(finding.column_flow ?? []);
      if (unaccounted.length > 0) {
        this.lastRoutedRejected = unaccounted.length;
        this.memory.recordRejection(focusId, `column_chain_incomplete: ${unaccounted.join(', ')}`, this.hopCount);
        this.heldFindingDraft.hold(structuredClone(finding));
        return buildIncompleteRejection(focusId, unaccounted, [...this.tracer.activeColumns]);
      }
    }

    // Active-phase admission guard: staged scope growth must fit the exploration budget.
    // Last fatal guard — runs before any durable mutation so a rejection leaves the hop unstaged.
    if (scopeAddNids.size > 0) {
      const projectedNodes = this.scopeNodeIds.size + scopeAddNids.size;
      const admission = checkActiveScopeAdmission(projectedNodes, this.estimateScopeDdlChars(scopeAddNids));
      if (!admission.ok) {
        this.lastRoutedRejected = scopeAddNids.size;
        this.memory.recordRejection(focusId, `over_active_scope_budget: +${scopeAddNids.size} routes would exceed the exploration budget`, this.hopCount);
        this.heldFindingDraft.hold(structuredClone(finding));
        return {
          error: 'over_active_scope_budget',
          hint: `Committing ${scopeAddNids.size} new routes would exceed the exploration budget (nodes ${admission.counts.nodes}/${admission.limits.node_cap}, est. tokens ${admission.counts.tokens}/${admission.limits.token_budget}). Your analysis is held: resend submit_findings keeping only the routes essential to the question — prune or defer the rest, or mark remaining branches terminal so the engine can close and synthesize.`,
          detail: {
            staged_routes: scopeAddNids.size,
            projected_nodes: admission.counts.nodes,
            node_cap: admission.limits.node_cap,
            projected_tokens: admission.counts.tokens,
            token_budget: admission.limits.token_budget,
          },
        };
      }
    }

    // Nonfatal notices become durable only after every fatal/completeness guard passes.
    const notices = [...actionPolicy.notices, ...invalidRoutes.filter(r => isAbsentKind(r.kind))];
    for (const notice of notices) {
      this.memory.recordRejection(notice.id, `\`${notice.id}\`: ${ROUTE_REJECTION_DIRECTIVE[notice.kind]}`, this.hopCount);
      if (notice.kind === 'absent_route') {
        routeOutcomes.push({ nodeId: notice.id, accepted: false, reason: 'unresolved' });
      }
    }

    // All validation has passed. From here on, apply the staged hop exactly once.
    this.lastRoutedNew = 0;
    this.lastRoutedRejected = 0;
    this.lastRoutedDeferred = 0;
    this.lastHopColumnFlowEntries = stagedColumnFlowEntries;
    this._pendingLineageQuestions = [];

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
      if (!this.depthFromOrigin.has(nid)) {
        this.depthFromOrigin.set(nid, this.directedDepthFromOrigin(nid)?.depth ?? focusDepth + 1);
      }
      this.budgetExpansions.push({ nodeId: nid, depth: focusDepth + 1, atHop: this.hopCount });
      this.log('debug', `[Depth] auto-add beyond initial scope id=${nid} depth=${focusDepth + 1} hop=${this.hopCount}`);
    }

    for (const nid of prunedNeighborNids) {
      this.removedSet.add(nid);
      this.markNodeState(nid, 'prune', 'ai', 'bb_prune_neighbor', {
        viaNodeId: focusId,
        atHop: this.hopCount,
      });
      if (!this.visited.has(nid) && SCRIPT_TYPES.has(this.nodeMap.get(nid)!.type) && this.scopeNodeIds.has(nid)) {
        this._totalNodes--;
        this.log('debug', `[Prune] prune_neighbor ${nid} — bodied scope node (total −1 → ${this._totalNodes})`);
      }
      this.log('debug', `[Prune] prune_neighbor hop=${this.hopCount}: ${nid}`);
    }
    // analyze/pass path: commit the detail slot + CT edges (prune exits early above).
    {
      this.memory.storeDetail(this.nodeMap.get(focusId)!, stagedSections, finding.summary, {
        badge_label: finding.badge_label,
        reason_for_visit: this.currentFocusQuestion || 'Historical path investigation',
      });
      this.lastHopDetailChars = stagedDetailChars;
      this.lastHopSummaryChars = stagedSummaryChars;
      this.archiveChars += this.lastHopDetailChars + this.lastHopSummaryChars;

      if ((this.mode.kind === 'ct' && this.tracer) && stagedColumnEdges.length > 0) {
        this.tracer.edges.push(...stagedColumnEdges);
        // Group continuation questions NOW (focusId + hopCount still match these edges) by the
        // upstream node that must answer each; the route loop below hands each group to that
        // node's own AgendaEntry so it renders only there, never at an unrelated next hop.
        lineageQuestionsByNode = this.tracer.getColumnLineageQuestionsByNode(focusId, this.hopCount);
        this.log('debug', `[CT] column_flow hop=${this.hopCount} focus=${focusId} entries=${this.lastHopColumnFlowEntries} total_edges=${this.tracer.edges.length} active_cols=${this.tracer.activeColumns.join(',')}`);
      }
    }

    for (const state of stagedCtNodeStates) {
      this.markNodeState(state.nodeId, state.action, state.source, state.reason, state.meta);
    }

    this.memory.recordVerdict(finding.verdict);
    this.lastHopVerdict = finding.verdict;
    this.markNodeState(
      focusId,
      finding.verdict,
      'ai',
      finding.verdict === 'analyze' ? 'submitted_analyze' : 'submitted_passthrough',
      {
        columns: this.tracer?.activeColumns,
        atHop: this.hopCount,
      },
    );
    this.completeTasks(this.currentFocusTaskIds);

    // Neighbor prunes exclude future enqueue attempts without shrinking the current agenda.

    if (routeRequests.length > 0) {
      // Snapshot fresh scope expansions before enqueueHop sees them as normal scope members.
      const freshlyExpandedIds = new Set<string>(scopeAddNids);
      for (const req of routeRequests) {
        const nid = resolveModelNodeId(req.nodeId, this.nodeMap) ?? req.nodeId.toLowerCase();
        if (!acceptedNids.has(nid)) continue;

        // Route enqueue funnels through the bipartite agenda rule.
        const agendaSizeBefore = this._agenda.length;
        const targetNode = this.nodeMap.get(nid);
        const targetIsBodied = !!targetNode && SCRIPT_TYPES.has(targetNode.type);
        const wasAlreadyVisited = this.visited.has(nid);
        const routeColumns = routeColumnsByNode.get(nid);
        const isFreshExpansion = freshlyExpandedIds.delete(nid);
        // reactivated is always false here: enqueueHop's visited-guard (above) already rejects any
        // route targeting an already-visited node, so reactivation only ever arises via supplementAgenda.
        this.enqueueHop(nid, req.question, 0, 2, {
          columns: routeColumns ? [...routeColumns] : undefined,
          lineageQuestions: lineageQuestionsByNode?.get(nid),
          freshScopeExpansion: isFreshExpansion,
          admitCtContractedBodiedTarget: this.mode.kind === 'ct' && !targetIsBodied,
        });
        const added = this._agenda.length - agendaSizeBefore;
        this.lastRoutedNew += Math.max(0, added);

        // Report accepted-but-contracted routes as deferred when no hop was enqueued.
        if (added === 0 && !targetIsBodied && !wasAlreadyVisited) {
          for (let i = routeOutcomes.length - 1; i >= 0; i--) {
            if (routeOutcomes[i].nodeId === nid && routeOutcomes[i].accepted) {
              routeOutcomes[i] = { nodeId: nid, accepted: false, deferred: true, reason: 'depth_contracted_beyond_budget' };
              this.recordContractedLead(nid, focusId, req.question);
              break;
            }
          }
        }
      }
    }

    this._status = 'exploring';
    this.heldFindingDraft.clear();
    const outcomes = routeOutcomes.length > 0 ? { route_outcomes: routeOutcomes } : {};

      return { ok: true, ...outcomes };
    } catch (err: unknown) {
      this.log('error', '[Engine] Exception in submitFindings', err);
      this._status = 'error';
      return {
        error: 'engine_crash',
        hint: 'The engine crashed while processing findings. Call start_exploration to restart the session.',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Calculates the approximate number of DDL characters required by the scope.
   *
   * @returns The total character count.
   */
  public estimateScopeDdlChars(stagedAdditions?: Iterable<string>): number {
    let total = 0;
    for (const nid of this.scopeNodeIds) {
      const ddl = getNodeDdl(nid, this.nodeMap, this.store ?? undefined);
      if (ddl) {
        total += ddl.length;
      }
    }
    if (stagedAdditions) {
      for (const nid of stagedAdditions) {
        if (this.scopeNodeIds.has(nid)) continue;
        const ddl = getNodeDdl(nid, this.nodeMap, this.store ?? undefined);
        if (ddl) total += ddl.length;
      }
    }
    return total;
  }

  /**
   * Evaluates the breadth-first search reachability for initializing traversal scope.
   *
   * @param startId - Starting node identifier.
   * @param direction - Direction of graph traversal ('upstream', 'downstream', 'bidirectional').
   * @param depthIntent - AI-proposed and user-approved starting scope depth.
   * @returns A set of valid node identifiers reachable within the depth parameters.
   */
  private computeBfsScope(
    startId: string,
    direction: 'upstream' | 'downstream' | 'bidirectional',
    depthIntent: DepthIntent,
  ): Set<string> {
    const seen = new Set<string>();
    this.depthFromOrigin.clear();
    this.directedDepths.clear();
    this.directedDepthsFilled = false;

    const limit = (side: 'upstream' | 'downstream'): number => {
      switch (depthIntent.kind) {
        case 'explicit': return depthIntent.levels;
        case 'full_frontier': return Number.POSITIVE_INFINITY;
        case 'default_start': return DEFAULT_SM_START_DEPTH;
        case 'asymmetric': {
          const value = depthIntent[side];
          return value === 'all' ? Number.POSITIVE_INFINITY : value;
        }
      }
    };
    const walk = (mode: 'inbound' | 'outbound', maxDepth: number): void => {
      bfsFromNode(this.graph, startId, (key, _attr, depth) => {
        seen.add(key);
        const prior = this.depthFromOrigin.get(key);
        if (prior === undefined || depth < prior) this.depthFromOrigin.set(key, depth);
        return depth >= maxDepth;
      }, { mode });
    };
    if (direction === 'upstream' || direction === 'bidirectional') walk('inbound', limit('upstream'));
    if (direction === 'downstream' || direction === 'bidirectional') walk('outbound', limit('downstream'));

    // Exclusion axes only — origin is never dropped (it anchors the trace). The `seed_bfs` purpose
    // deliberately omits the schema allowlist: out-of-allowlist reachables must survive the seed so
    // they become `schema:` gate classes the user can approve (see startExploration gate classes).
    const hasFilters = this.excludedTypes.size > 0 || this.excludedSchemas.size > 0 || this.excludedNodeIds.size > 0;
    if (hasFilters) {
      for (const id of Array.from(seen)) {
        if (id === startId) continue;
        const node = this.nodeMap.get(id);
        if (!node) continue;
        if (this.checkBorder(id, node, 'seed_bfs').kind !== 'in_border') seen.delete(id);
      }
    }

    return seen;
  }

  /** Returns directional graph neighbors based on the active exploration direction. */
  private directionalNeighbors(nodeId: string, direction: 'upstream' | 'downstream' | 'bidirectional'): string[] {
    if (direction === 'upstream') return this.graph.inNeighbors(nodeId);
    if (direction === 'downstream') return this.graph.outNeighbors(nodeId);
    return this.graph.neighbors(nodeId);
  }

  /**
   * Reachability from `startId` following only edges in the active traversal direction.
   *
   * @remarks
   * Directional analogue of {@link bfsReachable} (which is undirected): mirrors its
   * removed/scope filtering exactly but walks {@link directionalNeighbors}. For a
   * `bidirectional` session this is identical to the undirected walk; for upstream /
   * downstream it prevents a backward cross-edge from falsely connecting an orphaned node.
   */
  private directionalReachable(
    startId: string,
    removed: ReadonlySet<string>,
    scope: ReadonlySet<string>,
  ): Set<string> {
    if (!this.graph.hasNode(startId)) return new Set();
    const reachable = new Set<string>([startId]);
    const queue = [startId];
    let idx = 0;
    while (idx < queue.length) {
      const id = queue[idx++];
      for (const nid of this.directionalNeighbors(id, this._direction)) {
        if (reachable.has(nid) || removed.has(nid)) continue;
        if (!scope.has(nid)) continue;
        reachable.add(nid);
        queue.push(nid);
      }
    }
    return reachable;
  }

  /**
   * Seeds the initial agenda based on the requested traversal parameters.
   *
   * @param originId - Identifies the starting node to build the agenda from.
   * @param direction - Edge traversal direction.
   * @param targetCols - Array of target column names for detailed tracking.
   * @param rootTaskId - New exploration root that owns every initial seed task.
   */
  private seedAgenda(originId: string, direction: 'upstream' | 'downstream' | 'bidirectional', targetCols: string[] | undefined, rootTaskId: string): void {
    for (const nid of this.directionalNeighbors(originId, direction)) {
      this.enqueueHop(nid, `Analyze relationship to ${originId}`, 1, 0, { columns: targetCols, parentTaskId: rootTaskId });
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
    // Bound carried columns to this pass node's on-trace spine before propagation.
    const spineBound = (this.mode.kind === 'ct' && this.tracer)
      ? this.tracer.determineActiveColumnsForCandidate(entry.nodeId, entry.activeColumns ?? [])
      : entry.activeColumns;
    // Spine-empty candidates fall back to the requested set verbatim (determineActiveColumnsForCandidate
    // above) — bound that result to the pass node's own declared columns too, same predicate as enqueueHop.
    const carried = this.mode.kind === 'ct' ? (this.resolveActiveColumnsForNode(entry.nodeId, spineBound) ?? []) : spineBound;
    const questions = entry.taskIds
      .map(taskId => this.taskLedger.getTask(taskId)?.question)
      .filter((question): question is string => Boolean(question));
    if (this.mode.kind === 'ct' && (carried?.length ?? 0) === 0) {
      this.log('debug', `[Disposition] pass-node ${entry.nodeId} declares none of the carried columns — contraction stops here`);
      // The pass node itself is already marked `passthrough` by the dispatcher; what is lost here is
      // everything behind it. Record the lead so the shortened trace carries its own explanation.
      const via = this.currentFocusNodeId ?? this.originNodeId ?? undefined;
      if (via) {
        this.recordContractedLead(entry.nodeId, via, questions[0] ?? `Continue through ${entry.nodeId}`);
      }
      return;
    }
    for (const nid of this.directionalNeighbors(entry.nodeId, this._direction)) {
      for (const question of questions.length ? questions : [`Continue through ${entry.nodeId}`]) {
        this.enqueueHop(nid, question, entry.depth + 1, entry.priority, { columns: carried });
      }
    }
  }

  /**
   * The committed-connectivity set K that a prune must not orphan from the origin: every
   * already-analyzed node PLUS every node still queued on the agenda.
   *
   * @remarks
   * A prune (self or neighbor) is topology-safe only if it leaves every committed node reachable from
   * the origin. Seeding that set from analyzed (`notedNodeIds`) alone missed **agenda-queued** nodes —
   * a routed-but-unvisited node whose detail slot would silently vanish from the render if a prune
   * disconnected it (its id survives in scope but `getResult`'s reachability recompute drops it). K
   * makes the queued node visible to the orphan guard so the prune is rejected instead.
   */
  private committedConnectedIds(): Set<string> {
    const ids = new Set<string>(this.memory.notedNodeIds);
    for (const e of this._agenda.entries) ids.add(e.nodeId);
    return ids;
  }

  /** One topology-conservation evaluator shared by focus and neighbor prune paths. */
  private firstDisconnectedAfterPrune(
    targetId: string,
    requiredConnectedIds: ReadonlySet<string>,
    removedBefore: ReadonlySet<string> = this.removedSet,
  ): string | null {
    const candidateRemoved = new Set(removedBefore);
    candidateRemoved.add(targetId);
    return firstDisconnectedRequiredNode(
      this.graph,
      this.originNodeId!,
      candidateRemoved,
      requiredConnectedIds,
      this.scopeNodeIds,
    );
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
   * @param opts - Optional enqueue modifiers, an options object by design: two of the flags are
   *   adjacent same-typed booleans with different semantics, and a positional transposition would
   *   compile silently while corrupting hop accounting.
   */
  private enqueueHop(
    targetId: string,
    question: string,
    depth: number,
    priority: number,
    opts: {
      /** Columns of interest (column-trace mode); BB tasks must not carry any. */
      readonly columns?: string[];
      /**
       * CT chain-continuation questions opened for `targetId` by the committing hop's
       * `column_flow` edges — carried onto the agenda entry itself so `<lineage_questions>`
       * renders only when this exact node is dispatched.
       */
      readonly lineageQuestions?: string[];
      /** Internal cycle guard for the recursive contraction step. */
      readonly visitedRefs?: Set<string>;
      /**
       * Whether `targetId` was absent from {@link scopeNodeIds} before the caller's own mutations
       * this call (callers that pre-add to scope before enqueueing MUST pass this explicitly; the
       * live default only holds for callers that never touch scope themselves).
       */
      readonly freshScopeExpansion?: boolean;
      /**
       * Whether `targetId` was previously visited and had its visited flag reset (a
       * `supplementAgenda` re-analysis), so it consumes a brand-new hop despite being in scope.
       */
      readonly reactivated?: boolean;
      /** Existing task to attach instead of creating a new task. */
      readonly existingTaskId?: string;
      /** Parent task assigned when a new task is created. */
      readonly parentTaskId?: string;
      /**
       * Whether this call is the bodied leaf of an accepted CT route through a non-bodied carrier
       * and may therefore extend the initial seed after filter checks.
       */
      readonly admitCtContractedBodiedTarget?: boolean;
    } = {},
  ): void {
    const {
      columns,
      lineageQuestions,
      visitedRefs = new Set<string>(),
      freshScopeExpansion = !this.scopeNodeIds.has(targetId),
      reactivated = false,
      existingTaskId,
      parentTaskId,
      admitCtContractedBodiedTarget = false,
    } = opts;
    if (!this.scopeNodeIds.has(targetId) && priority !== 3) {
      const contractedTarget = this.nodeMap.get(targetId);
      const canAdmitCtContraction = admitCtContractedBodiedTarget
        && this.mode.kind === 'ct'
        && !!contractedTarget
        && SCRIPT_TYPES.has(contractedTarget.type)
        && !this.visited.has(targetId)
        && !this.removedSet.has(targetId)
        && this.checkBorder(targetId, contractedTarget, 'ct_contraction').kind === 'in_border';
      if (!canAdmitCtContraction) {
        this.log('debug', `[Disposition] enqueue drop ${targetId} — out-of-scope target (priority=${priority}, not deferred) via focus=${this.currentFocusNodeId ?? this.originNodeId ?? '(none)'}`);
        return;
      }
      // A carrier is not a way around the stated border: the node behind it is judged on the same
      // axis the route path uses, and a breach becomes a lead rather than a silent admission.
      const contractionBreach = this.depthBorderBreach(targetId, depth);
      if (contractionBreach !== null) {
        const via = this.currentFocusNodeId ?? this.originNodeId;
        this.log(
          'debug',
          `[Depth] CT contraction deferred hop=${this.hopCount} id=${targetId} ← ${via ?? '(none)'} `
          + `depth=${contractionBreach} cap=up:${this.depthLimits.upstream}/down:${this.depthLimits.downstream}`,
        );
        if (via) this.recordContractedLead(targetId, via, question);
        return;
      }
      const admittedDepth = this.directedDepthFromOrigin(targetId)?.depth ?? depth;
      this.scopeNodeIds.add(targetId);
      // Bodied by construction (canAdmitCtContraction asserts SCRIPT_TYPES) — mirror supplementAgenda
      // so the bodied denominator stays source-measured, not stale on this admission path.
      this.bodiedScopeSize++;
      this.depthFromOrigin.set(targetId, admittedDepth);
      this.budgetExpansions.push({ nodeId: targetId, depth: admittedDepth, atHop: this.hopCount });
      this.log('debug', `[Depth] CT contraction add beyond initial scope id=${targetId} depth=${admittedDepth} hop=${this.hopCount}`);
    }
    if (this.visited.has(targetId) || this.removedSet.has(targetId)) {
      this.log('debug', `[Disposition] enqueue skip ${targetId} — already ${this.removedSet.has(targetId) ? 'removed' : 'visited'}`);
      return;
    }
    const node = this.nodeMap.get(targetId);
    if (!node) {
      this.log('debug', `[Disposition] enqueue drop ${targetId} — absent from the loaded graph model`);
      return;
    }

    // Empty set === no columns: normalize an explicit `[]` to omitted so a caller passing an empty
    // array in BB mode is not misread as "carries active columns" by the guard below.
    const filtered = columns?.filter(Boolean);
    const activeColumns = filtered && filtered.length ? filtered : undefined;
    if (this.mode.kind === 'bb' && activeColumns !== undefined) {
      throw new Error('BB agenda tasks must not carry active columns');
    }
    if (SCRIPT_TYPES.has(node.type)) {
      const task = this.ensureExecutableTask(targetId, question, priority, activeColumns, existingTaskId, parentTaskId);
      const alreadyQueued = this._agenda.has(targetId);
      // Bodied node — push directly (or merge into existing entry).
      this._agenda.push({ taskIds: [task.id], nodeId: targetId, priority, depth, activeColumns: this.agendaColumnsFor(activeColumns), ...(lineageQuestions?.length ? { lineageQuestions } : {}) });
      // Only grow the denominator if we expand beyond the approved scope or reactivate a cycle,
      // so that Y matches the approved scope "contract" for normal in-scope exploration.
      if (!alreadyQueued && (freshScopeExpansion || reactivated)) {
        this._totalNodes++;
        const agendaReason = freshScopeExpansion ? 'out-of-scope expansion' : 'reactivated';
        this.log('debug', `[Agenda] enqueue ${targetId} — ${agendaReason} (total +1 → ${this._totalNodes})`);
      }
      return;
    }

    // Non-bodied origins still get an agenda slot; middle non-bodied routes stay contracted.
    if (priority === 3) {
      const task = this.ensureExecutableTask(targetId, question, priority, activeColumns, existingTaskId, parentTaskId);
      // Agenda membership (not scope membership) is the correct "will this consume an uncounted
      // hop" oracle here: a non-bodied origin/supplement target may already be in scopeNodeIds
      // (contracted-through earlier) yet never have had its own agenda slot until now.
      const alreadyQueued = this._agenda.has(targetId);
      this._agenda.push({ taskIds: [task.id], nodeId: targetId, priority, depth, activeColumns: this.agendaColumnsFor(activeColumns), ...(lineageQuestions?.length ? { lineageQuestions } : {}) });
      if (!alreadyQueued && !SCRIPT_TYPES.has(node.type)) {
        this._totalNodes++;
        this.log('debug', `[Agenda] enqueue ${targetId} — non-bodied direct push (total +1 → ${this._totalNodes})`);
      }
      return;
    }

    // Non-bodied (table, external). Contract the edge: forward the authored
    // question to the target's bodied neighbors in the exploration direction.
    if (visitedRefs.has(targetId)) return;
    visitedRefs.add(targetId);
    // CT-only: `columns` here is resolved against the ORIGIN (seed) or an earlier carrier, never
    // against `targetId` itself — bound it to what this carrier actually declares before it can
    // reach a bodied neighbour. `agendaColumnsFor` runs first so an omitted `columns` is resolved
    // to the tracer's target set before the bound, not left to escape the bound as `undefined`.
    const ctCarried = this.mode.kind === 'ct'
      ? this.resolveActiveColumnsForNode(targetId, this.agendaColumnsFor(columns)) ?? []
      : undefined;
    if (ctCarried && ctCarried.length === 0) {
      // Carrier declares none of the forwarded columns: stop the contraction here instead of
      // dispatching a bodied neighbour with a column it cannot carry.
      this.log('debug', `[Disposition] enqueue drop ${targetId} — carrier declares none of the forwarded columns, contraction stops here`);
      const via = this.currentFocusNodeId ?? this.originNodeId ?? undefined;
      this.markNodeState(targetId, 'passthrough', 'engine', 'non_bodied_passthrough', {
        columns: ctCarried,
        viaNodeId: via,
        atHop: this.hopCount,
      });
      // The trace ends short here. Without a lead the truncation is invisible — the user sees a
      // chain that simply stops, with no record of which carrier broke it or why.
      if (via) this.recordContractedLead(targetId, via, question);
      return;
    }
    const carried = ctCarried ?? columns;
    this.markNodeState(targetId, 'passthrough', 'engine', 'non_bodied_passthrough', {
      columns: carried,
      viaNodeId: this.currentFocusNodeId ?? this.originNodeId ?? undefined,
      atHop: this.hopCount,
    });
    for (const nid of this.directionalNeighbors(targetId, this._direction)) {
      // Re-anchor only when the question lands on a bodied focus — further non-bodied hops forward
      // the plain question and annotate at their own bodied leaves (no compounding). The suffix
      // wording is prompt-layer-owned: buildPassthroughReAnchor (smPrompts.ts).
      const neighbor = this.nodeMap.get(nid);
      const reAnchor = neighbor && SCRIPT_TYPES.has(neighbor.type)
        ? buildPassthroughReAnchor(targetId, nid, this.mode.kind)
        : '';
      const forwarded = `${question}${reAnchor}`;
      this.enqueueHop(nid, forwarded, depth + 1, priority, { columns: carried, lineageQuestions, visitedRefs, parentTaskId, admitCtContractedBodiedTarget });
    }
  }

  /**
   * Projects the agenda entry's persisted `activeColumns` for one CT hop.
   *
   * @remarks
   * Mirrors {@link ensureExecutableTask}'s task-ledger fallback: when the caller omits columns
   * (e.g. `route_requests` with no `columns`), the agenda entry must still carry the tracer's
   * non-empty {@link ColumnTracer.targetColumns} so the CT checkpoint invariant in
   * `NavigationSnapshotSchema` (agenda entries require a defined `activeColumns` in CT mode) is
   * always satisfiable at {@link toJSON}. BB mode passes `activeColumns` through unchanged (always
   * `undefined` per the guard above).
   *
   * The fallback is copied, never handed out by reference: an agenda entry's `activeColumns` is
   * mutable per hop, and sharing the tracer's `target_columns` array would let one hop's edit
   * rewrite the frozen target set that the snapshot invariant compares against.
   */
  private agendaColumnsFor(activeColumns: string[] | undefined): string[] | undefined {
    if (this.mode.kind !== 'ct') return activeColumns;
    if (activeColumns?.length) return activeColumns;
    const fallback = this.tracer?.targetColumns;
    return fallback ? [...fallback] : undefined;
  }

  /** Creates the typed task attached to a concrete agenda hop. */
  private ensureExecutableTask(
    nodeId: string,
    question: string,
    priority: number,
    activeColumns: string[] | undefined,
    existingTaskId?: string,
    parentTaskId: string | undefined = this.currentFocusTaskIds[0],
  ): InvestigationTask {
    const existing = existingTaskId ? this.taskLedger.getTask(existingTaskId) : undefined;
    if (existing) return existing;
    if (this.mode.kind === 'ct') {
      const columns = activeColumns?.length ? activeColumns : this.tracer?.targetColumns;
      if (!columns?.length) throw new Error('CT agenda tasks require at least one active column');
      return this.taskLedger.ensureTask({
        kind: 'column_lineage',
        source: priority === 2 ? 'model' : 'engine',
        question,
        nodeId,
        parentTaskId,
        activeColumns: columns as [string, ...string[]],
        createdHop: this.hopCount,
      });
    }
    return this.taskLedger.ensureTask({
      kind: 'analytical',
      source: priority === 2 ? 'model' : 'engine',
      question,
      nodeId,
      parentTaskId,
      createdHop: this.hopCount,
    });
  }

  /**
   * Collects neighboring node attributes for evaluation during hop routing.
   *
   * @param focusId - Central node identifier to derive neighbor connections from.
   * @returns Array of metadata structures matching neighbor hop properties.
   */
  private buildNeighborList(focusId: string): HopNeighbor[] {
    const inSet = new Set(this.graph.inNeighbors(focusId));
    const outSet = new Set(this.graph.outNeighbors(focusId));
    const ids = Array.from(new Set([...inSet, ...outSet]));
    const hasSchemaFilter = this.sessionAllowedSchemas.size > 0;
    const edgeVerb = new Map<string, string>();
    for (const e of this.model.edges) {
      if (e.source !== focusId && e.target !== focusId) continue;
      const other = e.source === focusId ? e.target : e.source;
      const verb = edgeApiType(e.type, this.nodeMap.get(e.source)?.type ?? '');
      if (verb !== 'read' || !edgeVerb.has(other)) edgeVerb.set(other, verb);
    }
    return ids.map(nid => {
      const n = this.nodeMap.get(nid)!;
      const boundary = this.visited.has(nid) ? 'cycle' : 'none';
      // Column aspect active -> surface all available columns for the AI to choose from
      const cols = (this.tracer?.state ?? null)
        ? getNodeColumns(nid, this.nodeMap, this.store ?? undefined)?.map(c => c.name)
        : undefined;
      const neighbor: HopNeighbor = {
        id: nid, s: n.schema, n: n.name, t: n.type,
        edge_direction: inSet.has(nid) ? 'upstream' : 'downstream',
        edge_type: edgeVerb.get(nid) ?? 'read', boundary, ...(cols?.length ? { cols } : {}),
      };

      const d = this.depthFromOrigin.get(nid);
      if (d !== undefined) neighbor.depth_from_origin = d;
      neighbor.in_budget = this.scopeNodeIds.has(nid);

      // Both allowlist grants, so the flag agrees with the border test below: a node the user named
      // in a follow-up is inside the approved scope even though its schema is not.
      if (hasSchemaFilter) {
        neighbor.in_approved_scope = this.sessionAllowedSchemas.has(n.schema.toLowerCase())
          || this.sessionAllowedNodeIds.has(nid.toLowerCase());
      }

      // Display annotation: `display` tests type-exclusion + allowlist only (no direction / node /
      // schema exclusion). A type-hidden neighbor forces the scope flag false; either block arms the
      // action-required prompt. `out_of_allowlist` only fires when a schema filter is active.
      const displayBorder = this.checkBorder(nid, n, 'display');
      if (displayBorder.kind === 'excluded') {
        neighbor.in_approved_scope = false;
        neighbor.would_trigger_action_required = true;
      } else if (displayBorder.kind === 'out_of_allowlist') {
        neighbor.would_trigger_action_required = true;
      }
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

    // Result scope is the approved BFS scope in both modes. CT once rebuilt it from the tracer's
    // value-edge set, which deleted every dependency that carried no value into the traced column —
    // a filter, a grain setter, a sibling-column feed — after the AI had analyzed it and without a
    // prune. The tracer's edges drive emphasis and flow-role grouping; they never bound the answer.
    const reachableNodeIds = bfsReachable(this.graph, this.originNodeId!, this.removedSet, undefined, this.scopeNodeIds);
    const finalNodeIds = new Set<string>(reachableNodeIds);
    finalNodeIds.add(this.originNodeId!);

    // Conservation backstop: the render set is recomputed by reachability, which can disagree with
    // the disposition ledger. Under the invariants (prune never orphans a committed node) this delta
    // is empty; if it is not, an analyzed node's detail slot is about to be dropped from the render —
    // log it (never a silent filter) so the loss is visible instead of vanishing.
    const droppedSlots = mem.detail_slots.filter(slot => !finalNodeIds.has(slot.nodeId));
    if (droppedSlots.length > 0) {
      this.log('debug', `[Disposition] getResult drops ${droppedSlots.length} analyzed detail slot(s) unreachable from origin under removedSet/scope — ${trunc(droppedSlots.map(s => s.nodeId).join(', '), 200)} (conservation delta; expected empty)`);
    }

    const finalEdges: Array<[string, string, string]> = [];
    for (const e of this.model.edges) {
      if (finalNodeIds.has(e.source) && finalNodeIds.has(e.target)) {
        finalEdges.push([e.source, e.target, edgeApiType(e.type, this.nodeMap.get(e.source)?.type ?? '')]);
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
        return { id: n.id, s: n.schema, n: n.name, t: n.type };
      }),
      edges: finalEdges,
      suggested_sections: sections,
      detail_slots: mem.detail_slots.filter(slot => finalNodeIds.has(slot.nodeId)),
      node_states: Array.from(this.nodeStates.values()),
      columnAspect: this.tracer?.state ?? null,
      // CT focus nodes the AI pruned (verdict=prune -> no column flow).
      ...(this.mode.kind === 'ct' && this.tracer ? { ctPrunedNodeIds: Array.from(this.ctPrunedFocusIds) } : {}),
    };
  }

  /**
   * Emits the serializable active map state used by diagnostics and checkpoint assembly.
   *
   * @returns Plain object suitable for JSON output routines.
   */
  public toJSON(): SmState {
    const snapshot: SmState = {
      snapshotVersion: 1,
      columnAspect: this.tracer?.state ?? null,
      status: this._status,
      hopCount: this.hopCount,
      scopeSize: this.scopeNodeIds.size,
      scopeNodeIds: Array.from(this.scopeNodeIds),
      visited: Array.from(this.visited),
      removedSet: Array.from(this.removedSet),
      nodeStates: Array.from(this.nodeStates.values()),
      agendaSize: this._agenda.length,
      agenda: this._agenda.entries.map(cloneAgendaEntry),
      currentFocusNodeId: this.currentFocusNodeId,
      memory: this.memory.toJSON(),
      engineInternals: this.serializeInternals(),
      ...(this.mode.kind === 'ct' && this.tracer ? {
        // The in-flight hop's own questions (set from its AgendaEntry at dispatch), not a fresh
        // recompute against `currentFocusNodeId` — that would describe the just-committed hop,
        // not the one a mid-hop resume needs to keep showing.
        lineageQuestionsLastHop: [...this._pendingLineageQuestions],
        ctPrunedNodeIds: Array.from(this.ctPrunedFocusIds),
      } : {}),
    };
    try {
      return parseNavigationSnapshot(snapshot);
    } catch (err) {
      // The engine's own state must always satisfy the strict checkpoint boundary; a rejection
      // here is an internal invariant violation, not model/user behavior — the LogFn contract has
      // no `error` level, so `warn` is the closest available severity. issuePaths only (no
      // checkpoint values) so the line stays safe to persist.
      if (err instanceof InvalidEngineCheckpointError) {
        this.log('error', `[Checkpoint] serialize rejected — paths=${trunc(err.diagnostic, LOG_TRUNC_CONTENT)}`, err);
      }
      throw err;
    }
  }

  /**
   * Flattens the engine's private working state into a serializable projection.
   *
   * @remarks
   * The companion to {@link toJSON}'s top-level fields: the private state required by the strict
   * current-format checkpoint. Maps and sets are flattened to arrays for the JSON boundary.
   */
  private serializeInternals(): EngineInternalsSnapshot {
    return {
      originNodeId: this.originNodeId,
      direction: this._direction,
      depthBudget: this.depthBudget,
      depthEnforcement: this.depthEnforcement,
      depthLimits: {
        upstream: Number.isFinite(this.depthLimits.upstream) ? this.depthLimits.upstream : null,
        downstream: Number.isFinite(this.depthLimits.downstream) ? this.depthLimits.downstream : null,
      },
      depthFromOrigin: Array.from(this.depthFromOrigin.entries()),
      extendedDepthCap: this.extendedDepthCap,
      budgetExpansions: this.budgetExpansions.map(b => ({ ...b })),
      bodiedScopeSize: this._bodiedScopeSize,
      totalNodes: this._totalNodes,
      userSchemas: Array.from(this.userSchemas),
      sessionAllowedSchemas: Array.from(this.sessionAllowedSchemas),
      sessionAllowedNodeIds: Array.from(this.sessionAllowedNodeIds),
      excludedTypes: Array.from(this.excludedTypes),
      excludedSchemas: Array.from(this.excludedSchemas),
      excludedNodeIds: Array.from(this.excludedNodeIds),
      guiHiddenTypes: Array.from(this.guiHiddenTypes),
      passNodeIds: Array.from(this.passNodeIds),
      currentFocusQuestion: this.currentFocusQuestion,
      currentFocusTaskIds: [...this.currentFocusTaskIds],
      lastCurrentTask: this._lastCurrentTask,
      discoverySummary: this._discoverySummary,
      archiveChars: this.archiveChars,
      lastHopDetailChars: this.lastHopDetailChars,
      lastHopSummaryChars: this.lastHopSummaryChars,
      lastHopVerdict: this.lastHopVerdict,
      lastHopColumnFlowEntries: this.lastHopColumnFlowEntries,
      lastRoutedNew: this.lastRoutedNew,
      lastRoutedRejected: this.lastRoutedRejected,
      lastRoutedDeferred: this.lastRoutedDeferred,
      investigationTasks: this.taskLedger.investigationTasks.map(task => ({ ...task })),
      pendingLeads: this.taskLedger.pendingLeads.map(lead => ({ ...lead })),
      initSnapshot: this.initSnapshot,
    };
  }

  /**
   * Rehydrates a {@link NavigationEngine} from a validated current-format snapshot onto fresh
   * runtime handles.
   *
   * @remarks
   * The runtime handles (`model` / `graph` / `log` / `store`) are rebuilt by the caller from
   * the loaded model and the per-window logger — they are deliberately not serialized. Restore
   * overlays only a snapshot accepted by the strict checkpoint boundary; it does not infer omitted
   * task, agenda, memory, or engine state from older telemetry projections.
   *
   * @param rawSnapshot - Current-format checkpoint payload validated before reconstruction.
   * @param model - The loaded database model (same topology the snapshot was taken against).
   * @param graph - A fresh `graphology` instance for the model.
   * @param log - The host logger.
   * @param config - Restore-time config; `activeFilter` is overridden by the snapshot's
   *   allowlists, so callers normally pass `{}`.
   * @param store - Optional column store.
   * @returns A new engine carrying the restored state.
   */
  public static fromJSON(
    rawSnapshot: unknown,
    model: DatabaseModel,
    graph: Graph,
    log: LogFn,
    config: { activeFilter?: SerializedFilterState | null } = {},
    store?: ColumnStore | null,
  ): NavigationEngine {
    const snapshot = parseNavigationSnapshot(rawSnapshot);
    const internals = snapshot.engineInternals;

    const engine = new NavigationEngine(
      model,
      graph,
      log,
      { activeFilter: config.activeFilter ?? null, memory: AiMemoryManager.fromJSON(snapshot.memory) },
      store,
    );

    // ── Top-level lifecycle / scope / agenda state ──
    engine._status = snapshot.status;
    if (snapshot.columnAspect) {
        engine.tracer = new ColumnTracer(snapshot.columnAspect.target_columns, snapshot.columnAspect);
        engine.mode = { kind: 'ct' };
      }
    engine.taskLedger.restore(internals.investigationTasks, internals.pendingLeads);
    engine.hopCount = snapshot.hopCount;
    engine.scopeNodeIds = new Set(snapshot.scopeNodeIds);
    engine.visited = new Set(snapshot.visited);
    engine.removedSet = new Set(snapshot.removedSet);
    engine.nodeStates = new Map(snapshot.nodeStates.map(s => [s.nodeId, s]));
    engine.currentFocusNodeId = snapshot.currentFocusNodeId;
    for (const entry of snapshot.agenda) engine._agenda.push(cloneAgendaEntry(entry));

    // ── Private working-state projection ──
    engine.originNodeId = internals.originNodeId;
    engine._direction = internals.direction;
    engine.depthBudget = internals.depthBudget;
    if (internals.depthLimits) {
      // A border the user stated outlives the resume it was approved in.
      engine.depthLimits = {
        upstream: internals.depthLimits.upstream ?? Number.POSITIVE_INFINITY,
        downstream: internals.depthLimits.downstream ?? Number.POSITIVE_INFINITY,
      };
      engine.depthEnforcement = internals.depthEnforcement;
      log('debug', `[Depth] restored border enforcement=${internals.depthEnforcement} cap=up:${engine.depthLimits.upstream}/down:${engine.depthLimits.downstream}`);
    } else {
      if (internals.depthEnforcement !== 'silent' || internals.extendedDepthCap !== 0) {
        log('debug', `[Depth] normalized legacy checkpoint authority enforcement=${internals.depthEnforcement} extension=${internals.extendedDepthCap} to seed-only routing`);
      }
      engine.depthEnforcement = 'silent';
    }
    engine.depthFromOrigin = new Map(internals.depthFromOrigin);
    engine.extendedDepthCap = 0;
    engine.budgetExpansions = internals.budgetExpansions.map(b => ({ ...b }));
    engine._bodiedScopeSize = internals.bodiedScopeSize;
    engine._totalNodes = internals.totalNodes;
    engine.userSchemas = new Set(internals.userSchemas);
    engine.sessionAllowedSchemas = new Set(internals.sessionAllowedSchemas);
    engine.sessionAllowedNodeIds = new Set(internals.sessionAllowedNodeIds ?? []);
    engine.excludedTypes = new Set(internals.excludedTypes);
    engine.excludedSchemas = new Set(internals.excludedSchemas);
    engine.excludedNodeIds = new Set(internals.excludedNodeIds);
    engine.guiHiddenTypes = new Set(internals.guiHiddenTypes);
    engine.passNodeIds = new Set(internals.passNodeIds);
    engine.currentFocusQuestion = internals.currentFocusQuestion;
    engine.currentFocusTaskIds = [...internals.currentFocusTaskIds];
    engine._lastCurrentTask = internals.lastCurrentTask;
    engine._discoverySummary = internals.discoverySummary;
    engine.archiveChars = internals.archiveChars;
    engine.lastHopDetailChars = internals.lastHopDetailChars;
    engine.lastHopSummaryChars = internals.lastHopSummaryChars;
    engine.lastHopVerdict = internals.lastHopVerdict;
    engine.lastHopColumnFlowEntries = internals.lastHopColumnFlowEntries;
    engine.lastRoutedNew = internals.lastRoutedNew;
    engine.lastRoutedRejected = internals.lastRoutedRejected;
    engine.lastRoutedDeferred = internals.lastRoutedDeferred;
    engine.initSnapshot = internals.initSnapshot;
    // CT continuation state lives at the top level, not in engineInternals; without it a resumed
    // session re-dispatches focus nodes the AI already pruned and drops the pending sub-questions.
    engine._pendingLineageQuestions = [...(snapshot.lineageQuestionsLastHop ?? [])];
    engine.ctPrunedFocusIds = new Set(snapshot.ctPrunedNodeIds ?? []);

    return engine;
  }
}
