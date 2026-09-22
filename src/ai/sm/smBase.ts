import { columnCarryFromRoute, DEFAULT_SM_START_DEPTH, EngineAspectMode, InvalidRoute, type DepthIntent } from './smTypes';
import { buildSubmissionRejection, isAbsentKind, ROUTE_REJECTION_DIRECTIVE, type SubmissionFaults } from './smRouteValidation';
import { computeUnaccounted } from './smCompleteness';
import { checkActiveScopeAdmission, DEFAULT_TURN_TOKEN_BUDGET, type TurnTokenBudget } from '../support/tokenBudget';
import { COLUMN_FLOW_NOTE_MAX, SUBMIT_FINDINGS_BADGE_LABEL_MAX } from '../tools/toolSchemas';

import type Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path/unweighted';
import { bfsFromNode } from 'graphology-traversal';
import type { DatabaseModel, LineageNode } from '../../engine/types';
import type { ColumnStore } from '../../engine/columnStore';
import { ASYMMETRIC_DEPTH_REQUIRES_BIDIRECTIONAL } from '../../engine/shared/explorationDepthContract';
import type { SerializedFilterState } from '../../engine/projectStore';
import { buildEdgeTypeMap, buildHopFocusNode } from '../tools/tools';
import { buildNodeMap, getNodeColumns, getNodeDdl, SCRIPT_TYPES } from '../support/graphUtils';
import { buildPassthroughReAnchor } from '../prompting/smPrompts';
import { edgeApiType } from '../support/aiPresenter';
import { bfsDepthMap, firstDisconnectedRequiredNode, bfsReachable, type LogFn } from '../../engine/graphGuards';
import { trunc, LOG_TRUNC_CONTENT } from '../../utils/log';
import { normalizeColName, splitSqlName, stripBrackets } from '../../utils/sql';
import { AiMemoryManager, appendUniqueSectionText, type DetailSlot, type WorkingMemory } from '../session/memoryManager';
import type { ClassificationValue } from '../session/classification';
import { RepairDraftStore } from '../support/repairDraftStore';
import { resolveModelNodeId } from '../support/inputNormalization';
import { evaluateCurrentHopActionPolicy } from './currentHopActionPolicy';
import type { ApprovedBorder, ColumnAspect, ColumnEdge, DeferredQuestion, DiagnosticsSnapshot, EngineInitSnapshot, EngineInternalsSnapshot, HopContext, HopNeighbor, HopProgress, HopSubmission, InvestigationTask, NavigationInitParams, PendingLead, RouteOutcome, ScopeSummary, ScopeSummaryLeaf, ColumnCarry, RouteColumns, SmNodeAction, SmNodeColumnRole, SmNodeState, SmNodeStateReason, SmNodeStateSource, SmResult, SmState, SmStatus, SubmitResult, SupplementChain, SupplementSkip } from '../sm/smTypes';
import { estimateTokens } from '../support/tokenBudget';
import { ColumnTracer } from "./columnTracer";
import { AgendaManager, type AgendaEntry } from './agendaManager';
import { TaskLedger, type InvestigationTaskInput } from './taskLedger';
import { parseNavigationSnapshot, InvalidEngineCheckpointError } from './navigationSnapshotSchema';
import { REJECTION_CODES } from '../support/rejectionCodes';

/**
 * A hop neighbour plus the engine decisions already taken about it.
 *
 * @remarks
 * A neighbour named in an accepted route or `column_flow` entry is prune-refused for the rest of
 * the run ({@link declaredRouteIds}); disclosing that lock here stops a hop proposing a prune the
 * engine will refuse anyway.
 */
export interface HopNeighborDisclosure extends HopNeighbor {
  /** Named in an accepted route or `column_flow`, so a prune of it is permanently refused. */
  prune_protected?: boolean;
  /** Already analyzed on an earlier hop; a prune cannot remove committed analysis. */
  already_visited?: boolean;
  /** Already pruned on an earlier hop; a removed node stays removed. */
  already_removed?: boolean;
  /** Columns a committed `column_flow` edge already attributes to this neighbour, CT only — a stated `columns: 'none'` contradicts this set rather than narrowing it. */
  attributed_columns?: string[];
}

/** Extends the base working memory with a snapshot of the traversal map (visited/current/agenda) that grounds the AI's routing decisions. */
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
  /** Contract the currently dispatched hop runs under — `bb` on a CT-run branch carrying none of the traced columns; see {@link NavigationEngine.currentHopAnalysisMode}. */
  readonly currentHopAnalysisMode: 'bb' | 'ct';
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

  /** Current hop context for the engine. */
  getHopContext(): HopContext;

  /**
   * Submits the findings for the current step and calculates the next state.
   *
   * @param budget - The submitting turn's budget, which the active-scope admission guard is
   *   measured against.
   */
  submitFindings(params: HopSubmission, budget?: TurnTokenBudget): SubmitResult;

  /** Final result of the exploration session. */
  getResult(): SmResult;

  /** Serializes the current state machine data to JSON. */
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
   * Only callable when `status === 'complete'` and at least one bodied id is supplied; the engine
   * re-enters `awaiting_findings` and merges new `DetailSlot` entries without resetting prior
   * analysis.
   *
   * @param nodeIds - Ids to append to the agenda. Non-bodied (table, external) ids follow the
   *   bipartite contraction rule (`enqueueHop`), forwarding the question to bodied neighbors
   *   instead of landing on the agenda themselves. Ids outside the graph are dropped.
   * @param leadIds - Host-selected pending lead identifiers to schedule.
   * @returns Counts agendaed, contracted, or skipped (unknown / duplicate), plus `skippedDetails`
   *   naming which id was dropped and why.
   */
  supplementAgenda(nodeIds: string[], leadIds?: string[], chain?: SupplementChain): { ok: true; agendaed: number; contracted: number; skipped: number; skippedDetails: SupplementSkip[] } | { error: string; hint?: string };
}

/**
 * The write path a border test serves. Each purpose fixes which of the three axes
 * (exclusion sets, approved-direction reachability, schema allowlist) participate — so
 * every call site consults an identical, self-documenting axis profile.
 *
 * @remarks
 * Axis profile per purpose: `route`/`contraction` = exclusions + direction + allowlist;
 * `supplement` = exclusions + allowlist (direction not re-tested for an already-surfaced lead);
 * `seed_bfs` = exclusions only, allowlist deliberately skipped so unlisted reachables survive to
 * become `schema:` gate classes; `display` = allowlist + type exclusions, advisory only.
 */
type BorderPurpose = 'route' | 'contraction' | 'supplement' | 'seed_bfs' | 'display';

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

/**
 * Combined border + depth admission test for one route candidate. A record, not a boolean: the two
 * axes are reported to the model differently (schema gate name vs level count), so callers that
 * need the distinction read the axes while the completeness guard reads only `admitted`.
 */
type RouteAdmission = {
  /** First failing border axis, or `in_border`. */
  border: BorderVerdict;
  /** Breaching depth when a depth ceiling the user fixed is crossed, otherwise `null`. */
  depthBreach: number | null;
  /** Depth the candidate was judged at — the number a deferred lead quotes. */
  candidateDepth: number;
  /** True only when both axes clear: the router would accept a route to this node now. */
  admitted: boolean;
};

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
    ...(entry.activeColumns ? { activeColumns: [...entry.activeColumns] } : {}),
    ...(entry.columnCarry
      ? { columnCarry: entry.columnCarry.kind === 'carry' ? { kind: 'carry' as const, columns: [...entry.columnCarry.columns] } : entry.columnCarry }
      : {}),
    ...(entry.lineageQuestions ? { lineageQuestions: [...entry.lineageQuestions] } : {}),
  };
}

