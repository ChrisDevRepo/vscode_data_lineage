import type { InvalidRoute, DepthIntent, HeldSubmissionParts } from './smTypes';
import { buildRouteValidationRejection, routeRejectionDetail, routeRejectionDirectives, routeRejectionReason } from './smRouteValidation';
import { activeSubmitFindingsRecoveryHint, extractRawSectionAngles, validateSectionsAgainstClassification } from '../interaction/rules/submitFindingsRules';
import { COLUMN_FLOW_NOTE_MAX, SUBMIT_FINDINGS_BADGE_LABEL_MAX, findingRepairOrder, validateHopSubmissionShape, type SubmitFindingsHopColumns } from '../tools/toolSchemas';

import type Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path/unweighted';
import { bfsFromNode } from 'graphology-traversal';
import type { DatabaseModel, LineageNode } from '../../engine/types';
import type { ColumnStore } from '../../engine/columnStore';
import { ASYMMETRIC_DEPTH_BOTH_ZERO, bothSidesClosed, directionFromDepth, type DepthSideValue } from '../../engine/shared/explorationDepthContract';
import type { SerializedFilterState } from '../../engine/projectStore';
import { buildEdgeTypeMap, buildHopFocusNode, buildUnrelatedMap } from '../tools/tools';
import { buildNodeMap, getNodeColumns, getNodeDdl, SCRIPT_TYPES } from '../support/graphUtils';
import { edgeApiType, presentColumnCompact } from '../support/aiPresenter';
import { analyzeRemoval, bfsReachable, type LogFn, type RemovalAnalysis } from '../../engine/graphGuards';
import { trunc, LOG_TRUNC_CONTENT, LOG_TRUNC_LIST } from '../../utils/log';
import { compileExclusionMatcher, normalizeColName, quoteIdentifier, schemaKey } from '../../utils/sql';
import { AiMemoryManager, type DetailSlot, type IncomingQuestion, type WorkingMemory } from '../session/memoryManager';
import { CLASSIFICATION_KEPT_ANGLES, type ClassificationValue } from '../session/classification';
import { RepairDraftStore } from '../support/repairDraftStore';
import { resolveModelNodeId } from '../support/modelReferences';
import { evaluateCurrentHopActionPolicy, type CurrentHopActionTarget } from './currentHopActionPolicy';
import type { ApprovedBorder, ColumnAspect, ColumnCarry, ColumnEdge, ScalarReturnTarget, FunctionCallerContext, DeferredQuestion, DiagnosticsSnapshot, EngineInitSnapshot, EngineInternalsSnapshot, HopContext, HopNeighbor, HopProgress, HopFindingKept, HopSubmission, InvestigationTask, NavigationInitParams, PendingLead, PrunedBranch, RouteOutcome, RouteSkipDisposition, ScopeExclusionGroup, ScopeExclusions, ScopeSummary, ScopeSummaryLeaf, SmNodeAction, SmNodeColumnRole, SmNodeState, SmNodeStateReason, SmNodeStateSource, SmResult, SmState, SmStatus, SubmitResult, SupplementChain, SupplementSkip } from '../sm/smTypes';
import { estimateTokens, type ProposedScope } from '../support/tokenBudget';
import { ColumnTracer, columnAttachment, columnClosure, columnEndpointKeyFactory, resolveColumnFlowTarget } from "./columnTracer";
import { AgendaManager, type AgendaEntry, type WorklistView } from './agendaManager';
import { TaskLedger, type InvestigationTaskInput } from './taskLedger';
import { resolveScalarReturnTarget, resolveFunctionCallerTarget, functionCallerDdlHash, uniqueScalarReturnTargets } from './scalarReturnBinding';
import { parseNavigationSnapshot, InvalidEngineCheckpointError } from './navigationSnapshotSchema';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { makeRejection, type ToolRejection } from '../support/toolErrorEnvelope';

/** A hop neighbour plus the engine decisions already taken about it. */
export interface HopNeighborDisclosure extends HopNeighbor {
  /** A neighbor already passed through on the route into this focus, protected by the visit-once rule. */
  prune_protected?: boolean;
  /** Already analyzed on an earlier hop; a prune cannot remove committed analysis. */
  already_visited?: boolean;
  /** Already pruned on an earlier hop; a removed node stays removed. */
  already_removed?: boolean;
  /** Columns a committed `column_flow` edge attributes to this neighbour, as evidence only. */
  attributed_columns?: string[];
  /** This neighbour is unreachable from the origin in the approved direction (a downstream write target during an upstream-only run, or the reverse), in BB and CT alike. In a bidirectional session it marks a neighbour outside both the upstream and the downstream closure of the origin, reached only sideways through a shared node. An out-of-direction neighbour is never visited, and a prune on it is a no-op. */
  out_of_direction?: boolean;
  /** An open target can receive an in-scope subquestion or an out-of-scope deferred proposal. */
  can_question: boolean;
  /** A queued, visited, removed or protected target cannot be neighbor-pruned. */
  can_prune: boolean;
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
  /** Checkpoint projection of the live enforcement mode — `strict` when any side has a finite exact depth, `silent` otherwise. */
  depth_enforcement?: 'strict' | 'silent';
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

/** User-facing reason when a queued function investigation no longer matches its caller declaration. */
const CALLER_CONTEXT_CHANGED = "Exploration stopped: a queued function investigation no longer matches its caller's loaded SQL or column. Start a new analysis.";
/** User-facing reason when a queued scalar return no longer matches its caller's compiler-declared binding. */
const SCALAR_BINDING_CHANGED = "Exploration stopped: a queued scalar function return no longer matches its caller's declared column binding. Start a new analysis.";
/** User-facing reason when a queued column investigation carries no qualified source column. */
const COLUMN_SOURCE_MISSING = 'Exploration stopped: a queued column investigation has no qualified source column to continue from. Start a new analysis.';

/** Why an invalid removal proposal is refused; the disconnected-analysis wording is reserved for a valid one that cuts visited support. */
const REMOVAL_REFUSAL: Record<NonNullable<RemovalAnalysis['rejection']>, string> = {
  'origin': 'not removed — the origin is never pruned.',
  'invalid-scope': 'not removed — it is outside the approved scope, so there is nothing to prune.',
  'unknown-node': 'not removed — it is not in the loaded model, so there is nothing to prune.',
  'visited': 'not removed — it is retained by committed analysis or a column mapping.',
};
/** Fields of a held finding draft besides its section angles. Each is one part: a retry that sends it replaces the held value whole (`[]` clears a held list), and a retry that omits it keeps the held value. An empty `summary` counts as omitted. */
const HELD_FIELDS = ['summary', 'badge_label', 'prune_neighbors', 'questions', 'column_flow', 'terminated_inputs'] as const;
type HeldField = typeof HELD_FIELDS[number];

/** Splits dotted issue paths into the parts a rejection fails: `sections.<angle>` fails that angle, and any other path fails its whole top-level field (`questions.1.nodeId` fails `questions`). */
function splitFailedParts(paths: readonly string[]): { readonly fields: Set<string>; readonly angles: Set<string> } {
  const fields = new Set<string>();
  const angles = new Set<string>();
  for (const path of paths) {
    const [top, second] = path.split('.');
    if (!top) continue;
    if (top === 'sections' && (second === 'business' || second === 'technical')) angles.add(second);
    else fields.add(top);
  }
  if (fields.has('sections')) angles.clear();
  return { fields, angles };
}

/** A section angle's merge key. */
const angleKey = (section: { angle?: string }): string => section.angle ?? '';

/** Defines the core interface for the state machine handling exploration modes. */
export interface IHopStateMachine {
  /** The current status of the state machine. */
  readonly status: SmStatus;
  /** The size of the current exploration scope. */
  readonly scopeSize: number;
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
  /** Neighbours removed by a resolved AI prune, with the sender's reason. */
  readonly prunedBranches: ReadonlyArray<PrunedBranch>;
  /** Current focus node id (node the AI must analyse this hop) — null before the first hop. */
  readonly currentFocus: string | null;
  /** Live hop progress: completed AI hops, queued nodes, and total acknowledged nodes. */
  readonly hopProgress: HopProgress;

  /** Publishes validated isolated engine memory into the session's stable memory object. */
  publishMemoryTo(target: AiMemoryManager): void;

  /** Current hop context for the engine. */
  getHopContext(): HopContext;

  /** Submits the findings for the current step and calculates the next state. */
  submitFindings(params: HopSubmission): SubmitResult;

  /** Whether every active task reached this nonroot SQL hop through storage without a committed mapping. */
  readonly canPruneCurrent: boolean;

  /** Removes an unrelated candidate focus through the shared atomic removal policy. */
  pruneCurrent(focusNodeId: string, reason: string): SubmitResult;

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

  /** Every captured detail slot in insertion order. */
  getDetailSlots(): DetailSlot[];

  /** Extends a completed exploration with additional nodes for analysis. */
  supplementAgenda(nodeIds: string[], leadIds?: string[], chain?: SupplementChain): { ok: true; agendaed: number; skipped: number; skippedDetails: SupplementSkip[] } | ToolRejection;
}

/** The write path a border test serves. Every purpose tests the exclusion sets; `route` also tests approved-direction reachability, while `supplement` (an already-surfaced lead) and `seed_bfs` (the walk that defines the direction) do not. */
type BorderPurpose = 'route' | 'supplement' | 'seed_bfs';

/** First failing border axis for a candidate node, or `in_border` when it clears every participating axis. A discriminated verdict (not a boolean bag) so a caller can route each outcome distinctly — e.g. the route path rejects `excluded` but *defers* `out_of_direction`. */
type BorderVerdict =
  | { kind: 'in_border' }
  | { kind: 'excluded'; axis: 'type' | 'schema' | 'node_id' }
  | { kind: 'out_of_direction' };

/** Combined border + depth admission test for one route candidate. A record, not a boolean: the two axes are reported to the model differently (schema gate name vs level count), so callers that need the distinction read the axes while others read only `admitted`. */
type RouteAdmission = {
  /** First failing border axis, or `in_border`. */
  border: BorderVerdict;
  /** Breaching depth when a depth ceiling the user fixed is crossed, otherwise `null`. */
  depthBreach: number | null;
  /** True only when both axes clear: the router would accept a route to this node now. */
  admitted: boolean;
};

/** Follow-up lead reason for each deferral reason — exhaustive, so no reason falls through. */
const LEAD_REASON_BY_DEFERRAL: Readonly<Record<DeferredQuestion['reason'], PendingLead['reason']>> = {
  schema: 'schema_boundary',
  depth: 'depth_boundary',
  direction: 'out_of_direction',
  excluded: 'excluded',
};

/** Deferral reason of each lead reason the live engine records. */
const DEFERRAL_BY_LEAD_REASON: ReadonlyMap<PendingLead['reason'], DeferredQuestion['reason']> = new Map(
  (Object.entries(LEAD_REASON_BY_DEFERRAL) as Array<[DeferredQuestion['reason'], PendingLead['reason']]>).map(([deferral, lead]) => [lead, deferral]),
);

/** Copies an agenda entry so a snapshot and the live agenda never share an array. */
function cloneAgendaEntry(entry: AgendaEntry): AgendaEntry {
  return structuredClone(entry);
}

/** One qualified continuation arriving at a node: the source endpoints it carries and its routing leg. */
interface ContinuationLeg {
  sourceRefs: ScalarReturnTarget[];
  traversalSide: 'upstream' | 'downstream';
}

/** Everything {@link NavigationEngine.submitFindings} validated and staged, handed to the commit step unchanged. */
interface ValidatedHop {
  focusId: string;
  finding: HopFindingKept;
  /** Authored neighbor questions, or inherited questions on an explicit passthrough. */
  routeRequests: Array<{ nodeId: string; question: string; callerContext?: FunctionCallerContext }>;
  /** Generated CT instructions accompany, never replace, the authored investigation purpose. */
  flowQuestionByNode: Map<string, string>;
  routeOutcomes: RouteOutcome[];
  acceptedNids: Set<string>;
  scopeAddNids: Set<string>;
  deferredRoutes: Array<{ nodeId: string; schema: string; question: string; reason: DeferredQuestion['reason']; depth: number | undefined }>;
  prunedNeighborNids: Set<string>;
  /** CT carry derived from this hop's column_flow: node → tracked columns it carries. */
  carryByNode: Map<string, Set<string>>;
  /** Qualified context and directed carrier leg of each accepted continuation. */
  routeContexts: Map<string, ContinuationLeg[]>;
  stagedSections: Parameters<AiMemoryManager['storeDetail']>[1];
  stagedDetailChars: number;
  stagedSummaryChars: number;
  stagedColumnEdges: ColumnEdge[];
  stagedColumnFlowEntries: number;
}

/** Unified Navigation Engine — the core state machine for all exploration modes. */
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
  /** Gate-locked mission-type classification (`business`|`technical`|`both`) — the AI's own verdict, declared as a required field on the `start_exploration` proposal and Zod-validated before the gate can approve. */
  public classification?: ClassificationValue;
  /** The operational status of the state machine. */
  protected _status: SmStatus = 'created';
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
  /** A neighbor prune not yet resolved: nodeId → each sender's own vote on its edge into the node (`'prune'` from `prune_neighbors`, `'keep'` from an ordinary route, a question, or — CT — a `column_flow` reference). One sender casts at most one ballot, keyed by its own focus id, so a reactivated sender's fresh verdict replaces its own earlier one rather than adding a second vote — {@link tryResolvePrunes} removes the node only once every live sender has finished and every recorded ballot reads `'prune'`, or when the agenda empties. Checkpoints preserve accepted ballots so resuming does not change a shared node's fate. */
  private pruneBallots = new Map<string, Map<string, 'prune' | 'keep'>>();
  /** Removals since the last hop commit began, reported in that commit's acknowledgement ({@link commitRemovals}). */
  private hopRemovals: { pruned: string[]; cut_ids: string[] } = { pruned: [], cut_ids: [] };
  /** Engine-owned lifecycle state for nodes; detail slots are content storage only. */
  protected nodeStates = new Map<string, SmNodeState>();
  /** List representing the current navigation agenda. */
  protected _agenda: AgendaManager;
  /** Explicit user follow-up targets admitted after a completed exploration. */
  private supplementNodeIds = new Set<string>();
  /** Structured source of truth for questions and follow-up leads. */
  private readonly taskLedger: TaskLedger;
  /** Identifier of the node currently in focus. */
  protected currentFocusNodeId: string | null = null;
  /** Active task-ledger question captured at dequeue so it can label the detail slot. */
  protected currentFocusQuestion: string | null = null;
  /** Stable tasks currently being answered by the focus node's single hop. */
  protected currentFocusTaskIds: string[] = [];
  /** Total number of hops executed. */
  protected hopCount = 0;
  /** Hops whose findings were committed; {@link hopCount} also counts a dispatched focus not yet submitted. */
  private committedHops = 0;
  /** Why the engine entered `error` on a live invariant failure, phrased for the user. */
  private _errorReason: string | null = null;
  /** Total acknowledged nodes: initialised to the scope size at gate approval, +1 on out-of-scope expansion or reactivation, −1 on prune. */
  private _totalNodes = 0;
  /** Breadth-first search depth for nodes from the origin. */
  protected depthFromOrigin = new Map<string, number>();
  /** The configurable depth budget. */
  protected depthBudget: number | null = null;
  /** Both sides unbounded — the default depth ceiling. Never mutated in place (only ever reassigned wholesale), so instances may safely share this one frozen object. */
  private static readonly UNBOUNDED_DEPTH_LIMITS: { upstream: number; downstream: number } = Object.freeze({
    upstream: Number.POSITIVE_INFINITY,
    downstream: Number.POSITIVE_INFINITY,
  });
  /** Per-side depth ceilings from the approved intent; `Infinity` where that side is unbounded. A side at `levels: 0` is `0` whatever its exactness. */
  protected depthLimits: { upstream: number; downstream: number } = NavigationEngine.UNBOUNDED_DEPTH_LIMITS;
  /** Whether the approved depth is a hard border (`'strict'`) or an initial seed the model may grow (`'silent'`). Set from the AI's own `depthIntent`: an `'exact'` side binds and a `levels: 0` side is always closed; an open `'approximate'` side does not bind. */
  protected depthEnforcement: 'strict' | 'silent' = 'silent';
  /** Resolves the per-side ceilings, published budget and enforcement of an approved depth intent. */
  private static resolveDepthBorder(depthIntent: DepthIntent): {
    limits: { upstream: number; downstream: number };
    budget: number | null;
    enforcement: 'strict' | 'silent';
  } {
    const sideCap = (side: DepthSideValue): number => {
      if (side.levels !== 0 && side.exactness !== 'exact') return Number.POSITIVE_INFINITY;
      return side.levels === 'all' ? Number.POSITIVE_INFINITY : side.levels;
    };
    const limits = { upstream: sideCap(depthIntent.upstream), downstream: sideCap(depthIntent.downstream) };
    const bothFinite = Number.isFinite(limits.upstream) && Number.isFinite(limits.downstream);
    return {
      limits,
      budget: bothFinite ? Math.max(limits.upstream, limits.downstream) : null,
      enforcement: Number.isFinite(limits.upstream) || Number.isFinite(limits.downstream) ? 'strict' : 'silent',
    };
  }
  /** Directed distance from the origin to every reachable node, per side; cleared whenever the BFS seed is recomputed and refilled on the next depth read ({@link ensureDirectedDepths}). */
  private directedDepths = new Map<string, { upstream?: number; downstream?: number }>();
  /** Whether {@link directedDepths} holds the current seed's walk; false until the next fill. */
  private directedDepthsFilled = false;
  /** History of explicit AI expansions beyond the initial BFS seed. */
  protected budgetExpansions: Array<{ nodeId: string; depth: number; atHop: number }> = [];

  /** Submission held after a rejection a retry can correct without re-authoring the analysis — a schema rejection in the `submit_findings` handler ({@link holdRejectedSubmission}), a route/column fault, or a field over its length cap — so {@link applyHeldContent} restores what the retry omits. Other rejections never establish held state. */
  private readonly heldFindingDraft = new RepairDraftStore<HopFindingKept, { readonly failed: readonly string[]; readonly focusId: string; readonly hop: number; readonly mode: 'bb' | 'ct' }>();

  /** Exploration direction set by `init`; consulted by `enqueueHop` when contracting reference nodes. */
  protected _direction: 'upstream' | 'downstream' | 'bidirectional' = 'bidirectional';

  /** Schemas (lower-cased) in the user's active filter. */
  protected userSchemas: Set<string> = new Set();
  /** Schemas the approved border admits, as reported in diagnostics and the approved border; the exclusion sets enforce it. Starts as a copy of {@link userSchemas}; `init` adds the origin's schema and every GUI-hidden schema the proposal's `excludeSchemas` no longer excludes. */
  protected sessionAllowedSchemas: Set<string> = new Set();
  /** Object types the user asked to exclude (e.g. ['view','function']); pruned from scope at init. */
  protected excludedTypes: Set<string> = new Set();
  /** Schemas (lower-cased) the user asked to exclude; pruned from scope at init. */
  protected excludedSchemas: Set<string> = new Set();
  /** Specific node ids (lower-cased) the user asked to exclude; pruned from scope at init. */
  protected excludedNodeIds: Set<string> = new Set();
  /** Object types hidden by the GUI filter at session start; the default `excludeTypes` of a proposal that states none. */
  protected guiHiddenTypes: Set<string> = new Set();
  /** Schemas (lower-cased) hidden by the GUI filter at session start — the complement of {@link userSchemas} over every schema in the loaded model. Seeds a fresh proposal's default `excludeSchemas` ({@link getGuiHiddenSchemas}); never enforced on its own. */
  protected guiHiddenSchemas: Set<string> = new Set();
  /** Node ids (lower-cased) matching a GUI exclusion pattern at session start. Seeds a fresh proposal's default `excludeNodeIds` ({@link getGuiExcludedNodeIds}); never enforced on its own. */
  protected guiExcludedNodeIds: Set<string> = new Set();
  /** Each GUI exclusion pattern that compiles, in filter order, with its own node predicate — attributes an excluded object to the rule that matched it ({@link getScopeSummary}). */
  private readonly guiExclusionRules: Array<{ pattern: string; matches: (node: { schema: string; name: string; fullName: string }) => boolean }> = [];
  /** Specific node ids (lower-cased) the user asked to keep in scope but skip analysis on. The hop dispatcher detects these on dequeue and records user passthrough — topology is preserved so descendants stay reachable. */
  protected passNodeIds: Set<string> = new Set();
  /** Last `init` params kept for refine re-run — origin/direction/depth/etc survive across the gate cycle. */
  protected initSnapshot: EngineInitSnapshot | null = null;

  /** Compressed AI-composed memo of the discovery walk's findings + user-stated semantic constraints, composed once after gate approval and rendered into every hop's stable prefix as `<discovery_summary>` (alongside `<mission_brief>` and the sliding `<short_term_memory>`). */
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
  /** The source policy used by this active engine and the state dump it writes. */
  get identifierCaseSensitive(): boolean { return this.model.identifierCaseSensitive === true; }

  /** Uses the loaded source identifier policy for object and schema keys. */
  protected columnKey(value: string): string {
    return normalizeColName(value, this.model.identifierCaseSensitive);
  }