/**
 * Unified Navigation Engine — the core state machine for all exploration modes.
 *
 * @remarks
 * Map & Router: the engine owns the topological map (visited/current/agenda); the AI acts as
 * router, proposing hops the engine validates before advancing.
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
   * Set by the caller after construction, like {@link sessionId} — not a constructor param, and
   * excluded from {@link toJSON}'s checkpoint; the caller re-applies it from
   * `AiSession.classification` (the single source of truth) on restore.
   */
  public classification?: ClassificationValue;
  /** The operational status of the state machine. */
  protected _status: SmStatus = 'created';
  /**
   * Name of the active mode, read only by label/prompt-argument sites. No behaviour is gated on it
   * — {@link tracer} is the predicate every branch reads, and both are written together at every
   * assignment site so they always agree.
   */
  protected mode: EngineAspectMode = { kind: 'bb' };
  /** The column aspect CT adds to the BB spine, `null` in BB. Its presence *is* CT mode. */
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
  /**
   * Neighbour ids an accepted `route_requests` entry declared part of the traced path, plus — in
   * CT — the nodes a `column_flow` entry names for a traced column.
   *
   * @remarks
   * A non-bodied target is contracted by the bipartite agenda rule ({@link enqueueHop}) and gets no
   * agenda entry or detail slot, so this set is the backend's own record of the declaration —
   * consulted by {@link committedConnectedIds} and by `submitFindings`'s `prune_neighbors` admission.
   */
  protected declaredRouteIds = new Set<string>();
  /**
   * Nodes the last {@link getResult} removed from the render as undispositioned sinks, surfaced as
   * `renderDroppedNodeIds` so the render states its own disposition explicitly.
   */
  protected renderDroppedIds = new Set<string>();
  /** Engine-owned lifecycle state for nodes; detail slots are content storage only. */
  protected nodeStates = new Map<string, SmNodeState>();
  /** List representing the current navigation agenda. */
  protected _agenda = new AgendaManager();
  /** Structured source of truth for questions and follow-up leads. */
  private readonly taskLedger = new TaskLedger();
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
   * Both sides are kept because a border can be asymmetric — collapsing to one number would judge a
   * node against the ceiling the user did not set for that path. Absent when no directed path reaches that side.
   */
  private directedDepths = new Map<string, { upstream?: number; downstream?: number }>();
  /** Whether {@link directedDepths} holds the current seed's walk; false until the next fill. */
  private directedDepthsFilled = false;
  /** History of explicit AI expansions beyond the initial BFS seed. */
  protected budgetExpansions: Array<{ nodeId: string; depth: number; atHop: number }> = [];

  /**
   * Submission held only after a field-scoped failure a retry can correct without re-authoring the
   * analysis — route/column incompleteness, or a field over its length cap — so a retry with empty
   * sections can reuse already-valid authored prose. Other validation failures never establish held
   * state.
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
   * siblings. Grows only through {@link admitSupplementTargets}.
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
   * Compressed AI-composed memo of the discovery walk's findings + user-stated semantic
   * constraints, composed once after gate approval and rendered into every hop's stable prefix as
   * `<discovery_summary>` (alongside `<mission_brief>` and the sliding `<short_term_memory>`).
   *
   * @remarks
   * Captures user-stated intent that cannot be expressed in the structural approval fields (e.g.
   * "ignore audit-related processing"), so it rides with the AI across hops even past a mid-walk
   * node that wasn't pre-listable. Never wiped by sliding-memory rotations. Read via {@link getDiscoverySummary}.
   */
  protected _discoverySummary: string | null = null;
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

    // GUI-hidden types captured for diagnostics only (BFS log shows honored/ignored).
    const ALL_OBJECT_TYPES = ['table', 'view', 'procedure', 'function', 'external'] as const;
    const guiActiveTypes = config.activeFilter?.types?.map(t => t.toLowerCase()) ?? [];
    if (guiActiveTypes.length > 0) {
      this.guiHiddenTypes = new Set(ALL_OBJECT_TYPES.filter(t => !guiActiveTypes.includes(t)));
    }
  }

  /** Publishes this validated engine's memory while preserving the session memory object identity. */
  public publishMemoryTo(target: AiMemoryManager): void {
    target.restoreFromJSON(this.memory.toJSON());
    this.memory = target;
  }

  /** Enforced depth ceiling published as `approved_border.depth_cap`; `null` while the seed stays growable. */
  protected computeDepthCap(): number | null {
    return this.depthEnforcement === 'strict' ? this.depthBudget : null;
  }

  /** Extends the session schema allowlist (case-insensitive) after the user confirms an out-of-filter route. */
  public extendAllowedSchemas(schema: string): void {
    this.sessionAllowedSchemas.add(schema.toLowerCase());
  }

  /**
   * Canonical focus id of a currently-held finding, or `null` when none is held.
   *
   * @remarks
   * Non-null means the prior `submit_findings` failed only on a field-scoped, correctable defect.
   */
  public get heldFindingFocus(): string | null {
    const held = this.heldFindingDraft.get();
    if (!held) return null;
    return resolveModelNodeId(held.focus_node_id, this.nodeMap)
      ?? held.focus_node_id.toLowerCase()
      ?? null;
  }

  /**
   * Restores held prose only when a correction retry keeps the focus and sends no sections.
   * A retry with authored sections is a deliberate replacement and remains unchanged.
   */
  public applyHeldContent(incoming: HopSubmission): HopSubmission {
    const held = this.heldFindingDraft.get();
    if (!held) return incoming;
    const heldFocus = resolveModelNodeId(held.focus_node_id, this.nodeMap) ?? held.focus_node_id.toLowerCase();
    const inFocus = resolveModelNodeId(incoming.focus_node_id, this.nodeMap) ?? incoming.focus_node_id.toLowerCase();
    if (heldFocus !== inFocus || inFocus !== this.currentFocusNodeId) return incoming;
    if (incoming.sections.length > 0) return incoming;
    // Prose only — `verdict`/`badge_label` are decisions the retry may legitimately change.
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
   * Deduplicates on `(nodeId, fromFocusNodeId)`: a later deferral for the same pair replaces the
   * earlier one. Also records a rejection in memory so `recent_rejections` reflects the same event.
   */
  protected deferQuestion(entry: DeferredQuestion): void {
    this.recordPendingLead(entry);
    this.memory.recordRejection(entry.nodeId, `deferred: out of approved scope (${entry.reason})`, entry.atHop);
  }

  /**
   * Records the structured task and lead corresponding to an accepted scope-boundary deferral.
   *
   * @remarks
   * `'schema_and_depth'` reports as `'schema_boundary'` (the stricter gate); the breaching depth
   * still rides the lead's own `depth` field. The lead reason is not widened to a composite member
   * because `PendingLead['reason']` is a persisted `z.enum` and a new member breaks older readers.
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

  /**
   * Applies the mode's task shape to one set of common task fields.
   *
   * @remarks
   * The single home for the CT/BB task fork: a CT task is `column_lineage` carrying the columns the
   * hop tracks, a BB task is the plain kind with no column state.
   *
   * @param preferredColumns - Columns this task tracks; the target set is used when empty.
   * @throws When column tracing is active but no column can be attributed to the task.
   */
  private taskInputFor(
    common: Omit<InvestigationTaskInput, 'kind' | 'activeColumns'>,
    bbKind: 'root' | 'analytical',
    preferredColumns: readonly string[] | undefined,
  ): InvestigationTaskInput {
    if (!this.tracer) return { ...common, kind: bbKind };
    const columns = preferredColumns?.length ? preferredColumns : this.tracer.targetColumns;
    if (!columns?.length) throw new Error('CT tasks require at least one active column');
    return { ...common, kind: 'column_lineage', activeColumns: [...columns] as [string, ...string[]] };
  }

  /** Creates a structurally mode-valid deferred task without changing agenda state. */
  private ensureDeferredTask(nodeId: string, question: string, createdHop: number): InvestigationTask {
    return this.taskLedger.ensureTask(this.taskInputFor({
      source: 'model',
      question,
      nodeId,
      parentTaskId: this.currentFocusTaskIds[0],
      status: 'deferred',
      createdHop,
    }, 'analytical', this.tracer?.activeColumns));
  }

  /** Completes executable tasks and resolves any scheduled follow-up leads they own. */
  private completeTasks(taskIds: ReadonlyArray<string>): void {
    for (const taskId of taskIds) {
      this.taskLedger.setTaskStatus(taskId, 'resolved', this.hopCount);
      this.taskLedger.resolveTaskLeads(taskId);
      const nodeId = this.taskLedger.getTask(taskId)?.nodeId;
      if (nodeId) this.taskLedger.resolveNodeLeads(nodeId, this.hopCount);
    }
  }

  /**
   * Records the process lifecycle state for a node.
   *
   * @remarks
   * Source of truth for whether a node was analyzed, passed through, or pruned (`DetailSlot`
   * remains only the text bucket). Stronger terminal states replace weaker ones, so an
   * AI-analyzed node is not later downgraded by an incidental pass-through observation.
   */
  private markNodeState(
    nodeId: string,
    action: SmNodeAction,
    source: SmNodeStateSource,
    reason: SmNodeStateReason,
    meta: { columns?: string[]; columnRole?: SmNodeColumnRole; viaNodeId?: string; atHop?: number } = {},
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
    // Role reflects the latest observed hop, independent of the action-rank merge below.
    const columnRole = meta.columnRole ?? existing?.columnRole;
    if (existing && rank(existing.action) > rank(action)) {
      this.nodeStates.set(id, {
        ...existing,
        columns: mergedColumns.length > 0 ? mergedColumns : existing.columns,
        ...(columnRole ? { columnRole } : {}),
      });
      return;
    }

    this.nodeStates.set(id, {
      nodeId: id,
      action,
      source,
      reason,
      ...(mergedColumns.length > 0 ? { columns: mergedColumns } : {}),
      ...(columnRole ? { columnRole } : {}),
      ...(meta.viaNodeId ? { viaNodeId: meta.viaNodeId } : existing?.viaNodeId ? { viaNodeId: existing.viaNodeId } : {}),
      ...(typeof meta.atHop === 'number' ? { atHop: meta.atHop } : existing?.atHop !== undefined ? { atHop: existing.atHop } : {}),
    });
  }

  /**
   * Emits a session-end diagnostic summarizing badge_label diversity across analyzed verdicts. Low
   * diversity indicates the AI is not distinguishing functional roles, so the final view won't
   * group variants usefully.
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

  /** Per-hop diagnostic snapshot for structured logging and AI-visible fields — safe to log. */
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
      ...(this.tracer ? {
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
   * Diagnostics accessor for telemetry / eval extraction. Distinct from
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
   * An object id adopted as a tracked column locks an unwinnable CT session (every real column
   * submitted is rejected `out_col_not_on_node`). Detection is exact: {@link resolveModelNodeId}
   * only matches schema-qualified two-part spellings, so bare/three-part column names never false-match.
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
   * Refuses target entries that resolve to node ids — the engine never adopts an object reference
   * as a column. Side-effect-free on reject: tracer and mode stay untouched, so a rejected
   * follow-up leaves the completed session unchanged.
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
    if (nodeColumns.length === 0) {
      // No declared surface: apply the same last-segment rule as the declared branch below, one spelling only.
      const bare: string[] = [];
      const seen = new Set<string>();
      for (const requested of columns) {
        const name = stripBrackets(splitSqlName(requested).pop() ?? requested).trim();
        const key = normalizeColName(name);
        if (name.length === 0 || seen.has(key)) continue;
        seen.add(key);
        bare.push(name);
      }
      return bare;
    }
    const byNorm = new Map<string, string>(nodeColumns.map((c) => [normalizeColName(c.name), c.name]));
    const resolved: string[] = [];
    for (const requested of columns) {
      // Resolve by exact name then last dot-segment, returning the DECLARED name for canonical comparison.
      const exact = byNorm.get(normalizeColName(requested));
      const lastSegment = requested.split('.').pop() ?? requested;
      const suffix = exact === undefined ? byNorm.get(normalizeColName(lastSegment)) : undefined;
      const match = exact ?? suffix;
      if (match !== undefined && !resolved.includes(match)) resolved.push(match);
    }
    return resolved;
  }


  /** Returns the column-trace side; a bidirectional session traces columns upstream. */
  private columnTraceDirection(): 'upstream' | 'downstream' {
    return this.effectiveDirection() === 'downstream' ? 'downstream' : 'upstream';
  }

  /**
   * Collapses `this._direction` plus an asymmetric depth's per-side `0` into the single traversal
   * direction actually approved for later hop growth.
   *
   * @remarks
   * Only narrows a `'bidirectional'` session — a fixed direction already fully restricts. An
   * asymmetric side of exactly `0` is a permanent exclusion of that direction (not just the initial
   * seed); both sides `0` cannot reach here (rejected at the Zod boundary before `init()`).
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
   * The lineage question is directional: an undirected shortest path can route around through a
   * shared sink (e.g. an audit table every procedure writes to) and report a node as nearer than it
   * is. `null` when no directed path exists either side; callers fall back to a hop-relative estimate.
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

  /** Per-side directed distances from the origin to `targetId`, or `undefined` when unreachable. */
  private directedDepthsFor(targetId: string): { upstream?: number; downstream?: number } | undefined {
    if (!this.originNodeId) return undefined;
    this.ensureDirectedDepths();
    return this.directedDepths.get(targetId);
  }

  /**
   * Fills {@link directedDepths} with one walk per side, unless the current seed already filled it.
   *
   * @remarks
   * Two traversals answer every node's distance, fixing the cost of enforcing a border per scope
   * seed rather than per candidate. The first depth recorded for a node is its shortest on that
   * side — breadth-first order guarantees it.
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
   * Only true under `'strict'` enforcement (the AI reported an explicit level count). A node is
   * inside the border when EITHER side's distance fits that side's own ceiling — judging it on the
   * other side's ceiling would refuse requested work; a breach reports the smallest resolved distance.
   *
   * @param fallbackDepth - Hop-relative depth to judge by when no directed path resolves.
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
    // Without a resolved side, judge against the tighter ceiling — an unestablished side must not bypass a fixed border.
    const limit = Math.min(this.depthLimits.upstream, this.depthLimits.downstream);
    return fallbackDepth > limit ? fallbackDepth : null;
  }

  /**
   * True when a route target is reachable from the origin within the approved traversal direction.
   *
   * @remarks
   * `'bidirectional'` is the upstream closure plus downstream closure, never the undirected walk —
   * a node reached only by crossing sideways through a shared consumer is not an approved-direction
   * target. {@link directedDepthsFor} is shared with {@link depthBorderBreach} so both axes agree.
   */
  private isReachableInApprovedDirection(targetId: string): boolean {
    const direction = this.effectiveDirection();
    if (!this.originNodeId) return true;
    if (targetId === this.originNodeId) return true;
    if (direction === 'bidirectional') return this.directedDepthsFor(targetId) !== undefined;
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
   * Consolidates the exclusion-set / direction / schema-allowlist checks every write path shares,
   * axes selected by `purpose` ({@link BorderPurpose}), check order fixed (exclusions → direction →
   * allowlist).
   *
   * @param purpose - Which write path is asking, fixing the participating axes.
   */
  private checkBorder(nodeId: string, node: LineageNode, purpose: BorderPurpose): BorderVerdict {
    // Only the display annotation ignores schema/node exclusions (it flags type-hidden neighbors only).
    const excludeAllSets = purpose !== 'display';
    const checkDirection = purpose === 'route' || purpose === 'contraction';
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

  /**
   * Whether the router would admit a route to `nodeId` right now — border **and** depth.
   *
   * @remarks
   * {@link checkBorder} owns only the border axis; a candidate inside the border but past a fixed
   * depth ceiling still clears it and is deferred as a lead rather than accepted. This is the single
   * statement of both axes so the route path and {@link requiredNeighborIds} cannot drift on either.
   *
   * @param focusId - Hop the route is issued from, supplying the hop-relative depth fallback when
   *   no directed path from the origin resolves.
   */
  private admitsRoute(nodeId: string, node: LineageNode, focusId: string): RouteAdmission {
    const border = this.checkBorder(nodeId, node, 'route');
    let candidateDepth = this.depthFromOrigin.get(nodeId) ?? this.directedDepthFromOrigin(nodeId)?.depth;
    if (candidateDepth === undefined) {
      candidateDepth = (this.depthFromOrigin.get(focusId) ?? 0) + 1;
    }
    const depthBreach = this.depthBorderBreach(nodeId, candidateDepth);
    return {
      border,
      depthBreach,
      candidateDepth,
      admitted: border.kind === 'in_border' && depthBreach === null,
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

  /** Gets live hop progress: completed AI hops, queued nodes, display-safe total work, cumulative prunes, and the last hop's newly-routed (added) count. */
  public get hopProgress(): HopProgress {
    // Every prune path marks node-state 'prune', the single source for the cumulative tally.
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
    return this.initSnapshot?.analysisMode ?? this.mode.kind;
  }

  /**
   * The analysis mode of the hop currently dispatched — the contract selector for this hop alone.
   *
   * @remarks
   * Unlike the session-level {@link currentAnalysisMode} (locked at `init`), this varies per hop,
   * even per edge: a CT hop reaching a branch with no columns to map dispatches as BB rather than
   * demand a `column_flow` account it cannot give. Column state selects the contract, never the AI's prune/keep verdict.
   */
  public get currentHopAnalysisMode(): 'bb' | 'ct' {
    return this.hopModeFromColumnList(this.tracer?.activeColumns);
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
      columnAspectActive: this.tracer !== null,
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
   * A node is **prunable** when removing it from {@link scopeNodeIds} leaves every other in-scope
   * node still reachable from {@link originNodeId} along the active direction. Otherwise it is
   * **must-pass** — pruning would orphan in-scope descendants the user did not ask to remove.
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
   * Pruning verification only inspects **direct neighbors of the current focus node that are also
   * within the active BFS scope** — this keeps the tool from becoming a backdoor for out-of-scope
   * exploration. Returns the "invalid" subset; empty array iff all pass.
   */
  public validateNeighborIds(ids: string[]): string[] {
    const focusId = this.currentFocusNodeId ?? '';
    const neighborIndex = this.model.neighborIndex[focusId] ?? { in: [], out: [] };
    const directNeighbors = new Set<string>([...neighborIndex.in, ...neighborIndex.out]);
    return ids.filter(id => !this.scopeNodeIds.has(id.toLowerCase()) || !directNeighbors.has(id.toLowerCase()));
  }

  /** Structured tasks assigned to the current focus node, rendered as the `<current_task>` block. */
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

  /** Compressed discovery-summary memo composed at the post-approval round, or `null` when none was set (e.g. SM started with no prior discovery walk). */
  public getDiscoverySummary(): string | null {
    return this._discoverySummary;
  }

  /**
   * Stores the discovery-handoff memo composed at proposal time, set verbatim at gate approval and
   * never recomposed. Empty or whitespace-only input becomes `null`.
   */
  public setDiscoverySummary(text: string): void {
    const trimmed = text.trim();
    this._discoverySummary = trimmed.length > 0 ? trimmed : null;
  }

  /** Stores the current-task question at the moment a hop context is delivered. */
  private _lastCurrentTask = '';

  /** Sets up the navigation map to prepare for traversal. */
  public init(params: NavigationInitParams): { ok: true; scopeSize: number; agendaSize: number; scopeSchemas: string[] } | { error: string; hint?: string; unresolved_excludeNodeIds?: string[]; unresolved_passNodeIds?: string[] } {
    if (params.depthIntent?.kind === 'asymmetric' && (params.direction ?? 'bidirectional') !== 'bidirectional') {
      return {
        error: ASYMMETRIC_DEPTH_REQUIRES_BIDIRECTIONAL,
        hint: 'Resend this refine with direction "bidirectional" — asymmetric depths require it and the prior proposal kept a single direction — or use one direction with a symmetric depth.',
      };
    }
    if (params.analysisMode === 'ct' && (!params.targetColumns || params.targetColumns.length === 0)) {
      return {
        error: 'target_columns_required_for_ct',
        hint: 'Resend with at least one named targetColumns value for CT, or change analysisMode to "bb" and resend.',
      };
    }
    if (params.analysisMode === 'bb' && params.targetColumns !== undefined) {
      return {
        error: REJECTION_CODES.ctFieldForbiddenInBb,
        hint: 'Omit targetColumns and resubmit the BB specification. If the provider emits an empty array, the encoding boundary normalizes it automatically.',
      };
    }
    // Refine detection: initSnapshot is null on first init, populated thereafter — survives status transitions.
    const wasRefine = this.initSnapshot !== null;
    const prevScopeSize = this.scopeNodeIds.size;

    // Phase 1 — validate every payload reference before touching state, so a rejected refine leaves the live engine unchanged.
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
    // Resolve CT columns against the origin's DDL now, but hold it locally until phase 2 commits.
    let resolvedActiveColumns: string[] = [];
    if (analysisMode === 'ct' && effectiveTargetColumns && effectiveTargetColumns.length > 0) {
      // Object references are rejected before any resolution — a node id can never be a column.
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
      this.log('debug', `[Admit] guard=ct_target_columns phase=init focus=${originNode.id} active=${resolved.length} — tracing [${resolved.join(', ')}]`);
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
        // Each side keeps its own ceiling; the scalar budget stays a display/checkpoint summary, never the enforcement value.
        const sideLimit = (value: number | 'all'): number =>
          value === 'all' ? Number.POSITIVE_INFINITY : value;
        this.depthLimits = {
          upstream: sideLimit(depthIntent.upstream),
          downstream: sideLimit(depthIntent.downstream),
        };
        // Null unless BOTH sides are capped — reporting the finite side alone would state a ceiling for a side that has none.
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
    // Logged explicitly since the `[BFS]` line reports the INTENT, not what it bound to.
    const capSide = (value: number): string => (Number.isFinite(value) ? String(value) : 'all');
    this.log(
      'debug',
      `[Depth] resolved intent=${depthIntent.kind} label=${depthLabel} `
      + `enforcement=${this.depthEnforcement} `
      + `cap=up:${capSide(this.depthLimits.upstream)}/down:${capSide(this.depthLimits.downstream)} `
      + `budget=${this.depthBudget ?? 'none'}`,
    );
    this.budgetExpansions = [];
    this.scopeNodeIds = this.computeBfsScope(originNode.id, direction, depthIntent);

    // Requested target columns stay in target_columns for auditability; active_columns is the DDL-resolved set for the origin hop.
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
    // Seed the denominator with the approved bodied scope size so the user sees the true "contract" denominator (e.g. "Hop 1 of 27") from the first hop.
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

    // [AI] [Contract] — a stable hash of the resolved scope contract, cross-referenced by downstream hop logs.
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
    // Snapshot kept so the refine path (gate cycle) can re-run init with new filters without the AI re-sending origin/direction/depth/mission_brief.
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
    const rootTask = this.taskLedger.ensureTask(this.taskInputFor({
      source: 'mission',
      question: params.question,
      nodeId: originNode.id,
      createdHop: 0,
    }, 'root', initialActiveColumns));
    this.enqueueHop(originNode.id, params.question, 0, 3, { carry: { kind: 'carry', columns: initialActiveColumns ?? [] }, existingTaskId: rootTask.id });
    this.seedAgenda(originNode.id, this._direction, initialActiveColumns, rootTask.id);
    this._status = 'initialized';

    return {
      ok: true,
      scopeSize: this.scopeNodeIds.size,
      agendaSize: this._agenda.length,
      scopeSchemas: Array.from(scopeSchemas).sort(),
    };
  }

  /**
   * Admits follow-up targets by id, widening the allowlist for each one named.
   *
   * @remarks
   * Id-scoped, never schema-scoped, and monotonic — repeated follow-ups can only widen. Exclusion
   * sets stay a hard wall: an excluded id is never admitted, checked via the same {@link checkBorder}
   * the supplement write path applies, so this site cannot drift from it.
   *
   * @param nodeIds - Follow-up targets, canonical or free-cased; unresolvable and excluded ids are ignored.
   * @returns The canonical ids actually admitted, so the reply can name them.
   */
  private admitSupplementTargets(nodeIds: readonly string[]): string[] {
    const admitted: string[] = [];
    for (const raw of nodeIds) {
      const id = this.nodeMap.has(raw) ? raw : this.nodeMap.has(raw.toLowerCase()) ? raw.toLowerCase() : null;
      const node = id ? this.nodeMap.get(id) : undefined;
      if (!node || this.checkBorder(node.id, node, 'supplement').kind === 'excluded') continue;
      this.sessionAllowedNodeIds.add(node.id.toLowerCase());
      admitted.push(node.id);
    }
    if (admitted.length > 0) this.log('info', `[Border] supplement admit ids=[${admitted.join(',')}]`);
    return admitted;
  }

  /**
   * Returns a pruned node to the analysable set so a follow-up can add it back.
   *
   * @remarks
   * `removedSet` is not a standing veto — adding only ever introduces edges, so it cannot orphan a
   * committed node. `_totalNodes` is credited back only under the same condition that debited it, so
   * a focus prune (which never debited) is not double-counted.
   */
  private unprune(id: string): void {
    if (!this.removedSet.delete(id)) return;
    const node = this.nodeMap.get(id);
    if (node && !this.visited.has(id) && SCRIPT_TYPES.has(node.type) && this.scopeNodeIds.has(id)) {
      this._totalNodes++;
    }
    this.nodeStates.delete(id);
    this.log('debug', `[Supplement] unprune hop=${this.hopCount} id=${id} (total → ${this._totalNodes})`);
  }

  /**
   * Walks a chain add from each named id and returns the named ids followed by every object reached.
   *
   * @remarks
   * The walk stops at a user-excluded object, so what the user removed and the branch reachable
   * only through it stay out. Objects already analysed are not re-queued — only the named ids are
   * re-analysed on request.
   *
   * @returns Named ids first, then reached ids in breadth-first order, without duplicates.
   */
  private expandSupplementChain(nodeIds: readonly string[], chain: SupplementChain): string[] {
    const maxDepth = chain.depth === 'all' ? Number.POSITIVE_INFINITY : chain.depth;
    const mode = chain.direction === 'upstream' ? 'inbound' : 'outbound';
    const result: string[] = [...nodeIds];
    const seen = new Set(nodeIds.map(id => id.toLowerCase()));
    for (const raw of nodeIds) {
      const start = this.nodeMap.has(raw) ? raw : this.nodeMap.has(raw.toLowerCase()) ? raw.toLowerCase() : null;
      if (!start || !this.graph.hasNode(start)) continue;
      bfsFromNode(this.graph, start, (key, _attr, depth) => {
        if (key === start) return false;
        const node = this.nodeMap.get(key);
        if (!node || this.checkBorder(key, node, 'supplement').kind === 'excluded') return true;
        if (!seen.has(key.toLowerCase()) && !this.visited.has(key)) {
          seen.add(key.toLowerCase());
          result.push(key);
        }
        return depth >= maxDepth;
      }, { mode });
    }
    this.log('info', `[Supplement] chain dir=${chain.direction} depth=${String(chain.depth)} named=${nodeIds.length} → added=${result.length - nodeIds.length}`);
    return result;
  }

  /**
   * Extends a completed exploration with additional nodes for analysis.
   *
   * @remarks
   * Only callable when `status === 'complete'`. A prune this run made is not a veto here (see
   * {@link unprune}) — only {@link excludedNodeIds} remains a hard wall.
   *
   * @param leadIds - Host-selected pending leads; never accepted from a model tool payload.
   * @returns Counts for agendaed, contracted, and skipped ids, plus per-node `skippedDetails`
   *   naming which id was dropped and why (`excluded` | `unresolved`), or a structured error.
   */
  public supplementAgenda(nodeIds: string[], leadIds: string[] = [], chain?: SupplementChain): { ok: true; agendaed: number; contracted: number; skipped: number; skippedDetails: SupplementSkip[] } | { error: string; hint?: string } {
    if (this._status !== 'complete') {
      return {
        error: REJECTION_CODES.supplementRequiresCompleteEngine,
        hint: `supplementAgenda is only valid after the prior exploration has completed (status === 'complete'). Current status: ${this._status}.`,
      };
    }
    if ((!Array.isArray(nodeIds) || nodeIds.length === 0) && (!Array.isArray(leadIds) || leadIds.length === 0)) {
      // leadIds is host-selected; the hint below names nodeIds, the only input the model can actually fill.
      return {
        error: REJECTION_CODES.supplementEmpty,
        hint: 'supplement requires at least one node id in supplement.nodeIds — pending leads are host-selected and cannot be supplied here. Name the ids from the completed exploration you want extended; if no node is left to extend, do not resend an empty supplement — answer from the completed exploration, or start a fresh exploration by providing an origin instead of supplement.',
      };
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

    if (chain) nodeIds = this.expandSupplementChain(nodeIds, chain);
    const requested = [
      ...nodeIds.map(nodeId => ({ nodeId, question: `Supplement: investigate ${nodeId} on user follow-up`, taskId: undefined as string | undefined, leadId: undefined as string | undefined })),
      ...leadEntries.map(entry => ({ nodeId: entry!.lead.nodeId, question: entry!.task.question, taskId: entry!.task.id, leadId: entry!.lead.id })),
    ];

    // Every reject above is side-effect-free, so admission runs here — after the last reject and before the first mutation.
    this.admitSupplementTargets(requested.map(request => request.nodeId));

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
      // A user-excluded node is a hard wall here; the allowlist axis already widened above, so `excluded` is the only refusal left.
      const supNode = this.nodeMap.get(id);
      const supBorder = supNode ? this.checkBorder(id, supNode, 'supplement') : null;
      if (supBorder && supBorder.kind !== 'in_border') {
        this.log('debug', `[Supplement] refuse hop=${this.hopCount} id=${id} reason=excluded`);
        skippedDetails.push({ nodeId: id, reason: 'excluded' });
        skipped++;
        continue;
      }
      // Past the wall: a prune this run made no longer stands between the user and the object they asked for.
      this.unprune(id);
      // Captured before mutation so enqueueHop can credit _totalNodes correctly.
      const wasNewToScope = !this.scopeNodeIds.has(id);
      const wasVisited = this.visited.has(id);
      if (wasNewToScope) {
        this.scopeNodeIds.add(id);
        const node = this.nodeMap.get(id);
        if (node && SCRIPT_TYPES.has(node.type)) this.bodiedScopeSize++;
      }
      // Reset visited guard so the supplemented id can be analyzed even if passed-through earlier.
      if (wasVisited) this.visited.delete(id);
      const existingDepth = this.depthFromOrigin.get(id);
      const depth = typeof existingDepth === 'number' ? existingDepth : 0;
      // CT: pass target columns so supplemented nodes are analyzed with column context.
      const supplementColumns = this.tracer?.targetColumns;
      if (request.leadId) this.taskLedger.scheduleLead(request.leadId);
      // Every open lead on the named object is scheduled here and resolved when its hop completes.
      for (const lead of this.taskLedger.pendingLeads) {
        if (lead.status === 'pending' && lead.nodeId.toLowerCase() === id.toLowerCase()) this.taskLedger.scheduleLead(lead.id);
      }
      this.enqueueHop(id, request.question, depth, 3, {
        carry: { kind: 'carry', columns: supplementColumns ?? [] },
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
   * @remarks
   * CT resolves active columns from two base states (`carry`'s own list, or `[]` for
   * `row_role_only`), overridden by spine recovery from accumulated `column_flow` edges when that
   * resolves non-empty — a stated `row_role_only` never narrows a demand an earlier committed edge already placed.
   */
  public getHopContext(): HopContext {
    let entry: AgendaEntry | undefined;
    while (this._agenda.length > 0) {
      const candidate = this._agenda.dequeue();
        if (!candidate) break;

      if (this.visited.has(candidate.nodeId)) {
        // Sound: no path queues a question onto a node visited at dequeue time — enqueueHop skips or clears the flag in the same call.
        this.completeTasks(candidate.taskIds);
        continue;
      }

      // User-requested auto-pass: keep in scope, skip the AI hop, contract through to bodied neighbours so descendants stay reachable.
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
      if (this.tracer) {
        const spineBound = this.tracer.determineActiveColumnsForCandidate(
          candidate.nodeId,
          candidate.activeColumns ?? [],
          this.writtenCarrierIds(candidate.nodeId),
          this.log,
          this.columnTraceDirection(),
        );
        const bound = this.resolveActiveColumnsForNode(candidate.nodeId, spineBound) ?? [];
        const statedRowRole = candidate.columnCarry?.kind === 'row_role_only';
        if (statedRowRole && bound.length > 0) {
          this.log('debug', `[Normalize] dispatch carry hop=${this.hopCount} id=${candidate.nodeId} from=none to=[${bound.join(', ')}] — a committed column_flow edge attributes traced columns to this node`);
        }
        const base = statedRowRole ? [] : candidate.activeColumns ?? [];
        candidate.activeColumns = bound.length > 0 ? bound : base;
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
    if (this.tracer) {
      this.tracer.setActiveColumns(entry.activeColumns || []);
    }
    // Read continuation questions from THIS entry, not a global cache, so the render site sees only the node actually being dispatched.
    this._pendingLineageQuestions = entry.lineageQuestions ? [...entry.lineageQuestions] : [];

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
      // Named-node consent is the other allowlist half; omitting it would still refuse an object the user already asked for by name.
      ...(this.sessionAllowedNodeIds.size > 0 ? { node_ids: Array.from(this.sessionAllowedNodeIds).sort() } : {}),
      depth_cap: this.computeDepthCap(),
    };
    workingMemory.deferred_count = this.deferredQuestions.length;
    if (this.tracer) {
      workingMemory.column_aspect = this.tracer.state;
    }

    this._lastCurrentTask = this.currentFocusQuestion ?? '';
    this._status = 'awaiting_findings';
    return {
      sm_status: 'awaiting_findings' as const,
      hop: this.hopCount,
      analysis_mode: this.currentHopAnalysisMode,
      agenda_remaining: this._agenda.length,
      focus_node: focusNode,
      neighbors: this.buildNeighborList(entry.nodeId),
      working_memory: workingMemory,
    };
  }

  /**
   * Unvisited, un-queued, un-removed directional neighbors of `focusId` that the router would
   * currently admit a route to — the exact set the required-nodes guard demands an account for
   * on the next submit, in both modes.
   *
   * @remarks
   * Single source for that set: the guard callback and the per-hop envelope render both read it, so
   * the rendered checklist can never drift from what the engine enforces. No prior
   * {@link scopeNodeIds} membership is required — a route the router would accept commits the
   * neighbor into scope itself, so "in scope" is an outcome of routing here, never a precondition.
   *
   * @param budget - The submitting turn's budget; a neighbor already in scope paid this cost when
   *   it entered, so only a *fresh* addition is checked against it.
   * @returns Directional neighbor ids that must be routed or accounted for before the walk advances.
   */
  public requiredNeighborIds(focusId: string, budget: TurnTokenBudget = DEFAULT_TURN_TOKEN_BUDGET): string[] {
    return Array.from(this.directionalNeighbors(focusId, this._direction))
      .filter(nid => !this.visited.has(nid) && !this._agenda.has(nid) && !this.removedSet.has(nid))
      // Exempt: a prune (deferred lead survives it), a not-yet-scoped neighbor over budget, or an id absent from `nodeMap`.
      .filter(nid => {
        const node = this.nodeMap.get(nid);
        if (node === undefined || !this.admitsRoute(nid, node, focusId).admitted) return false;
        if (this.scopeNodeIds.has(nid)) return true;
        const projectedNodes = this.scopeNodeIds.size + 1;
        return checkActiveScopeAdmission(budget, projectedNodes, this.estimateScopeDdlChars([nid])).ok;
      });
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
    const focusNode = buildHopFocusNode(
      node, this.nodeMap, new Map(), this.store ?? undefined, 'bb_ddl',
      this.model.neighborIndex, this.edgeTypeMap,
    );
    if (this.depthBudget !== null) {
      const d = this.depthFromOrigin.get(focusId);
      if (d !== undefined) focusNode.depth_from_origin = d;
    }
    return {
      sm_status: this._status,
      hop: this.hopCount,
      analysis_mode: this.currentHopAnalysisMode,
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
   * Pruning is AI-decided in both modes: `route_requests`/`prune_neighbors` on a `verdict=prune`
   * submission commit through the same admission/enqueue path as any other verdict before the focus
   * itself is pruned, so the don't-orphan check sees the route this same payload just queued.
   *
   * @param budget - The submitting turn's budget the active-scope admission guard is measured
   *   against; the shipped defaults apply where a caller runs outside a turn.
   */
  public submitFindings(params: HopSubmission, budget: TurnTokenBudget = DEFAULT_TURN_TOKEN_BUDGET): SubmitResult {
    if (this._status !== 'awaiting_findings') {
      const hint = this._status === 'complete'
        ? 'The engine already completed this exploration. Produce the synthesis output (chat prose + present_result) now — do not call submit_findings again.'
        : this._status === 'error'
          ? 'The engine is in an error state. Call start_exploration to begin a fresh exploration.'
          : `Engine is in status '${this._status}'. Expected 'awaiting_findings'. Wait for a hop context, or restart via start_exploration if the session was wiped.`;
      return { error: 'invalid_status', current_status: this._status, hint };
    }

    try {
      // A held draft reaches this point only via `applyHeldContent`, called directly above.
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
    // Enforced here (ahead of every mutation) so a length violation holds the draft instead of costing a verbatim resend.
    const lengthViolations: Array<{ path: string; chars: number; limit: number }> = [];
    if (finding.badge_label !== undefined && finding.badge_label.length > SUBMIT_FINDINGS_BADGE_LABEL_MAX) {
      lengthViolations.push({ path: 'badge_label', chars: finding.badge_label.length, limit: SUBMIT_FINDINGS_BADGE_LABEL_MAX });
    }
    (finding.column_flow ?? []).forEach((entry, entryIndex) => {
      (entry.upstream_columns ?? []).forEach((ref, refIndex) => {
        if (ref.note !== undefined && ref.note.length > COLUMN_FLOW_NOTE_MAX) {
          lengthViolations.push({
            path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.note`,
            chars: ref.note.length,
            limit: COLUMN_FLOW_NOTE_MAX,
          });
        }
      });
    });
    if (lengthViolations.length > 0) {
      const measured = lengthViolations.map(v => `${v.path}: ${v.chars} chars, limit ${v.limit}`).join('; ');
      this.memory.recordRejection(focusId, `field_length_exceeded: ${measured}`, this.hopCount);
      this.heldFindingDraft.hold(structuredClone(finding));
      return {
        error: 'field_length_exceeded',
        hint: `${measured}. Nothing was committed. Your analysis is held: resubmit submit_findings for ${focusId} with the listed field(s) shortened — send sections: [] to keep the prose you already authored, or new sections to replace it.`,
        detail: lengthViolations.map(v => ({ path: v.path, chars: v.chars, limit: v.limit })),
      };
    }
    // Active columns the focus declares — feeds the CT completeness guard and every hint offering `passthrough` as the repair.
    let declaredActiveColumns: readonly string[] = [];
    if (this.tracer) {
      const declaredNorm = new Set(
        (getNodeColumns(focusId, this.nodeMap, this.store ?? undefined) ?? []).map(c => normalizeColName(c.name)),
      );
      declaredActiveColumns = this.tracer.activeColumns.filter(c => declaredNorm.has(normalizeColName(c)));
    }
    const passthroughColumnClause = declaredActiveColumns.length > 0
      ? ` ${focusId} declares tracked column${declaredActiveColumns.length > 1 ? 's' : ''} [${declaredActiveColumns.join(', ')}], so that passthrough must carry a column_flow entry for each of them — column_flow:[] is refused here.`
      : '';
    // Every fault below accumulates instead of returning, so one rejection names all of them.
    let originPruneFault: SubmissionFaults['originPrune'];
    let focusOrphanFault: SubmissionFaults['focusOrphan'];
    let columnChainFault: SubmissionFaults['columnChain'];
    let pruneSectionsFault: SubmissionFaults['pruneSections'];
    if (finding.verdict === 'prune') {
      if (focusId === this.originNodeId) {
        originPruneFault = { focusId, keepClause: passthroughColumnClause };
      }
      // A prune carries no sections — findings belong on `analyze`. Structural shape only (present or not), never the prose content.
      if ((finding.sections ?? []).length > 0) {
        pruneSectionsFault = { focusId, sectionCount: (finding.sections ?? []).length };
      }
      // Deliberately nothing else is checked: the AI decides WHAT is pruned, the engine only whether removal is structurally valid.
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
    // Populated at commit, keyed by upstream node id, so each routed hop's own AgendaEntry carries only the questions opened for it.
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
    const stagedColumnFlowEntries = this.tracer
      ? finding.column_flow?.length ?? 0
      : 0;
    const routeColumnsByNode = new Map<string, Set<string>>();
    const routeQuestionsByNode = new Map<string, string>();
    const routeRequests = [...(finding.route_requests ?? [])];

    if (this.tracer && finding.column_flow) {
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
        // Stating `routeColumnsByNode` here (rather than leaving `columns` absent) means it never reads as the model's own `'none'`.
        if (!routed.has(nid)) routeRequests.push({ nodeId: nid, question, columns: [...routeColumnsByNode.get(nid)!] });
      }
    }

    const pruneTargets = (finding.prune_neighbors ?? []).map((raw, index) => ({
      raw,
      resolved: resolveModelNodeId(raw, this.nodeMap),
      path: `prune_neighbors.${index}`,
    }));
    // pruneTargets is the submit's one resolution home; reading its canonical ids keeps every verdict true for any spelling the model sends.
    const pruneNeighborIds = new Set(pruneTargets.map(t => t.resolved ?? t.raw.toLowerCase()));
    // Computed for EVERY verdict: still needed on the rejection path, since repairing a refused prune to `passthrough` raises the obligation.
    const requiredNodeIds = this.requiredNeighborIds(focusId, budget);
    const owedNodeIds = finding.verdict === 'prune' ? [] : requiredNodeIds;
    const authoredRouteCount = finding.route_requests?.length ?? 0;
    // Same-submit CT content: an authored `columns: 'none'` vs this hop's own column_flow naming that neighbor. Independent of BB admission.
    for (let routeIdx = 0; routeIdx < authoredRouteCount; routeIdx++) {
      const req = routeRequests[routeIdx];
      if (req.columns !== 'none') continue;
      const nid = resolveModelNodeId(req.nodeId, this.nodeMap);
      if (!nid) continue;
      const flowCols = routeColumnsByNode.get(nid);
      if (flowCols && flowCols.size > 0) {
        invalidRoutes.push({
          kind: 'route_columns_flow_conflict',
          id: nid,
          path: `route_requests.${routeIdx}.columns`,
          available_columns: [...flowCols],
          reason: `route_requests states columns: 'none' for \`${nid}\`, but this submission's own column_flow names \`${nid}\` as the upstream contributor for [${[...flowCols].join(', ')}].`,
        });
      }
    }
    const flowSynthesizedCount = routeRequests.length;
    // A required neighbor the payload neither routed nor pruned is pure bookkeeping: it is already admissible, so the engine fills the
    // route itself here rather than spending a generation to be handed back the ids it already supplied, logged at `info` for attribution.
    // A neighbor the model DID name in `prune_neighbors` is not filled: if that prune is refused, the refusal is reported, not overridden.
    const routedIds = new Set(routeRequests.map(req => resolveModelNodeId(req.nodeId, this.nodeMap) ?? req.nodeId.toLowerCase()));
    for (const reqId of owedNodeIds) {
      if (routedIds.has(reqId) || pruneNeighborIds.has(reqId)) continue;
      routeRequests.push({
        nodeId: reqId,
        question: `Continue the trace from \`${focusId}\` into \`${reqId}\`: determine what \`${reqId}\` contributes to the value \`${focusId}\` produces, and whether the chain continues past it.`,
      });
      routedIds.add(reqId);
      this.log('info', `[AutoFill] required neighbor route hop=${this.hopCount} focus=${focusId} id=${reqId} reason=unaccounted_in_submission — engine-authored route question, no rejection charged`);
    }
    const routeTargets: Array<{ raw: string; resolved: string | null; path: string }> = [];
    for (let index = 0; index < routeRequests.length; index++) {
      const raw = routeRequests[index].nodeId;
      routeTargets.push({
        raw,
        resolved: resolveModelNodeId(raw, this.nodeMap),
        path: index < authoredRouteCount
          ? `route_requests.${index}.nodeId`
          : index < flowSynthesizedCount ? 'column_flow' : 'engine_required_neighbor',
      });
    }
    const actionPolicy = evaluateCurrentHopActionPolicy({
      originId: this.originNodeId!,
      routeTargets,
      pruneTargets,
      scopeNodeIds: this.scopeNodeIds,
      visitedIds: this.visited,
      removedIds: this.removedSet,
      notedIds: new Set(this.memory.notedNodeIds),
      agendaIds: new Set(this._agenda.entries.map(entry => entry.nodeId)),
    });
    invalidRoutes.push(...actionPolicy.fatalErrors);

    if (routeRequests.length > 0) {
      for (let routeIdx = 0; routeIdx < routeRequests.length; routeIdx++) {
        const req = routeRequests[routeIdx];
        const nid = resolveModelNodeId(req.nodeId, this.nodeMap);
        const nNode = nid ? this.nodeMap.get(nid) : null;
        if (!nid || !nNode) continue; // Recorded as a nonfatal unresolved notice above.
        const admission = this.admitsRoute(nid, nNode, focusId);
        const routeBorder = admission.border;
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

        // An omitted depth leaves the approved depth an initial BFS seed the model may grow; a user-stated level count defers the route as a follow-up instead.
        const { depthBreach, candidateDepth } = admission;
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
        // Symmetric with the prune/defer logs: record every neighbour ADD so the debug trace shows both sides of the agenda decision.
        this.log('debug', `[Agenda] route accept hop=${this.hopCount} id=${nNode.id} ← ${focusId} subq=${req.question ? trunc(req.question, 80) : '(none)'}`);

      }
    }
    // Column Aspect validation + completeness is delegated to ColumnTracer and pure set-difference checks.
    // `column_flow` is optional on the wire (a prune verdict commonly omits it), so the call is guarded on presence.
    // Hoisted so the completeness guard further down reads the identical direction the edges were staged under.
    const traceDirection = this.columnTraceDirection();
    if (this.tracer && finding.column_flow) {
      const valResult = this.tracer.validateColumnFlow(focusId, finding, this.nodeMap, this.model, this.store ?? null, this.log, this.removedSet, traceDirection);
      if (valResult.error) {
        return valResult.error;
      }

      invalidRoutes.push(...valResult.invalidRoutes);
      // Single edge-staging source: validateColumnFlow stages every upstream real column.
      for (const e of valResult.stagedEdges) e.hop = this.hopCount;
      stagedColumnEdges.push(...valResult.stagedEdges);
    }

    // A declared node (an accepted route_request, or a column_flow upstream_columns/writes_to target) is refused as a prune candidate outright,
    // split out ahead of the undirected topology walk below — that walk alone cannot see a declared dead end as unsafe to delete.
    // Same-submit staged endpoints count too: they only join `declaredRouteIds` at commit time, after this verdict.
    const stagedRouteIds = new Set<string>();
    for (const e of stagedColumnEdges) {
      stagedRouteIds.add(e.from_node);
      stagedRouteIds.add(e.to_node);
    }
    const isDeclared = (nid: string): boolean => this.declaredRouteIds.has(nid) || stagedRouteIds.has(nid);
    const declaredPruneIds = actionPolicy.acceptedPruneIds.filter(isDeclared);
    for (const nid of declaredPruneIds) {
      this.log('debug', `[Prune] prune_neighbor refused hop=${this.hopCount} id=${nid} reason=declared_route_protected`);
      invalidRoutes.push({
        kind: 'prune_would_orphan',
        id: nid,
        reason: `Pruning \`${nid}\` is refused: an earlier accepted route_request or column_flow entry already declared it part of the traced path, so it stays reachable for the rest of the run.`,
      });
    }
    const prunablePruneIds = declaredPruneIds.length > 0
      ? actionPolicy.acceptedPruneIds.filter((nid) => !isDeclared(nid))
      : actionPolicy.acceptedPruneIds;
    {
      // One shared predicate (`wouldOrphan`) decides the whole batch; the focus self-prune below asks the same question through the same call.
      const verdictByCandidate = this.wouldOrphan(prunablePruneIds, { extraProtected: [focusId] });
      for (const nid of verdictByCandidate.accepted) prunedNeighborNids.add(nid);
      for (const { id, orphanId } of verdictByCandidate.refused) {
        // `[Reject]` counts tool dispatches; this refusal is already carried by the `route_validation_failed` that follows, so `[Reject]` here double-counted.
        this.log('debug', `[Prune] prune_neighbor refused hop=${this.hopCount} id=${id} reason=would_orphan_noted disconnected=${orphanId}`);
        invalidRoutes.push({ kind: 'prune_would_orphan', id, reason: `Pruning \`${id}\` would orphan \`${orphanId}\`, which nothing else keeps reachable from the origin. Prune both in one submission, or keep \`${id}\`.` });
      }
    }

    // Focus prune check, after routes and neighbor prunes are staged: the walk reads the staged sets and widens scope by routes not yet in `scopeNodeIds`.
    if (finding.verdict === 'prune' && originPruneFault === undefined) {
      // NOT a gap: a node the tracer already declared (route or column_flow) is free to prune ITSELF; the real gap (a later hop naming an
      // already-removed node as a fresh contributor) is closed at declare time in `ColumnTracer.validateColumnFlow` (`pruned_contributor`), not here.
      const focusVerdict = this.wouldOrphan([focusId], {
        extraProtected: acceptedNids,
        extraRemoved: prunedNeighborNids,
      });
      const focusRefusal = focusVerdict.refused[0];
      if (focusRefusal) {
        focusOrphanFault = { focusId, orphanId: focusRefusal.orphanId, keepClause: passthroughColumnClause };
      }
    }

    // analyze/pass path: commit the detail slot + CT edges (prune's own commit is separate, below) — stage its sections + CT passthrough roles.
    {
      const flowNotes = (finding.column_flow ?? []).flatMap(entry =>
        (entry.upstream_columns ?? []).map(ref => ref.note ?? ''),
      );
      stagedSections = appendUniqueSectionText(
        finding.sections ?? [],
        flowNotes,
        focusId,
        message => this.log('debug', message),
      );
      stagedDetailChars = stagedSections.reduce((sum, s) => sum + (s.text?.length ?? 0), 0);
      stagedSummaryChars = finding.summary?.length ?? 0;

      // Mark non-bodied to/from nodes as pass-through without re-staging column edges.
      if (this.tracer && finding.column_flow) {
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

    // CT completeness guard: a declared active column left unaccounted is `column_chain_incomplete`; declaring none of them is the empty-flow
    // escape, genuinely open where the engine cannot disprove it (no column metadata, or the trace never touched this node — not fabrication).
    // Same exemption as `owedNodeIds` above: a self-pruned focus owes no column_flow account either — it is leaving the graph, not continuing through it.
    if (this.tracer && finding.verdict !== 'prune') {
      const submittedFlow = finding.column_flow ?? [];
      // `declaredActiveColumns` (computed above) decides both halves: is the empty-flow declaration checkably false, and may a rejection hint still offer it.
      const contradicted = declaredActiveColumns;
      const declaresNoTrackedColumns =
        finding.verdict === 'passthrough' && submittedFlow.length === 0 && contradicted.length === 0;
      const unaccounted = declaresNoTrackedColumns ? [] : this.tracer.unaccountedActiveColumns(submittedFlow, traceDirection);
      if (unaccounted.length > 0) {
        columnChainFault = {
          focusId,
          unaccounted,
          available: [...this.tracer.activeColumns],
          contradicted: [...contradicted],
          traceDirection,
        };
      }
      if (declaresNoTrackedColumns) {
        this.log('debug', `[Admit] guard=ct_completeness phase=active focus=${focusId} reason=declares_none — declares none of the active columns [${this.tracer.activeColumns.join(', ')}], column chain ends here`);
      } else if (unaccounted.length === 0) {
        this.log('debug', `[Admit] guard=ct_completeness phase=active focus=${focusId} reason=all_accounted active=${this.tracer.activeColumns.length}`);
      }
    }

    // Completeness guard, both modes: every in-scope directional neighbor must be routed or pruned (via the don't-orphan check) before advance.
    // Only a neighbor the model itself put in `prune_neighbors` can reach this point unaccounted, and only when that prune was refused.
    for (const reqId of owedNodeIds) {
      if (acceptedNids.has(reqId) || prunedNeighborNids.has(reqId)) continue;
      const invalidlyPruned = pruneNeighborIds.has(reqId);
      invalidRoutes.push({
        kind: 'missing_required_route',
        id: reqId,
        invalidlyPruned,
        reason: invalidlyPruned
          ? `Required neighbor was submitted in prune_neighbors from focus ${focusId}, but that prune was refused: ${reqId}. Route it, or prune it only if it does not orphan a node nothing else keeps reachable.`
          : `Required neighbor was not accounted for from focus ${focusId}: ${reqId}`,
        available_routes: requiredNodeIds,
      });
    }

    // ONE rejection per submission: the model gets every known fault at once, instead of repairing one and being told the next on resubmit.
    const fatalRoutes = invalidRoutes.filter(r => !isAbsentKind(r.kind));
    const reported = buildSubmissionRejection({
      routes: fatalRoutes,
      originPrune: originPruneFault,
      focusOrphan: focusOrphanFault,
      columnChain: columnChainFault,
      pruneSections: pruneSectionsFault,
      // Disclosure, not a fault: the neighbour demand a prune verdict is exempt from.
      ...(finding.verdict === 'prune' && requiredNodeIds.length > 0 ? { repairWouldOwe: requiredNodeIds } : {}),
    });
    if (reported) {
      // Counts the per-reference faults only; a verdict-level refusal (origin, or would-orphan) names no rejected reference.
      const rejectedRefs = fatalRoutes.length + (columnChainFault?.unaccounted.length ?? 0);
      if (rejectedRefs > 0) this.lastRoutedRejected = rejectedRefs;
      for (const r of fatalRoutes) this.memory.recordRejection(r.id, r.reason, this.hopCount);
      if (columnChainFault) {
        this.memory.recordRejection(focusId, `column_chain_incomplete: ${columnChainFault.unaccounted.join(', ')}`, this.hopCount);
      }
      // Field-scoped faults leave the authored sections and summary valid, so holding them avoids a from-scratch re-author.
      if (reported.hold) this.heldFindingDraft.hold(structuredClone(finding));
      return reported.rejection;
    }

    // Active-phase admission guard: last fatal guard, runs before any durable mutation so a rejection leaves the hop unstaged.
    if (scopeAddNids.size > 0) {
      const projectedNodes = this.scopeNodeIds.size + scopeAddNids.size;
      const admission = checkActiveScopeAdmission(budget, projectedNodes, this.estimateScopeDdlChars(scopeAddNids));
      if (!admission.ok) {
        this.lastRoutedRejected = scopeAddNids.size;
        this.memory.recordRejection(focusId, `over_active_scope_budget: +${scopeAddNids.size} routes would exceed the exploration budget`, this.hopCount);
        this.heldFindingDraft.hold(structuredClone(finding));
        // Dropping the route is the repair that always exists, so it is named in both branches — a subset presumes a set the model may not have.
        const staged = scopeAddNids.size;
        const budgets = `(nodes ${admission.counts.nodes}/${admission.limits.node_cap}, est. tokens ${admission.counts.tokens}/${admission.limits.token_budget})`;
        return {
          error: 'over_active_scope_budget',
          hint: staged === 1
            ? `Committing 1 new route would exceed the exploration budget ${budgets}. It is the only route staged, so no smaller set of routes exists. Your analysis is held: resend submit_findings with route_requests:[] — the hop closes on what it already has and the engine synthesizes. Say what this route would have added in sections[].text if it matters to the answer.`
            : `Committing ${staged} new routes would exceed the exploration budget ${budgets}. Your analysis is held: resend submit_findings keeping only the routes essential to the question — prune or defer the rest, mark remaining branches terminal, or send route_requests:[] to close the hop on what it already has so the engine can synthesize.`,
          detail: {
            staged_routes: scopeAddNids.size,
            projected_nodes: admission.counts.nodes,
            node_cap: admission.limits.node_cap,
            projected_tokens: admission.counts.tokens,
            token_budget: admission.limits.token_budget,
          },
        };
      }
      this.log('debug', `[Admit] guard=active_scope_budget phase=active focus=${focusId} routes=+${scopeAddNids.size} nodes=${admission.counts.nodes}/${admission.limits.node_cap} tokens=${admission.counts.tokens}/${admission.limits.token_budget}`);
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
    // Focus commit: a prune records via `storePrunedDetail` and the `submitted_prune` state; every other verdict keeps the analyze/pass path.
    if (finding.verdict === 'prune') {
      if (this.tracer) this.ctPrunedFocusIds.add(focusId);
      this.removedSet.add(focusId);
      this.visited.add(focusId);
      this.memory.storePrunedDetail(
        this.nodeMap.get(focusId)!,
        finding.sections ?? [],
        finding.summary ?? '',
        { badge_label: finding.badge_label, reason_for_visit: this.currentFocusQuestion || 'Historical path investigation' },
      );
    } else {
      this.memory.storeDetail(
        this.nodeMap.get(focusId)!,
        stagedSections,
        finding.summary,
        {
          badge_label: finding.badge_label,
          reason_for_visit: this.currentFocusQuestion || 'Historical path investigation',
        },
        message => this.log('debug', message),
      );
      this.lastHopDetailChars = stagedDetailChars;
      this.lastHopSummaryChars = stagedSummaryChars;
      this.archiveChars += this.lastHopDetailChars + this.lastHopSummaryChars;

      if (this.tracer && stagedColumnEdges.length > 0) {
        this.tracer.edges.push(...stagedColumnEdges);
        // A staged edge's endpoints are the same declaration as an accepted route_request; this covers what the accepted-route path above
        // does not — writes_to targets and any upstream_columns target the border/depth admission deferred or excluded.
        for (const e of stagedColumnEdges) {
          this.declaredRouteIds.add(e.from_node);
          this.declaredRouteIds.add(e.to_node);
        }
        // Group continuation questions NOW (focusId + hopCount still match these edges) so the route loop below renders each only at its own next hop.
        lineageQuestionsByNode = this.tracer.getColumnLineageQuestionsByNode(focusId, this.hopCount);
        this.log('debug', `[CT] column_flow hop=${this.hopCount} focus=${focusId} entries=${this.lastHopColumnFlowEntries} total_edges=${this.tracer.edges.length} active_cols=${this.tracer.activeColumns.join(',')}`);
      }
    }

    for (const state of stagedCtNodeStates) {
      this.markNodeState(state.nodeId, state.action, state.source, state.reason, state.meta);
    }

    this.memory.recordVerdict(finding.verdict);
    this.lastHopVerdict = finding.verdict;
    if (finding.verdict === 'prune') {
      this.markNodeState(focusId, 'prune', 'ai', 'submitted_prune', {
        columns: this.tracer?.activeColumns,
        atHop: this.hopCount,
      });
      // Focus took an AI hop, so it counts towards hopCount; _totalNodes is not decremented, so hopCount never exceeds it.
      this.log('debug', `[Self-Prune] hop=${this.hopCount} id=${focusId} mode=${this.mode.kind}`);
    } else {
      this.markNodeState(
        focusId,
        finding.verdict,
        'ai',
        finding.verdict === 'analyze' ? 'submitted_analyze' : 'submitted_passthrough',
        {
          columns: this.tracer?.activeColumns,
          // The hop's own dispatch decides the role: handed traced columns is a carrier, handed none was explored for its row-set effect.
          ...(this.tracer ? { columnRole: this.tracer.activeColumns.length > 0 ? 'carrier' as const : 'row_role_only' as const } : {}),
          atHop: this.hopCount,
        },
      );
    }
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
        // An accepted route declares nid part of the traced path the moment it is admitted — before `enqueueHop` runs, since a non-bodied
        // target ends that call contracted, with no agenda entry left for anything downstream to protect it.
        this.declaredRouteIds.add(nid);
        const routeColumns = routeColumnsByNode.get(nid);
        const isFreshExpansion = freshlyExpandedIds.delete(nid);
        // reactivated is always false here except when this hop's own column_flow left the route as an open chain end (`openColumnEnd`).
        const columnQuestions = lineageQuestionsByNode?.get(nid);
        this.enqueueHop(nid, req.question, 0, 2, {
          carry: this.routeCarryFor(nid, req.columns, routeColumns),
          lineageQuestions: columnQuestions,
          freshScopeExpansion: isFreshExpansion,
          admitContractedBodiedTarget: !targetIsBodied,
          openColumnEnd: (columnQuestions?.length ?? 0) > 0,
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

    // Exclusion axes only — origin is never dropped. `seed_bfs` omits the schema allowlist so out-of-allowlist reachables survive as gate classes.
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
      this.enqueueHop(nid, `Analyze relationship to ${originId}`, 1, 0, { carry: { kind: 'carry', columns: targetCols ?? [] }, parentTaskId: rootTaskId });
    }
  }

  /**
   * Forwards a pass-tagged node's intent to its in-direction bodied neighbours.
   *
   * @remarks
   * Mirrors `enqueueHop`'s non-bodied contraction branch: when a node is in
   * {@link passNodeIds} the AI is not asked to analyse it, yet its descendants must stay
   * reachable. Walk in-direction neighbours and re-enqueue each via
   * `enqueueHop` (which respects scope, visited, and the bipartite rule).
   */
  private contractThroughPassNode(entry: AgendaEntry): void {
    // Bound carried columns to this pass node's on-trace spine before propagation.
    const spineBound = this.tracer
      ? this.tracer.determineActiveColumnsForCandidate(entry.nodeId, entry.activeColumns ?? [], new Set(), this.log, this.columnTraceDirection())
      : entry.activeColumns;
    // Spine-empty candidates fall back to the requested set verbatim; bound that to the pass node's own declared columns, same as enqueueHop.
    const carried = this.tracer ? (this.resolveActiveColumnsForNode(entry.nodeId, spineBound) ?? []) : spineBound;
    // Same rule as `enqueueHop`'s contraction: a stated row role belongs to the branch, not the pass node, so it travels on unresolved.
    const forwardedCarry: ColumnCarry = entry.columnCarry?.kind === 'row_role_only'
      ? entry.columnCarry
      : { kind: 'carry', columns: carried ?? [] };
    const questions = entry.taskIds
      .map(taskId => this.taskLedger.getTask(taskId)?.question)
      .filter((question): question is string => Boolean(question));
    for (const nid of this.directionalNeighbors(entry.nodeId, this._direction)) {
      for (const question of questions.length ? questions : [`Continue through ${entry.nodeId}`]) {
        this.enqueueHop(nid, question, entry.depth + 1, entry.priority, { carry: forwardedCarry });
      }
    }
  }

  /**
   * The committed-connectivity set K that a prune must not orphan from the origin: every
   * already-analyzed node PLUS every node still queued on the agenda.
   *
   * @remarks
   * A prune is topology-safe only if it leaves every committed node reachable from the origin — analyzed nodes plus agenda-queued ones (a
   * routed-but-unvisited node would otherwise silently vanish from the render). A `declaredRouteIds` member counts only when it is in
   * `scopeNodeIds`, since the reachability walk it feeds is scope-bounded; an out-of-scope endpoint would read as disconnected and refuse unrelated prunes.
   */
  private committedConnectedIds(): Set<string> {
    const ids = new Set<string>(this.memory.notedNodeIds);
    for (const e of this._agenda.entries) ids.add(e.nodeId);
    // A declaration — a contracted route, or (CT) a column_flow entry — still counts as committed, protecting anything reachable only behind it.
    for (const id of this.declaredRouteIds) if (this.scopeNodeIds.has(id)) ids.add(id);
    return ids;
  }

  /**
   * The nodes a prune must leave reachable from the origin: everything the render would keep.
   *
   * @remarks
   * {@link committedConnectedIds} protects only what a hop already analyzed or queued, leaving an in-scope but not-yet-judged node free to be
   * orphaned silently. The set here is every in-scope node less the ones `getResult` drops anyway as undispositioned sinks
   * ({@link undispositionedSinkIds}), so the guard and the render read the same predicate and a prune is refused exactly when it would
   * take a node the answer would otherwise show. Nothing here judges content — orphaning is pure topology.
   *
   * @param extra - Nodes protected for this check alone (routes the same payload staged, which are
   *   not in {@link scopeNodeIds} until commit).
   */
  private protectedFromOrphaning(extra?: Iterable<string>): Set<string> {
    const ids = this.committedConnectedIds();
    const rendered = bfsReachable(this.graph, this.originNodeId!, this.removedSet, undefined, this.scopeNodeIds);
    rendered.add(this.originNodeId!);
    const trimmed = this.undispositionedSinkIds(rendered, this.columnEndpointsOutsideRender(rendered));
    for (const id of this.scopeNodeIds) if (!trimmed.has(id)) ids.add(id);
    for (const id of extra ?? []) ids.add(id);
    return ids;
  }

  /**
   * Decides which prune candidates may be removed without orphaning a protected node.
   *
   * @remarks
   * The one implementation of "would removing this disconnect something the answer keeps", shared by the neighbor prune batch and the focus
   * self-prune. The whole candidate set is exempt from the protected set, so a branch submitted as a unit is judged as one. The all-at-once
   * walk settles the common case in one BFS (reachability is monotone in the removal set); per-candidate walks run only to attribute a failure.
   *
   * @param candidates - Canonical ids the payload proposes to remove, in submission order.
   * @param opts - `extraProtected` widens the protected set and the traversal scope with ids this
   *   payload staged but has not committed; `extraRemoved` carries removals already staged by this
   *   same payload.
   * @returns Accepted ids in submission order, and one refusal per rejected id naming the node its
   * removal would orphan.
   */
  private wouldOrphan(
    candidates: readonly string[],
    opts: { extraProtected?: Iterable<string>; extraRemoved?: Iterable<string> } = {},
  ): { accepted: string[]; refused: Array<{ id: string; orphanId: string }> } {
    if (candidates.length === 0) return { accepted: [], refused: [] };
    const extraProtected = [...(opts.extraProtected ?? [])];
    const protectedIds = this.protectedFromOrphaning(extraProtected);
    const scope = extraProtected.length > 0
      ? new Set<string>([...this.scopeNodeIds, ...extraProtected])
      : this.scopeNodeIds;
    const baseRemoved = new Set<string>([...this.removedSet, ...(opts.extraRemoved ?? [])]);

    const allRemoved = new Set<string>(baseRemoved);
    for (const id of candidates) allRemoved.add(id);
    // Every candidate is inside `allRemoved`, which the walk skips, so the exemption is implicit here.
    if (firstDisconnectedRequiredNode(this.graph, this.originNodeId!, allRemoved, protectedIds, scope) === null) {
      return { accepted: [...candidates], refused: [] };
    }
    const undecided = new Set<string>(candidates);

    const accepted: string[] = [];
    const refused: Array<{ id: string; orphanId: string }> = [];
    const staged = new Set<string>(baseRemoved);
    for (const id of candidates) {
      undecided.delete(id);
      // Still-undecided candidates stay exempt so a branch submitted as a unit is judged as one; a refused candidate protects what sits behind it.
      const required = new Set<string>(protectedIds);
      for (const pending of undecided) required.delete(pending);
      const trial = new Set<string>(staged);
      trial.add(id);
      const orphanId = firstDisconnectedRequiredNode(this.graph, this.originNodeId!, trial, required, scope);
      if (orphanId) {
        refused.push({ id, orphanId });
        continue;
      }
      accepted.push(id);
      staged.add(id);
    }
    return { accepted, refused };
  }

  /**
   * Single funnel for all writes to the agenda.
   *
   * @remarks
   * Enforces the **bipartite agenda rule** by construction: only bodied nodes (view/procedure/function) enter the agenda; non-bodied nodes
   * are *contracted*, forwarding the authored question to their bodied neighbors. `visitedRefs` guards against reference-to-reference cycles.
   *
   * @param targetId - Node to enqueue (or contract).
   * @param question - Authored reason / sub-question for the visit. Preserved verbatim when forwarded.
   * @param depth - Topological depth relative to origin.
   * @param priority - Agenda priority (0 = BFS, 2 = routed, 3 = origin).
   * @param opts - Enqueue modifiers, an options object by design: two of the flags are adjacent
   *   same-typed booleans with different semantics, and a positional transposition would compile
   *   silently while corrupting hop accounting. `carry` is required; every other field is optional.
   */
  private enqueueHop(
    targetId: string,
    question: string,
    depth: number,
    priority: number,
    opts: {
      /**
       * The per-neighbor column decision for this hop (column-trace mode); BB tasks must not carry
       * any columns. Every caller states one explicitly — there is no "no opinion" carry.
       */
      readonly carry: ColumnCarry;
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
      /**
       * CT: whether this enqueue carries an open column-chain end — a column a committed
       * `column_flow` edge attributed to `targetId` itself, or to the carrier `targetId` produces,
       * that no hop has accounted for yet. The one condition under which the visited guard
       * reopens a node instead of dropping the column ({@link reopensColumnChain}).
       */
      readonly openColumnEnd?: boolean;
      /** Existing task to attach instead of creating a new task. */
      readonly existingTaskId?: string;
      /** Parent task assigned when a new task is created. */
      readonly parentTaskId?: string;
      /**
       * Whether this call is the bodied leaf of an accepted route through a non-bodied carrier
       * (a routed table contracts to its bodied writers) and may therefore extend the initial
       * seed after filter checks. Shared walk machinery — BB and CT behave alike.
       */
      readonly admitContractedBodiedTarget?: boolean;
    },
  ): void {
    const {
      carry,
      lineageQuestions,
      visitedRefs = new Set<string>(),
      freshScopeExpansion = !this.scopeNodeIds.has(targetId),
      reactivated = false,
      existingTaskId,
      parentTaskId,
      admitContractedBodiedTarget = false,
      openColumnEnd = false,
    } = opts;
    let reopened = false;
    if (!this.scopeNodeIds.has(targetId) && priority !== 3) {
      const contractedTarget = this.nodeMap.get(targetId);
      const canAdmitContraction = admitContractedBodiedTarget
        && !!contractedTarget
        && SCRIPT_TYPES.has(contractedTarget.type)
        && !this.visited.has(targetId)
        && !this.removedSet.has(targetId)
        && this.checkBorder(targetId, contractedTarget, 'contraction').kind === 'in_border';
      if (!canAdmitContraction) {
        this.log('debug', `[Disposition] enqueue drop ${targetId} — out-of-scope target (priority=${priority}, not deferred) via focus=${this.currentFocusNodeId ?? this.originNodeId ?? '(none)'}`);
        return;
      }
      // A carrier is not a way around the stated border: the node behind it is judged on the same axis, and a breach becomes a lead, not a silent admission.
      const contractionBreach = this.depthBorderBreach(targetId, depth);
      if (contractionBreach !== null) {
        const via = this.currentFocusNodeId ?? this.originNodeId;
        this.log(
          'debug',
          `[Depth] contraction deferred hop=${this.hopCount} id=${targetId} ← ${via ?? '(none)'} `
          + `depth=${contractionBreach} cap=up:${this.depthLimits.upstream}/down:${this.depthLimits.downstream}`,
        );
        if (via) this.recordContractedLead(targetId, via, question);
        return;
      }
      const admittedDepth = this.directedDepthFromOrigin(targetId)?.depth ?? depth;
      this.scopeNodeIds.add(targetId);
      // Bodied by construction (canAdmitContraction asserts SCRIPT_TYPES) — mirror supplementAgenda so the denominator stays source-measured.
      this.bodiedScopeSize++;
      this.depthFromOrigin.set(targetId, admittedDepth);
      this.budgetExpansions.push({ nodeId: targetId, depth: admittedDepth, atHop: this.hopCount });
      this.log('debug', `[Depth] contraction add beyond initial scope id=${targetId} depth=${admittedDepth} hop=${this.hopCount}`);
    }
    if (this.visited.has(targetId) || this.removedSet.has(targetId)) {
      if (!this.reopensColumnChain(targetId, carry, openColumnEnd)) {
        // PRUNE-BEFORE-DEMAND: `openColumnEnd` beside an already-removed node should be unreachable (`validateColumnFlow`'s `pruned_contributor`
        // check rejects a column_flow naming a removed supplier at declare time) — if it fires anyway the demand is genuinely lost, not debug-level.
        const lostDemand = openColumnEnd && this.removedSet.has(targetId);
        this.log(
          lostDemand ? 'warn' : 'debug',
          `[Disposition] enqueue skip ${targetId} — already ${this.removedSet.has(targetId) ? 'removed' : 'visited'}`
          + (lostDemand ? ' — a committed column_flow demand on this node is dropped, not reopened (PRUNE-BEFORE-DEMAND)' : ''),
        );
        return;
      }
      // The earlier visit answered a different question: reopen (same path `supplementAgenda` uses) rather than drop a column that stays owed.
      this.visited.delete(targetId);
      reopened = true;
      this.log('debug', `[CT] reopen ${targetId} — open column chain end via focus=${this.currentFocusNodeId ?? this.originNodeId ?? '(none)'} hop=${this.hopCount}`);
    }
    const node = this.nodeMap.get(targetId);
    if (!node) {
      this.log('debug', `[Disposition] enqueue drop ${targetId} — absent from the loaded graph model`);
      return;
    }

    // Two facts, kept apart by {@link ColumnCarry}: `carry: []` is "none resolve here yet" (recoverable at dispatch), `row_role_only` is the
    // router's own statement of no traced value at all. Collapsing them would let the target set be re-padded onto a node the router excluded.
    const activeColumns = carry.kind === 'carry' ? carry.columns.filter(Boolean) : undefined;
    if (!this.tracer && activeColumns?.length) {
      throw new Error('BB agenda tasks must not carry active columns');
    }
    if (SCRIPT_TYPES.has(node.type)) {
      const task = this.ensureExecutableTask(targetId, question, priority, activeColumns, existingTaskId, parentTaskId);
      const alreadyQueued = this._agenda.has(targetId);
      // Bodied node — push directly (or merge into existing entry).
      this._agenda.push({ taskIds: [task.id], nodeId: targetId, priority, depth, activeColumns: this.agendaColumnsFor(carry, activeColumns), ...(this.carryToRecord(carry)), ...(lineageQuestions?.length ? { lineageQuestions } : {}) });
      // Only grow the denominator on out-of-scope expansion or reactivation, so it matches the approved scope "contract" for normal exploration.
      if (!alreadyQueued && (freshScopeExpansion || reactivated || reopened)) {
        this._totalNodes++;
        const agendaReason = freshScopeExpansion ? 'out-of-scope expansion' : reopened ? 'reopened column chain' : 'reactivated';
        this.log('debug', `[Agenda] enqueue ${targetId} — ${agendaReason} (total +1 → ${this._totalNodes})`);
      }
      return;
    }

    // Non-bodied origins still get an agenda slot; middle non-bodied routes stay contracted.
    if (priority === 3) {
      const task = this.ensureExecutableTask(targetId, question, priority, activeColumns, existingTaskId, parentTaskId);
      // Agenda membership, not scope membership, is the right "will this consume an uncounted hop" oracle: a non-bodied target may be in
      // scope (contracted-through earlier) yet never have had its own agenda slot until now.
      const alreadyQueued = this._agenda.has(targetId);
      this._agenda.push({ taskIds: [task.id], nodeId: targetId, priority, depth, activeColumns: this.agendaColumnsFor(carry, activeColumns), ...(this.carryToRecord(carry)), ...(lineageQuestions?.length ? { lineageQuestions } : {}) });
      if (!alreadyQueued && !SCRIPT_TYPES.has(node.type)) {
        this._totalNodes++;
        this.log('debug', `[Agenda] enqueue ${targetId} — non-bodied direct push (total +1 → ${this._totalNodes})`);
      }
      return;
    }

    // Non-bodied (table, external). Contract the edge: forward the authored question to the target's bodied neighbors in the direction.
    if (visitedRefs.has(targetId)) return;
    visitedRefs.add(targetId);
    // CT-only: `columns` here resolves against the ORIGIN or an earlier carrier, never `targetId` itself — bind it to what this carrier
    // actually declares before it reaches a bodied neighbour. The bind annotates, never gates; the node behind it re-derives its own set at dispatch.
    const ctCarried = this.tracer
      ? this.resolveActiveColumnsForNode(targetId, this.agendaColumnsFor(carry, activeColumns)) ?? []
      : undefined;
    const carried = ctCarried ?? activeColumns;
    // A stated row role survives the contraction: the router judged the whole branch to shape rows, and a carrier cannot upgrade that to a
    // column question. Every other carry forwards its resolved columns as before.
    const forwardedCarry: ColumnCarry = carry.kind === 'row_role_only' ? carry : { kind: 'carry', columns: carried ?? [] };
    this.markNodeState(targetId, 'passthrough', 'engine', 'non_bodied_passthrough', {
      columns: carried,
      ...(carry.kind === 'row_role_only' ? { columnRole: 'row_role_only' as const } : {}),
      viaNodeId: this.currentFocusNodeId ?? this.originNodeId ?? undefined,
      atHop: this.hopCount,
    });
    // An open column end at a non-bodied carrier is answerable only by what writes into it, so the reopen offer travels to its producers only.
    const columnProducers = openColumnEnd ? new Set(this.graph.inNeighbors(targetId)) : null;
    // The carried column itself continues only on the carrier's far side from the node that handed it over; a same-side neighbour is still
    // walked but carries no traced column or chain question (the spine bind at dispatch can still recover one later). Null in BB.
    const columnContinuation = this.tracer ? this.carrierColumnContinuation(targetId) : null;
    for (const nid of this.directionalNeighbors(targetId, this._direction)) {
      // Re-anchor only when the question lands on a bodied focus that continues the carrier's column side; a same-side neighbour gets the
      // plain, unanchored question instead. Suffix wording is prompt-layer-owned: buildPassthroughReAnchor (smPrompts.ts).
      const neighbor = this.nodeMap.get(nid);
      const continues = columnContinuation === null || columnContinuation.has(nid);
      const neighborCarry = continues || forwardedCarry.kind === 'row_role_only' ? forwardedCarry : { kind: 'carry' as const, columns: [] };
      // The suffix is gated on the BRANCH, not the session: it grounds the answer in a traced column, unanswerable on a branch carrying none.
      const reAnchor = continues && neighbor && SCRIPT_TYPES.has(neighbor.type)
        ? buildPassthroughReAnchor(targetId, nid, this.carryAnalysisMode(neighborCarry))
        : '';
      const forwarded = `${question}${reAnchor}`;
      this.enqueueHop(nid, forwarded, depth + 1, priority, { carry: neighborCarry, lineageQuestions: continues ? lineageQuestions : undefined, visitedRefs, parentTaskId, admitContractedBodiedTarget, openColumnEnd: columnProducers?.has(nid) ?? false });
    }
  }

  /**
   * CT: the neighbours of a non-bodied carrier on which a column handed over by the committing
   * focus (the origin at seed time) continues.
   *
   * @remarks
   * A focus that reads the carrier hands over a value the carrier's producers wrote; a focus that
   * writes it hands over a value the carrier's consumers read. A focus that is not adjacent to the
   * carrier, or that both reads and writes it, does not fix a side, and every neighbour keeps the
   * carry.
   *
   * @param carrierId - Canonical id of the non-bodied carrier being contracted.
   * @returns The far-side neighbour ids, or `null` when the side is undetermined.
   */
  private carrierColumnContinuation(carrierId: string): Set<string> | null {
    const senderId = this.currentFocusNodeId ?? this.originNodeId;
    if (!senderId || senderId === carrierId || !this.graph.hasNode(senderId) || !this.graph.hasNode(carrierId)) return null;
    const senderReads = this.graph.hasDirectedEdge(carrierId, senderId);
    const senderWrites = this.graph.hasDirectedEdge(senderId, carrierId);
    if (senderReads === senderWrites) return null;
    return new Set(senderReads ? this.graph.inNeighbors(carrierId) : this.graph.outNeighbors(carrierId));
  }

  /**
   * CT: the non-bodied carriers a node writes — the carriers whose open column ends it owes, by the
   * producer rule {@link enqueueHop} applies when it offers a reopen to a carrier's producers.
   *
   * @param nodeId - Canonical id of the node being dispatched.
   * @returns The written non-bodied neighbour ids; empty when the node writes none.
   */
  private writtenCarrierIds(nodeId: string): Set<string> {
    const carriers = new Set<string>();
    if (!this.graph.hasNode(nodeId)) return carriers;
    for (const nid of this.graph.outNeighbors(nodeId)) {
      const neighbor = this.nodeMap.get(nid);
      if (neighbor && !SCRIPT_TYPES.has(neighbor.type)) carriers.add(nid);
    }
    return carriers;
  }

  /**
   * Whether an already-visited node must be reopened to account for a column left open on the
   * chain, rather than skipped.
   *
   * @remarks
   * The visited guard is a BB rule — one node, one question, one hop. In CT a committed `column_flow` edge can name an already-passed node
   * with a genuinely new question, since the earlier hop's completeness check demanded nothing about this column. Four facts gate the reopen
   * and each is also the termination bound: a committed edge (not a routing opinion) left the column open; the node is not the focus
   * committing right now; it is bodied and not pruned; and {@link nodeStates} shows it was never dispatched with this column.
   *
   * @param targetId - Canonical id of the already-visited node.
   * @param carry - The column decision this enqueue carries to it.
   * @param openColumnEnd - Whether a committed edge left a chain end open at or behind this node.
   * @returns Whether to clear the visited flag and queue the node for one more hop.
   */
  private reopensColumnChain(targetId: string, carry: ColumnCarry, openColumnEnd: boolean): boolean {
    if (!this.tracer || !openColumnEnd || carry.kind !== 'carry') return false;
    if (this.removedSet.has(targetId) || targetId === this.currentFocusNodeId) return false;
    const node = this.nodeMap.get(targetId);
    if (!node || !SCRIPT_TYPES.has(node.type)) return false;
    const owed = computeUnaccounted(
      carry.columns.filter(Boolean),
      this.nodeStates.get(targetId)?.columns ?? [],
    );
    return owed.length > 0;
  }

  /**
   * Resolves the column decision one accepted route carries to its neighbor.
   *
   * @remarks
   * The AI's stated decision is never overridden here; the two channels are combined only where not in tension. `stated: 'none'` alongside a
   * non-empty `flowColumns` is a same-hop self-contradiction rejected before commit (`route_columns_flow_conflict`), so a `row_role_only`
   * carry here always paired with a non-empty `flowColumns` means `stated` was genuinely `undefined` — filled from this hop's own evidence.
   * Actual columns on both channels for the same neighbor are non-conflicting and added together. A `'none'` that contradicts an EARLIER
   * hop's committed spine is still honored as submitted — {@link getHopContext} rebinds the committed column at dispatch so it is not dropped.
   *
   * @param _nodeId - The resolved route target. Unused — this function reads no per-node engine state, kept for call-site symmetry with
   *   {@link enqueueHop}'s other per-neighbor resolvers.
   * @param stated - The route request's own `columns` field as submitted.
   * @param flowColumns - Columns this hop's `column_flow` attributed to the same target, if any.
   * @returns The carry decision to enqueue with.
   */
  private routeCarryFor(_nodeId: string, stated: RouteColumns | undefined, flowColumns: ReadonlySet<string> | undefined): ColumnCarry {
    // `stated` is `undefined` only for a BB-mode route (CT requires `columns` on every route). A BB-mode hop of a CT run still holds a
    // tracer and reads that as `row_role_only`; a plain BB session holds no tracer, so a `row_role_only` carry (tagged CT-only `columnRole`,
    // refused by the BB checkpoint schema) is replaced with an inert empty list.
    const carry = !this.tracer && stated === undefined
      ? { kind: 'carry' as const, columns: [] }
      : columnCarryFromRoute(stated);
    if (!flowColumns || flowColumns.size === 0) return carry;
    if (carry.kind === 'row_role_only') return { kind: 'carry', columns: [...flowColumns] };
    return { kind: 'carry', columns: [...new Set([...flowColumns, ...carry.columns])] };
  }

  /**
   * The analysis mode one branch is dispatched under, read from the carry it is enqueued with.
   *
   * @remarks
   * The dispatch-time counterpart is {@link currentHopAnalysisMode}; this is the same
   * determination made one step earlier, where the only evidence available is the carry.
   *
   * @param carry - The column decision the branch is enqueued with.
   * @returns `ct` when the branch may still carry a traced column, `bb` when it carries none.
   */
  private carryAnalysisMode(carry: ColumnCarry): 'bb' | 'ct' {
    return this.hopModeFromColumnList(carry.kind === 'row_role_only' ? [] : carry.columns);
  }

  /** Empty or absent columns (or no tracer) dispatch as BB; a named column set is CT. */
  private hopModeFromColumnList(columns: readonly string[] | undefined): 'bb' | 'ct' {
    if (!this.tracer) return 'bb';
    return (columns?.filter(Boolean).length ?? 0) > 0 ? 'ct' : 'bb';
  }

  /**
   * Projects the authored carry decision onto an agenda entry, when there is one worth persisting.
   *
   * @remarks
   * BB entries never record one: the mode has no column channel, and the snapshot schema refuses
   * the field on a BB agenda.
   *
   * @param carry - The caller's column decision for this hop.
   * @returns A spreadable `columnCarry` fragment, or an empty object.
   */
  private carryToRecord(carry: ColumnCarry): { columnCarry?: ColumnCarry } {
    if (!this.tracer) return {};
    return { columnCarry: carry.kind === 'carry' ? { kind: 'carry', columns: [...carry.columns] } : carry };
  }

  /**
   * Projects the agenda entry's persisted `activeColumns` for one CT hop.
   *
   * @remarks
   * When the caller states no column opinion, the agenda entry still carries the tracer's non-empty target columns, copied (never handed
   * out by reference) so one hop's edit cannot rewrite the frozen target set the CT checkpoint invariant compares against.
   */
  private agendaColumnsFor(carry: ColumnCarry, activeColumns: string[] | undefined): string[] | undefined {
    // The enqueue guard upstream throws before a BB entry can reach here with columns.
    if (!this.tracer) return undefined;
    // A stated row role is the one carry the target set must not fill in: `[]` keeps the CT snapshot invariant satisfied without padding one back on.
    if (carry.kind === 'row_role_only') return [];
    if (activeColumns !== undefined) return activeColumns;
    const fallback = this.tracer.targetColumns;
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
    return this.taskLedger.ensureTask(this.taskInputFor({
      source: priority === 2 ? 'model' : 'engine',
      question,
      nodeId,
      parentTaskId,
      createdHop: this.hopCount,
    }, 'analytical', activeColumns));
  }

  /**
   * Collects neighboring node attributes for evaluation during hop routing.
   *
   * @param focusId - Central node identifier to derive neighbor connections from.
   * @returns Array of metadata structures matching neighbor hop properties.
   */
  private buildNeighborList(focusId: string): HopNeighborDisclosure[] {
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
      // CT only: the spine already staged for this neighbour as an `upstream_columns` supplier on an earlier hop, surfaced ahead of the
      // model's own decision so it can state `columns: 'none'` knowing the consequence, or route with the attributed columns and avoid it.
      const attributedColumns = this.tracer
        ? this.tracer.determineActiveColumnsForCandidate(nid, [], undefined, this.log, this.columnTraceDirection())
        : [];
      const neighbor: HopNeighborDisclosure = {
        id: nid, s: n.schema, n: n.name, t: n.type,
        edge_direction: inSet.has(nid) ? 'upstream' : 'downstream',
        edge_type: edgeVerb.get(nid) ?? 'read', boundary, ...(cols?.length ? { cols } : {}),
        // Engine decisions already taken about this neighbour, stated before the model acts rather than as a rejection after it.
        ...(this.declaredRouteIds.has(nid) ? { prune_protected: true } : {}),
        ...(this.visited.has(nid) ? { already_visited: true } : {}),
        ...(this.removedSet.has(nid) ? { already_removed: true } : {}),
        ...(attributedColumns.length ? { attributed_columns: attributedColumns } : {}),
      };

      const d = this.depthFromOrigin.get(nid);
      if (d !== undefined) neighbor.depth_from_origin = d;
      neighbor.in_budget = this.scopeNodeIds.has(nid);

      // Display annotation: `display` tests type-exclusion + allowlist only. `out_of_allowlist` only fires when a schema filter is active.
      const displayBorder = this.checkBorder(nid, n, 'display');

      // One statement of the allowlist axis, so the flag and the action-required signal below cannot disagree.
      if (hasSchemaFilter) {
        neighbor.in_approved_scope = displayBorder.kind !== 'out_of_allowlist';
      }

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
   * Collects the column-edge endpoints the render does not hold.
   *
   * @remarks
   * A hop's read source or write target one hop past the border is a correct answer that is simply not a render member, so the delivered
   * chain can name something the panel never draws. These endpoints are the one class the sink disposition never sees on its own, since it
   * only iterates the render. Empty in BB, where there is no tracer at all.
   *
   * @param render - The render set membership is tested against.
   * @returns Endpoint ids outside the render, usually empty.
   */
  private columnEndpointsOutsideRender(render: ReadonlySet<string>): Set<string> {
    const outside = new Set<string>();
    for (const edge of this.tracer?.edges ?? []) {
      if (!render.has(edge.from_node)) outside.add(edge.from_node);
      if (!render.has(edge.to_node)) outside.add(edge.to_node);
    }
    return outside;
  }

  /**
   * Selects the nodes no hop dispositioned that the render reaches only as a write sink.
   *
   * @remarks
   * Scope admits a node; only a hop dispositions one. A node with no investigation task, no column-aspect edge endpoint, and no
   * {@link nodeStates} entry was never analyzed, routed, contracted through or pruned — it is in the render only because BFS reachability
   * walked into it. Such a node that also supplies nothing the render keeps (every edge into it is written-to or EXEC'd) is a side-effect
   * sink, not answer evidence; peeling is iterative, so a sink chain goes as a unit. A node that *supplies* a rendered node stays — a
   * candidate carrying the only path to a kept node is a passthrough, not a sink, and is restored.
   *
   * @param reachable - The reachability-bounded render set to classify.
   * @param columnBorder - Column-edge endpoints the render does not hold ({@link columnEndpointsOutsideRender}), classified against the
   *   same contract with two differences from `reachable`: an engine-written `non_bodied_passthrough` on a committed edge is not retention
   *   evidence (treated as absent), and a border node's membership bypasses `removedSet`, so a prune that pulled it out of the render can
   *   still leave it named on a committed edge — routed through the sink check here, the one case a prune verdict does not already answer.
   * @returns Ids to drop; reachable ones leave the render, border ones leave the delivered chain.
   */
  private undispositionedSinkIds(reachable: ReadonlySet<string>, columnBorder: ReadonlySet<string>): Set<string> {
    const candidates: string[] = [];
    for (const id of [...reachable, ...columnBorder]) {
      if (id === this.originNodeId) continue;
      const state = this.nodeStates.get(id);
      const onBorder = columnBorder.has(id);
      const engineRecord = onBorder && state?.source === 'engine';
      const borderPruned = onBorder && state?.action === 'prune';
      // Any hop verdict is BB retention; `engineRecord`/`borderPruned` are the CT add — neither is a hop's own retention verdict, but both classify by the same sink rule.
      if (state !== undefined && !engineRecord && !borderPruned) continue;
      if (this.taskLedger.investigationTasks.some(task => task.nodeId === id)) continue;
      if (!onBorder && this.tracer?.edges.some(edge =>
        edge.from_node === id || edge.to_node === id || edge.hop_node === id)) continue;
      candidates.push(id);
    }
    if (candidates.length === 0) return new Set();

    const render = new Set(reachable);
    const sinks = new Set<string>();
    for (let peeled = true; peeled;) {
      peeled = false;
      for (const id of candidates) {
        if (sinks.has(id)) continue;
        if (this.model.edges.some(e => e.source === id && render.has(e.target))) continue;
        sinks.add(id);
        render.delete(id);
        peeled = true;
      }
    }

    // Each pass restores at least one candidate, so the sink count bounds the loop.
    let stranded: string[] = [];
    for (let pass = sinks.size; pass >= 0; pass--) {
      const kept = bfsReachable(this.graph, this.originNodeId!, new Set([...this.removedSet, ...sinks]), undefined, this.scopeNodeIds);
      stranded = Array.from(reachable).filter(id => !sinks.has(id) && !kept.has(id));
      if (stranded.length === 0) return sinks;
      for (const id of stranded) for (const nid of this.graph.neighbors(id)) sinks.delete(nid);
    }
    // Unreachable while the restore above converges; conservation outranks the trim either way.
    this.log('debug', `[Disposition] sink trim abandoned — ${stranded.length} node(s) still stranded (${trunc(stranded.join(', '), 200)})`);
    return new Set();
  }

  /**
   * Packages exploration records into the final presentation topology.
   *
   * @returns Detailed analysis metrics matching the outcome format.
   */
  public getResult(): SmResult {
    const mem = this.memory.getResult();

    // Result scope is the approved BFS scope in both modes. The tracer's edges drive emphasis and flow-role grouping; they never bound the answer.
    const reachableNodeIds = bfsReachable(this.graph, this.originNodeId!, this.removedSet, undefined, this.scopeNodeIds);
    const finalNodeIds = new Set<string>(reachableNodeIds);
    finalNodeIds.add(this.originNodeId!);

    // Drop the sinks no hop dispositioned, and classify the column-edge endpoints one hop past the border by the same contract, so the
    // delivered chain cannot name a terminal write sink the render already refused to draw.
    const columnBorder = this.columnEndpointsOutsideRender(finalNodeIds);
    const undispositioned = this.undispositionedSinkIds(finalNodeIds, columnBorder);
    // The two inputs are disjoint by construction, so the verdict splits back apart exactly: a node that was never drawn is not a drop from the drawing.
    const borderSinks = new Set<string>();
    for (const id of columnBorder) if (undispositioned.delete(id)) borderSinks.add(id);
    // Recorded on every call so a snapshot taken after this one describes this render, not an earlier one.
    this.renderDroppedIds = new Set(undispositioned);
    if (borderSinks.size > 0) {
      this.log('debug', `[Disposition] getResult withholds ${borderSinks.size} column-chain endpoint(s) — ${trunc(Array.from(borderSinks).join(', '), 200)} (past the render border, never analyzed, routed, contracted or pruned, and supplying nothing the render keeps)`);
    }
    if (undispositioned.size > 0) {
      for (const id of undispositioned) finalNodeIds.delete(id);
      this.log('debug', `[Disposition] getResult drops ${undispositioned.size} undispositioned sink node(s) — ${trunc(Array.from(undispositioned).join(', '), 200)} (in scope, never analyzed, routed, contracted or pruned, and supplying nothing the render keeps)`);
    }

    // A prune can orphan a scope node the don't-orphan guard does not protect (never analyzed, never queued); such a node leaves the render
    // through the reachability bound above with no prune of its own and no detail slot, so it is recorded and logged here, once.
    const orphaned = Array.from(this.scopeNodeIds).filter(
      id => !finalNodeIds.has(id) && !this.removedSet.has(id) && !undispositioned.has(id));
    if (orphaned.length > 0) {
      for (const id of orphaned) this.renderDroppedIds.add(id);
      this.log('debug', `[Disposition] getResult drops ${orphaned.length} scope node(s) unreachable from origin under removedSet — ${trunc(orphaned.join(', '), 200)} (orphaned by a prune; never dispositioned themselves)`);
    }

    // Conservation backstop: under the invariants this delta is empty; if not, an analyzed node's detail slot is about to be silently
    // dropped from the render — log it. The sink trim above names its own drops, so they are not double-counted here.
    const droppedSlots = mem.detail_slots.filter(slot => !finalNodeIds.has(slot.nodeId) && !undispositioned.has(slot.nodeId));
    if (droppedSlots.length > 0) {
      this.log('debug', `[Disposition] getResult drops ${droppedSlots.length} analyzed detail slot(s) unreachable from origin under removedSet/scope — ${trunc(droppedSlots.map(s => s.nodeId).join(', '), 200)} (conservation delta; expected empty)`);
    }

    const finalEdges: Array<[string, string, string]> = [];
    for (const e of this.model.edges) {
      if (finalNodeIds.has(e.source) && finalNodeIds.has(e.target)) {
        finalEdges.push([e.source, e.target, edgeApiType(e.type, this.nodeMap.get(e.source)?.type ?? '')]);
      }
    }

    // bfsDepthMap walks source->target only, so an undirected walk on an upstream trace would collapse the whole ancestor chain past
    // maxDepth. The skeleton groups render stages, not a flow claim (direction is stated separately by buildDirectionLines), so the
    // grouping walk here is fed both edge directions; bfsDepthMap's own directed contract and tests are untouched.
    const symmetrizedEdges: Array<[string, string, string]> = [];
    for (const [s, t, ty] of finalEdges) { symmetrizedEdges.push([s, t, ty], [t, s, ty]); }
    const depthMap = bfsDepthMap(symmetrizedEdges, this.originNodeId!);
    const sortedIds = Array.from(finalNodeIds).sort((a, b) => (depthMap.get(a) ?? 999) - (depthMap.get(b) ?? 999));

    const sections: Array<{ label: string; node_ids: string[] }> = [];
    const maxDepth = Math.max(...Array.from(depthMap.values()), 0);
    for (let i = 0; i <= maxDepth; i++) {
      const idsAtDepth = sortedIds.filter(id => depthMap.get(id) === i);
      if (idsAtDepth.length > 0) {
        sections.push({ label: i === 0 ? 'Origin' : `Stage ${i}`, node_ids: idsAtDepth });
      }
    }
    // A retained node with no edge in finalEdges never enters the walk above; the skeleton's
    // contract is to bucket every rendered node, so the remainder is appended as "Unconnected"
    // rather than silently dropped.
    const unbucketed = sortedIds.filter(id => !depthMap.has(id));
    if (unbucketed.length > 0) {
      sections.push({ label: 'Unconnected', node_ids: unbucketed });
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
      columnAspect: this.tracer?.deliveredState(borderSinks) ?? null,
      // CT focus nodes the AI pruned (verdict=prune -> no column flow).
      ...(this.tracer ? { ctPrunedNodeIds: Array.from(this.ctPrunedFocusIds) } : {}),
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
      // Mode-independent: the sink trim bounds the render in BB and CT alike.
      ...(this.renderDroppedIds.size > 0 ? { renderDroppedNodeIds: Array.from(this.renderDroppedIds) } : {}),
      // Mode-independent: an accepted route declares its target in BB and CT alike. `ct`-prefixed key name frozen by stored runs (navigationSnapshotSchema.ts).
      ctDeclaredRouteIds: Array.from(this.declaredRouteIds),
      ...(this.tracer ? {
        // The in-flight hop's own questions (set from its AgendaEntry at dispatch), not a fresh recompute — that would describe the wrong hop on a mid-hop resume.
        lineageQuestionsLastHop: [...this._pendingLineageQuestions],
        ctPrunedNodeIds: Array.from(this.ctPrunedFocusIds),
      } : {}),
    };
    try {
      return parseNavigationSnapshot(snapshot);
    } catch (err) {
      // A rejection here is an internal invariant violation, not model/user behavior. issuePaths only (no checkpoint values) so the line stays safe to persist.
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
      if (internals.depthEnforcement !== 'silent') {
        log('debug', `[Depth] normalized legacy checkpoint authority enforcement=${internals.depthEnforcement} to seed-only routing`);
      }
      engine.depthEnforcement = 'silent';
    }
    engine.depthFromOrigin = new Map(internals.depthFromOrigin);
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
    // CT continuation state lives at the top level, not in engineInternals; without it a resumed session re-dispatches pruned focus nodes.
    engine._pendingLineageQuestions = [...(snapshot.lineageQuestionsLastHop ?? [])];
    engine.ctPrunedFocusIds = new Set(snapshot.ctPrunedNodeIds ?? []);
    // Absent on a checkpoint written before this set was persisted — restores as empty rather than inventing declarations the run never made.
    engine.declaredRouteIds = new Set(snapshot.ctDeclaredRouteIds ?? []);
    // Absent on a checkpoint written before the field existed, or on one whose last render dropped nothing — both mean "no recorded drop".
    engine.renderDroppedIds = new Set(snapshot.renderDroppedNodeIds ?? []);

    return engine;
  }
}