  protected identifierKey(value: string): string {
    return schemaKey(value, this.model.identifierCaseSensitive);
  }

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
    this._agenda = new AgendaManager(model.identifierCaseSensitive, (nodeId, columns) => {
      this.log('debug', `[Agenda] ordinary carry kept as a separate task beside a scalar return node=${nodeId} columns=[${columns.join(', ')}]`);
    });
    this.taskLedger = new TaskLedger(model.identifierCaseSensitive);
    this.graph = graph;
    this.log = log;
    this.store = store ?? null;
    this.nodeMap = buildNodeMap(model);
    this.edgeTypeMap = buildEdgeTypeMap(model);
    this.memory = config.memory ?? new AiMemoryManager();
    const schemas = config.activeFilter?.schemas?.map(s => this.identifierKey(s)) ?? [];
    this.userSchemas = new Set(schemas);
    this.sessionAllowedSchemas = new Set(schemas);

    const ALL_OBJECT_TYPES = ['table', 'view', 'procedure', 'function', 'external'] as const;
    const guiActiveTypes = config.activeFilter?.types?.map(t => t.toLowerCase()) ?? [];
    if (guiActiveTypes.length > 0) {
      this.guiHiddenTypes = new Set(ALL_OBJECT_TYPES.filter(t => !guiActiveTypes.includes(t)));
    }

    if (schemas.length > 0) {
      const allSchemas = new Set<string>();
      for (const n of this.nodeMap.values()) allSchemas.add(this.identifierKey(n.schema));
      this.guiHiddenSchemas = new Set(Array.from(allSchemas).filter(s => !schemas.includes(s)));
    }

    const isGuiExcluded = compileExclusionMatcher(config.activeFilter?.exclusionPatterns ?? [], (pattern, err) => {
      this.log('debug', `[Filter] Skipping invalid GUI exclusion pattern "${pattern}": ${err instanceof Error ? err.message : String(err)}`);
    });
    if (isGuiExcluded) {
      for (const n of this.nodeMap.values()) {
        if (isGuiExcluded(n)) this.guiExcludedNodeIds.add(this.identifierKey(n.id));
      }
    }
    for (const pattern of config.activeFilter?.exclusionPatterns ?? []) {
      const matches = compileExclusionMatcher([pattern]);
      if (matches) this.guiExclusionRules.push({ pattern, matches });
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

  /** Object types the GUI filter hid at session start. */
  public getGuiHiddenTypes(): string[] {
    return Array.from(this.guiHiddenTypes);
  }

  /** Schemas the GUI filter hid at session start — the default `excludeSchemas` baseline, same override rule as {@link getGuiHiddenTypes}. */
  public getGuiHiddenSchemas(): string[] {
    return Array.from(this.guiHiddenSchemas);
  }

  /** Node ids matching a GUI exclusion pattern at session start — the default `excludeNodeIds` baseline, same override rule as {@link getGuiHiddenTypes}. */
  public getGuiExcludedNodeIds(): string[] {
    return Array.from(this.guiExcludedNodeIds);
  }

  /** Whether the draft held for the current focus carries a `column_flow`, so a retry may omit it to keep the held list. */
  public get heldColumnFlow(): boolean {
    return this.heldFindingFocus !== null && this.heldFindingDraft.get()?.column_flow !== undefined;
  }

  /** Canonical focus id of a currently-held finding, or `null` when none is held. */
  public get heldFindingFocus(): string | null {
    const held = this.heldFindingDraft.get();
    const authorization = this.heldFindingDraft.getAuthorization();
    if (!held || !authorization || authorization.focusId !== this.currentFocusNodeId
      || authorization.hop !== this.hopCount || authorization.mode !== this.currentHopAnalysisMode) return null;
    return authorization.focusId;
  }

  /** The draft held for the current focus, or `null`. */
  private heldDraftOfCurrentFocus(): HopFindingKept | null {
    return this.heldFindingFocus === null ? null : this.heldFindingDraft.get();
  }

  /** Overlays a retry on the draft held for the same focus by the one held-draft rule: each part the retry sends — a section angle or a {@link HELD_FIELDS} field — replaces the held part whole, and each part it omits keeps the held part. Nothing else is restored, dropped or combined. */
  public applyHeldContent(incoming: HopSubmission): HopSubmission | ToolRejection {
    const inFocus = resolveModelNodeId(incoming.focus_node_id, this.nodeMap, this.identifierCaseSensitive);
    const held = inFocus === this.currentFocusNodeId ? this.heldDraftOfCurrentFocus() : null;
    if (!held) {
      if (incoming.sections.length === 0 && !incoming.summary.trim()) {
        return makeRejection({
          code: REJECTION_CODES.missingField,
          hint: 'sections is empty and no draft is held for this node; resend the full call with authored sections and a non-empty summary.',
        });
      }
      return incoming.summary.trim() ? incoming : this.emptySummaryRejection();
    }
    this.log('debug', `[Hold] held parts restored hop=${this.hopCount} focus=${inFocus}`);
    const merged = this.overlayHeld(held, incoming);
    return merged.summary.trim() ? merged : this.emptySummaryRejection();
  }

  /** Applies the held-draft rule ({@link applyHeldContent}) to `sent` over `held`. */
  private overlayHeld(held: HopFindingKept, sent: HopFindingKept): HopFindingKept {
    const merged: HopFindingKept = { ...sent, sections: RepairDraftStore.mergeByKey(held.sections, sent.sections, angleKey) };
    for (const field of HELD_FIELDS) {
      const omitted = field === 'summary' ? !sent.summary.trim() : sent[field] === undefined;
      if (omitted && held[field] !== undefined) Object.assign(merged, { [field]: structuredClone(held[field]) });
    }
    return merged;
  }

  /** A finding whose summary is empty with no held summary to restore. */
  private emptySummaryRejection(): ToolRejection {
    const held = this.heldPartsOfCurrentFocus();
    return makeRejection({
      code: REJECTION_CODES.missingField,
      hint: `summary is empty and no summary is held for this node; ${held ? 'send summary plus focus_node_id' : 'resend the full call with summary'}: one sentence on what this node does to the data and hands on.${held ? ` ${findingRepairOrder(held)}` : ''}`,
      issuePaths: ['summary'],
    });
  }

  /** Holds valid parts of an initially schema-rejected finding; malformed repairs preserve an existing draft and request both its outstanding fields and the malformed repair's defective fields. */
  public holdRejectedSubmission(input: unknown, failedPaths: readonly string[]): HeldSubmissionParts | null {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return this.heldPartsOfCurrentFocus();
    const raw = input as Record<string, unknown> & { focus_node_id?: unknown };
    if (typeof raw.focus_node_id !== 'string') return this.heldPartsOfCurrentFocus();
    const focus = resolveModelNodeId(raw.focus_node_id, this.nodeMap, this.identifierCaseSensitive);
    if (focus !== this.currentFocusNodeId) return this.heldPartsOfCurrentFocus();
    const held = this.heldPartsOfCurrentFocus();
    if (held) {
      const { fields, angles } = splitFailedParts([...held.resend, ...failedPaths]);
      return { ...held, resend: [...[...angles].map(angle => `sections.${angle}`), ...fields] };
    }
    const sent: HopFindingKept = {
      focus_node_id: raw.focus_node_id,
      sections: extractRawSectionAngles(raw.sections),
      summary: typeof raw.summary === 'string' ? raw.summary : '',
    };
    for (const field of HELD_FIELDS) {
      if (field !== 'summary' && raw[field] !== undefined && raw[field] !== null) Object.assign(sent, { [field]: structuredClone(raw[field]) });
    }
    return this.holdValidParts(sent, failedPaths);
  }

  /** Holds a rejected finding minus the parts the rejection's issue paths fail ({@link splitFailedParts}): a failed section angle or field is left out whole and named as owed in the next retry. */
  private holdValidParts(finding: HopFindingKept, issuePaths: readonly string[]): HeldSubmissionParts | null {
    const { fields, angles } = splitFailedParts(issuePaths);
    const draft: HopFindingKept = {
      focus_node_id: finding.focus_node_id,
      sections: fields.has('sections') ? [] : finding.sections.filter(section => !angles.has(angleKey(section))),
      summary: fields.has('summary') ? '' : finding.summary,
    };
    for (const field of HELD_FIELDS) {
      if (field !== 'summary' && !fields.has(field) && finding[field] !== undefined) Object.assign(draft, { [field]: structuredClone(finding[field]) });
    }
    const resend = [...[...angles].map(angle => `sections.${angle}`), ...fields];
    const parts = this.heldParts(draft, resend);
    if (!this.currentFocusNodeId || (parts.sections.length === 0 && !parts.summary && parts.fields.length === 0)) {
      this.heldFindingDraft.clear();
      return null;
    }
    this.heldFindingDraft.hold(draft, { failed: resend, focusId: this.currentFocusNodeId, hop: this.hopCount, mode: this.currentHopAnalysisMode });
    return parts;
  }

  /** The parts of a held draft, as a rejection names them to the model. */
  private heldParts(held: HopFindingKept, resend: readonly string[]): HeldSubmissionParts {
    return {
      sections: held.sections.map(angleKey),
      summary: held.summary.trim().length > 0,
      fields: HELD_FIELDS.filter((field): field is Exclude<HeldField, 'summary'> => field !== 'summary' && held[field] !== undefined),
      resend,
    };
  }

  /** The parts the draft held for the current focus restores, unchanged; `null` when none is held. */
  private heldPartsOfCurrentFocus(): HeldSubmissionParts | null {
    const held = this.heldDraftOfCurrentFocus();
    return held ? this.heldParts(held, this.heldFindingDraft.getAuthorization()?.failed ?? []) : null;
  }

  /** Projection of unresolved scope-boundary leads; feeds the follow-up suggestions after synthesis. */
  public get deferredQuestions(): ReadonlyArray<DeferredQuestion> {
    return this.pendingLeads.flatMap(lead => {
      const reason = DEFERRAL_BY_LEAD_REASON.get(lead.reason);
      const task = this.taskLedger.getTask(lead.taskId);
      if (!reason || !task) return [];
      return [{
        nodeId: lead.nodeId,
        schema: lead.schema ?? this.nodeMap.get(lead.nodeId)?.schema ?? '',
        fromFocusNodeId: lead.fromNodeId,
        question: task.question,
        reason,
        ...(lead.depth !== undefined ? { depth: lead.depth } : {}),
        atHop: lead.createdHop,
      }];
    });
  }

  /** Neighbours removed by a resolved AI prune, each with the sender's own reason — follow-up material for the completed chat, not report content. */
  public get prunedBranches(): ReadonlyArray<PrunedBranch> {
    return this.pendingLeads
      .filter(lead => lead.reason === 'pruned_by_ai' && this.removedSet.has(lead.nodeId))
      .map(lead => ({ nodeId: lead.nodeId, fromFocusNodeId: lead.fromNodeId, reason: lead.valueToUser }));
  }

  /** Read-only typed task ledger used by prompts and diagnostics. */
  public get investigationTasks(): ReadonlyArray<InvestigationTask> {
    return this.taskLedger.investigationTasks;
  }

  /** Unresolved scope-boundary leads offered after the run. */
  public get pendingLeads(): ReadonlyArray<PendingLead> {
    return this.taskLedger.pendingLeads.filter(lead => lead.status === 'pending');
  }

  /** Records a deferred route — the sole entry point for mutating the bucket. */
  protected deferQuestion(entry: DeferredQuestion, legs: ReadonlyArray<ContinuationLeg> = []): void {
    this.recordPendingLead(entry, legs);
    this.memory.recordRejection(entry.nodeId, `deferred: out of approved scope (${entry.reason})`, entry.atHop);
  }

  /** Records the structured task and lead corresponding to an accepted scope-boundary deferral. */
  private recordPendingLead(entry: DeferredQuestion, legs: ReadonlyArray<ContinuationLeg>): void {
    const leadReason = LEAD_REASON_BY_DEFERRAL[entry.reason];
    const tasks = legs.length > 0
      ? legs.map(leg => this.ensureDeferredTask(entry.nodeId, entry.question, entry.atHop, leg))
      : [this.ensureDeferredTask(entry.nodeId, entry.question, entry.atHop)];
    for (const task of tasks) this.taskLedger.ensureLead({
      taskId: task.id,
      nodeId: entry.nodeId,
      fromNodeId: entry.fromFocusNodeId,
      reason: leadReason,
      schema: entry.schema,
      ...(entry.depth !== undefined ? { depth: entry.depth } : {}),
      valueToUser: entry.question
        ? `Continue at ${entry.nodeId} to answer: ${entry.question}`
        : entry.reason === 'excluded'
          ? `Continue at ${entry.nodeId}, excluded from this run's scope.`
          : `Continue at ${entry.nodeId} beyond the approved ${entry.reason} boundary.`,
      createdHop: entry.atHop,
    });
  }

  /** Records one sender's prune reason as a `pending` `pruned_by_ai` lead, re-arming one an earlier vote left dismissed. A vote that keeps the node, its dispatch or its return to the graph dismisses the lead. */
  private recordPruneLead(nodeId: string, fromNodeId: string, reason: string): void {
    const task = this.ensureDeferredTask(nodeId, '', this.hopCount);
    this.taskLedger.ensureLead({
      taskId: task.id,
      nodeId,
      fromNodeId,
      reason: 'pruned_by_ai',
      schema: this.nodeMap.get(nodeId)?.schema,
      valueToUser: reason,
      createdHop: this.hopCount,
      status: 'pending',
    });
  }

  /** Applies the mode's task shape to one set of common task fields. */
  private taskInputFor(
    common: Omit<InvestigationTaskInput, 'kind' | 'activeColumns' | 'returnTargets'>,
    bbKind: 'root' | 'analytical',
    preferredColumns: readonly string[] | undefined,
    returnTargets?: readonly ScalarReturnTarget[],
    sourceRefs?: readonly ScalarReturnTarget[],
  ): InvestigationTaskInput {
    if (!this.tracer || !preferredColumns?.length) return { ...common, kind: bbKind };
    const columns = preferredColumns;
    return { ...common, kind: 'column_lineage', activeColumns: [...columns] as [string, ...string[]],
      ...(returnTargets?.length ? { returnTargets: returnTargets.map(target => ({ ...target })) } : {}),
      ...(sourceRefs?.length ? { sourceRefs: sourceRefs.map(ref => ({ ...ref })) } : {}),
    };
  }

  /** Creates a structurally mode-valid deferred task without changing agenda state. */
  private ensureDeferredTask(nodeId: string, question: string, createdHop: number, leg?: ContinuationLeg): InvestigationTask {
    const columns = leg && [...new Map(leg.sourceRefs.map(ref => [this.columnKey(ref.col), ref.col])).values()];
    return this.taskLedger.ensureTask(this.taskInputFor({
      source: 'model',
      question,
      nodeId,
      parentTaskId: this.currentFocusTaskIds[0],
      status: 'deferred',
      createdHop,
      ...(leg?.traversalSide ? { traversalSide: leg.traversalSide } : {}),
    }, 'analytical', columns, undefined, leg?.sourceRefs));
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

  /** Records the process lifecycle state for a node. */
  private markNodeState(
    nodeId: string,
    action: SmNodeAction,
    source: SmNodeStateSource,
    reason: SmNodeStateReason,
    meta: { columns?: string[]; columnRole?: SmNodeColumnRole; viaNodeId?: string; atHop?: number } = {},
  ): void {
    const id = resolveModelNodeId(nodeId, this.nodeMap, this.identifierCaseSensitive) ?? this.identifierKey(nodeId);
    if (!this.nodeMap.has(id)) return;

    const rank = (a: SmNodeAction): number => {
      if (a === 'prune') return 3;
      if (a === 'analyze') return 2;
      return 1;
    };
    const existing = this.nodeStates.get(id);
    const mergedColumns = Array.from(new Set([...(existing?.columns ?? []), ...(meta.columns ?? [])]));
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

  /** Whether an explicitly passed-through neighbor is already retained on the route into this focus. */
  private isCarrierInto(carrierId: string, focusId: string): boolean {
    return this.nodeStates.get(carrierId)?.action === 'passthrough'
      && this.directionalNeighbors(carrierId, this._direction).includes(focusId);
  }

  /** Emits a session-end diagnostic summarizing badge_label diversity across analyzed verdicts. Low diversity indicates the AI is not distinguishing functional roles, so the final view won't group variants usefully. */
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
      inSchema: focus ? this.sessionAllowedSchemas.size === 0 || this.sessionAllowedSchemas.has(this.identifierKey(focus.schema)) : true,
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

  /** Continuation questions carried on the dequeued {@link AgendaEntry} for the hop currently in flight — set at dispatch in {@link getHopContext}, from that entry's own `lineageQuestions`, never from whichever node happened to commit most recently. Both the live per-hop worker message and {@link toJSON} read this, so the state dump records the questions the hop was dispatched with. */
  public get pendingLineageQuestions(): string[] {
    return this._pendingLineageQuestions;
  }

  /** Returns every captured detail slot in insertion order. */
  public getDetailSlots(): DetailSlot[] {
    return this.memory.getResult().detail_slots;
  }

  /** Gets the operational status. */
  public get status(): SmStatus {
    return this._status;
  }

  /** User-facing reason for an `error` status raised by a live engine invariant; `null` otherwise. */
  public get errorReason(): string | null {
    return this._status === 'error' ? this._errorReason : null;
  }

  /** Hops whose findings this engine committed, excluding a dispatched focus still awaiting findings. */
  public get submittedHopCount(): number {
    return this.committedHops;
  }

  /** Gets the active column-tracing aspect, if any. */
  public get columnAspect(): ColumnAspect | null {
    return this.tracer?.state ?? null;
  }

  /** Matches declared columns under the source comparison policy, preserving exact matches and rejecting ambiguous aliases. */
  private matchColumnsToNode(nodeId: string, columns: string[]): { resolved: string[]; unmatched: string[] } {
    const declared = new Set((getNodeColumns(nodeId, this.nodeMap, this.store ?? undefined) ?? []).map(column => column.name));
    const resolved: string[] = [], unmatched: string[] = [];
    for (const column of columns) {
      if (declared.size === 0 || declared.has(column)) { resolved.push(column); continue; }
      const matches = [...declared].filter(name => this.columnKey(name) === this.columnKey(column));
      if (matches.length === 1) resolved.push(matches[0]!);
      else unmatched.push(column);
    }
    return { resolved, unmatched };
  }

  /** The requested output columns on the origin, resolved to its declared names: the roots CT carry attaches to. */
  private columnRoots(): Array<{ node: string; col: string }> {
    const origin = this.originNodeId;
    return origin && this.tracer ? this.matchColumnsToNode(origin, this.tracer.targetColumns).resolved.map(col => ({ node: origin, col })) : [];
  }

  /** The qualified (node, column) identities a column task continues from. */
  private qualifiedTaskRefs(task: InvestigationTask): Array<{ node: string; col: string }> | null {
    if (task.kind !== 'column_lineage') return [];
    if (task.sourceRefs?.length) return task.sourceRefs.map(ref => ({ ...ref }));
    if (task.returnTargets?.length) return task.returnTargets.map(target => ({ ...target }));
    if (task.source === 'mission' && !task.parentTaskId && task.nodeId === this.originNodeId) {
      const requested = new Set(task.activeColumns.map(col => this.columnKey(col)));
      return this.columnRoots().filter(root => requested.has(this.columnKey(root.col)));
    }
    return null;
  }

  /** The qualified endpoints of a task as the prompt renders them: those on the task's own object (assigned) and those on another object (external), compared by identifier key. */
  public taskEndpoints(task: InvestigationTask): { assigned: ScalarReturnTarget[]; external: ScalarReturnTarget[] } {
    const refs = this.qualifiedTaskRefs(task) ?? [];
    const own = (ref: ScalarReturnTarget): boolean => !!task.nodeId && this.identifierKey(ref.node) === this.identifierKey(task.nodeId);
    return { assigned: refs.filter(own), external: refs.filter(ref => !own(ref)) };
  }

  /** Whether a queued task still dispatches exactly as accepted: its qualified endpoints exist ({@link qualifiedTaskRefs}) and each names a loaded object and, where that object declares columns, one of them. Dispatch never rewrites or narrows the accepted carry. */
  private taskRefsResolve(task: InvestigationTask): boolean {
    const refs = this.qualifiedTaskRefs(task);
    return refs !== null && refs.every(ref => this.nodeMap.has(ref.node) && this.matchColumnsToNode(ref.node, [ref.col]).unmatched.length === 0);
  }

  /** The qualified tracked-column identities this hop received, read only from its current tasks ({@link qualifiedTaskRefs}); dispatch refuses a task without them. */
  private incomingColumnRefs(traversalSide?: 'upstream' | 'downstream'): Array<{ node: string; col: string }> {
    if (!this.tracer || !this.currentFocusNodeId) return [];
    const refs = new Map<string, { node: string; col: string }>();
    for (const task of this.getCurrentTasks()) {
      if (task.kind !== 'column_lineage' || traversalSide && task.traversalSide !== traversalSide) continue;
      for (const ref of this.qualifiedTaskRefs(task) ?? []) refs.set(`${ref.node}|${this.columnKey(ref.col)}`, ref);
    }
    return [...refs.values()];
  }

  /** Uses an arriving column task's side before the session's default direction. */
  private columnTraceDirection(): 'upstream' | 'downstream' {
    const arrivingSides = new Set(this.getCurrentTasks().flatMap(task =>
      task.kind === 'column_lineage' && task.traversalSide ? [task.traversalSide] : []));
    const [arrivingSide] = arrivingSides;
    if (arrivingSides.size === 1 && arrivingSide !== undefined) return arrivingSide;
    return this.effectiveDirection() === 'downstream' ? 'downstream' : 'upstream';
  }

  /** Collapses `this._direction` plus a depth side of exactly `0` into the single traversal direction actually approved for later hop growth. */
  private effectiveDirection(): 'upstream' | 'downstream' | 'bidirectional' {
    if (this._direction !== 'bidirectional') return this._direction;
    return directionFromDepth(this.currentDepthIntent);
  }

  /** Directed distance from the origin to `targetId`, and which side of the origin it lies on. */
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

  /** Fills {@link directedDepths} with one walk per side, unless the current seed already filled it. */
  private ensureDirectedDepths(): void {
    if (this.directedDepthsFilled || !this.originNodeId) return;
    this.directedDepthsFilled = true;
    const origin = this.originNodeId;
    for (const [mode, side] of [['inbound', 'upstream'], ['outbound', 'downstream']] as const) {
      bfsFromNode(this.graph, origin, (key, _attr, depth) => {
        const node = key === origin ? undefined : this.nodeMap.get(key);
        if (node && this.checkBorder(key, node, 'seed_bfs').kind !== 'in_border') return true;
        const entry = this.directedDepths.get(key);
        if (!entry) this.directedDepths.set(key, { [side]: depth });
        else if (entry[side] === undefined) entry[side] = depth;
        return false;
      }, { mode });
    }
  }

  /** Whether admitting `targetId` would cross a depth border the user fixed. */
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
    const limit = Math.min(this.depthLimits.upstream, this.depthLimits.downstream);
    return fallbackDepth > limit ? fallbackDepth : null;
  }

  /** True when a route target is reachable from the origin within the approved traversal direction. */
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

  /** The single scope-border test — is `node` inside the approved border for the given write path? */
  private checkBorder(nodeId: string, node: LineageNode, purpose: BorderPurpose): BorderVerdict {
    const checkDirection = purpose === 'route';

    if (this.excludedTypes.has(node.type.toLowerCase())) return { kind: 'excluded', axis: 'type' };
    if (this.excludedNodeIds.has(this.identifierKey(nodeId))) return { kind: 'excluded', axis: 'node_id' };
    if (this.excludedSchemas.has(this.identifierKey(node.schema))) return { kind: 'excluded', axis: 'schema' };
    if (checkDirection && !this.isReachableInApprovedDirection(nodeId)) return { kind: 'out_of_direction' };
    return { kind: 'in_border' };
  }

  /** Whether an `excluded` border verdict traces to the GUI schema filter (the node's schema is unticked) rather than a user-authored exclusion pattern (`excludeTypes`/`excludeNodeIds`, or a schema the user typed that the GUI did not already hide), so a supplement skip or route deferral can tell the model the `confirm_sm_start` repair. */
  private isGuiHiddenSchemaBorder(border: BorderVerdict, node: LineageNode): boolean {
    return border.kind === 'excluded' && border.axis === 'schema' && this.guiHiddenSchemas.has(this.identifierKey(node.schema));
  }

  /** Whether the router would admit a route to `nodeId` right now — border **and** depth. */
  private admitsRoute(nodeId: string, node: LineageNode, focusId: string): RouteAdmission {
    const border = this.checkBorder(nodeId, node, 'route');
    let candidateDepth = this.depthFromOrigin.get(nodeId) ?? this.directedDepthFromOrigin(nodeId)?.depth;
    if (candidateDepth === undefined) {
      candidateDepth = (this.depthFromOrigin.get(focusId) ?? 0) + 1;
    }
    const depthBreach = this.supplementNodeIds.has(nodeId) ? null : this.depthBorderBreach(nodeId, candidateDepth);
    return {
      border,
      depthBreach,
      admitted: border.kind === 'in_border' && depthBreach === null,
    };
  }

  /** Scope admission shared by column source choices and submitted references, including retained evidence. */
  private admitsColumnReference(nodeId: string, node: LineageNode, focusId: string, acceptedIds?: ReadonlySet<string>): boolean {
    return nodeId === focusId || this.scopeNodeIds.has(nodeId) || this.visited.has(nodeId)
      || acceptedIds?.has(nodeId) === true || this.admitsRoute(nodeId, node, focusId).admitted;
  }

  /** Gets the size of the active exploration scope. */
  public get scopeSize(): number {
    return this.scopeNodeIds.size;
  }

  /** Gets live hop progress: completed AI hops, queued nodes, display-safe total work, cumulative prunes, and the last hop's newly-routed (added) count. */
  public get hopProgress(): HopProgress {
    let pruned = 0;
    for (const s of this.nodeStates.values()) if (s.action === 'prune') pruned++;
    const open = this._agenda.length;
    const total = Math.max(this._totalNodes, this.hopCount + open);
    return { current: this.hopCount, open, total, pruned, added: this.lastRoutedNew };
  }

  /** Origin id captured at the most recent {@link init}; cached so the refine path can re-init without re-asking the AI. */
  public get currentOrigin(): string | null {
    return this.initSnapshot?.origin ?? null;
  }

  /** Direction captured at {@link init}. */
  public get currentDirection(): 'upstream' | 'downstream' | 'bidirectional' {
    return this._direction;
  }

  /** Fallback depth verdict for a {@link currentDepthIntent} read before {@link init} ever ran. */
  private static readonly UNSET_DEPTH_INTENT: DepthIntent = Object.freeze({
    upstream: { levels: 'all' as const, exactness: 'approximate' as const },
    downstream: { levels: 'all' as const, exactness: 'approximate' as const },
  });

  /** Depth verdict captured at {@link init}, verbatim. */
  public get currentDepthIntent(): DepthIntent {
    return this.initSnapshot?.depthIntent ?? NavigationEngine.UNSET_DEPTH_INTENT;
  }

  /** Target columns captured at {@link init} (null when no column-trace aspect). */
  public get currentTargetColumns(): string[] | null {
    return this.initSnapshot?.targetColumns ?? null;
  }

  /** Neighbor action choices and column facts that narrow this hop's served schema: every declared focus column as `out_col` when metadata exists, and whether the focus is a procedure (the one node that may name a `writes_to` target). Eligible function neighbors narrow caller-context questions; stored column metadata narrows the admissible `upstream_columns` sources. */
  public get hopSubmitColumns(): SubmitFindingsHopColumns {
    const focus = this.currentFocusNodeId ? this.nodeMap.get(this.currentFocusNodeId) : undefined;
    const neighbors = focus ? this.neighborChoices(focus.id) : [];
    const declaredOutCols = focus
      ? [...new Set((getNodeColumns(focus.id, this.nodeMap, this.store ?? undefined) ?? []).map(column => column.name).filter(Boolean))]
      : [];
    return {
      neighbors,
      outCols: declaredOutCols.length > 0 ? declaredOutCols : null,
      writesTo: focus?.type === 'procedure',
      callerContextNodeIds: focus && this.graph.hasNode(focus.id) && getNodeDdl(focus.id, this.nodeMap, this.store ?? undefined)
        ? neighbors.filter(neighbor => neighbor.can_question).map(neighbor => neighbor.id).filter(id =>
          this.getCurrentTasks().some(task => task.kind === 'column_lineage' && task.nodeId === focus.id
            && task.activeColumns.some(col => resolveFunctionCallerTarget(id, { node: focus.id, col }, this.nodeMap, this.model, this.store)))).sort()
        : [],
      columnSourceNodeIds: focus && this.graph.hasNode(focus.id) ? this.columnSourceNodeIds(focus.id) : [],
      ...(focus?.type === 'procedure' && this.graph.hasNode(focus.id) ? { writeTargetNodeIds: this.graph.outNeighbors(focus.id).sort() } : {}),
      incomingRefs: this.incomingColumnRefs(),
      identifierCaseSensitive: this.identifierCaseSensitive,
      ...(this.currentReturnTargets().length ? { returnTargets: this.currentReturnTargets() } : {}),
    };
  }

  /** Object-graph ids an `upstream_columns` contributor may name at one hop: the focus's neighbors plus the read suppliers of its declared scalar callers. The served `node` enum and the contributor admission both read it, so a column edge never leaves the object graph. */
  private columnContributorIds(focusId: string): Set<string> {
    const callers = uniqueScalarReturnTargets([
      ...this.currentReturnTargets(),
      ...this.getCurrentTasks().flatMap(task => task.callerContext ? [{ node: task.callerContext.node, col: task.callerContext.col }] : []),
    ], this.model.identifierCaseSensitive).map(target => target.node);
    const candidates = new Set(this.neighborChoices(focusId).map(neighbor => neighbor.id));
    for (const caller of callers) {
      if (this.graph.hasNode(caller)) for (const supplier of this.graph.inNeighbors(caller)) candidates.add(supplier);
    }
    return candidates;
  }

  /** Metadata-derived `upstream_columns` source ids for one hop: {@link columnContributorIds} kept when stored columns exist or the procedure/external missing-metadata fallback applies and not already pruned — mirroring the engine's contributor admission, so a columnless scalar function is never offered as a column source. */
  private columnSourceNodeIds(focusId: string): string[] {
    return [...this.columnContributorIds(focusId)].filter(id => {
      const node = this.nodeMap.get(id);
      if (!node || this.removedSet.has(id) || !this.admitsColumnReference(id, node, focusId)) return false;
      return node.type === 'procedure' || node.type === 'external'
        || (getNodeColumns(id, this.nodeMap, this.store ?? undefined)?.length ?? 0) > 0;
    }).sort();
  }

  /** Qualified destinations carried by the active task ledger, without column-name collapse. */
  private currentReturnTargets(): ScalarReturnTarget[] {
    return uniqueScalarReturnTargets(this.getCurrentTasks().flatMap(task => task.kind === 'column_lineage' ? task.returnTargets ?? [] : []), this.model.identifierCaseSensitive);
  }

  /** Context evidence for the declared scalar return task, supplied only at its function hop. */
  private scalarReturnContext(): Pick<HopContext, 'caller_output_targets' | 'caller_objects' | 'caller_requested_outputs'> {
    const targets = this.currentReturnTargets();
    const declared = uniqueScalarReturnTargets(this.getCurrentTasks().flatMap(task => task.callerContext ? [{ node: task.callerContext.node, col: task.callerContext.col }] : []), this.model.identifierCaseSensitive);
    const callers = uniqueScalarReturnTargets([...targets, ...declared], this.model.identifierCaseSensitive);
    if (!callers.length) return {};
    return {
      ...(targets.length ? { caller_output_targets: targets } : {}),
      ...(declared.length ? { caller_requested_outputs: declared } : {}),
      caller_objects: [...new Set(callers.map(target => target.node))].map(node => ({ node, ddl: getNodeDdl(node, this.nodeMap, this.store ?? undefined) ?? '' })),
    };
  }

  /** Checks an authored caller context against its original task, directed route and exact SQL snapshot. */
  private validFunctionCallerContext(functionId: string, context: FunctionCallerContext): boolean {
    const parent = this.taskLedger.getTask(context.callerTaskId);
    const target = resolveFunctionCallerTarget(functionId, context, this.nodeMap, this.model, this.store);
    const ddl = getNodeDdl(context.node, this.nodeMap, this.store ?? undefined);
    return !!target && !!ddl && !!parent && parent.kind === 'column_lineage'
      && parent.nodeId === target.node && parent.activeColumns.some(col => this.columnKey(col) === this.columnKey(target.col))
      && this.scopeNodeIds.has(target.node) && !this.removedSet.has(target.node)
      && functionCallerDdlHash(ddl) === context.ddlHash;
  }

  /** Compiler declarations and task-anchored model investigations remain separate sources of scalar authorization. */
  private resolveReturnTarget(functionId: string, target: ScalarReturnTarget, taskIds?: readonly string[]): ScalarReturnTarget | null {
    const compiled = resolveScalarReturnTarget(functionId, target, this.nodeMap, this.store, this.model.identifierCaseSensitive);
    if (compiled) return compiled;
    if (getNodeColumns(functionId, this.nodeMap, this.store ?? undefined)?.length) return null;
    const tasks = taskIds ? taskIds.flatMap(id => this.taskLedger.getTask(id) ?? []) : this.taskLedger.investigationTasks;
    const declared = tasks.some(task => task.nodeId === functionId && task.kind === 'column_lineage' && task.callerContext
      && task.parentTaskId === task.callerContext.callerTaskId
      && task.returnTargets?.some(expected => expected.node === target.node && this.columnKey(expected.col) === this.columnKey(target.col))
      && task.callerContext.node === target.node && this.columnKey(task.callerContext.col) === this.columnKey(target.col)
      && this.validFunctionCallerContext(functionId, task.callerContext));
    return declared ? resolveFunctionCallerTarget(functionId, target, this.nodeMap, this.model, this.store) : null;
  }

  /** Explicit analysis mode captured at {@link init}. */
  public get currentAnalysisMode(): 'bb' | 'ct' {
    return this.initSnapshot?.analysisMode ?? (this.tracer ? 'ct' : 'bb');
  }

  /** The analysis mode of the hop currently dispatched — the contract selector for this hop alone. */
  public get currentHopAnalysisMode(): 'bb' | 'ct' {
    return (this.tracer?.activeColumns.filter(Boolean).length ?? 0) > 0 ? 'ct' : 'bb';
  }

  /** Builds a one-shot snapshot of the proposed scope for the `confirm_sm_start` gate detail. */
  public getScopeSummary(namesPerType = Number.POSITIVE_INFINITY): ScopeSummary {
    const bySchema: Record<string, { hops: number; scope: number; byType: Record<string, ScopeSummaryLeaf> }> = Object.create(null);
    let hopCount = 0;

    for (const id of this.scopeNodeIds) {
      const n = this.nodeMap.get(id);
      if (!n) continue;
      const schema = n.schema;
      const type = n.type ?? 'external';
      const takesHop = SCRIPT_TYPES.has(n.type) && !this.passNodeIds.has(this.identifierKey(id));
      if (takesHop) hopCount++;

      if (!bySchema[schema]) bySchema[schema] = { hops: 0, scope: 0, byType: {} };
      const schemaEntry = bySchema[schema];
      schemaEntry.scope++;
      if (takesHop) schemaEntry.hops++;
      if (!schemaEntry.byType[type]) {
        schemaEntry.byType[type] = { hops: 0, scope: 0, nodeNames: [], omitted: 0 };
      }
      const leaf = schemaEntry.byType[type];
      leaf.scope++;
      if (takesHop) leaf.hops++;
      if (leaf.nodeNames.length < namesPerType) leaf.nodeNames.push(n.name);
      else leaf.omitted++;
    }

    for (const schemaEntry of Object.values(bySchema)) {
      for (const leaf of Object.values(schemaEntry.byType)) {
        leaf.nodeNames.sort((a, b) => a.localeCompare(b));
      }
    }

    const schemasByTypeName = new Map<string, Set<string>>();
    for (const n of this.nodeMap.values()) {
      const type = n.type ?? 'external';
      const key = `${type}\u0000${this.identifierKey(n.name)}`;
      const schemas = schemasByTypeName.get(key) ?? new Set<string>();
      schemas.add(this.identifierKey(n.schema));
      schemasByTypeName.set(key, schemas);
    }
    const ambiguousObjectNames: Record<string, string[]> = {};
    for (const [key, schemas] of schemasByTypeName) {
      if (schemas.size < 2) continue;
      const [type, lowerName] = key.split('\u0000');
      (ambiguousObjectNames[type] ??= []).push(lowerName);
    }

    const estimatedDdlChars = this.estimateScopeDdlChars();
    const originNode = this.originNodeId ? this.nodeMap.get(this.originNodeId) : undefined;
    const originLabel = originNode ? `${originNode.schema}.${originNode.name}` : (this.originNodeId ?? '');
    const canonicalNodeId = (id: string): string => {
      const key = resolveModelNodeId(id, this.nodeMap, this.identifierCaseSensitive) ?? id;
      const node = this.nodeMap.get(key);
      return node ? `${quoteIdentifier(node.schema)}.${quoteIdentifier(node.name)}` : key;
    };
    const schemaNames = new Map<string, string>();
    const selectedSchemas = new Map<string, string>();
    for (const n of this.nodeMap.values()) {
      const key = this.identifierKey(n.schema);
      const target = this.excludedSchemas.has(key) ? schemaNames : selectedSchemas;
      if (!target.has(key)) target.set(key, n.schema);
    }

    return {
      hopCount,
      identifierCaseSensitive: this.identifierCaseSensitive,
      scopeCount: this.scopeNodeIds.size,
      origin: this.originNodeId ?? '',
      originLabel,
      missionBrief: this.initSnapshot?.mission_brief,
      depth: this.depthBudget,
      depthIntent: this.currentDepthIntent,
      direction: this._direction,
      analysisMode: this.currentAnalysisMode,
      columnAspectActive: this.tracer !== null,
      targetColumns: this.tracer?.targetColumns,
      estimatedDdlChars,
      estimatedDdlTokens: estimateTokens(estimatedDdlChars),
      bySchema,
      ambiguousObjectNames,
      scopeNotes: this.memory.getScopeNotes(),
      classification: this.classification,
      activeFilters: {
        schemas: Array.from(this.excludedSchemas, key => schemaNames.get(key) ?? key).sort(),
        types: Array.from(this.excludedTypes).sort(),
        nodeIds: Array.from(this.excludedNodeIds, canonicalNodeId).sort(),
        passNodeIds: Array.from(this.passNodeIds, canonicalNodeId).sort(),
      },
      selectedSchemas: [...selectedSchemas.values()].sort((a, b) => a.localeCompare(b)),
      exclusions: this.excludedObjectsByCause(),
    };
  }

  /** Groups every excluded object under the first GUI exclusion rule matching it, or under `named` when none does. An object the schema or type filter already removes is left out, so each count states what the rule removes from the selected schemas and types. */
  private excludedObjectsByCause(): ScopeExclusions {
    const group = (): ScopeExclusionGroup => ({ count: 0, byType: {} });
    const rules = this.guiExclusionRules.map(rule => ({ pattern: rule.pattern, ...group() }));
    const named = group();
    for (const id of this.excludedNodeIds) {
      const node = this.nodeMap.get(resolveModelNodeId(id, this.nodeMap, this.identifierCaseSensitive) ?? id);
      if (!node) continue;
      if (this.excludedSchemas.has(this.identifierKey(node.schema))) continue;
      if (node.type && this.excludedTypes.has(node.type.toLowerCase())) continue;
      const ruleIndex = this.guiExclusionRules.findIndex(rule => rule.matches(node));
      const target = ruleIndex >= 0 ? rules[ruleIndex] : named;
      target.count++;
      (target.byType[node.type ?? 'external'] ??= []).push({ schema: node.schema, name: node.name });
    }
    for (const entry of [...rules, named]) {
      for (const objects of Object.values(entry.byType)) {
        objects.sort((a, b) => a.name.localeCompare(b.name) || a.schema.localeCompare(b.schema));
      }
    }
    return { rules: rules.filter(rule => rule.count > 0), named };
  }

  /** Applies the shared graph removal policy with this session's scope, anchors and direction legs. */
  private removalSupport(removedBefore: ReadonlySet<string>, removedAfter: ReadonlySet<string>, anchors: ReadonlySet<string> = this.visited): RemovalAnalysis {
    const protectedAnchors = new Set([...anchors, ...(this.tracer?.edges ?? []).flatMap(edge => [edge.from_node, edge.to_node])]);
    const analysis = analyzeRemoval(this.graph, {
      originId: this.originNodeId ?? '', scope: this.scopeNodeIds, removedBefore, removedAfter,
      visited: protectedAnchors, currentNodeId: this.currentFocusNodeId ?? undefined, sides: this.allowedNoteSides(),
    });
    if (analysis.rejection || !this.originNodeId || this.supplementNodeIds.size === 0) return analysis;
    const connectedBefore = bfsReachable(this.graph, this.originNodeId, removedBefore, undefined, this.scopeNodeIds);
    const connectedAfter = bfsReachable(this.graph, this.originNodeId, removedAfter, undefined, this.scopeNodeIds);
    for (const id of this.supplementNodeIds) {
      if (!protectedAnchors.has(id)) continue;
      if (connectedBefore.has(id)) analysis.before.add(id);
      if (connectedAfter.has(id)) analysis.after.add(id);
      if (!removedAfter.has(id) && connectedBefore.has(id) && !connectedAfter.has(id)
        && !analysis.disconnectedVisited.includes(id)) analysis.disconnectedVisited.push(id);
    }
    return analysis;
  }

  /** Validates that the given node ids are legitimate targets for neighbor-column inspection (the `get_neighbor_columns` tool). */
  public validateNeighborIds(ids: string[]): string[] {
    const allowed = new Set(this.neighborColumnIds);
    return ids.filter(id => !allowed.has(resolveModelNodeId(id, this.nodeMap, this.identifierCaseSensitive) ?? ''));
  }

  /** In-scope neighbor ids available for column lookup, including visited evidence. */
  public get neighborColumnIds(): string[] {
    return this.neighborChoices(this.currentFocusNodeId ?? '').filter(neighbor => this.scopeNodeIds.has(neighbor.id)).map(neighbor => neighbor.id);
  }

  /** The current hop's sub-questions as archived beside its findings: every non-blank task question in dispatch order. The mission question, carried separately as the original question, is left out in either mode and wherever routing re-sends it. `from_node` names the asking hop only for a model-authored question whose parent task belongs to a visited node; engine-routed text is kept without a sender. */
  private currentIncomingQuestions(): IncomingQuestion[] {
    const focusId = this.currentFocusNodeId;
    const mission = (this.memory.getUserQuestion() ?? '').trim();
    return this.getCurrentTasks().flatMap(task => {
      const question = task.question.trim();
      const isMission = task.source === 'mission' && !task.parentTaskId;
      if (isMission || !question || question === mission) return [];
      const from = task.source === 'model' && task.parentTaskId ? this.taskLedger.getTask(task.parentTaskId)?.nodeId : undefined;
      return [{ question, ...(from && from !== focusId && this.visited.has(from) ? { from_node: from } : {}) }];
    });
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

  /** Stores the discovery-handoff memo composed at proposal time, set verbatim at gate approval and never recomposed. Empty or whitespace-only input becomes `null`. */
  public setDiscoverySummary(text: string): void {
    const trimmed = text.trim();
    this._discoverySummary = trimmed.length > 0 ? trimmed : null;
  }

  /** Stores the current-task question at the moment a hop context is delivered. */
  private _lastCurrentTask = '';

  /** Sets up the navigation map to prepare for traversal. */
  public init(params: NavigationInitParams): { ok: true } | ToolRejection {
    const depthIntent: DepthIntent = params.depthIntent;
    if (bothSidesClosed(depthIntent.upstream, depthIntent.downstream)) {
      return makeRejection({
        code: ASYMMETRIC_DEPTH_BOTH_ZERO,
        hint: 'This refine closes the last open side: resend depth with at least one side ≥ 1 or "all".',
      });
    }
    if (params.analysisMode === 'ct' && (!params.targetColumns || params.targetColumns.length === 0)) {
      return makeRejection({
        code: REJECTION_CODES.missingField,
        hint: 'Resend with at least one named targetColumns value for CT, or change analysisMode to "bb" and resend.',
      });
    }
    if (params.analysisMode === 'bb' && params.targetColumns !== undefined) {
      return makeRejection({
        code: REJECTION_CODES.ctFieldForbiddenInBb,
        hint: 'Omit targetColumns and resubmit the BB specification.',
      });
    }
    const wasRefine = this.initSnapshot !== null;
    const prevScopeSize = this.scopeNodeIds.size;

    const resolveId = (raw: string): string | null => resolveModelNodeId(raw, this.nodeMap, this.identifierCaseSensitive);
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
      return makeRejection({
        code: 'unknown_node_ids',
        reason: [
          ...(excludeIds.unresolved.length > 0 ? [`excludeNodeIds not in the loaded model: ${excludeIds.unresolved.join(', ')}`] : []),
          ...(passIds.unresolved.length > 0 ? [`passNodeIds not in the loaded model: ${passIds.unresolved.join(', ')}`] : []),
        ].join('; '),
        hint: "These references do not resolve to loaded object identities. Call lineage_search_objects with each user-named identifier to resolve the canonical schema-qualified id, then re-call lineage_start_exploration with the corrected list.",
        detail: { unresolved_excludeNodeIds: excludeIds.unresolved, unresolved_passNodeIds: passIds.unresolved },
      });
    }
    if (excludeIds.resolved.length + passIds.resolved.length > 0) {
      this.log('debug', `[NL] excludeNodeIds resolved=[${trunc(excludeIds.resolved, LOG_TRUNC_LIST)}] passNodeIds resolved=[${trunc(passIds.resolved, LOG_TRUNC_LIST)}]`);
    }

    const resolvedOriginId = resolveModelNodeId(params.origin, this.nodeMap, this.identifierCaseSensitive);
    const originNode = resolvedOriginId ? this.nodeMap.get(resolvedOriginId) : null;
    if (!originNode) {
      return makeRejection({
        code: 'origin_not_found',
        reason: 'origin must resolve unambiguously to a loaded object ID.',
        issuePaths: ['origin'],
        hint: 'Verify the origin node id with lineage_search_objects first. Use the canonical id it returns.',
      });
    }

    const analysisMode: 'bb' | 'ct' = params.analysisMode ?? ((params.targetColumns?.length ?? 0) > 0 ? 'ct' : 'bb');
    const effectiveTargetColumns = analysisMode === 'ct' ? params.targetColumns : undefined;
    let resolvedActiveColumns: string[] = [];
    if (analysisMode === 'ct' && effectiveTargetColumns && effectiveTargetColumns.length > 0) {
      const declared = getNodeColumns(originNode.id, this.nodeMap, this.store ?? undefined) ?? [];
      const { resolved, unmatched } = this.matchColumnsToNode(originNode.id, effectiveTargetColumns);
      if (resolved.length === 0 || unmatched.length > 0) {
        const declaredNames = declared.map((c) => c.name);
        const offending = unmatched.length > 0 ? unmatched : effectiveTargetColumns;
        this.log('debug', `[AI] [CT] requested columns [${effectiveTargetColumns.join(',')}] offending=[${offending.join(',')}] not on origin ${originNode.id} — rejecting (no partial-trace fallback)`);
        return makeRejection({
          code: 'unknown_columns',
          reason: 'targetColumns must match declared columns of the origin under its identifier comparison policy.',
          issuePaths: effectiveTargetColumns.flatMap((column, index) => offending.includes(column) ? [`targetColumns.${index}`] : []),
          detail: effectiveTargetColumns.flatMap((column, index) => offending.includes(column)
            ? [{ path: `targetColumns.${index}`, allowed_values: declaredNames, when: { node: originNode.id } }] : []),
          hint: declaredNames.length > 0
            ? `targetColumns [${offending.join(', ')}] are not columns on ${originNode.id}. Provide valid columns, ask the user to clarify, or switch analysisMode to "bb".`
            : `targetColumns [${offending.join(', ')}] are not columns on ${originNode.id}, which exposes no column metadata of its own. Provide valid columns, ask the user to clarify, or switch analysisMode to "bb".`,
        });
      }
      effectiveTargetColumns.forEach((column, index) => {
        if (column !== resolved[index]) this.log('debug', `[CT] target column matched from=${JSON.stringify(column)} to=${JSON.stringify(resolved[index])}`);
      });
      this.log('debug', `[Admit] guard=ct_target_columns phase=init focus=${originNode.id} active=${resolved.length} — tracing [${resolved.join(', ')}]`);
      resolvedActiveColumns = resolved;
    }

    this.visited.clear();
    this.removedSet.clear();
    this.pruneBallots.clear();
    this.supplementNodeIds.clear();
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

    const originSchema = this.identifierKey(originNode.schema);
    const originId = this.identifierKey(originNode.id);
    this.excludedSchemas = new Set((params.excludeSchemas ?? [...this.guiHiddenSchemas]).map(s => this.identifierKey(s)).filter(s => s !== originSchema));
    this.excludedNodeIds = new Set(excludeIds.resolved.map(s => this.identifierKey(s)).filter(id => id !== originId));
    if (excludeIds.resolved.some(id => this.identifierKey(id) === originId)) {
      this.log('debug', `[Border] origin ${originNode.id} named in excludeNodeIds — kept in scope as the origin`);
    }
    this.passNodeIds = new Set(passIds.resolved.map(s => this.identifierKey(s)));
    if (this.userSchemas.size > 0) {
      const openedByProposal = params.excludeSchemas === undefined
        ? []
        : [...this.guiHiddenSchemas].filter(schema => !this.excludedSchemas.has(schema));
      this.sessionAllowedSchemas = new Set([...this.userSchemas, originSchema, ...openedByProposal]);
    }

    this.originNodeId = originNode.id;
    const direction = params.direction || 'bidirectional';
    const border = NavigationEngine.resolveDepthBorder(depthIntent);
    this.depthLimits = border.limits;
    this.depthBudget = border.budget;
    this.depthEnforcement = border.enforcement;
    const sideLabel = (side: DepthSideValue): string => `${side.levels}:${side.exactness}`;
    const depthLabel = `up=${sideLabel(depthIntent.upstream)} down=${sideLabel(depthIntent.downstream)}`;
    const capSide = (value: number): string => (Number.isFinite(value) ? String(value) : 'all');
    this.log(
      'debug',
      `[Depth] resolved ${depthLabel} `
      + `enforcement=${this.depthEnforcement} `
      + `cap=up:${capSide(this.depthLimits.upstream)}/down:${capSide(this.depthLimits.downstream)} `
      + `budget=${this.depthBudget ?? 'none'}`,
    );
    this.budgetExpansions = [];
    this.scopeNodeIds = this.computeBfsScope(originNode.id, direction);

    let initialActiveColumns = effectiveTargetColumns;
    if (analysisMode === 'ct' && effectiveTargetColumns && effectiveTargetColumns.length > 0) {
      this.tracer = new ColumnTracer(effectiveTargetColumns, undefined, this.model.identifierCaseSensitive);
      initialActiveColumns = resolvedActiveColumns;
      this.tracer.setActiveColumns(initialActiveColumns);
    } else {
      this.tracer = null;
    }

    const breakdown = { table: 0, view: 0, procedure: 0, function: 0, external: 0 } as Record<string, number>;
    for (const id of this.scopeNodeIds) {
      const n = this.nodeMap.get(id);
      if (n) {
        const t = n.type?.toLowerCase() ?? 'external';
        breakdown[t] = (breakdown[t] ?? 0) + 1;
      }
    }
    this._totalNodes = this.scopeNodeIds.size;
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
      this.log('debug', `[BFS-refine] cause=user_refine origin=${originNode.id} dir=${direction} depth=${depthLabel}${excludeNodeIdsLine} → scope=Δ (was=${prevScopeSize} now=${this.scopeNodeIds.size}) (tables=${breakdown.table}, views=${breakdown.view}, procs=${breakdown.procedure}, functions=${breakdown.function}) excludeTypes=[${excludedTypesAnnotated}]${guiHiddenLine}`);
    } else {
      this.log('debug', `[BFS] origin=${originNode.id} dir=${direction} depth=${depthLabel} → scope=${this.scopeNodeIds.size} (tables=${breakdown.table}, views=${breakdown.view}, procs=${breakdown.procedure}, functions=${breakdown.function}) excludeTypes=[${excludedTypesAnnotated}]${excludeNodeIdsLine}${guiHiddenLine}`);
    }

    const contractParts = [
      originNode.id,
      direction,
      `${sideLabel(depthIntent.upstream)}|${sideLabel(depthIntent.downstream)}`,
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

    this._direction = direction;
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
    const rootTask = this.taskLedger.ensureTask(this.taskInputFor({
      source: 'mission',
      question: params.question,
      nodeId: originNode.id,
      createdHop: 0,
    }, 'root', initialActiveColumns));
    this.enqueueHop(originNode.id, params.question, 0, 3, { carry: { kind: 'carry', columns: initialActiveColumns ?? [] }, existingTaskId: rootTask.id });
    this._status = 'initialized';

    return { ok: true };
  }

  /** Nodes physically connected to the traced graph, plus every batch id reachable from it — directly or transitively through another batch id. */
  private tracedGraphReachable(batchIds: ReadonlySet<string>): Set<string> {
    const reachable = new Set<string>([...this.scopeNodeIds, ...this.visited].filter(id => !this.removedSet.has(id)));
    const allowed = new Set<string>([...reachable, ...batchIds]);
    const queue = [...reachable];
    let idx = 0;
    while (idx < queue.length) {
      const id = queue[idx++];
      for (const nid of this.graph.neighbors(id)) {
        if (reachable.has(nid) || !allowed.has(nid)) continue;
        reachable.add(nid);
        queue.push(nid);
      }
    }
    return reachable;
  }

  /** Finds follow-up targets that clear the border but have no dependency path to the traced graph. */
  private admitSupplementTargets(nodeIds: readonly string[]): { admitted: string[]; skipped: SupplementSkip[] } {
    const admitted: string[] = [];
    const skipped: SupplementSkip[] = [];
    const candidates: LineageNode[] = [];
    for (const raw of nodeIds) {
      const id = resolveModelNodeId(raw, this.nodeMap, this.identifierCaseSensitive);
      const node = id ? this.nodeMap.get(id) : undefined;
      if (node && this.checkBorder(node.id, node, 'supplement').kind !== 'excluded') candidates.push(node);
    }
    const batchIds = new Set(candidates.map(node => node.id));
    const tracedReachable = this.tracedGraphReachable(batchIds);
    for (const node of candidates) {
      if (tracedReachable.has(node.id)) {
        admitted.push(node.id);
        continue;
      }
      const connectors = this.connectorsTo(node.id, batchIds);
      skipped.push({
        nodeId: node.id,
        reason: REJECTION_CODES.notConnectedToTrace,
        hint: connectors?.length
          ? `${node.id} joins this trace only through ${connectors.join(', ')}, outside the retained trace; name ${connectors.length === 1 ? 'it' : 'them'} in supplement.nodeIds together with ${node.id}, or trace ${node.id} on its own with lineage_start_exploration origin=${node.id}.`
          : `${node.id} is not connected to this trace; trace it on its own with lineage_start_exploration origin=${node.id}.`,
      });
      this.log('debug', `[Border] supplement refuse hop=${this.hopCount} id=${node.id} reason=${REJECTION_CODES.notConnectedToTrace}${connectors?.length ? ` connectors=[${connectors.join(',')}]` : ''}`);
    }
    if (admitted.length > 0) this.log('debug', `[Border] supplement admit ids=[${admitted.join(',')}]`);
    return { admitted, skipped };
  }

  /** The objects outside the retained trace on the shortest scope-bounded path between a supplement target and the trace, or null when no such path clears the border. */
  private connectorsTo(nodeId: string, batchIds: ReadonlySet<string>): string[] | null {
    const path = this.scopeBoundedPathToOrigin(nodeId, this.allowedNoteSides()) ?? this.scopeBoundedPathToOrigin(nodeId);
    if (!path) return null;
    const towardTrace = path.slice(0, -1).reverse();
    const nearestRetained = towardTrace.findIndex(id => !this.removedSet.has(id) && (this.scopeNodeIds.has(id) || this.visited.has(id)));
    if (nearestRetained < 0) return null;
    const connectors = towardTrace.slice(0, nearestRetained).filter(id => !batchIds.has(id));
    return connectors.every(id => {
      const node = this.nodeMap.get(id);
      return !!node && this.checkBorder(id, node, 'supplement').kind === 'in_border';
    }) ? connectors : null;
  }

  /** Returns a pruned node to the analysable set so a follow-up can add it back. */
  private unprune(id: string): void {
    if (!this.removedSet.delete(id)) return;
    this.taskLedger.dismissNodeLeads(id, 'pruned_by_ai');
    const node = this.nodeMap.get(id);
    if (node && !this.visited.has(id) && this.scopeNodeIds.has(id)) {
      this._totalNodes++;
    }
    this.nodeStates.delete(id);
    this.log('debug', `[Supplement] unprune hop=${this.hopCount} id=${id} (total → ${this._totalNodes})`);
  }

  /** Walks a chain add from each named id and returns the named ids followed by every object reached. */
  private expandSupplementChain(nodeIds: readonly string[], chain: SupplementChain): string[] {
    const maxDepth = chain.depth === 'all' ? Number.POSITIVE_INFINITY : chain.depth;
    const mode = chain.direction === 'upstream' ? 'inbound' : 'outbound';
    const result: string[] = [...nodeIds];
    const seen = new Set(nodeIds.map(id => this.identifierKey(id)));
    for (const raw of nodeIds) {
      const start = resolveModelNodeId(raw, this.nodeMap, this.identifierCaseSensitive);
      if (!start || !this.graph.hasNode(start)) continue;
      bfsFromNode(this.graph, start, (key, _attr, depth) => {
        if (key === start) return false;
        const node = this.nodeMap.get(key);
        if (!node) return true;
        if (this.checkBorder(key, node, 'supplement').kind === 'excluded') {
          if (!seen.has(this.identifierKey(key))) {
            seen.add(this.identifierKey(key));
            result.push(key);
          }
          return true;
        }
        if (!seen.has(this.identifierKey(key)) && !this.visited.has(key)) {
          seen.add(this.identifierKey(key));
          result.push(key);
        }
        return depth >= maxDepth;
      }, { mode });
    }
    this.log('info', `[Supplement] chain dir=${chain.direction} depth=${String(chain.depth)} named=${nodeIds.length} → added=${result.length - nodeIds.length}`);
    return result;
  }

  /** The carry a follow-up starts from, read only from the request itself. */
  private supplementCarryFor(nodeId: string, task?: InvestigationTask): ColumnCarry | 'no_qualified_task' | 'scalar_binding_unresolved' {
    if (!this.tracer) return { kind: 'carry', columns: [] };
    if (task?.kind !== 'column_lineage') return { kind: 'row_role_only' };
    if (!this.qualifiedTaskRefs(task)?.length) return 'no_qualified_task';
    if (this.nodeMap.get(nodeId)?.type !== 'function' || getNodeColumns(nodeId, this.nodeMap, this.store ?? undefined)?.length) {
      return { kind: 'carry', columns: task.activeColumns };
    }
    const targets = uniqueScalarReturnTargets(task.returnTargets ?? [], this.model.identifierCaseSensitive);
    if (!targets.length) return 'no_qualified_task';
    const outputs = targets.flatMap(target => {
      const bound = this.resolveReturnTarget(nodeId, target);
      return bound && this.scopeNodeIds.has(bound.node) ? [bound] : [];
    });
    return outputs.length === targets.length ? { kind: 'scalar_return', outputs } : 'scalar_binding_unresolved';
  }

  /** Extends a completed exploration with additional nodes for analysis. */
  public supplementAgenda(nodeIds: string[], leadIds: string[] = [], chain?: SupplementChain): { ok: true; agendaed: number; skipped: number; skippedDetails: SupplementSkip[] } | ToolRejection {
    if (this._status !== 'complete') {
      return makeRejection({
        code: REJECTION_CODES.supplementRequiresCompleteEngine,
        hint: `supplementAgenda is only valid after the prior exploration has completed (status === 'complete'). Current status: ${this._status}.`,
      });
    }
    if ((!Array.isArray(nodeIds) || nodeIds.length === 0) && (!Array.isArray(leadIds) || leadIds.length === 0)) {
      return makeRejection({
        code: REJECTION_CODES.supplementEmpty,
        hint: 'supplement requires at least one node id in supplement.nodeIds — pending leads are host-selected and cannot be supplied here. Name the ids from the completed exploration you want extended; if no node is left to extend, do not resend an empty supplement — answer from the completed exploration, or start a fresh exploration by providing an origin instead of supplement.',
      });
    }

    const leadEntries = leadIds.map(leadId => {
      const lead = this.taskLedger.pendingLeads.find(item => item.id === leadId && item.status === 'pending');
      const task = lead ? this.taskLedger.getTask(lead.taskId) : undefined;
      return lead && task ? { lead, task } : null;
    });
    if (leadEntries.some(entry => !entry)) {
      return makeRejection({
        code: 'invalid_pending_lead',
        hint: 'Use an unresolved pending lead id from the completed exploration, or provide explicit supplement nodeIds.',
      });
    }

    nodeIds = chain ? this.expandSupplementChain(nodeIds, chain) : [...nodeIds];
    const requested = [
      ...nodeIds.map(nodeId => ({ nodeId, question: '', taskId: undefined as string | undefined, leadId: undefined as string | undefined })),
      ...leadEntries.map(entry => ({ nodeId: entry!.lead.nodeId, question: entry!.task.question, taskId: entry!.task.id as string | undefined, leadId: entry!.lead.id as string | undefined })),
    ];

    const admission = this.admitSupplementTargets(requested.map(request => request.nodeId));
    const unconnectedIds = new Set(admission.skipped.map(skip => this.identifierKey(skip.nodeId)));
    const admittedIds = new Set(admission.admitted);
    // Validate every selected task before any target is unpruned or queued.
    const refused: string[] = [];
    const prepared = requested.map(request => {
      const id = resolveModelNodeId(request.nodeId, this.nodeMap, this.identifierCaseSensitive);
      const selectedTask = request.taskId ? this.taskLedger.getTask(request.taskId) : undefined;
      const recovered = id && admittedIds.has(id) ? this.supplementCarryFor(id, selectedTask) : { kind: 'row_role_only' } as ColumnCarry;
      if (typeof recovered === 'string') refused.push(`${id} (${recovered === 'no_qualified_task' ? 'no qualified task' : 'scalar binding unresolved'})`);
      const carry = typeof recovered === 'string' ? { kind: 'row_role_only' } as ColumnCarry : recovered;
      const replaceTask = !!selectedTask && carry.kind === 'row_role_only';
      return {
        ...request,
        carry,
        existingTaskId: replaceTask ? undefined : request.taskId,
        parentTaskId: replaceTask ? request.taskId : undefined,
      };
    });

    if (refused.length > 0) {
      this.log('debug', `[Supplement] refuse hop=${this.hopCount} ids=[${refused.join(',')}]`);
      return makeRejection({
        code: REJECTION_CODES.routeValidationFailed,
        reason: `Supplement refused: ${refused.join(', ')}`,
        hint: 'A follow-up continues a column trace only from a selected task with qualified endpoints, and a scalar function only from that task\'s resolvable return targets. Nothing was changed; name the object without the task for an object visit, or start a new exploration.',
      });
    }
    const agendaBefore = this._agenda.length;
    let skipped = admission.skipped.length;
    const skippedDetails: SupplementSkip[] = [...admission.skipped];
    for (const request of prepared) {
      const raw = request.nodeId;
      const id = resolveModelNodeId(raw, this.nodeMap, this.identifierCaseSensitive);
      if (!id) {
        this.log('debug', `[Supplement] refuse hop=${this.hopCount} id=${raw} reason=unresolved`);
        skippedDetails.push({ nodeId: raw, reason: 'unresolved' });
        skipped++;
        continue;
      }
      if (unconnectedIds.has(this.identifierKey(id))) continue;
      const supNode = this.nodeMap.get(id);
      const supBorder = supNode ? this.checkBorder(id, supNode, 'supplement') : null;
      if (supBorder && supBorder.kind !== 'in_border') {
        const isAllowlistBoundary = !!supNode && this.isGuiHiddenSchemaBorder(supBorder, supNode);
        const reason = isAllowlistBoundary ? 'out_of_allowlist' as const : 'excluded' as const;
        this.log('debug', `[Supplement] refuse hop=${this.hopCount} id=${id} reason=${reason}`);
        const guiFilterHint = isAllowlistBoundary
          ? `${id} is outside the GUI schema filter (schema '${supNode!.schema}' is unticked), not a user-authored exclusion; start a new lineage_start_exploration proposal naming ${id}, with excludeSchemas sent and omitting '${supNode!.schema}' (a fresh proposal defaults excludeSchemas back to the GUI-hidden list, so omitting the field re-excludes it), for the user to approve at the confirm_sm_start gate.`
          : undefined;
        skippedDetails.push(guiFilterHint
          ? { nodeId: id, reason, hint: guiFilterHint }
          : { nodeId: id, reason });
        skipped++;
        continue;
      }
      this.unprune(id);
      const wasNewToScope = !this.scopeNodeIds.has(id);
      const wasVisited = this.visited.has(id);
      if (wasNewToScope) this.scopeNodeIds.add(id);
      if (wasVisited) this.visited.delete(id);
      const existingDepth = this.depthFromOrigin.get(id);
      const depth = typeof existingDepth === 'number' ? existingDepth : 0;
      if (request.leadId) this.taskLedger.scheduleLead(request.leadId);
      for (const lead of this.taskLedger.pendingLeads) {
        if (lead.status === 'pending' && this.identifierKey(lead.nodeId) === this.identifierKey(id)) this.taskLedger.scheduleLead(lead.id);
      }
      this.enqueueHop(id, request.question, depth, 3, {
        carry: request.carry,
        freshScopeExpansion: wasNewToScope,
        reactivated: wasVisited,
        existingTaskId: request.existingTaskId,
        parentTaskId: request.parentTaskId,
      });
      this.supplementNodeIds.add(id);
    }

    const agendaed = this._agenda.length - agendaBefore;

    if (agendaed > 0) this._status = 'awaiting_findings';

    const modeLabel = this.tracer ? 'sm (ct)' : 'sm';
    this.log('info', `[Supplement] added ${requested.length} requested tasks → agendaed=${agendaed} skipped=${skipped}; mode=${modeLabel}, status=${this._status}`);

    return { ok: true, agendaed, skipped, skippedDetails };
  }

  /** Gets the details for the next scheduled navigation hop. */
  public getHopContext(): HopContext {
    let entry: AgendaEntry | undefined;
    while (this._agenda.length > 0) {
      const candidate = this._agenda.dequeue(this.worklistView());
      if (!candidate) break;

      if (this.visited.has(candidate.nodeId)) {
        this.completeTasks(candidate.taskIds);
        continue;
      }

      // Engine invariant: every accepted column task names qualified endpoints, so no dispatch, pass node included, reads bare names.
      if (candidate.taskIds.some(taskId => { const task = this.taskLedger.getTask(taskId); return task && !this.taskRefsResolve(task); })) {
        return this.failInvariant(candidate.nodeId, 'sourceRefs', COLUMN_SOURCE_MISSING);
      }
      if (this.passNodeIds.has(this.identifierKey(candidate.nodeId))) {
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

      const candidateNode = this.nodeMap.get(candidate.nodeId);
      if (candidateNode && !SCRIPT_TYPES.has(candidateNode.type)) {
        this.visited.add(candidate.nodeId);
        this.markNodeState(candidate.nodeId, 'passthrough', 'engine', 'storage_passthrough', {
          columns: candidate.activeColumns, atHop: this.hopCount,
        });
        this.memory.recordVerdict('passthrough');
        this.forwardStorageTasks(candidate);
        this.completeTasks(candidate.taskIds);
        this._totalNodes--;
        continue;
      }

      for (const taskId of candidate.taskIds) {
        const task = this.taskLedger.getTask(taskId);
        if (task?.callerContext && (task.parentTaskId !== task.callerContext.callerTaskId || !this.validFunctionCallerContext(candidate.nodeId, task.callerContext))) {
          return this.failInvariant(candidate.nodeId, 'callerContext', CALLER_CONTEXT_CHANGED);
        }
      }
      if (candidate.columnCarry?.kind === 'scalar_return') {
        for (const target of candidate.columnCarry.outputs) {
          if (!this.scopeNodeIds.has(target.node) || !this.resolveReturnTarget(candidate.nodeId, target, candidate.taskIds)) {
            return this.failInvariant(candidate.nodeId, 'columnCarry.outputs', SCALAR_BINDING_CHANGED);
          }
        }
        candidate.activeColumns = [...new Set(candidate.columnCarry.outputs.map(target => target.col))];
      }

      entry = candidate;
      break;
    }

    if (!entry) {
      this.resolvePendingPrunes(true);
      this._status = 'complete';
      this._totalNodes = this.hopCount;
      this.logLabelDiversity();
      return { done: true };
    }

    this.visited.add(entry.nodeId);
    this.pruneBallots.delete(entry.nodeId);
    this.taskLedger.dismissNodeLeads(entry.nodeId, 'pruned_by_ai');
    this.hopCount++;
    this.heldFindingDraft.clear();
    this.currentFocusNodeId = entry.nodeId;
    this.currentFocusTaskIds = [...entry.taskIds];
    for (const taskId of entry.taskIds) this.taskLedger.setTaskStatus(taskId, 'active');
    this.currentFocusQuestion = this.taskLedger.getTask(entry.taskIds[0])?.question ?? null;

    if (this.tracer) {
      this.tracer.setActiveColumns(entry.activeColumns || []);
    }
    this._pendingLineageQuestions = entry.lineageQuestions ? [...entry.lineageQuestions] : [];

    const node = this.nodeMap.get(entry.nodeId)!;

    const focusNode = buildHopFocusNode(
      node, this.nodeMap, buildUnrelatedMap(this.model), this.store ?? undefined, 'bb_ddl',
      this.model.neighborIndex, this.edgeTypeMap, this.identifierCaseSensitive,
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
      schemas: Array.from(this.sessionAllowedSchemas).filter(schema => !this.excludedSchemas.has(this.identifierKey(schema))).sort(),
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
      ...this.scalarReturnContext(),
      storage_context: this.currentStorageContext,
      neighbors: this.buildNeighborList(entry.nodeId),
      working_memory: workingMemory,
    };
  }

  /** Stops the live run on an engine invariant a dispatch or a submission cannot satisfy. */
  private failInvariant(nodeId: string, field: string, reason: string): HopContext {
    this.log('error', `[Invariant] dispatch refused field=${field} hop=${this.hopCount + 1} — engine stopped`);
    this.log('debug', `[Invariant] dispatch refused node=${nodeId} field=${field}`);
    this._status = 'error';
    this._errorReason = reason;
    return { done: false, sm_status: 'error' };
  }

  /** Open directional neighbors of this focus, including queued work; exact-depth proposals are marked deferred. */
  private openNeighbors(focusId: string): Array<{ id: string; queued: boolean; deferred: boolean }> {
    const directional = new Set(this.directionalNeighbors(focusId, this._direction));
    return this.neighborChoices(focusId).flatMap(({ id, can_question }) => {
      const node = this.nodeMap.get(id);
      if (!node || !can_question || !directional.has(id)) return [];
      const admission = this.admitsRoute(id, node, focusId);
      if (!admission.admitted && (admission.border.kind !== 'in_border' || admission.depthBreach === null)) return [];
      return [{ id, queued: this._agenda.has(id), deferred: !admission.admitted }];
    });
  }

  /** The metadata-driven question a passthrough candidate carries to the next object: whether that object touches the forwarded endpoints at all, not an assignment to map them. */
  private candidateQuestion(nid: string, side: 'upstream' | 'downstream', refs: ReadonlyArray<{ node: string; col: string }>): string {
    return `Determine whether ${nid} ${side === 'upstream' ? 'writes' : 'uses'} ${refs.map(ref => `${ref.node}.${ref.col}`).join(', ')}; map confirmed value contributions and end unused inputs on this branch.`;
  }

  /** Re-renders the current focus hop context without advancing the agenda. */
  public peekHopContext(): HopContext | null {
    const focusId = this.currentFocusNodeId;
    if (!focusId) return null;
    const node = this.nodeMap.get(focusId);
    if (!node) return null;
    const focusNode = buildHopFocusNode(
      node, this.nodeMap, buildUnrelatedMap(this.model), this.store ?? undefined, 'bb_ddl',
      this.model.neighborIndex, this.edgeTypeMap, this.identifierCaseSensitive,
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
      ...this.scalarReturnContext(),
      storage_context: this.currentStorageContext,
      neighbors: this.buildNeighborList(focusId),
      current_task: this.currentFocusQuestion ?? this._lastCurrentTask ?? undefined,
    };
  }

  /** Validates a hop decision's active status and canonical focus before held content or mutation. */
  private validateCurrentHopFocus(rawFocusId: unknown): string | ToolRejection {
    if (this._status === 'complete') return makeRejection({
      code: REJECTION_CODES.explorationComplete,
      hint: 'Hop loop is closed - every scope node has been analyzed and the archive is sealed. Call lineage_present_result to assemble the final report from the archive. Do not retry submit_findings.',
      detail: { next_action: 'present_result' },
    });
    if (this._status !== 'awaiting_findings') return makeRejection({
      code: REJECTION_CODES.invalidStatus,
      reason: `A hop decision arrived while the engine is in status '${this._status}', not 'awaiting_findings'.`,
      detail: { current_status: this._status },
    });
    const focusId = typeof rawFocusId === 'string'
      ? resolveModelNodeId(rawFocusId, this.nodeMap, this.identifierCaseSensitive) ?? undefined : undefined;
    if (!focusId || !this.nodeMap.has(focusId)) return makeRejection({
      code: REJECTION_CODES.invalidInput,
      reason: `focus_node_id \`${rawFocusId ?? ''}\` not found in the loaded model.`,
      hint: activeSubmitFindingsRecoveryHint(this.currentFocusNodeId ?? undefined),
    });
    const expected = this.currentFocusNodeId ?? '';
    if (focusId !== expected) return makeRejection({
      code: REJECTION_CODES.focusNodeIdMismatch,
      reason: `focus_node_id names \`${focusId}\`; the current object is \`${expected}\`.`,
      hint: `Resend the same call with focus_node_id \`${expected}\`.`,
      issuePaths: ['focus_node_id'],
      detail: { expected, got: focusId },
    });
    return focusId;
  }

  /** True when only storage-forwarded tasks reached this nonroot SQL object without a committed mapping. */
  public get canPruneCurrent(): boolean {
    return this.passthroughSender() !== undefined;
  }

  /** Storage sender shared by the active hop's candidate-only arrivals; mixed direct work stays protected. */
  private passthroughSender(): string | undefined {
    const focus = this.currentFocusNodeId;
    if (this._status !== 'awaiting_findings' || !focus || focus === this.originNodeId
      || !SCRIPT_TYPES.has(this.nodeMap.get(focus)!.type)) return undefined;
    const tasks = this.getCurrentTasks();
    if (!tasks.length || tasks.some(task => !task.passthroughFromNodeId
      || SCRIPT_TYPES.has(this.nodeMap.get(task.passthroughFromNodeId)?.type ?? 'view'))) return undefined;
    if (this.tracer?.edges.some(edge => edge.from_node === focus || edge.to_node === focus)) return undefined;
    return tasks[0]!.passthroughFromNodeId;
  }

  /** Available storage definitions on this route, retained as metadata without inventing loading SQL or column edges. */
  public get currentStorageContext(): ReadonlyArray<Record<string, unknown>> {
    const ids = new Set(this.getCurrentTasks().flatMap(task => [
      ...(task.passthroughFromNodeId ? [task.passthroughFromNodeId] : []),
      ...(this.qualifiedTaskRefs(task) ?? []).map(ref => ref.node),
    ]));
    return [...ids].flatMap(id => {
      const node = this.nodeMap.get(id);
      if (!node || SCRIPT_TYPES.has(node.type)) return [];
      const ddl = getNodeDdl(id, this.nodeMap, this.store ?? undefined);
      return [{ ...buildHopFocusNode(node, this.nodeMap, buildUnrelatedMap(this.model), this.store ?? undefined,
        'ddl', this.model.neighborIndex, this.edgeTypeMap, this.identifierCaseSensitive),
        columns: getNodeColumns(id, this.nodeMap, this.store ?? undefined) ?? [], ...(ddl ? { ddl } : {}) }];
    });
  }

  /** Removes a whole unrelated hop reached through passthrough and the open nodes the shared directed pruning rule cuts with it. Uses the ordinary structural removal policy in BB and CT; unaffected branches remain. */
  public pruneCurrent(focusNodeId: string, reason: string): SubmitResult {
    const focusId = this.validateCurrentHopFocus(focusNodeId);
    if (typeof focusId !== 'string') return focusId;
    if (typeof reason !== 'string' || !reason.trim()) return makeRejection({
      code: REJECTION_CODES.invalidInput, reason: 'A non-empty reason must explain why this object is unrelated.',
    });
    const fromNodeId = this.passthroughSender();
    const hint = 'Use lineage_submit_findings to resolve this hop.';
    if (fromNodeId === undefined) return makeRejection({
      code: REJECTION_CODES.invalidInput, reason: 'The current hop was not reached through passthrough.', hint,
    });
    const refusal = this.pruneRefusal([focusId]);
    if (refusal) return makeRejection({ code: REJECTION_CODES.invalidInput, reason: refusal, hint });
    const removal = this.removalSupport(this.removedSet, new Set([...this.removedSet, focusId]));
    const removed = new Set([focusId, ...removal.cutIds]);
    const mapped = (this.tracer?.edges ?? []).filter(edge => removed.has(edge.from_node) || removed.has(edge.to_node));
    if (mapped.length > 0) return makeRejection({
      code: REJECTION_CODES.invalidInput,
      reason: `Committed column mappings name ${[...new Set(mapped.flatMap(edge => [edge.from_node, edge.to_node]).filter(id => removed.has(id)))].join(', ')}; pruning would remove them.`,
      hint,
    });

    this.beginHopCommit(0);
    this.lastHopDetailChars = 0;
    this.lastHopSummaryChars = reason.length;
    this.archiveChars += reason.length;
    this.memory.storeDetail(this.nodeMap.get(focusId)!, [], reason, { incoming_questions: this.currentIncomingQuestions() });
    this.removedSet.add(focusId);
    this.hopRemovals.pruned.push(focusId);
    this.pruneBallots.delete(focusId);
    this.markNodeState(focusId, 'prune', 'ai', 'submitted_prune', { viaNodeId: fromNodeId, atHop: this.hopCount });
    this.lastHopVerdict = 'prune';
    this.completeTasks(this.currentFocusTaskIds);
    this.recordPruneLead(focusId, fromNodeId, reason);
    this.cutUnreachable(focusId, removal);
    this.finishHopCommit();
    this.log('debug', `[Self-Prune] hop=${this.hopCount} id=${focusId}`);
    return { ok: true, ...this.commitRemovals };
  }

  /** The removals since the current hop commit began: `pruned` for nodes a prune named, `cut_ids` for the open nodes the directed pruning rule cut with them. Includes a pending neighbor prune resolved when the agenda empties after the commit. Empty lists are omitted. */
  public get commitRemovals(): Pick<Extract<SubmitResult, { ok: true }>, 'pruned' | 'cut_ids'> {
    const { pruned, cut_ids } = this.hopRemovals;
    return { ...(pruned.length > 0 ? { pruned: [...pruned] } : {}), ...(cut_ids.length > 0 ? { cut_ids: [...cut_ids] } : {}) };
  }

  /** Starts the bookkeeping shared by every committed hop decision. */
  private beginHopCommit(columnFlowEntries: number): void {
    this.committedHops++;
    this.lastRoutedNew = 0;
    this.lastRoutedRejected = 0;
    this.lastRoutedDeferred = 0;
    this.lastHopColumnFlowEntries = columnFlowEntries;
    this._pendingLineageQuestions = [];
    this.hopRemovals = { pruned: [], cut_ids: [] };
  }

  /** Ends every committed hop decision: resolves ready neighbor prunes and returns to exploring. */
  private finishHopCommit(): void {
    this.resolvePendingPrunes();
    this.heldFindingDraft.clear();
    this._status = 'exploring';
  }

  /** Why removing `nodeIds` now is refused, or undefined when the removal is supported. The check counts neighbor prunes still pending resolution, except targets this submission keeps by routing them. Routed targets and staged column endpoints are protected as committed analysis. */
  private pruneRefusal(nodeIds: readonly string[], routed: ReadonlySet<string> = new Set(), stagedColumnEdges: readonly ColumnEdge[] = []): string | undefined {
    const pending = [...this.pruneBallots].filter(([id, ballots]) => !routed.has(id) && [...ballots.values()].every(vote => vote === 'prune')).map(([id]) => id);
    const analysis = this.removalSupport(this.removedSet, new Set([...this.removedSet, ...pending, ...nodeIds]),
      new Set([...this.visited, ...routed, ...stagedColumnEdges.flatMap(edge => [edge.from_node, edge.to_node])]));
    if (analysis.rejection) return REMOVAL_REFUSAL[analysis.rejection];
    if (analysis.disconnectedVisited.length > 0) return `Removing it would disconnect committed analysis of ${analysis.disconnectedVisited.join(', ')}.`;
    return undefined;
  }

  /** Validates and commits the current SQL object's findings, explicit neighbor decisions and qualified column mappings. Every admitted open neighbor needs an authored question or prune decision, including queued work. Storage forwarding is engine-owned; this command never invents an investigation purpose or column source. */
  public submitFindings(params: HopSubmission): SubmitResult {
    const focusId = this.validateCurrentHopFocus(params?.focus_node_id);
    if (typeof focusId !== 'string') return focusId;

    const archivedAngles = this.memory.getArchivedAngles(focusId);
    // An omitted CT flow is restored from the held draft before the shape check requires one.
    if (params.column_flow === undefined && this.heldColumnFlow) {
      params = { ...params, column_flow: structuredClone(this.heldFindingDraft.get()!.column_flow) };
    }
    const shape = validateHopSubmissionShape(params, this.currentHopAnalysisMode, this.classification,
      this.heldFindingFocus !== this.currentFocusNodeId && archivedAngles.size === 0);
    if (!shape.ok) return shape.error;
    const merged = this.applyHeldContent(shape.data);
    if ('code' in merged) return merged;
    params = merged;
    // A missing locked angle joins the column, route and length checks below in one rejection.
    const classViolation = validateSectionsAgainstClassification(params.sections,
      this.classification, archivedAngles);

    if (this.getCurrentTasks().some(task => task.callerContext && (!task.nodeId || task.parentTaskId !== task.callerContext.callerTaskId || !this.validFunctionCallerContext(task.nodeId, task.callerContext)))) {
      // No model reply can restore the caller's loaded SQL: stop the engine as the dispatch check
      // does, and answer with a backend-fault code so the run ends on this reply.
      this.failInvariant(this.currentFocusNodeId ?? '', 'callerContext', CALLER_CONTEXT_CHANGED);
      return makeRejection({ code: REJECTION_CODES.invalidStatus, reason: CALLER_CONTEXT_CHANGED });
    }
    try {
      const invalidRoutes: InvalidRoute[] = [];
      const routeOutcomes: RouteOutcome[] = [];
      const finding: HopFindingKept = params;
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
      const acceptedNids = new Set<string>();
      const scopeAddNids = new Set<string>();
      const deferredRoutes: ValidatedHop['deferredRoutes'] = [];
      const prunedNeighborNids = new Set<string>();
      const stagedColumnEdges: ColumnEdge[] = [];
      const stagedColumnFlowEntries = this.tracer
        ? finding.column_flow?.length ?? 0
        : 0;
      const traceDirection = this.columnTraceDirection();
      const carryByNode = new Map<string, Set<string>>();
      const routeContexts: ValidatedHop['routeContexts'] = new Map();
      const flowQuestionByNode = new Map<string, string>();
      // A carried endpoint keeps its accepted identity in the declared spelling of its object's column.
      const addCarry = (nid: string, accepted: ScalarReturnTarget, traversalSide: 'upstream' | 'downstream'): void => {
        const declared = getNodeColumns(accepted.node, this.nodeMap, this.store ?? undefined)?.find(column => this.columnKey(column.name) === this.columnKey(accepted.col));
        const ref = { node: accepted.node, col: declared?.name ?? accepted.col };
        if (!carryByNode.has(nid)) carryByNode.set(nid, new Set());
        carryByNode.get(nid)!.add(ref.col);
        const legs = routeContexts.get(nid) ?? [];
        const prior = legs.find(leg => leg.traversalSide === traversalSide);
        if (prior) prior.sourceRefs = uniqueScalarReturnTargets([...prior.sourceRefs, ref], this.identifierCaseSensitive);
        else legs.push({ sourceRefs: [{ ...ref }], traversalSide });
        routeContexts.set(nid, legs);
      };
      const incomingRefs = this.incomingColumnRefs();
      const taskSides = new Set(this.getCurrentTasks().flatMap(task => task.kind === 'column_lineage' && task.traversalSide ? [task.traversalSide] : []));
      const mixedSides = taskSides.size > 1;
      const upstreamRefs = mixedSides ? this.incomingColumnRefs('upstream') : incomingRefs;
      const downstreamRefs = mixedSides ? this.incomingColumnRefs('downstream') : incomingRefs;
      let entrySides: Array<{ index: number; upstream: boolean; downstream: boolean }> | undefined;
      if (this.tracer && (finding.column_flow || this.currentReturnTargets().length)) {
        const validated = this.tracer.validateColumnFlow(focusId, finding, this.nodeMap, this.model, this.store ?? null, this.log, this.removedSet, traceDirection, upstreamRefs, this.currentReturnTargets(), this.getCurrentTasks().flatMap(task => task.callerContext && task.nodeId && this.validFunctionCallerContext(task.nodeId, task.callerContext) ? [{ node: task.callerContext.node, col: task.callerContext.col }] : []), mixedSides ? downstreamRefs : [], this.columnRoots(), this.columnContributorIds(focusId));
        invalidRoutes.push(...validated.invalidRoutes);
        entrySides = validated.entrySides;
        for (const edge of validated.stagedEdges) edge.hop = this.hopCount;
        stagedColumnEdges.push(...validated.stagedEdges);
      }
      const endpointKey = columnEndpointKeyFactory(this.nodeMap, this.identifierCaseSensitive);
      const arriving = new Set(incomingRefs.map(ref => endpointKey(ref.node, ref.col)));
      const mapped = new Set(stagedColumnEdges.flatMap(edge => [endpointKey(edge.from_node, edge.from_col), endpointKey(edge.to_node, edge.to_col)]));
      const terminated = new Set<string>();
      for (const [index, ref] of (finding.terminated_inputs ?? []).entries()) {
        const key = endpointKey(ref.node, ref.col);
        if (!arriving.has(key) || mapped.has(key)) {
          invalidRoutes.push({ kind: 'invalid_task_decision', id: focusId, path: `terminated_inputs.${index}`,
            reason: !arriving.has(key) ? `Terminated input \`${ref.node}.${ref.col}\` is not an assigned incoming column.` : `Input \`${ref.node}.${ref.col}\` is both mapped and terminated; choose one disposition.` });
        } else terminated.add(key);
      }
      if (this.tracer && finding.column_flow) {
        // A column is carried only when the one closure of the requested outputs holds it.
        const closureEdges = [...this.tracer.edges, ...stagedColumnEdges];
        const attachedUpstream = columnClosure(this.columnRoots(), closureEdges, 'upstream', endpointKey);
        const flowingDownstream = columnAttachment(this.columnRoots(), closureEdges, 'downstream', endpointKey).flowing;
        if (traceDirection === 'upstream') {
          for (const [index, entry] of finding.column_flow.entries()) {
            if (entrySides && !entrySides.some(side => side.index === index && side.upstream)) continue;
            for (const ref of entry.upstream_columns) {
              const nid = resolveModelNodeId(ref.node, this.nodeMap, this.identifierCaseSensitive) ?? this.identifierKey(ref.node);
              if (!attachedUpstream.has(endpointKey(nid, ref.col)) || terminated.has(endpointKey(nid, ref.col))) continue;
              addCarry(nid, { node: nid, col: ref.col }, 'upstream');
              if (!flowQuestionByNode.has(nid)) {
                flowQuestionByNode.set(nid, `Trace ${nid}.${ref.col} as upstream input for ${focusId}.${entry.out_col}.`);
              }
            }
          }
        }
        // A focus on the downstream side (the origin itself counts) forwards its tracked outputs
        // to its consumers whatever the trace direction — a bidirectional session traces columns
        // upstream while its origin still owes the declared column downstream.
        if (this.onDownstreamSide(focusId) && this.graph.hasNode(focusId)
          && (finding.column_flow.length > 0 || focusId === this.originNodeId || this.currentReturnTargets().length > 0)) {
          const outputs = new Map<string, { node: string; col: string }>();
          for (const [index, entry] of finding.column_flow.entries()) {
            if (entrySides && !entrySides.some(side => side.index === index && side.downstream)) continue;
            if (focusId !== this.originNodeId && entry.upstream_columns.length === 0) {
              continue;
            }
            const resolved = resolveColumnFlowTarget(entry, focusId, this.nodeMap, this.identifierCaseSensitive);
            if (!resolved) continue;
            const output = { node: resolved.attributionTo, col: resolved.attributionCol };
            const outputKey = endpointKey(output.node, output.col);
            if (flowingDownstream.has(outputKey)) {
              outputs.set(outputKey, output);
              const writer = resolved.writerEdge;
              if (writer && stagedColumnEdges.some(edge => edge.from_node === focusId
                && this.columnKey(edge.from_col) === this.columnKey(entry.out_col)
                && edge.to_node === writer.toNode && this.columnKey(edge.to_col) === this.columnKey(writer.toCol))) {
                const localOutput = { node: focusId, col: entry.out_col };
                if (flowingDownstream.has(endpointKey(localOutput.node, localOutput.col))) outputs.set(endpointKey(localOutput.node, localOutput.col), localOutput);
              }
            }
          }
          const continuation = [...outputs.values()].filter(ref => !terminated.has(endpointKey(ref.node, ref.col)));
          for (const nid of this.graph.outNeighbors(focusId)) {
            if (!this.onDownstreamSide(nid)) continue;
            // A declared write assigns the destination's endpoints, not the producer's borrowed ports.
            const assigned = continuation.filter(ref => this.identifierKey(ref.node) === this.identifierKey(nid));
            const routed = assigned.length ? assigned : continuation.filter(ref => this.identifierKey(ref.node) === this.identifierKey(focusId));
            for (const ref of routed) addCarry(nid, ref, 'downstream');
            if (routed.length > 0) {
              flowQuestionByNode.set(nid, assigned.length
                ? `Resolve the assigned endpoints ${routed.map(ref => `${ref.node}.${ref.col}`).join(', ')} in ${nid}; record their SQL-established relations and retain known outside dependencies or unresolved evidence in sections.`
                : this.candidateQuestion(nid, 'downstream', routed));
            }
          }
        }
      }

      const pruneTargets = (finding.prune_neighbors ?? []).map((prune, index) => ({
        raw: prune.id,
        resolved: resolveModelNodeId(prune.id, this.nodeMap, this.identifierCaseSensitive),
        path: `prune_neighbors.${index}.id`,
      }));
      const pruneNeighborIds = new Set(pruneTargets.map(t => t.resolved ?? this.identifierKey(t.raw)));

      const routeRequests: ValidatedHop['routeRequests'] = [];
      const requested = new Set<string>();
      const neighbors = new Map(this.neighborChoices(focusId).map(neighbor => [neighbor.id, neighbor]));
      (finding.questions ?? []).forEach((q, index) => {
        const nid = resolveModelNodeId(q.nodeId, this.nodeMap, this.identifierCaseSensitive);
        if (!nid) {
          invalidRoutes.push({ kind: 'question_not_neighbor', id: q.nodeId, path: `questions.${index}.nodeId`, reason: `Object \`${q.nodeId}\` is not in the loaded model.` });
          return;
        }
        if (!neighbors.has(nid)) {
          invalidRoutes.push({
            kind: 'question_not_neighbor',
            id: nid,
            path: `questions.${index}.nodeId`,
            reason: `\`${nid}\` is not a neighbor of the focus \`${focusId}\`.`,
          });
          return;
        }
        if (!neighbors.get(nid)!.can_question) {
          invalidRoutes.push({ kind: 'question_closed', id: nid, path: `questions.${index}.nodeId`,
            reason: `\`${nid}\` is already ${this.removedSet.has(nid) ? 'pruned' : 'visited'} and cannot receive another investigation in this run.`,
          });
          return;
        }
        if (pruneNeighborIds.has(nid)) {
          invalidRoutes.push({
            kind: 'prune_question_conflict',
            id: nid,
            path: `questions.${index}.nodeId`,
            reason: `\`${nid}\` is also named in prune_neighbors; the same submission cannot prune and investigate it.`,
          });
          return;
        }
        let callerContext: FunctionCallerContext | undefined;
        if (q.caller_context) {
          const target = resolveFunctionCallerTarget(nid, q.caller_context, this.nodeMap, this.model, this.store);
          const callerTask = this.getCurrentTasks().find(task => task.kind === 'column_lineage' && task.nodeId === focusId
            && task.activeColumns.some(col => this.columnKey(col) === this.columnKey(q.caller_context!.col)));
          const ddl = getNodeDdl(focusId, this.nodeMap, this.store ?? undefined);
          if (!target || target.node !== focusId || !callerTask || !ddl || !this.scopeNodeIds.has(focusId)) {
            const activeOutputs = [...new Set(this.getCurrentTasks()
              .filter(task => task.kind === 'column_lineage' && task.nodeId === focusId)
              .flatMap(task => task.activeColumns).filter((col): col is string => !!col))];
            invalidRoutes.push({ kind: 'bad_caller_context', id: focusId, path: `questions.${index}.caller_context`,
              reason: 'caller_context must name an active real output of the current caller, which reads this loaded function.', allowed_values: activeOutputs, when: { node: focusId } });
            return;
          }
          callerContext = { ...target, callerTaskId: callerTask.id, ddlHash: functionCallerDdlHash(ddl) };
        }
        requested.add(nid);
        routeRequests.push({ nodeId: nid, question: q.question, ...(callerContext ? { callerContext } : {}) });
      });
      for (const { id: nid } of this.openNeighbors(focusId).filter(neighbor => !neighbor.deferred)) {
        if (requested.has(nid) || pruneNeighborIds.has(nid)) continue;
        invalidRoutes.push({ kind: 'missing_task_decision', id: nid, path: `questions.${finding.questions?.length ?? 0}`,
          reason: `Eligible neighbor \`${nid}\` has no authored investigation question or prune decision. A column mapping supplies its trace context, not its investigation purpose.` });
      }
      const outOfScopePruneIds = new Set<string>();
      for (const target of pruneTargets) {
        if (!target.resolved || target.resolved === this.originNodeId) continue;
        if (!neighbors.has(target.resolved)) {
          outOfScopePruneIds.add(target.resolved);
          invalidRoutes.push({ kind: 'prune_unsupported', id: target.resolved, path: target.path,
            reason: `\`${target.resolved}\` is not a neighbor of the focus \`${focusId}\`; prune_neighbors may name only this hop's neighbors.` });
          continue;
        }
        const targetNode = this.nodeMap.get(target.resolved);
        if (!targetNode) continue;
        if (!this.admitsRoute(target.resolved, targetNode, focusId).admitted) {
          outOfScopePruneIds.add(target.resolved);
          invalidRoutes.push({
            kind: 'prune_noop_out_of_scope',
            id: target.resolved,
            path: target.path,
            reason: `\`${target.resolved}\` is outside the approved exploration scope and cannot be pruned.`,
          });
        }
      }
      const actionPolicy = this.pruneActionPolicy(focusId, pruneTargets.filter(t => !t.resolved || !outOfScopePruneIds.has(t.resolved)));

      for (const req of routeRequests) {
        const nid = req.nodeId;
        const nNode = this.nodeMap.get(nid);
        if (!nNode) continue;
        const { admitted, border, depthBreach } = this.admitsRoute(nid, nNode, focusId);
        if (!admitted) {
          const schemaBorder = border.kind === 'excluded' && this.isGuiHiddenSchemaBorder(border, nNode);
          const reason = border.kind === 'excluded' ? schemaBorder ? 'schema' as const : 'excluded' as const
            : border.kind === 'out_of_direction' ? 'out_of_direction' as const : 'depth' as const;
          routeOutcomes.push({ nodeId: nNode.id, accepted: false, deferred: true, reason });
          deferredRoutes.push({ nodeId: nNode.id, schema: nNode.schema, question: req.question, reason: reason === 'out_of_direction' ? 'direction' : reason,
            depth: reason === 'depth' || schemaBorder ? depthBreach ?? undefined : undefined });
          this.log('debug', reason === 'depth'
            ? `[Depth] border reached hop=${this.hopCount} id=${nNode.id} ← ${focusId} depth=${depthBreach} cap=up:${this.depthLimits.upstream}/down:${this.depthLimits.downstream}`
            : `[Agenda] route ignore hop=${this.hopCount} id=${nNode.id} ← ${focusId} reason=${reason}${reason === 'out_of_direction' ? ` direction=${this._direction}` : ''}`);
          continue;
        }

        acceptedNids.add(nid);
        routeOutcomes.push({ nodeId: nNode.id, accepted: true });
        if (!this.scopeNodeIds.has(nid)) scopeAddNids.add(nid);
        this.log('debug', `[Agenda] route accept hop=${this.hopCount} id=${nNode.id} ← ${focusId} subq=${trunc(req.question, 80)}`);
      }
      // CT check 1: a column reference names an object the approved scope reaches; anything else is rejected, never dropped.
      for (const [entryIndex, entry] of (this.tracer ? finding.column_flow ?? [] : []).entries()) {
        const refs = [
          ...(entry.writes_to ? [{ node: entry.writes_to.node, path: `column_flow.${entryIndex}.writes_to.node` }] : []),
          ...entry.upstream_columns.map((ref, refIndex) => ({ node: ref.node, path: `column_flow.${entryIndex}.upstream_columns.${refIndex}.node` })),
        ];
        for (const ref of refs) {
          const nid = resolveModelNodeId(ref.node, this.nodeMap, this.identifierCaseSensitive);
          const node = nid ? this.nodeMap.get(nid) : undefined;
          if (!nid || !node || this.admitsColumnReference(nid, node, focusId, acceptedNids)) continue;
          const { border, depthBreach } = this.admitsRoute(nid, node, focusId);
          const outside = border.kind === 'excluded' ? 'excluded' : border.kind === 'out_of_direction' ? 'out of direction' : depthBreach !== null ? `beyond depth ${depthBreach}` : null;
          if (!outside) continue;
          invalidRoutes.push({ kind: 'column_out_of_scope', id: nid, path: ref.path,
            reason: `\`${nid}\` is out of scope (${outside}) and will not appear in the AI preview. Record the dependency in sections or as a questions follow-up.` });
        }
      }
      invalidRoutes.push(...actionPolicy.invalidRoutes);
      const pruneIds = actionPolicy.acceptedPruneIds;
      const aloneRefusals = new Map(pruneIds.map(id => [id, this.pruneRefusal([id], acceptedNids, stagedColumnEdges)]));
      const jointRefusal = pruneIds.length > 1 && ![...aloneRefusals.values()].some(Boolean) ? this.pruneRefusal(pruneIds, acceptedNids, stagedColumnEdges) : undefined;
      for (const target of pruneTargets) {
        if (!target.resolved || !aloneRefusals.has(target.resolved)) continue;
        const refusal = aloneRefusals.get(target.resolved) ?? (jointRefusal && `${jointRefusal} (together with the other prune_neighbors entries)`);
        if (refusal) invalidRoutes.push({ kind: 'prune_unsupported', id: target.resolved, path: target.path, reason: `\`${target.resolved}\`: ${refusal}` });
      }
      for (const nid of pruneIds) prunedNeighborNids.add(nid);

      const stagedSections: ValidatedHop['stagedSections'] = finding.sections ?? [];
      const stagedSummaryChars = finding.summary?.length ?? 0;

      if (this.tracer) {
        const submittedFlow = finding.column_flow ?? [];
        const accounted = new Set(terminated);
        for (const entry of submittedFlow) {
          accounted.add(endpointKey(focusId, entry.out_col));
          const target = entry.returns_to ?? resolveColumnFlowTarget(entry, focusId, this.nodeMap, this.identifierCaseSensitive);
          if (target) accounted.add('node' in target ? endpointKey(target.node, target.col) : endpointKey(target.attributionTo, target.attributionCol));
          for (const ref of entry.upstream_columns) {
            const key = endpointKey(ref.node, ref.col);
            if (mapped.has(key)) accounted.add(key);
          }
        }
        for (const route of routeRequests) {
          if (!acceptedNids.has(route.nodeId)) continue;
          if (route.callerContext) accounted.add(endpointKey(route.callerContext.node, route.callerContext.col));
        }
        // An explicit empty flow on an ordinary arrival still declares that no input is carried.
        const wholeStop = submittedFlow.length === 0 && focusId !== this.originNodeId && this.currentReturnTargets().length === 0;
        // A passthrough-forwarded candidate (an endpoint on another object) is a question, not an assignment: left unmapped, its CT ends at this node.
        const candidates = new Set(this.getCurrentTasks().flatMap(task => task.passthroughFromNodeId === undefined ? []
          : (this.qualifiedTaskRefs(task) ?? []).filter(ref => this.identifierKey(ref.node) !== this.identifierKey(focusId)).map(ref => endpointKey(ref.node, ref.col))));
        const unaccounted = wholeStop ? [] : incomingRefs.filter(ref => !accounted.has(endpointKey(ref.node, ref.col)));
        const endedCandidates = unaccounted.filter(ref => candidates.has(endpointKey(ref.node, ref.col)));
        if (endedCandidates.length) this.log('debug', `[CT] unmapped candidates end hop=${this.hopCount} focus=${focusId} refs=[${endedCandidates.map(ref => `${ref.node}.${ref.col}`).join(', ')}]`);
        const missing = unaccounted.filter(ref => !candidates.has(endpointKey(ref.node, ref.col)));
        if (missing.length) invalidRoutes.push({ kind: 'missing_task_decision', id: focusId,
          path: focusId === this.originNodeId ? `column_flow.${submittedFlow.length}` : `terminated_inputs.${finding.terminated_inputs?.length ?? 0}`,
          reason: `Assigned column targets [${missing.map(ref => `${ref.node}.${ref.col}`).join(', ')}] have no mapping or explicit endpoint. Supply the missing mapping, or name an incoming column that stops in terminated_inputs.` });
      }
      const stagedDetailChars = stagedSections.reduce((sum, section) => sum + (section.text?.length ?? 0), 0);

      if (classViolation || lengthViolations.length > 0 || invalidRoutes.length > 0) {
        return this.rejectFinding(focusId, finding, classViolation, lengthViolations, invalidRoutes, pruneTargets, acceptedNids, stagedColumnEdges);
      }

      return this.applyValidatedHop({
        focusId, finding, routeRequests, flowQuestionByNode, routeOutcomes, acceptedNids, scopeAddNids, deferredRoutes, prunedNeighborNids,
        carryByNode, routeContexts, stagedSections, stagedDetailChars, stagedSummaryChars, stagedColumnEdges,
        stagedColumnFlowEntries,
      });
    } catch (err: unknown) {
      this.log('error', '[Engine] Exception in submitFindings', err);
      this._status = 'error';
      const message = err instanceof Error ? err.message : String(err);
      return makeRejection({
        code: REJECTION_CODES.engineCrash,
        reason: message || 'The engine failed while applying findings.',
      });
    }
  }

  /** One rejection for every engine-side fault of a submission — a missing locked section angle, an over-cap `badge_label` or `column_flow` note, and each fatal route/column failure — so one round corrects them all. Nothing is committed: the valid parts are held ({@link holdValidParts}) and the failed ones named for resending. A missing locked angle is owed without failing a sent angle; a failed list entry fails its whole list. */
  private rejectFinding(
    focusId: string,
    finding: HopFindingKept,
    classViolation: string | null | undefined,
    lengthViolations: ReadonlyArray<{ path: string; chars: number; limit: number }>,
    fatalRoutes: InvalidRoute[],
    pruneTargets: ReadonlyArray<{ raw: string; resolved: ReturnType<typeof resolveModelNodeId>; path: string }>,
    acceptedNids: ReadonlySet<string>,
    stagedColumnEdges: readonly ColumnEdge[],
  ): ToolRejection {
    const neighbors = this.neighborChoices(focusId);
    fatalRoutes = fatalRoutes.map(route => {
      const action = route.path?.startsWith('prune_neighbors.') ? 'can_prune'
        : route.path?.match(/^questions\.\d+\.nodeId$/) ? 'can_question' : undefined;
      return action ? { ...route, allowed_values: neighbors.filter(neighbor => neighbor[action]
        && (action !== 'can_prune' || !this.pruneRefusal([neighbor.id], acceptedNids, stagedColumnEdges))).map(neighbor => neighbor.id) } : route;
    });
    const conflictPrunePaths = fatalRoutes.flatMap(route => route.kind === 'prune_question_conflict'
      ? pruneTargets.filter(target => (target.resolved ?? this.identifierKey(target.raw)) === route.id).map(target => target.path)
      : []);
    const archived = this.memory.getArchivedAngles(focusId);
    const owedAngles = !classViolation ? [] : this.classification
      ? CLASSIFICATION_KEPT_ANGLES[this.classification].filter(angle => !archived.has(angle) && !finding.sections.some(section => section.angle === angle)).map(angle => `sections.${angle}`)
      : ['sections'];
    const held = this.holdValidParts(finding, [...owedAngles, ...lengthViolations.map(v => v.path), ...fatalRoutes.flatMap(route => route.path ? [route.path] : []), ...conflictPrunePaths]);
    const repairOrder = findingRepairOrder(held);
    const measured = lengthViolations.map(v => `${v.path}: ${v.chars} chars, limit ${v.limit}`).join('; ');
    if (measured) this.memory.recordRejection(focusId, `${REJECTION_CODES.fieldLengthExceeded}: ${measured}`, this.hopCount);
    if (fatalRoutes.length > 0) {
      this.lastRoutedRejected = fatalRoutes.length;
      for (const r of fatalRoutes) this.memory.recordRejection(r.id, r.reason, this.hopCount);
    }
    const lengthPaths = lengthViolations.map(v => v.path);
    const routePaths = [...fatalRoutes.flatMap(route => route.path ? [route.path] : []), ...conflictPrunePaths];
    const sectionReason = classViolation ? `sections: ${classViolation}` : '';
    const issuePaths = [...(sectionReason ? ['sections'] : []), ...lengthPaths, ...routePaths];
    const lengthDetail = lengthViolations.map(v => ({ path: v.path, chars: v.chars, limit: v.limit }));
    const categories = [sectionReason !== '', lengthViolations.length > 0, fatalRoutes.length > 0].filter(Boolean).length;
    if (categories === 1 && sectionReason) {
      return makeRejection({ code: REJECTION_CODES.invalidInput, reason: sectionReason, hint: repairOrder, issuePaths });
    }
    if (categories === 1 && measured) {
      return makeRejection({
        code: REJECTION_CODES.fieldLengthExceeded,
        hint: `${measured}. Nothing was committed. Shorten the listed field(s) for ${focusId}. ${repairOrder}`,
        detail: lengthDetail,
        issuePaths,
      });
    }
    if (categories === 1) {
      const rejection = buildRouteValidationRejection(fatalRoutes, repairOrder);
      return { ...rejection, issuePaths: [...new Set([...(rejection.issuePaths ?? []), ...conflictPrunePaths])] };
    }
    return makeRejection({
      code: REJECTION_CODES.invalidInput,
      reason: [sectionReason, measured, fatalRoutes.length > 0 ? routeRejectionReason(fatalRoutes) : ''].filter(Boolean).join('\n'),
      hint: [
        measured ? `Shorten the listed field(s) for ${focusId}.` : '',
        fatalRoutes.length > 0 ? routeRejectionDirectives(fatalRoutes) : '',
        'Nothing was committed.',
        repairOrder,
      ].filter(Boolean).join(' '),
      detail: [...lengthDetail, ...routeRejectionDetail(fatalRoutes)],
      issuePaths,
    });
  }

  /** Whether `nodeId` sits on the approved downstream side of the origin (the origin itself counts). */
  private onDownstreamSide(nodeId: string): boolean {
    if (this.effectiveDirection() === 'upstream') return false;
    if (nodeId === this.originNodeId) return true;
    return this.directedDepthsFor(nodeId)?.downstream !== undefined;
  }

  /** Removes the open nodes the latest removals left without a directed path to the origin. */
  private cutUnreachable(cutNodeId: string, removal: RemovalAnalysis): void {
    const dropped = removal.cutIds;
    this.hopRemovals.cut_ids.push(...dropped);
    for (const id of dropped) {
      this.removedSet.add(id);
      this.pruneBallots.delete(id);
      const queued = this._agenda.remove(id);
      if (queued) this.completeTasks(queued.taskIds);
      this.markNodeState(id, 'prune', 'engine', 'bb_prune_neighbor', { viaNodeId: cutNodeId, atHop: this.hopCount });
      const node = this.nodeMap.get(id);
      if (node && this.scopeNodeIds.has(id)) this._totalNodes--;
    }
    if (dropped.length > 0) {
      this.log('debug', `[Cut] hop=${this.hopCount} via=${cutNodeId} dropped=[${dropped.join(', ')}] (total → ${this._totalNodes})`);
    }
  }

  /** Commits a kept hop whose submission passed every validation guard: route deferrals, scope growth, neighbour prunes and their cut, the focus verdict and the enqueued neighbours, each exactly once. */
  private applyValidatedHop(staged: ValidatedHop): SubmitResult {
    const {
      focusId, finding, routeRequests, flowQuestionByNode, routeOutcomes, acceptedNids, scopeAddNids, deferredRoutes, prunedNeighborNids,
      carryByNode, routeContexts, stagedSections, stagedDetailChars, stagedSummaryChars, stagedColumnEdges,
      stagedColumnFlowEntries,
    } = staged;
    let lineageQuestionsByNode: Map<string, string[]> | undefined;
    this.beginHopCommit(stagedColumnFlowEntries);

    for (const deferred of deferredRoutes) {
      this.deferQuestion({
        nodeId: deferred.nodeId,
        schema: deferred.schema,
        fromFocusNodeId: focusId,
        question: deferred.question,
        reason: deferred.reason,
        depth: deferred.depth,
        atHop: this.hopCount,
      }, routeContexts.get(deferred.nodeId));
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

    const pruneReasons = new Map((finding.prune_neighbors ?? []).flatMap(prune => {
      const id = resolveModelNodeId(prune.id, this.nodeMap, this.identifierCaseSensitive);
      return id && prune.reason.trim() ? [[id, prune.reason] as const] : [];
    }));
    for (const nid of prunedNeighborNids) {
      const reason = pruneReasons.get(nid);
      if (this.recordBallot(nid, focusId, 'prune') && reason) this.recordPruneLead(nid, focusId, reason);
    }
    this.memory.storeDetail(
      this.nodeMap.get(focusId)!,
      stagedSections,
      finding.summary,
      {
        badge_label: finding.badge_label,
        incoming_questions: this.currentIncomingQuestions(),
      },
      message => this.log('debug', message),
    );
    this.lastHopDetailChars = stagedDetailChars;
    this.lastHopSummaryChars = stagedSummaryChars;
    this.archiveChars += this.lastHopDetailChars + this.lastHopSummaryChars;

    if (this.tracer && stagedColumnEdges.length > 0) {
      this.tracer.edges.push(...stagedColumnEdges);
      lineageQuestionsByNode = this.tracer.getColumnLineageQuestionsByNode(focusId, this.hopCount);
      this.log('debug', `[CT] column_flow hop=${this.hopCount} focus=${focusId} entries=${this.lastHopColumnFlowEntries} total_edges=${this.tracer.edges.length} active_cols=${this.tracer.activeColumns.join(',')}`);
    }
    this.tryResolvePrunes([...prunedNeighborNids]);

    this.memory.recordVerdict('analyze');
    this.lastHopVerdict = 'analyze';
    this.markNodeState(
      focusId,
      'analyze',
      'ai',
      'submitted_analyze',
      {
        columns: this.tracer?.activeColumns,
        ...(this.tracer ? { columnRole: this.tracer.activeColumns.length > 0 ? 'carrier' as const : 'row_role_only' as const } : {}),
        atHop: this.hopCount,
      },
    );
    this.completeTasks(this.currentFocusTaskIds);

    const freshlyExpandedIds = new Set<string>(scopeAddNids);
    for (const req of routeRequests) {
      const nid = req.nodeId;
      if (!acceptedNids.has(nid)) continue;
      if (this.removedSet.has(nid)) {
        const i = routeOutcomes.findIndex(o => o.nodeId === nid && o.accepted);
        if (i >= 0) routeOutcomes[i] = { nodeId: nid, accepted: false, reason: 'already_pruned' };
        continue;
      }

      const agendaSizeBefore = this._agenda.length;
      const isFreshExpansion = freshlyExpandedIds.delete(nid);
      const columnQuestions = lineageQuestionsByNode?.get(nid) ?? (flowQuestionByNode.has(nid) ? [flowQuestionByNode.get(nid)!] : undefined);
      const dispositions = new Map<string, RouteSkipDisposition>();
      const legs = routeContexts.get(nid) ?? [undefined];
      for (const leg of legs) {
        const legCarry = leg ? new Map([[nid, new Set(leg.sourceRefs.map(ref => ref.col))]]) : carryByNode;
        this.enqueueHop(nid, req.question, 0, 2, {
          dispositions,
          carry: this.neighborCarryFor(nid, legCarry, req.callerContext),
          sourceRefs: leg?.sourceRefs,
          traversalSide: leg?.traversalSide,
          ...(req.callerContext ? { callerContext: req.callerContext, parentTaskId: req.callerContext.callerTaskId } : {}),
          lineageQuestions: columnQuestions,
          freshScopeExpansion: isFreshExpansion,
        });
      }
      const added = this._agenda.length - agendaSizeBefore;
      this.lastRoutedNew += Math.max(0, added);

      // A target already queued merges into its pending hop and stays accepted; only a visit-once skip is reported.
      const directSkip = dispositions.get(nid);
      if (added === 0 && directSkip && directSkip !== 'not_enqueued') {
        for (let i = routeOutcomes.length - 1; i >= 0; i--) {
          if (routeOutcomes[i].nodeId !== nid || !routeOutcomes[i].accepted) continue;
          routeOutcomes[i] = { nodeId: nid, accepted: false, reason: directSkip };
          break;
        }
      }
    }

    for (const o of routeOutcomes) {
      if (o.accepted) continue;
      this.log('debug', `[Agenda] route outcome hop=${this.hopCount} focus=${focusId} id=${o.nodeId} accepted=false reason=${o.reason ?? 'none'}${o.deferred ? ' deferred=true' : ''}`);
    }
    this.finishHopCommit();
    const outcomes = routeOutcomes.length > 0 ? { route_outcomes: routeOutcomes } : {};

    return { ok: true, ...outcomes, ...this.commitRemovals };
  }

  /** Measures the scope for the exploration admission check: total nodes, rounds (the hops the run takes: those already taken, one per unvisited object not explicitly passed by the user, and one per supplement target) and the distinct starting trace columns. */
  public measureAdmissionScope(extraIds: readonly string[] = []): ProposedScope {
    const extra = new Set(extraIds);
    const ids = new Set(this.scopeNodeIds);
    for (const id of extra) ids.add(id);
    let rounds = this.hopCount;
    for (const nid of ids) {
      const n = this.nodeMap.get(nid);
      if (!n) continue;
      const takesHop = SCRIPT_TYPES.has(n.type) && !this.passNodeIds.has(this.identifierKey(nid))
        && (extra.has(nid) || (!this.visited.has(nid) && !this.removedSet.has(nid)));
      if (takesHop) rounds++;
    }
    return { nodes: ids.size, rounds, columns: new Set(this.currentTargetColumns ?? []).size };
  }

  /** Measures the scope a supplement would produce — the existing scope plus every object the supplement would admit — without changing the engine. A supplement selects no starting columns. */
  public measureSupplementScope(nodeIds: readonly string[], chain?: SupplementChain): ProposedScope {
    const ids = (chain ? this.expandSupplementChain(nodeIds, chain) : [...nodeIds]).map(raw => resolveModelNodeId(raw, this.nodeMap, this.identifierCaseSensitive) ?? raw);
    const seen = new Set(ids);
    for (let index = 0; index < ids.length; index++) {
      const node = this.nodeMap.get(ids[index]!);
      if (!node || SCRIPT_TYPES.has(node.type) || this.checkBorder(node.id, node, 'supplement').kind !== 'in_border') continue;
      for (const nid of this.directionalNeighbors(node.id, this._direction)) {
        const next = this.nodeMap.get(nid);
        if (!next || seen.has(nid) || this.visited.has(nid) || this.removedSet.has(nid)
          || this.checkBorder(nid, next, 'route').kind !== 'in_border') continue;
        seen.add(nid);
        ids.push(nid);
      }
    }
    return { ...this.measureAdmissionScope(this.admitSupplementTargets(ids).admitted), columns: 0 };
  }

  /** Calculates the approximate number of DDL characters required by the scope. */
  private estimateScopeDdlChars(): number {
    let total = 0;
    for (const nid of this.scopeNodeIds) {
      const ddl = getNodeDdl(nid, this.nodeMap, this.store ?? undefined);
      if (ddl) total += ddl.length;
    }
    return total;
  }

  /** Evaluates the breadth-first search reachability for initializing traversal scope. */
  private computeBfsScope(
    startId: string,
    direction: 'upstream' | 'downstream' | 'bidirectional',
  ): Set<string> {
    const seen = new Set<string>();
    this.depthFromOrigin.clear();
    this.directedDepths.clear();
    this.directedDepthsFilled = false;

    const limit = (side: 'upstream' | 'downstream'): number => this.depthLimits[side];
    const hasFilters = this.excludedTypes.size > 0 || this.excludedSchemas.size > 0 || this.excludedNodeIds.size > 0;
    const walk = (mode: 'inbound' | 'outbound', maxDepth: number): void => {
      bfsFromNode(this.graph, startId, (key, _attr, depth) => {
        if (hasFilters && key !== startId) {
          const node = this.nodeMap.get(key);
          if (node && this.checkBorder(key, node, 'seed_bfs').kind !== 'in_border') return true;
        }
        seen.add(key);
        const prior = this.depthFromOrigin.get(key);
        if (prior === undefined || depth < prior) this.depthFromOrigin.set(key, depth);
        return depth >= maxDepth;
      }, { mode });
    };
    if (direction === 'upstream' || direction === 'bidirectional') walk('inbound', limit('upstream'));
    if (direction === 'downstream' || direction === 'bidirectional') walk('outbound', limit('downstream'));

    return seen;
  }

  /** Returns directional graph neighbors based on the active exploration direction. */
  private directionalNeighbors(nodeId: string, direction: 'upstream' | 'downstream' | 'bidirectional'): string[] {
    if (direction === 'upstream') return this.graph.inNeighbors(nodeId);
    if (direction === 'downstream') return this.graph.outNeighbors(nodeId);
    return this.graph.neighbors(nodeId);
  }

  /** The note graph the agenda schedules over, read from current engine state. */
  private worklistView(): WorklistView {
    const allowed = this.allowedNoteSides();
    return {
      successors: nodeId => this.noteWalk(nodeId, allowed, false),
      distance: entry => this.directedDepthFromOrigin(entry.nodeId)?.depth ?? entry.depth,
    };
  }

  /** The note-graph sides the active direction allows ({@link worklistView}). */
  private allowedNoteSides(): ReadonlyArray<'upstream' | 'downstream'> {
    const direction = this.effectiveDirection();
    return direction === 'bidirectional' ? ['upstream', 'downstream'] : [direction];
  }

  /** Finds unfinished adjacent receivers, walking through only explicitly user-passed nodes. */
  private noteWalk(nodeId: string, allowed: ReadonlyArray<'upstream' | 'downstream'>, reversed: boolean): string[] {
    if (!this.graph.hasNode(nodeId)) return [];
    const sidesOf = (id: string) => (id === this.originNodeId
      ? allowed
      : allowed.filter(side => this.directedDepthsFor(id)?.[side] !== undefined));
    const out = new Set<string>();
    for (const side of sidesOf(nodeId)) {
      const followsInNeighbors = reversed ? side === 'downstream' : side === 'upstream';
      const step = (id: string) => (followsInNeighbors ? this.graph.inNeighbors(id) : this.graph.outNeighbors(id));
      const carriers = new Set<string>();
      const stack = step(nodeId);
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (id === nodeId) continue;
        const node = this.nodeMap.get(id);
        if (!node) continue;
        const queued = this._agenda.has(id);
        if (!this.passNodeIds.has(this.identifierKey(id))) {
          const unfinished = queued
            || (this.scopeNodeIds.has(id) && !this.visited.has(id) && !this.removedSet.has(id));
          if (unfinished && sidesOf(id).includes(side)) out.add(id);
          continue;
        }
        if (carriers.has(id) || this.removedSet.has(id)) continue;
        carriers.add(id);
        stack.push(...step(id));
      }
    }
    return Array.from(out);
  }

  /** Stores one sender's ballot without resolving it; false when `nodeId` is already removed. */
  private recordBallot(nodeId: string, focusId: string, vote: 'prune' | 'keep'): boolean {
    if (this.removedSet.has(nodeId)) return false;
    let ballots = this.pruneBallots.get(nodeId);
    if (!ballots) { ballots = new Map(); this.pruneBallots.set(nodeId, ballots); }
    ballots.set(focusId, vote);
    if (vote === 'prune') this.log('debug', `[Prune] vote hop=${this.hopCount} via=${focusId} id=${nodeId}`);
    return true;
  }

  /** Removes every node of `nodeIds` whose live senders have finished and whose ballots all read `'prune'` as one atomic removal proposal. */
  private tryResolvePrunes(nodeIds: readonly string[], runEnded = false): void {
    const ready: Array<{ nodeId: string; voters: string[] }> = [];
    for (const nodeId of nodeIds) {
      const ballots = this.pruneBallots.get(nodeId);
      if (!ballots || ballots.size === 0) continue;
      if (this.removedSet.has(nodeId) || this.visited.has(nodeId)) {
        this.pruneBallots.delete(nodeId);
        if (this.visited.has(nodeId)) this.taskLedger.dismissNodeLeads(nodeId, 'pruned_by_ai');
        continue;
      }
      const unheard = this.noteWalk(nodeId, this.allowedNoteSides(), true);
      if (unheard.length > 0) {
        if (!runEnded) continue;
        this.log('debug', `[Prune] resolve at run end id=${nodeId} unheard=[${trunc(unheard.join(', '), LOG_TRUNC_CONTENT)}] — agenda empty, no sender left to dispatch`);
      }
      const voters = Array.from(ballots.keys());
      const pruneVoters = voters.filter(id => ballots.get(id) === 'prune');
      this.pruneBallots.delete(nodeId);
      if (pruneVoters.length < voters.length) {
        this.taskLedger.dismissNodeLeads(nodeId, 'pruned_by_ai');
        if (pruneVoters.length > 0) {
          this.log('debug', `[Prune] resolve id=${nodeId} kept votes=${pruneVoters.length}/${voters.length}`);
          this.memory.recordRejection(nodeId, `\`${nodeId}\`: prune_neighbors could not remove it — another sender's route still keeps it in the answer.`, this.hopCount);
        }
        continue;
      }
      ready.push({ nodeId, voters });
    }
    const retain = (nodeId: string, analysis: RemovalAnalysis): void => {
      const refusal = analysis.rejection
        ? REMOVAL_REFUSAL[analysis.rejection]
        : `retained because removing it would disconnect previously visited analysis: ${analysis.disconnectedVisited.join(', ')}.`;
      this.memory.recordRejection(nodeId, `\`${nodeId}\`: ${refusal}`, this.hopCount);
      this.log('debug', `[Prune] reject id=${nodeId} reason=${analysis.rejection ?? 'visited_support'} count=${analysis.disconnectedVisited.length}`);
      this.taskLedger.dismissNodeLeads(nodeId, 'pruned_by_ai');
    };
    const batch = ready.filter(({ nodeId }) => {
      const alone = this.removalSupport(this.removedSet, new Set([...this.removedSet, nodeId]));
      if (alone.rejection || alone.disconnectedVisited.length) { retain(nodeId, alone); return false; }
      return true;
    });
    if (batch.length === 0) return;
    const removal = this.removalSupport(this.removedSet, new Set([...this.removedSet, ...batch.map(b => b.nodeId)]));
    if (removal.rejection || removal.disconnectedVisited.length) {
      for (const { nodeId } of batch) retain(nodeId, removal);
      return;
    }
    const first = [...batch].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1))[0];
    for (const { nodeId, voters } of batch) {
      this.removedSet.add(nodeId);
      this.hopRemovals.pruned.push(nodeId);
      this.markNodeState(nodeId, 'prune', 'ai', 'bb_prune_neighbor', { viaNodeId: voters.at(-1) ?? nodeId, atHop: this.hopCount });
      if (!this.visited.has(nodeId) && this.scopeNodeIds.has(nodeId)) {
        this._totalNodes--;
        this.log('debug', `[Prune] prune_neighbor ${nodeId} — scope node (total −1 → ${this._totalNodes})`);
      }
      this.log('debug', `[Prune] resolve id=${nodeId} removed votes=${voters.length}/${voters.length}`);
    }
    this.cutUnreachable(first.voters.at(-1) ?? first.nodeId, removal);
  }

  /** Re-attempts resolution for every neighbor prune still pending. */
  private resolvePendingPrunes(runEnded = false): void {
    this.tryResolvePrunes(Array.from(this.pruneBallots.keys()), runEnded);
  }

  /** Forwards storage arrivals through the shared agenda, preserving purpose and qualified candidates without claiming value edges. */
  private forwardStorageTasks(entry: AgendaEntry): void {
    const node = this.nodeMap.get(entry.nodeId)!;
    const columns = getNodeColumns(entry.nodeId, this.nodeMap, this.store ?? undefined) ?? [];
    this.memory.storeDetail(node, [{ angle: this.classification === 'business' ? 'business' : 'technical',
      text: `Storage metadata: ${JSON.stringify({ columns, ...(node.fks?.length ? { foreign_keys: node.fks } : {}) })}. Loading or consuming SQL must establish any value contribution.` }],
    'Storage object traversed without inferring a column mapping.');
    for (const nid of this.directionalNeighbors(entry.nodeId, this._direction)) {
      const next = this.nodeMap.get(nid);
      if (!next || this.visited.has(nid) || this.removedSet.has(nid)) {
        this.log('debug', `[Storage] not forwarded from=${entry.nodeId} next=${nid} — visited, removed or absent`);
        continue;
      }
      const admission = this.admitsRoute(nid, next, entry.nodeId);
      if (admission.border.kind !== 'in_border') {
        this.log('debug', `[Storage] not forwarded from=${entry.nodeId} next=${nid} — outside the approved border`);
        continue;
      }
      for (const taskId of entry.taskIds) {
        const task = this.taskLedger.getTask(taskId)!;
        const refs = this.qualifiedTaskRefs(task) ?? [];
        const sides: Array<'upstream' | 'downstream'> = task.traversalSide ? [task.traversalSide]
          : this.effectiveDirection() === 'bidirectional' ? ['upstream', 'downstream'] : [this.effectiveDirection() as 'upstream' | 'downstream'];
        const side = sides.find(direction => this.directionalNeighbors(entry.nodeId, direction).includes(nid));
        const carried = side ? refs : [];
        if (!admission.admitted && !this.scopeNodeIds.has(nid) && !this.supplementNodeIds.has(entry.nodeId)) {
          this.deferQuestion({ nodeId: nid, schema: next.schema, fromFocusNodeId: entry.nodeId,
            question: task.question, reason: 'depth', depth: admission.depthBreach ?? undefined, atHop: this.hopCount },
          carried.length && side ? [{ sourceRefs: carried, traversalSide: side }] : []);
          this.log('debug', `[Storage] deferred from=${entry.nodeId} next=${nid} — depth`);
          continue;
        }
        const fresh = !this.scopeNodeIds.has(nid);
        this.scopeNodeIds.add(nid);
        if (this.supplementNodeIds.has(entry.nodeId) && !SCRIPT_TYPES.has(next.type)) this.supplementNodeIds.add(nid);
        if (!this.depthFromOrigin.has(nid)) this.depthFromOrigin.set(nid, this.directedDepthFromOrigin(nid)?.depth ?? entry.depth + 1);
        const returns = next.type === 'function' && !getNodeColumns(nid, this.nodeMap, this.store ?? undefined)?.length
          ? carried.flatMap(ref => resolveScalarReturnTarget(nid, ref, this.nodeMap, this.store, this.identifierCaseSensitive) ?? []) : [];
        const carry: ColumnCarry = returns.length ? { kind: 'scalar_return', outputs: returns }
          : carried.length ? { kind: 'carry', columns: [...new Set(carried.map(ref => ref.col))] } : { kind: 'row_role_only' };
        this.enqueueHop(nid, task.question, entry.depth + 1, entry.priority, {
          carry, parentTaskId: task.id, sourceRefs: carried.length ? carried : undefined,
          traversalSide: carried.length ? side : undefined, passthroughFromNodeId: entry.nodeId,
          lineageQuestions: carried.length && side ? [this.candidateQuestion(nid, side, carried)] : undefined,
          freshScopeExpansion: fresh,
        });
        this.log('debug', `[Storage] forwarded from=${entry.nodeId} next=${nid} refs=${carried.length}`);
      }
    }
  }

  /** Forwards a pass-tagged node's intent to its in-direction bodied neighbours. */
  private contractThroughPassNode(entry: AgendaEntry): void {
    for (const nid of this.directionalNeighbors(entry.nodeId, this._direction)) {
      for (const taskId of entry.taskIds) {
        const task = this.taskLedger.getTask(taskId)!;
        const continues = !task.traversalSide || this.directionalNeighbors(entry.nodeId, task.traversalSide).includes(nid);
        const validCaller = continues && task.callerContext && this.validFunctionCallerContext(nid, task.callerContext) ? task.callerContext : undefined;
        const targets = continues && task.kind === 'column_lineage' ? task.returnTargets?.filter(target => this.resolveReturnTarget(nid, target, [task.id])) : undefined;
        const unresolved = continues && task.kind === 'column_lineage' && !targets?.length
          ? this.passNodeUnresolvedQuestion(entry.nodeId, this.qualifiedTaskRefs(task) ?? [])
          : '';
        this.enqueueHop(nid, unresolved ? `${task.question}${task.question ? '\n' : ''}${unresolved}` : task.question, entry.depth + 1, entry.priority, {
          carry: targets?.length ? { kind: 'scalar_return', outputs: targets } : { kind: 'row_role_only' },
          parentTaskId: validCaller?.callerTaskId ?? task.id,
          ...(validCaller ? { callerContext: validCaller } : {}),
          lineageQuestions: targets?.length ? entry.lineageQuestions : undefined,
          traversalSide: continues ? task.traversalSide : undefined,
          sourceRefs: targets?.length && task.kind === 'column_lineage' ? task.sourceRefs ?? task.returnTargets : undefined,
          passthroughFromNodeId: entry.nodeId,
        });
      }
    }
  }

  /** The source-qualified question a column continuation leaves at a pass node it cannot cross. */
  private passNodeUnresolvedQuestion(passNodeId: string, refs: ReadonlyArray<{ node: string; col: string }>): string {
    const named = refs.map(ref => `\`${ref.node}.${ref.col}\``).join(', ');
    this.log('debug', `[Agenda] column continuation stops at pass node=${passNodeId} refs=[${named}] — unresolved, dispatched as BB`);
    return `Column ${named} continues through \`${passNodeId}\`, which the approved scope passes through without analysis; no column mapping through it is recorded, so this continuation stays unresolved.`;
  }

  /** Single funnel for all writes to the agenda. */
  private enqueueHop(
    targetId: string,
    question: string,
    depth: number,
    priority: number,
    opts: {
      readonly carry: ColumnCarry;
      readonly lineageQuestions?: string[];
      readonly freshScopeExpansion?: boolean;
      readonly reactivated?: boolean;
      readonly callerContext?: FunctionCallerContext;
      readonly sourceRefs?: readonly ScalarReturnTarget[];
      readonly traversalSide?: 'upstream' | 'downstream';
      readonly existingTaskId?: string;
      readonly parentTaskId?: string;
      readonly passthroughFromNodeId?: string;
      readonly dispositions?: Map<string, RouteSkipDisposition>;
    },
  ): void {
    const {
      carry,
      lineageQuestions,
      freshScopeExpansion = !this.scopeNodeIds.has(targetId),
      reactivated = false,
      existingTaskId,
      callerContext,
      sourceRefs,
      traversalSide,
      parentTaskId,
      passthroughFromNodeId,
      dispositions,
    } = opts;
    if (!this.scopeNodeIds.has(targetId) && priority !== 3) {
      dispositions?.set(targetId, 'not_enqueued');
      this.log('debug', `[Disposition] enqueue drop ${targetId} — out-of-scope target`);
      return;
    }
    if (this.visited.has(targetId) || this.removedSet.has(targetId)) {
      const removed = this.removedSet.has(targetId);
      this.log('debug', `[Disposition] enqueue skip ${targetId} — already ${removed ? 'removed' : 'visited'} via focus=${this.currentFocusNodeId ?? this.originNodeId ?? '(none)'} hop=${this.hopCount}`);
      dispositions?.set(targetId, removed ? 'already_pruned' : 'already_visited');
      return;
    }
    const focusId = this.currentFocusNodeId;
    if (focusId && this._status === 'awaiting_findings' && this.visited.has(focusId) && this.recordBallot(targetId, focusId, 'keep')) {
      this.tryResolvePrunes([targetId]);
    }
    const node = this.nodeMap.get(targetId);
    if (!node) {
      this.log('debug', `[Disposition] enqueue drop ${targetId} — absent from the loaded graph model`);
      return;
    }

    const activeColumns = carry.kind === 'carry' ? carry.columns.filter(Boolean) : carry.kind === 'scalar_return' ? [...new Set(carry.outputs.map(target => target.col))] : undefined;
    if (!this.tracer && activeColumns?.length) {
      throw new Error('BB agenda tasks must not carry active columns');
    }
    if (this.tracer && node.type === 'function' && carry.kind === 'row_role_only' && !getNodeColumns(node.id, this.nodeMap, this.store ?? undefined)?.length) {
      question = `${question}${question ? '\n' : ''}No declared scalar caller output binding is available for this function. This visit does not resolve a caller's column contribution; do not invent function columns or return destinations.`;
    }
    const task = this.ensureExecutableTask(targetId, question, priority, activeColumns, existingTaskId, parentTaskId, carry.kind === 'scalar_return' ? carry.outputs : undefined, callerContext, sourceRefs, traversalSide, passthroughFromNodeId);
    const alreadyQueued = this._agenda.has(targetId);
    const agendaColumns = !this.tracer ? undefined : carry.kind === 'row_role_only' ? [] : activeColumns;
    const columnCarry = !this.tracer ? {} : { columnCarry: carry.kind === 'carry' ? { kind: 'carry' as const, columns: [...carry.columns] } : carry.kind === 'scalar_return' ? { kind: 'scalar_return' as const, outputs: carry.outputs.map(target => ({ ...target })) } : { ...carry } };
    this._agenda.push({ taskIds: [task.id], nodeId: targetId, priority, depth, activeColumns: agendaColumns, ...columnCarry, ...(lineageQuestions?.length ? { lineageQuestions } : {}) });
    if (!alreadyQueued && (freshScopeExpansion || reactivated)) this._totalNodes++;
  }

  /** Derives one neighbor's continuation from accepted flow, explicit qualified passthrough or a validated caller context. */
  private neighborCarryFor(nodeId: string, carryByNode: ReadonlyMap<string, ReadonlySet<string>>, callerContext?: FunctionCallerContext): ColumnCarry {
    if (!this.tracer) return { kind: 'carry', columns: [] };
    if (callerContext && !getNodeColumns(nodeId, this.nodeMap, this.store ?? undefined)?.length && this.validFunctionCallerContext(nodeId, callerContext)) {
      return { kind: 'scalar_return', outputs: [{ node: callerContext.node, col: callerContext.col }] };
    }
    const byKey = new Map<string, string>();
    for (const col of carryByNode.get(nodeId) ?? []) if (!byKey.has(this.columnKey(col))) byKey.set(this.columnKey(col), col);
    const columns = [...byKey.values()];
    return columns.length > 0 ? { kind: 'carry', columns } : { kind: 'row_role_only' };
  }

  /** Creates the typed task attached to a concrete agenda hop. */
  private ensureExecutableTask(
    nodeId: string,
    question: string,
    priority: number,
    activeColumns: string[] | undefined,
    existingTaskId?: string,
    parentTaskId: string | undefined = this.currentFocusTaskIds[0],
    returnTargets?: readonly ScalarReturnTarget[],
    callerContext?: FunctionCallerContext,
    sourceRefs?: readonly ScalarReturnTarget[],
    traversalSide?: 'upstream' | 'downstream',
    passthroughFromNodeId?: string,
  ): InvestigationTask {
    const existing = existingTaskId ? this.taskLedger.getTask(existingTaskId) : undefined;
    if (existing) return existing;
    return this.taskLedger.ensureTask(this.taskInputFor({
      source: priority === 2 ? 'model' : 'engine',
      question,
      nodeId,
      parentTaskId,
      createdHop: this.hopCount,
      ...(callerContext ? { callerContext } : {}),
      ...(traversalSide ? { traversalSide } : {}),
      ...(passthroughFromNodeId ? { passthroughFromNodeId } : {}),
    }, 'analytical', activeColumns, returnTargets, sourceRefs));
  }

  /** Collects neighboring node attributes for evaluation during hop routing. */
  private buildNeighborList(focusId: string): HopNeighborDisclosure[] {
    const inSet = new Set(this.graph.inNeighbors(focusId));
    const edgeVerb = new Map<string, string>();
    for (const e of this.model.edges) {
      if (e.source !== focusId && e.target !== focusId) continue;
      const other = e.source === focusId ? e.target : e.source;
      const verb = edgeApiType(e.type, this.nodeMap.get(e.source)?.type ?? '');
      if (verb !== 'read' || !edgeVerb.has(other)) edgeVerb.set(other, verb);
    }
    return this.neighborChoices(focusId).map(({ id: nid, ...capabilities }) => {
      const n = this.nodeMap.get(nid)!;
      const boundary = this.visited.has(nid) ? 'cycle' : 'none';
      const edgeDirection = inSet.has(nid) ? 'upstream' : 'downstream';
      // A table the focus writes carries its column constraints: the focus SQL alone cannot show
      // whether a value it inserts is accepted, e.g. a NULL into a NOT NULL column.
      const writtenColumns = edgeVerb.get(nid) === 'write' && n.type === 'table'
        ? getNodeColumns(nid, this.nodeMap, this.store ?? undefined)?.map(c => presentColumnCompact(c))
        : undefined;
      const cols = writtenColumns ?? (this.tracer
        ? getNodeColumns(nid, this.nodeMap, this.store ?? undefined)?.map(c => c.name)
        : undefined);
      const attributedColumns = this.tracer?.spineColumnsFor(nid, this.columnTraceDirection()) ?? [];
      const neighbor: HopNeighborDisclosure = {
        id: nid, s: n.schema, n: n.name, t: n.type,
        edge_direction: edgeDirection,
        edge_type: edgeVerb.get(nid) ?? 'read', boundary, ...(cols?.length ? { cols } : {}),
        ...capabilities,
        ...(this.isCarrierInto(nid, focusId) ? { prune_protected: true } : {}),
        ...(this.visited.has(nid) ? { already_visited: true } : {}),
        ...(this.removedSet.has(nid) ? { already_removed: true } : {}),
        ...(attributedColumns.length ? { attributed_columns: attributedColumns } : {}),
        ...(!this.isReachableInApprovedDirection(nid) ? { out_of_direction: true } : {}),
      };

      const d = this.depthFromOrigin.get(nid);
      if (d !== undefined) neighbor.depth_from_origin = d;
      neighbor.in_budget = this.scopeNodeIds.has(nid);

      neighbor.in_approved_scope = this.admitsRoute(nid, n, focusId).admitted;
      return neighbor;
    });
  }

  /** One neighbor projection for context, schemas, routing and repair choices. Questions may propose deferred work. */
  private neighborChoices(focusId: string): Array<Pick<HopNeighborDisclosure, 'id' | 'can_question' | 'can_prune'>> {
    const ids = this.graph.hasNode(focusId) ? this.graph.neighbors(focusId) : [];
    const prunable = new Set(this.pruneActionPolicy(focusId, ids.map((id, index) => ({ raw: id, resolved: id, path: `prune_neighbors.${index}.id` }))).acceptedPruneIds);
    return ids.map(id => {
      const node = this.nodeMap.get(id);
      const open = !!node && !this.visited.has(id) && !this.removedSet.has(id);
      return { id, can_question: open,
        can_prune: !!node && prunable.has(id) && this.scopeNodeIds.has(id) && this.admitsRoute(id, node, focusId).admitted && !this.pruneRefusal([id]),
      };
    });
  }

  /** The same action-state facts feed advertised prune choices and final submission validation. */
  private pruneActionPolicy(focusId: string, pruneTargets: CurrentHopActionTarget[]) {
    return evaluateCurrentHopActionPolicy({
      originId: this.originNodeId ?? '', pruneTargets,
      visitedIds: new Set([...this.visited, ...pruneTargets.flatMap(target =>
        target.resolved && this.isCarrierInto(target.resolved, focusId) ? [target.resolved] : [])]),
      removedIds: this.removedSet,
      notedIds: new Set(this.memory.notedNodeIds),
      agendaIds: new Set(this._agenda.entries.map(entry => entry.nodeId)),
    });
  }

  /** Shortest node chain from origin to a node, ignoring `removedSet` but bounded to `scopeNodeIds` (plus the target itself) so a chain is never assembled from ground the run never explored. */
  private scopeBoundedPathToOrigin(targetId: string, sides?: ReadonlyArray<'upstream' | 'downstream'>): string[] | null {
    const origin = this.originNodeId;
    if (!origin || !this.graph.hasNode(targetId)) return null;
    if (targetId === origin) return [origin];
    const parent = new Map<string, string>();
    const seen = new Set<string>([origin]);
    const queue = [origin];
    for (let idx = 0; idx < queue.length; idx++) {
      const id = queue[idx];
      if (id === targetId) break;
      const next = sides
        ? sides.flatMap(side => side === 'upstream' ? this.graph.inNeighbors(id) : this.graph.outNeighbors(id))
        : this.graph.neighbors(id);
      for (const nid of next) {
        if (seen.has(nid) || (nid !== targetId && !this.scopeNodeIds.has(nid))) continue;
        seen.add(nid);
        parent.set(nid, id);
        queue.push(nid);
      }
    }
    if (!seen.has(targetId)) return null;
    const path: string[] = [targetId];
    for (let cur = targetId; cur !== origin;) {
      const p = parent.get(cur);
      if (!p) return null; // defensive; unreachable given the seen check above
      path.push(p);
      cur = p;
    }
    return path.reverse();
  }

  /** Packages exploration records into the final presentation topology. */
  public getResult(): SmResult {
    if (this._status !== 'complete') {
      throw new Error(`Exploration result requested in status '${this._status}': a result exists only for a complete exploration.`);
    }
    const nodeStates = Array.from(this.nodeStates.values());
    const rendered = new Set(nodeStates.filter(state => state.action !== 'prune').map(state => state.nodeId));
    return {
      status: 'complete',
      originNodeId: this.originNodeId!,
      fullNodes: Array.from(rendered, id => {
        const n = this.nodeMap.get(id)!;
        return { id: n.id, s: n.schema, n: n.name, t: n.type };
      }),
      edges: this.model.edges.filter(e => rendered.has(e.source) && rendered.has(e.target))
        .map(e => [e.source, e.target, edgeApiType(e.type, this.nodeMap.get(e.source)?.type ?? '')]),
      detail_slots: this.memory.getResult().detail_slots.filter(slot => rendered.has(slot.nodeId)),
      node_states: nodeStates,
      columnAspect: this.tracer?.state ?? null,
    };
  }

  /** Emits the serializable active map state used by diagnostics and the presentation artifact's run record. */
  public toJSON(): SmState {
    const snapshot: SmState = {
      identifierCaseSensitive: this.identifierCaseSensitive,
      snapshotVersion: this.taskLedger.investigationTasks.some(task => task.kind === 'column_lineage' && task.returnTargets) || this._agenda.entries.some(entry => entry.columnCarry?.kind === 'scalar_return') ? 2 : 1,
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
      ctDeclaredRouteIds: [...new Set((this.tracer?.edges ?? []).flatMap(edge => [edge.from_node, edge.to_node]))],
      ...(this.tracer ? { lineageQuestionsLastHop: [...this._pendingLineageQuestions] } : {}),
    };
    try {
      return parseNavigationSnapshot(snapshot);
    } catch (err) {
      if (err instanceof InvalidEngineCheckpointError) {
        this.log('error', `[Checkpoint] serialize rejected — paths=${trunc(err.diagnostic, LOG_TRUNC_CONTENT)}`, err);
      }
      throw err;
    }
  }

  /** Flattens the engine's private working state into a serializable projection. */
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
      totalNodes: this._totalNodes,
      userSchemas: Array.from(this.userSchemas),
      sessionAllowedSchemas: Array.from(this.sessionAllowedSchemas),
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
      continuationVersion: 1,
      supplementNodeIds: [...this.supplementNodeIds],
      pruneBallots: [...this.pruneBallots].map(([nodeId, votes]) => ({ nodeId, votes: [...votes].map(([senderId, vote]) => ({ senderId, vote })) })),
      heldFinding: this.heldFindingDraft.get() ? {
        focusId: this.heldFindingDraft.getAuthorization()!.focusId, hop: this.heldFindingDraft.getAuthorization()!.hop, mode: this.heldFindingDraft.getAuthorization()!.mode,
        failed: [...(this.heldFindingDraft.getAuthorization()?.failed ?? [])],
        finding: structuredClone(this.heldFindingDraft.get()!),
      } : null,
    };
  }
}
