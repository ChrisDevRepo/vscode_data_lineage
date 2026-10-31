import type { InvalidRoute, DepthIntent, HeldSubmissionParts } from './smTypes';
import { buildRouteValidationRejection } from './smRouteValidation';
import { missingSectionParts } from '../interaction/rules/submitFindingsRules';
import {
  submitFindingsSchemaForMode,
  toHopFinding,
  type SubmitFindingsHopColumns,
  findingAdmissionFacts,
} from '../tools/toolSchemas';

import type Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path/unweighted';
import { bfsFromNode } from 'graphology-traversal';
import type { DatabaseModel, LineageNode } from '../../engine/types';
import type { ColumnStore } from '../../engine/columnStore';
import { isIndirectOnly } from '../../engine/shared/bridgeContract';
import {
  bothSidesClosed,
  directionFromDepth,
  resolveDepthBorder,
  type DepthSideValue,
} from '../../engine/shared/explorationDepthContract';
import type { SerializedFilterState } from '../../engine/projectStore';
import {
  buildEdgeTypeMap,
  buildHopFocusNode,
  buildUnrelatedMap,
} from '../tools/tools';
import {
  buildNodeMap,
  getNodeColumns,
  getNodeDdl,
  SCRIPT_TYPES,
} from '../support/graphUtils';
import { edgeApiType, presentColumnCompact } from '../support/aiPresenter';
import {
  analyzeRemoval,
  type LogFn,
  type RemovalAnalysis,
} from '../../engine/graphGuards';
import { trunc, LOG_TRUNC_CONTENT } from '../../utils/log';
import {
  compileExclusionMatcher,
  normalizeColName,
  quoteIdentifier,
  schemaKey,
} from '../../utils/sql';
import { errorMessage } from '../../utils/errorMessage';
import {
  AiMemoryManager,
  STORAGE_TRAVERSED_PLACEHOLDER_SUMMARY,
  type DetailSlot,
  type IncomingQuestion,
  type WorkingMemory,
} from '../session/memoryManager';
import {
  CLASSIFICATION_KEPT_ANGLES,
  type ClassificationValue,
} from '../session/classification';
import { ToolDraft } from '../support/toolDraft';
import { ingestToolInput } from '../support/toolIngestion';
import {
  evaluateStartTargetColumnsRule,
  inspectStartReferences,
  inspectTargetColumns,
} from '../interaction/rules/startExplorationRules';
import {
  resolveModelColumnNames,
  resolveModelNodeId,
} from '../support/modelReferences';
import {
  evaluateCurrentHopActionPolicy,
  type CurrentHopActionTarget,
} from './currentHopActionPolicy';
import type {
  ApprovedBorder,
  ColumnAspect,
  ColumnCarry,
  ColumnEdge,
  ScalarReturnTarget,
  FunctionCallerContext,
  DeferredQuestion,
  DiagnosticsSnapshot,
  EngineInitSnapshot,
  EngineInternalsSnapshot,
  HopContext,
  HopNeighbor,
  HopProgress,
  HopFindingKept,
  HopSubmission,
  InvestigationTask,
  NavigationInitParams,
  PendingLead,
  PrunedBranch,
  RouteOutcome,
  RouteSkipDisposition,
  ScopeExclusionGroup,
  ScopeExclusions,
  ScopeSummary,
  ScopeSummaryLeaf,
  SmNodeAction,
  SmNodeColumnRole,
  SmNodeState,
  SmNodeStateReason,
  SmNodeStateSource,
  SmResult,
  SmState,
  SmStatus,
  SubmitResult,
} from '../sm/smTypes';
import { estimateTokens, type ProposedScope } from '../support/tokenBudget';
import {
  ColumnTracer,
  allowsMissingColumnMetadata,
  columnAttachment,
  columnEndpointKeyFactory,
  resolveColumnFlowTarget,
} from './columnTracer';
import {
  AgendaManager,
  type AgendaEntry,
  type WorklistView,
} from './agendaManager';
import { TaskLedger, type InvestigationTaskInput } from './taskLedger';
import {
  resolveScalarReturnTarget,
  resolveFunctionCallerTarget,
  functionCallerDdlHash,
  uniqueScalarReturnTargets,
} from './scalarReturnBinding';
import {
  parseNavigationSnapshot,
  InvalidEngineCheckpointError,
} from './navigationSnapshotSchema';
import { REJECTION_CODES } from '../support/rejectionCodes';
import {
  at,
  makeRejection,
  type ToolRejection,
} from '../support/toolErrorEnvelope';

/** Resolved mentions from rejected decision fields; never accepted decisions. */
type ActionMentions = Partial<
  Record<'questions' | 'prune_neighbors' | 'column_flow', ReadonlySet<string>>
> & { identities?: ReadonlyMap<string, string> };

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
  /** A `column_flow` mapping may name this neighbour: it is in the served `upstream_columns.node` or `out_node` enum. Present in CT hops only; derived from the same ids as the enums. */
  can_map?: boolean;
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
const CALLER_CONTEXT_CHANGED =
  "Exploration stopped: a queued function investigation no longer matches its caller's loaded SQL or column. Start a new analysis.";
/** User-facing reason when a queued column investigation carries no qualified source column. */
const COLUMN_SOURCE_MISSING =
  'Exploration stopped: a queued column investigation has no qualified source column to continue from. Start a new analysis.';

/** Why an invalid removal proposal is refused; the disconnected-analysis wording is reserved for a valid one that cuts visited support. */
const REMOVAL_REFUSAL: Record<
  NonNullable<RemovalAnalysis['rejection']>,
  string
> = {
  origin: 'not removed — the origin is never pruned.',
  'invalid-scope':
    'not removed — it is outside the approved scope, so there is nothing to prune.',
  'unknown-node':
    'not removed — it is not in the loaded model, so there is nothing to prune.',
  visited:
    'not removed — it is retained by committed analysis or a column mapping.',
};
/** Fields of a held finding draft besides its section angles. Each is one part: a retry that sends it replaces the held value whole (`[]` clears a held list), and a retry that omits it keeps the held value. An empty `summary` counts as omitted. */
const HELD_FIELDS = [
  'summary',
  'badge_label',
  'prune_neighbors',
  'questions',
  'column_flow',
] as const;
type HeldField = (typeof HELD_FIELDS)[number];

/** Section child faults invalidate known angles only: unknown names are never extracted into held content. Whole-container faults still invalidate sections. */
function splitFailedParts(paths: readonly string[]): {
  readonly fields: Set<string>;
  readonly angles: Set<string>;
} {
  const fields = new Set<string>();
  const angles = new Set<string>();
  for (const path of paths) {
    const [top, second] = path.split('.');
    if (!top) continue;
    if (top === 'sections' && second) {
      if (second === 'business' || second === 'technical') angles.add(second);
    } else fields.add(top);
  }
  if (fields.has('sections')) angles.clear();
  return { fields, angles };
}

/** Whether a finding carries a part named as `resend` does: `summary`, `sections`, `sections.<angle>` or a held field. */
function hasPart(finding: HopFindingKept, part: string): boolean {
  if (part === 'summary') return finding.summary.trim().length > 0;
  if (part === 'sections') return finding.sections.length > 0;
  if (part.startsWith('sections.'))
    return finding.sections.some(
      (section) => section.angle === part.slice('sections.'.length),
    );
  return finding[part as HeldField] !== undefined;
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
  /** Valuable out-of-scope routes available for a later exploration proposal. */
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
}

/** The write path a border test serves. Every purpose tests the exclusion sets; `route` also tests approved-direction reachability, while `seed_bfs` (the walk that defines the direction) does not. */
type BorderPurpose = 'route' | 'seed_bfs';

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
const LEAD_REASON_BY_DEFERRAL: Readonly<
  Record<DeferredQuestion['reason'], PendingLead['reason']>
> = {
  schema: 'schema_boundary',
  depth: 'depth_boundary',
  direction: 'out_of_direction',
  excluded: 'excluded',
};

/** Deferral reason of each lead reason the live engine records. */
const DEFERRAL_BY_LEAD_REASON: ReadonlyMap<
  PendingLead['reason'],
  DeferredQuestion['reason']
> = new Map(
  (
    Object.entries(LEAD_REASON_BY_DEFERRAL) as Array<
      [DeferredQuestion['reason'], PendingLead['reason']]
    >
  ).map(([deferral, lead]) => [lead, deferral]),
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
  routeRequests: Array<{
    nodeId: string;
    question: string;
    callerContext?: FunctionCallerContext;
  }>;
  /** Generated CT instructions accompany, never replace, the authored investigation purpose. */
  flowQuestionByNode: Map<string, string>;
  routeOutcomes: RouteOutcome[];
  endedColumns: string[];
  acceptedNids: Set<string>;
  scopeAddNids: Set<string>;
  deferredRoutes: Array<{
    nodeId: string;
    schema: string;
    question: string;
    reason: DeferredQuestion['reason'];
    depth: number | undefined;
  }>;
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
  private hopRemovals: { pruned: string[]; cut_ids: string[] } = {
    pruned: [],
    cut_ids: [],
  };
  /** Engine-owned lifecycle state for nodes; detail slots are content storage only. */
  protected nodeStates = new Map<string, SmNodeState>();
  /** List representing the current navigation agenda. */
  protected _agenda: AgendaManager;
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
  private static readonly UNBOUNDED_DEPTH_LIMITS: {
    upstream: number;
    downstream: number;
  } = Object.freeze({
    upstream: Number.POSITIVE_INFINITY,
    downstream: Number.POSITIVE_INFINITY,
  });
  /** Per-side depth ceilings from the approved intent; `Infinity` where that side is unbounded. A side at `levels: 0` is `0` whatever its exactness. */
  protected depthLimits: { upstream: number; downstream: number } =
    NavigationEngine.UNBOUNDED_DEPTH_LIMITS;
  /** Whether the approved depth is a hard border (`'strict'`) or an initial seed the model may grow (`'silent'`). Set from the AI's own `depthIntent`: an `'exact'` side binds and a `levels: 0` side is always closed; an open `'approximate'` side does not bind. */
  protected depthEnforcement: 'strict' | 'silent' = 'silent';
  /** Directed distance from the origin to every reachable node, per side; cleared whenever the BFS seed is recomputed and refilled on the next depth read ({@link ensureDirectedDepths}). */
  private directedDepths = new Map<
    string,
    { upstream?: number; downstream?: number }
  >();
  /** Whether {@link directedDepths} holds the current seed's walk; false until the next fill. */
  private directedDepthsFilled = false;
  /** History of explicit AI expansions beyond the initial BFS seed. */
  protected budgetExpansions: Array<{
    nodeId: string;
    depth: number;
    atHop: number;
  }> = [];

  /** One wire-shaped draft: representation adaptation happens only after full-schema validation. */
  private readonly heldFindingDraft = new ToolDraft<Record<string, unknown>>();

  /** Exploration direction set by `init`; consulted by `enqueueHop` when contracting reference nodes. */
  protected _direction: 'upstream' | 'downstream' | 'bidirectional' =
    'bidirectional';

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
  private readonly guiExclusionRules: Array<{
    pattern: string;
    matches: (node: {
      schema: string;
      name: string;
      fullName: string;
    }) => boolean;
  }> = [];
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
  get identifierCaseSensitive(): boolean {
    return this.model.identifierCaseSensitive === true;
  }

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
    this._agenda = new AgendaManager(model.identifierCaseSensitive);
    this.taskLedger = new TaskLedger(model.identifierCaseSensitive);
    this.graph = graph;
    this.log = log;
    this.store = store ?? null;
    this.nodeMap = buildNodeMap(model);
    this.edgeTypeMap = buildEdgeTypeMap(model);
    this.memory = config.memory ?? new AiMemoryManager();
    const schemas =
      config.activeFilter?.schemas?.map((s) => this.identifierKey(s)) ?? [];
    this.userSchemas = new Set(schemas);
    this.sessionAllowedSchemas = new Set(schemas);

    const ALL_OBJECT_TYPES = [
      'table',
      'view',
      'procedure',
      'function',
      'external',
    ] as const;
    const guiActiveTypes =
      config.activeFilter?.types?.map((t) => t.toLowerCase()) ?? [];
    if (guiActiveTypes.length > 0) {
      this.guiHiddenTypes = new Set(
        ALL_OBJECT_TYPES.filter((t) => !guiActiveTypes.includes(t)),
      );
    }

    if (schemas.length > 0) {
      const allSchemas = new Set<string>();
      for (const n of this.nodeMap.values())
        allSchemas.add(this.identifierKey(n.schema));
      this.guiHiddenSchemas = new Set(
        Array.from(allSchemas).filter((s) => !schemas.includes(s)),
      );
    }

    const isGuiExcluded = compileExclusionMatcher(
      config.activeFilter?.exclusionPatterns ?? [],
      (pattern, err) => {
        this.log(
          'debug',
          `[Filter] Skipping invalid GUI exclusion pattern "${pattern}": ${errorMessage(err)}`,
        );
      },
    );
    if (isGuiExcluded) {
      for (const n of this.nodeMap.values()) {
        if (isGuiExcluded(n))
          this.guiExcludedNodeIds.add(this.identifierKey(n.id));
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

  /** Canonical focus of a nonempty safe draft in this hop, mode and session. */
  public get heldFindingFocus(): string | null {
    const held = this.heldFindingDraft.get();
    return this.heldFindingDraft.matches(this.findingContext()) &&
      held &&
      Object.keys(held).some((key) => key !== 'focus_node_id')
      ? this.currentFocusNodeId
      : null;
  }

  private findingContext(): string {
    return JSON.stringify([
      this.sessionId,
      this.currentFocusNodeId,
      this.hopCount,
      this.currentHopAnalysisMode,
    ]);
  }

  /** Project wire sections to the engine's existing snapshot/commit representation. */
  private heldDraftOfCurrentFocus(): HopFindingKept | null {
    return this.heldFindingFocus === null
      ? null
      : toHopFinding(
          this.heldFindingDraft.get() as Parameters<typeof toHopFinding>[0],
        );
  }

  /** Compatibility adapter for internal callers: empty summary/section defaults represent omission, not an authored replacement. */
  private findingWire(input: HopSubmission): Record<string, unknown> {
    const { sections, summary, ...fields } = input;
    return {
      ...fields,
      ...(summary !== '' && summary !== undefined ? { summary } : {}),
      ...(Array.isArray(sections)
        ? sections.length
          ? {
              sections: Object.fromEntries(
                sections.map((section) => [section.angle, section.text]),
              ),
            }
          : {}
        : { sections }),
    };
  }

  /** Only parts declared for the active finding can be owed; unsupported input remains rejected, never held. */
  private failedParts(paths: readonly string[]): string[] {
    const { fields, angles } = splitFailedParts(paths);
    return [
      ...[...angles]
        .filter(
          (angle) =>
            !this.classification ||
            CLASSIFICATION_KEPT_ANGLES[this.classification].some(
              (kept) => kept === angle,
            ),
        )
        .map((angle) => `sections.${angle}`),
      ...[...fields].filter(
        (field) =>
          (field === 'sections' ||
            field === 'focus_node_id' ||
            HELD_FIELDS.some((held) => held === field)) &&
          (field !== 'column_flow' || this.currentHopAnalysisMode === 'ct'),
      ),
    ];
  }

  /** The required parts a draft lacks: the summary, a locked section angle not yet archived, and the CT `column_flow`. */
  private missingRequiredParts(draft: HopFindingKept): string[] {
    const archived = this.currentFocusNodeId
      ? this.memory.getArchivedAngles(this.currentFocusNodeId)
      : new Set<string>();
    return [
      ...(draft.summary.trim() ? [] : ['summary']),
      ...(this.classification
        ? CLASSIFICATION_KEPT_ANGLES[this.classification]
            .filter(
              (angle) =>
                !archived.has(angle) &&
                !draft.sections.some((section) => section.angle === angle),
            )
            .map((angle) => `sections.${angle}`)
        : []),
      ...(this.currentHopAnalysisMode === 'ct' &&
      draft.column_flow === undefined
        ? ['column_flow']
        : []),
    ];
  }

  /** Read-only held-part metadata for this focus/hop/mode, all derived from its `ToolDraft`; owed parts are the declared parts the draft's faults name plus the required parts it lacks. `null` when no safe draft is held. */
  public heldPartsOfCurrentFocus(): HeldSubmissionParts | null {
    const held = this.heldDraftOfCurrentFocus();
    return held
      ? {
          sections: held.sections.map(angleKey),
          summary: held.summary.trim().length > 0,
          fields: HELD_FIELDS.filter(
            (field): field is Exclude<HeldField, 'summary'> =>
              field !== 'summary' && held[field] !== undefined,
          ),
          resend: [
            ...new Set([
              ...this.failedParts(this.heldFindingDraft.faultPaths),
              ...this.missingRequiredParts(held),
            ]),
          ],
        }
      : null;
  }

  /** Projection of unresolved scope-boundary leads; feeds the follow-up suggestions after synthesis. */
  public get deferredQuestions(): ReadonlyArray<DeferredQuestion> {
    return this.pendingLeads.flatMap((lead) => {
      const reason = DEFERRAL_BY_LEAD_REASON.get(lead.reason);
      const task = this.taskLedger.getTask(lead.taskId);
      if (!reason || !task) return [];
      return [
        {
          nodeId: lead.nodeId,
          schema: lead.schema ?? this.nodeMap.get(lead.nodeId)?.schema ?? '',
          fromFocusNodeId: lead.fromNodeId,
          question: task.question,
          reason,
          ...(lead.depth !== undefined ? { depth: lead.depth } : {}),
          atHop: lead.createdHop,
        },
      ];
    });
  }

  /** Neighbours removed by a resolved AI prune, each with the sender's own reason — follow-up material for the completed chat, not report content. */
  public get prunedBranches(): ReadonlyArray<PrunedBranch> {
    return this.pendingLeads
      .filter(
        (lead) =>
          lead.reason === 'pruned_by_ai' && this.removedSet.has(lead.nodeId),
      )
      .map((lead) => ({
        nodeId: lead.nodeId,
        fromFocusNodeId: lead.fromNodeId,
        reason: lead.valueToUser,
      }));
  }

  /** Read-only typed task ledger used by prompts and diagnostics. */
  public get investigationTasks(): ReadonlyArray<InvestigationTask> {
    return this.taskLedger.investigationTasks;
  }

  /** Unresolved scope-boundary leads offered after the run. */
  public get pendingLeads(): ReadonlyArray<PendingLead> {
    return this.taskLedger.pendingLeads.filter(
      (lead) => lead.status === 'pending',
    );
  }

  /** Records a deferred route — the sole entry point for mutating the bucket. */
  protected deferQuestion(
    entry: DeferredQuestion,
    legs: ReadonlyArray<ContinuationLeg> = [],
  ): void {
    this.recordPendingLead(entry, legs);
    this.memory.recordRejection(
      entry.nodeId,
      `deferred: out of approved scope (${entry.reason})`,
      entry.atHop,
    );
  }

  /** Records the structured task and lead corresponding to an accepted scope-boundary deferral. */
  private recordPendingLead(
    entry: DeferredQuestion,
    legs: ReadonlyArray<ContinuationLeg>,
  ): void {
    const leadReason = LEAD_REASON_BY_DEFERRAL[entry.reason];
    const tasks =
      legs.length > 0
        ? legs.map((leg) =>
            this.ensureDeferredTask(
              entry.nodeId,
              entry.question,
              entry.atHop,
              leg,
            ),
          )
        : [this.ensureDeferredTask(entry.nodeId, entry.question, entry.atHop)];
    for (const task of tasks)
      this.taskLedger.ensureLead({
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
  private recordPruneLead(
    nodeId: string,
    fromNodeId: string,
    reason: string,
  ): void {
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
    common: Omit<InvestigationTaskInput, 'kind' | 'activeColumns'>,
    bbKind: 'root' | 'analytical',
    preferredColumns: readonly string[] | undefined,
    sourceRefs?: readonly ScalarReturnTarget[],
  ): InvestigationTaskInput {
    if (!this.tracer || !preferredColumns?.length)
      return { ...common, kind: bbKind };
    const columns = preferredColumns;
    return {
      ...common,
      kind: 'column_lineage',
      activeColumns: [...columns] as [string, ...string[]],
      ...(sourceRefs?.length
        ? { sourceRefs: sourceRefs.map((ref) => ({ ...ref })) }
        : {}),
    };
  }

  /** Creates a structurally mode-valid deferred task without changing agenda state. */
  private ensureDeferredTask(
    nodeId: string,
    question: string,
    createdHop: number,
    leg?: ContinuationLeg,
  ): InvestigationTask {
    const columns = leg && [
      ...new Map(
        leg.sourceRefs.map((ref) => [this.columnKey(ref.col), ref.col]),
      ).values(),
    ];
    return this.taskLedger.ensureTask(
      this.taskInputFor(
        {
          source: 'model',
          question,
          nodeId,
          parentTaskId: this.currentFocusTaskIds[0],
          status: 'deferred',
          createdHop,
          ...(leg?.traversalSide ? { traversalSide: leg.traversalSide } : {}),
        },
        'analytical',
        columns,
        leg?.sourceRefs,
      ),
    );
  }

  /** Completes executable tasks for the committed focus hop. */
  private completeTasks(taskIds: ReadonlyArray<string>): void {
    for (const taskId of taskIds) {
      this.taskLedger.setTaskStatus(taskId, 'resolved', this.hopCount);
    }
  }

  /** Records the process lifecycle state for a node. */
  private markNodeState(
    nodeId: string,
    action: SmNodeAction,
    source: SmNodeStateSource,
    reason: SmNodeStateReason,
    meta: {
      columns?: string[];
      columnRole?: SmNodeColumnRole;
      viaNodeId?: string;
      atHop?: number;
    } = {},
  ): void {
    const id = nodeId;
    if (!this.nodeMap.has(id)) return;

    const rank = (a: SmNodeAction): number => {
      if (a === 'prune') return 3;
      if (a === 'analyze') return 2;
      return 1;
    };
    const existing = this.nodeStates.get(id);
    const mergedColumns = Array.from(
      new Set([...(existing?.columns ?? []), ...(meta.columns ?? [])]),
    );
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
      ...(meta.viaNodeId
        ? { viaNodeId: meta.viaNodeId }
        : existing?.viaNodeId
          ? { viaNodeId: existing.viaNodeId }
          : {}),
      ...(typeof meta.atHop === 'number'
        ? { atHop: meta.atHop }
        : existing?.atHop !== undefined
          ? { atHop: existing.atHop }
          : {}),
    });
  }

  /** Whether an explicitly passed-through neighbor is already retained on the route into this focus. */
  private isCarrierInto(carrierId: string, focusId: string): boolean {
    return (
      this.nodeStates.get(carrierId)?.action === 'passthrough' &&
      this.directionalNeighbors(carrierId, this._direction).includes(focusId)
    );
  }

  /** Emits a session-end diagnostic summarizing badge_label diversity across analyzed verdicts. Low diversity indicates the AI is not distinguishing functional roles, so the final view won't group variants usefully. */
  private logLabelDiversity(): void {
    const labels: string[] = [];
    for (const slot of this.memory.getResult().detail_slots) {
      if (slot.badge_label && slot.badge_label.trim().length > 0)
        labels.push(slot.badge_label);
    }
    if (labels.length === 0) return;
    const distinct = new Set(labels).size;
    const diversity = distinct / labels.length;
    const flag = diversity < 0.3 ? ' (low — variants not distinguished)' : '';
    this.log(
      'debug',
      `[Labels] distinct=${distinct} labeled=${labels.length} diversity=${diversity.toFixed(2)}${flag}`,
    );
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
      inSchema: focus
        ? this.sessionAllowedSchemas.size === 0 ||
          this.sessionAllowedSchemas.has(this.identifierKey(focus.schema))
        : true,
      verdict: this.lastHopVerdict,
      detailChars: this.lastHopDetailChars,
      summaryChars: this.lastHopSummaryChars,
      archiveChars: this.archiveChars,
      routedNew: this.lastRoutedNew,
      routedRejected: this.lastRoutedRejected,
      routedDeferred: this.lastRoutedDeferred,
      deferredQueued: this.deferredQuestions.length,
      agendaRemaining: this._agenda.length,
      tally: {
        ...this.memory.getVerdictCounts(),
        prune: this.hopProgress.pruned,
      },
      scopeExpansions: this.budgetExpansions.length,
      allowedSchemaCount: this.sessionAllowedSchemas.size,
      ...(this.tracer
        ? {
            columnEdgeCount: this.tracer.edges.length,
            activeColumnCount: this.tracer.activeColumns.length,
            columnFlowEntries: this.lastHopColumnFlowEntries,
          }
        : {}),
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
  private matchColumnsToNode(
    nodeId: string,
    columns: string[],
  ): { resolved: string[]; unmatched: string[] } {
    return resolveModelColumnNames(
      (getNodeColumns(nodeId, this.nodeMap, this.store ?? undefined) ?? []).map(
        (column) => column.name,
      ),
      columns,
      this.identifierCaseSensitive,
    );
  }

  /** The requested output columns on the origin, resolved to its declared names: the roots CT carry attaches to. */
  private columnRoots(): Array<{ node: string; col: string }> {
    const origin = this.originNodeId;
    return origin && this.tracer
      ? this.matchColumnsToNode(origin, this.tracer.targetColumns).resolved.map(
          (col) => ({ node: origin, col }),
        )
      : [];
  }

  /** The qualified (node, column) identities a column task continues from. */
  private qualifiedTaskRefs(
    task: InvestigationTask,
  ): Array<{ node: string; col: string }> | null {
    if (task.kind !== 'column_lineage') return [];
    if (task.sourceRefs?.length)
      return task.sourceRefs.map((ref) => ({ ...ref }));
    if (
      task.source === 'mission' &&
      !task.parentTaskId &&
      task.nodeId === this.originNodeId
    ) {
      const requested = new Set(
        task.activeColumns.map((col) => this.columnKey(col)),
      );
      return this.columnRoots().filter((root) =>
        requested.has(this.columnKey(root.col)),
      );
    }
    return null;
  }

  /** The qualified endpoints of a task as the prompt renders them: those on the task's own object (assigned) and those on another object (external), compared by identifier key. */
  public taskEndpoints(task: InvestigationTask): {
    assigned: ScalarReturnTarget[];
    external: ScalarReturnTarget[];
  } {
    const refs = this.qualifiedTaskRefs(task) ?? [];
    const own = (ref: ScalarReturnTarget): boolean =>
      !!task.nodeId &&
      this.identifierKey(ref.node) === this.identifierKey(task.nodeId);
    return {
      assigned: refs.filter(own),
      external: refs.filter((ref) => !own(ref)),
    };
  }

  /** Whether a queued task still dispatches exactly as accepted: its qualified endpoints exist ({@link qualifiedTaskRefs}) and each names a loaded object and, where that object declares columns, one of them. Dispatch never rewrites or narrows the accepted carry. */
  private taskRefsResolve(task: InvestigationTask): boolean {
    const refs = this.qualifiedTaskRefs(task);
    return (
      refs !== null &&
      refs.every(
        (ref) =>
          this.nodeMap.has(ref.node) &&
          this.matchColumnsToNode(ref.node, [ref.col]).unmatched.length === 0,
      )
    );
  }

  /** The qualified tracked-column identities this hop received, read only from its current tasks ({@link qualifiedTaskRefs}); dispatch refuses a task without them. */
  private incomingColumnRefs(
    traversalSide?: 'upstream' | 'downstream',
  ): Array<{ node: string; col: string }> {
    if (!this.tracer || !this.currentFocusNodeId) return [];
    const refs = new Map<string, { node: string; col: string }>();
    for (const task of this.getCurrentTasks()) {
      if (
        task.kind !== 'column_lineage' ||
        (traversalSide && task.traversalSide !== traversalSide)
      )
        continue;
      for (const ref of this.qualifiedTaskRefs(task) ?? [])
        refs.set(`${ref.node}|${this.columnKey(ref.col)}`, ref);
    }
    return [...refs.values()];
  }

  /** Uses an arriving column task's side before the session's default direction. */
  private columnTraceDirection(): 'upstream' | 'downstream' {
    const arrivingSides = new Set(
      this.getCurrentTasks().flatMap((task) =>
        task.kind === 'column_lineage' && task.traversalSide
          ? [task.traversalSide]
          : [],
      ),
    );
    const [arrivingSide] = arrivingSides;
    if (arrivingSides.size === 1 && arrivingSide !== undefined)
      return arrivingSide;
    return this.effectiveDirection() === 'downstream'
      ? 'downstream'
      : 'upstream';
  }

  /** Collapses `this._direction` plus a depth side of exactly `0` into the single traversal direction approved for later hop growth. */
  private effectiveDirection(): 'upstream' | 'downstream' | 'bidirectional' {
    if (this._direction !== 'bidirectional') return this._direction;
    return directionFromDepth(this.currentDepthIntent);
  }

  /** Directed distance from the origin to `targetId`, and which side of the origin it lies on. */
  private directedDepthFromOrigin(
    targetId: string,
  ): { depth: number; side: 'upstream' | 'downstream' } | null {
    if (!this.originNodeId) return null;
    if (targetId === this.originNodeId) return { depth: 0, side: 'downstream' };
    const sides = this.directedDepthsFor(targetId);
    if (!sides) return null;
    const { upstream, downstream } = sides;
    if (
      upstream !== undefined &&
      (downstream === undefined || upstream <= downstream)
    ) {
      return { depth: upstream, side: 'upstream' };
    }
    return downstream !== undefined
      ? { depth: downstream, side: 'downstream' }
      : null;
  }

  /** Per-side directed distances from the origin to `targetId`, or `undefined` when unreachable. */
  private directedDepthsFor(
    targetId: string,
  ): { upstream?: number; downstream?: number } | undefined {
    if (!this.originNodeId) return undefined;
    this.ensureDirectedDepths();
    return this.directedDepths.get(targetId);
  }

  /** Fills {@link directedDepths} with one walk per side, unless the current seed already filled it. */
  private ensureDirectedDepths(): void {
    if (this.directedDepthsFilled || !this.originNodeId) return;
    this.directedDepthsFilled = true;
    const origin = this.originNodeId;
    for (const [mode, side] of [
      ['inbound', 'upstream'],
      ['outbound', 'downstream'],
    ] as const) {
      bfsFromNode(
        this.graph,
        origin,
        (key, _attr, depth) => {
          const node = key === origin ? undefined : this.nodeMap.get(key);
          if (
            node &&
            this.checkBorder(key, node, 'seed_bfs').kind !== 'in_border'
          )
            return true;
          const entry = this.directedDepths.get(key);
          if (!entry) this.directedDepths.set(key, { [side]: depth });
          else if (entry[side] === undefined) entry[side] = depth;
          return false;
        },
        { mode },
      );
    }
  }

  /** Whether admitting `targetId` would cross a depth border the user fixed. */
  private depthBorderBreach(
    targetId: string,
    fallbackDepth: number | undefined,
  ): number | null {
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
    const limit = Math.min(
      this.depthLimits.upstream,
      this.depthLimits.downstream,
    );
    return fallbackDepth > limit ? fallbackDepth : null;
  }

  /** True when a route target is reachable from the origin within the approved traversal direction. */
  private isReachableInApprovedDirection(targetId: string): boolean {
    const direction = this.effectiveDirection();
    if (!this.originNodeId) return true;
    if (targetId === this.originNodeId) return true;
    if (direction === 'bidirectional')
      return this.directedDepthsFor(targetId) !== undefined;
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
  private checkBorder(
    nodeId: string,
    node: LineageNode,
    purpose: BorderPurpose,
  ): BorderVerdict {
    const checkDirection = purpose === 'route';

    if (this.excludedTypes.has(node.type.toLowerCase()))
      return { kind: 'excluded', axis: 'type' };
    if (this.excludedNodeIds.has(this.identifierKey(nodeId)))
      return { kind: 'excluded', axis: 'node_id' };
    if (this.excludedSchemas.has(this.identifierKey(node.schema)))
      return { kind: 'excluded', axis: 'schema' };
    if (checkDirection && !this.isReachableInApprovedDirection(nodeId))
      return { kind: 'out_of_direction' };
    return { kind: 'in_border' };
  }

  /** Whether an `excluded` border verdict traces to the GUI schema filter (the node's schema is unticked) rather than a user-authored exclusion pattern (`excludeTypes`/`excludeNodeIds`, or a schema the user typed that the GUI did not already hide), so a route deferral can tell the model the `confirm_sm_start` repair. */
  private isGuiHiddenSchemaBorder(
    border: BorderVerdict,
    node: LineageNode,
  ): boolean {
    return (
      border.kind === 'excluded' &&
      border.axis === 'schema' &&
      this.guiHiddenSchemas.has(this.identifierKey(node.schema))
    );
  }

  /** Whether the router would admit a route to `nodeId` right now — border **and** depth. */
  private admitsRoute(
    nodeId: string,
    node: LineageNode,
    focusId: string,
  ): RouteAdmission {
    const border = this.checkBorder(nodeId, node, 'route');
    let candidateDepth =
      this.depthFromOrigin.get(nodeId) ??
      this.directedDepthFromOrigin(nodeId)?.depth;
    if (candidateDepth === undefined) {
      candidateDepth = (this.depthFromOrigin.get(focusId) ?? 0) + 1;
    }
    const depthBreach = this.depthBorderBreach(nodeId, candidateDepth);
    return {
      border,
      depthBreach,
      admitted: border.kind === 'in_border' && depthBreach === null,
    };
  }

  /** Scope admission shared by column source choices and submitted references, including retained evidence. */
  private admitsColumnReference(
    nodeId: string,
    node: LineageNode,
    focusId: string,
  ): boolean {
    if (
      nodeId === focusId ||
      this.scopeNodeIds.has(nodeId) ||
      this.visited.has(nodeId)
    )
      return true;
    return this.admitsRoute(nodeId, node, focusId).admitted;
  }

  /** Gets the size of the active exploration scope. */
  public get scopeSize(): number {
    return this.scopeNodeIds.size;
  }

  /** Gets live hop progress: completed AI hops, queued nodes, display-safe total work, cumulative prunes, and the last hop's newly-routed (added) count. */
  public get hopProgress(): HopProgress {
    let pruned = 0;
    for (const s of this.nodeStates.values())
      if (s.action === 'prune') pruned++;
    const open = this._agenda.length;
    const total = Math.max(this._totalNodes, this.hopCount + open);
    return {
      current: this.hopCount,
      open,
      total,
      pruned,
      added: this.lastRoutedNew,
    };
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
    return (
      this.initSnapshot?.depthIntent ?? NavigationEngine.UNSET_DEPTH_INTENT
    );
  }

  /** Target columns captured at {@link init} (null when no column-trace aspect). */
  public get currentTargetColumns(): string[] | null {
    return this.initSnapshot?.targetColumns ?? null;
  }

  /** Neighbor action choices and column facts that narrow this hop's served schema: every declared focus column as `out_col` when metadata exists, and whether the focus is a procedure (the one node whose entries name an `out_node`). Eligible function neighbors narrow caller-context questions; stored column metadata narrows the admissible `upstream_columns` sources. */
  public get hopSubmitColumns(): SubmitFindingsHopColumns {
    const focus = this.currentFocusNodeId
      ? this.nodeMap.get(this.currentFocusNodeId)
      : undefined;
    const neighbors = focus ? this.neighborChoices(focus.id) : [];
    const declaredOutCols = focus
      ? [
          ...new Set(
            (
              getNodeColumns(focus.id, this.nodeMap, this.store ?? undefined) ??
              []
            )
              .map((column) => column.name)
              .filter(Boolean),
          ),
        ]
      : [];
    return {
      focusNodeId: focus?.id,
      neighbors,
      // At a procedure, out_col names the out_node column, never a column of the focus (D-130).
      outCols:
        declaredOutCols.length > 0 && focus?.type !== 'procedure'
          ? this.arrivingOutCols(declaredOutCols)
          : null,
      outNode: focus?.type === 'procedure',
      callerContextNodeIds:
        focus &&
        this.graph.hasNode(focus.id) &&
        getNodeDdl(focus.id, this.nodeMap, this.store ?? undefined)
          ? neighbors
              .filter((neighbor) => neighbor.can_question)
              .map((neighbor) => neighbor.id)
              .filter((id) =>
                this.getCurrentTasks().some(
                  (task) =>
                    task.kind === 'column_lineage' &&
                    task.nodeId === focus.id &&
                    task.activeColumns.some((col) =>
                      resolveFunctionCallerTarget(
                        id,
                        { node: focus.id, col },
                        this.nodeMap,
                        this.model,
                        this.store,
                      ),
                    ),
                ),
              )
              .sort()
          : [],
      // A procedure names itself as the source of a value it creates (D-130).
      columnSourceNodeIds:
        focus && this.graph.hasNode(focus.id)
          ? [
              ...this.columnSourceNodeIds(focus.id),
              ...(focus.type === 'procedure' ? [focus.id] : []),
            ].sort()
          : [],
      identifierCaseSensitive: this.identifierCaseSensitive,
      ...(this.currentDestinations().length
        ? { columnDestinations: this.currentDestinations() }
        : {}),
    };
  }

  /** The `out_col` enum of an upstream hop with declared columns: the declared columns that arrived as demands on this focus (what earlier hops mapped into it). A downstream trace, or no matching arrival, keeps every declared column. Extra `upstream_columns` sources of an arriving column stay allowed. */
  private arrivingOutCols(declared: readonly string[]): string[] {
    const tasks = this.getCurrentTasks().filter(
      (task) => task.kind === 'column_lineage',
    );
    if (
      this.columnTraceDirection() !== 'upstream' ||
      tasks.some((task) => task.traversalSide === 'downstream')
    )
      return [...declared];
    const arriving = new Set(
      tasks.flatMap((task) =>
        task.activeColumns.filter(Boolean).map((col) => this.columnKey(col)),
      ),
    );
    const matched = declared.filter((name) =>
      arriving.has(this.columnKey(name)),
    );
    return matched.length > 0 ? matched : [...declared];
  }

  /** Neighbour ids a `column_flow` mapping may name at this focus: the served `upstream_columns.node` and `out_node` enums. */
  private mappableNeighborIds(focusId: string): Set<string> {
    return new Set(
      this.graph.hasNode(focusId) ? this.columnSourceNodeIds(focusId) : [],
    );
  }

  /** Object-graph ids an `upstream_columns` contributor may name at one hop: the focus's neighbors plus the read suppliers of its declared scalar callers. The served `node` enum and the contributor admission both read it, so a column edge never leaves the object graph. */
  private columnContributorIds(focusId: string): Set<string> {
    const callers = uniqueScalarReturnTargets(
      [
        ...this.currentDestinations(),
        ...this.getCurrentTasks().flatMap((task) =>
          task.callerContext
            ? [{ node: task.callerContext.node, col: task.callerContext.col }]
            : [],
        ),
      ],
      this.model.identifierCaseSensitive,
    ).map((target) => target.node);
    const candidates = new Set(
      this.graph.hasNode(focusId) ? this.graph.neighbors(focusId) : [],
    );
    for (const caller of callers) {
      if (this.graph.hasNode(caller))
        for (const supplier of this.graph.inNeighbors(caller))
          candidates.add(supplier);
    }
    return candidates;
  }

  /** Metadata-derived `upstream_columns` source ids for one hop: {@link columnContributorIds} kept when stored columns exist or the node is trusted without column metadata, and not already pruned — mirroring the engine's contributor admission. A node without column metadata is never offered as its own column source. */
  private columnSourceNodeIds(focusId: string): string[] {
    return [...this.columnContributorIds(focusId)]
      .filter((id) => {
        const node = this.nodeMap.get(id);
        if (
          !node ||
          this.removedSet.has(id) ||
          !this.admitsColumnReference(id, node, focusId)
        )
          return false;
        return (
          (getNodeColumns(id, this.nodeMap, this.store ?? undefined)?.length ??
            0) > 0 ||
          (id !== focusId && allowsMissingColumnMetadata(node))
        );
      })
      .sort();
  }

  /** Qualified destinations carried by the active task ledger, without column-name collapse. */
  private currentDestinations(): ScalarReturnTarget[] {
    return uniqueScalarReturnTargets(
      this.getCurrentTasks().flatMap((task) =>
        (this.qualifiedTaskRefs(task) ?? []).flatMap(
          (ref) =>
            this.resolveCallerEndpoint(this.currentFocusNodeId ?? '', ref, [
              task.id,
            ]) ?? [],
        ),
      ),
      this.model.identifierCaseSensitive,
    );
  }

  /** Context evidence for the declared scalar return task, supplied only at its function hop. */
  private scalarReturnContext(): Pick<
    HopContext,
    'caller_objects' | 'caller_requested_outputs'
  > {
    const targets = this.currentDestinations();
    const declared = uniqueScalarReturnTargets(
      this.getCurrentTasks().flatMap((task) =>
        task.callerContext
          ? [{ node: task.callerContext.node, col: task.callerContext.col }]
          : [],
      ),
      this.model.identifierCaseSensitive,
    );
    const callers = uniqueScalarReturnTargets(
      [...targets, ...declared],
      this.model.identifierCaseSensitive,
    );
    if (!callers.length) return {};
    return {
      ...(declared.length ? { caller_requested_outputs: declared } : {}),
      caller_objects: [...new Set(callers.map((target) => target.node))].map(
        (node) => ({
          node,
          ddl: getNodeDdl(node, this.nodeMap, this.store ?? undefined) ?? '',
        }),
      ),
    };
  }

  /** Checks an authored caller context against its original task, directed route and exact SQL snapshot. */
  private validFunctionCallerContext(
    functionId: string,
    context: FunctionCallerContext,
  ): boolean {
    const parent = this.taskLedger.getTask(context.callerTaskId);
    const target = resolveFunctionCallerTarget(
      functionId,
      context,
      this.nodeMap,
      this.model,
      this.store,
    );
    const ddl = getNodeDdl(context.node, this.nodeMap, this.store ?? undefined);
    return (
      !!target &&
      !!ddl &&
      !!parent &&
      parent.kind === 'column_lineage' &&
      parent.nodeId === target.node &&
      parent.activeColumns.some(
        (col) => this.columnKey(col) === this.columnKey(target.col),
      ) &&
      this.scopeNodeIds.has(target.node) &&
      !this.removedSet.has(target.node) &&
      functionCallerDdlHash(ddl) === context.ddlHash
    );
  }

  /** Compiler declarations and task-anchored model investigations remain separate sources of scalar authorization. */
  private resolveCallerEndpoint(
    functionId: string,
    target: ScalarReturnTarget,
    taskIds?: readonly string[],
  ): ScalarReturnTarget | null {
    const compiled = resolveScalarReturnTarget(
      functionId,
      target,
      this.nodeMap,
      this.store,
      this.model.identifierCaseSensitive,
    );
    if (compiled) return compiled;
    if (
      getNodeColumns(functionId, this.nodeMap, this.store ?? undefined)?.length
    )
      return null;
    const tasks = taskIds
      ? taskIds.flatMap((id) => this.taskLedger.getTask(id) ?? [])
      : this.taskLedger.investigationTasks;
    const declared = tasks.some(
      (task) =>
        task.nodeId === functionId &&
        task.kind === 'column_lineage' &&
        task.callerContext &&
        task.parentTaskId === task.callerContext.callerTaskId &&
        task.sourceRefs?.some(
          (expected) =>
            expected.node === target.node &&
            this.columnKey(expected.col) === this.columnKey(target.col),
        ) &&
        task.callerContext.node === target.node &&
        this.columnKey(task.callerContext.col) === this.columnKey(target.col) &&
        this.validFunctionCallerContext(functionId, task.callerContext),
    );
    return declared
      ? resolveFunctionCallerTarget(
          functionId,
          target,
          this.nodeMap,
          this.model,
          this.store,
        )
      : null;
  }

  /** Explicit analysis mode captured at {@link init}. */
  public get currentAnalysisMode(): 'bb' | 'ct' {
    return this.initSnapshot?.analysisMode ?? (this.tracer ? 'ct' : 'bb');
  }

  /** The analysis mode of the hop currently dispatched — the contract selector for this hop alone. */
  public get currentHopAnalysisMode(): 'bb' | 'ct' {
    return (this.tracer?.activeColumns.filter(Boolean).length ?? 0) > 0
      ? 'ct'
      : 'bb';
  }

  /** Builds a one-shot snapshot of the proposed scope for the `confirm_sm_start` gate detail. */
  public getScopeSummary(
    namesPerType = Number.POSITIVE_INFINITY,
  ): ScopeSummary {
    const bySchema: Record<
      string,
      { hops: number; scope: number; byType: Record<string, ScopeSummaryLeaf> }
    > = Object.create(null);
    let hopCount = 0;

    for (const id of this.scopeNodeIds) {
      const n = this.nodeMap.get(id);
      if (!n) continue;
      const schema = n.schema;
      const type = n.type ?? 'external';
      const takesHop =
        SCRIPT_TYPES.has(n.type) &&
        !this.passNodeIds.has(this.identifierKey(id));
      if (takesHop) hopCount++;

      if (!bySchema[schema])
        bySchema[schema] = { hops: 0, scope: 0, byType: {} };
      const schemaEntry = bySchema[schema];
      schemaEntry.scope++;
      if (takesHop) schemaEntry.hops++;
      if (!schemaEntry.byType[type]) {
        schemaEntry.byType[type] = {
          hops: 0,
          scope: 0,
          nodeNames: [],
          omitted: 0,
        };
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
    const originNode = this.originNodeId
      ? this.nodeMap.get(this.originNodeId)
      : undefined;
    const originLabel = originNode
      ? `${originNode.schema}.${originNode.name}`
      : (this.originNodeId ?? '');
    const canonicalNodeId = (id: string): string => {
      const node = this.nodeMap.get(id);
      return node
        ? `${quoteIdentifier(node.schema)}.${quoteIdentifier(node.name)}`
        : id;
    };
    const schemaNames = new Map<string, string>();
    const selectedSchemas = new Map<string, string>();
    for (const n of this.nodeMap.values()) {
      const key = this.identifierKey(n.schema);
      const target = this.excludedSchemas.has(key)
        ? schemaNames
        : selectedSchemas;
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
        schemas: Array.from(
          this.excludedSchemas,
          (key) => schemaNames.get(key) ?? key,
        ).sort(),
        types: Array.from(this.excludedTypes).sort(),
        nodeIds: Array.from(this.excludedNodeIds, canonicalNodeId).sort(),
        passNodeIds: Array.from(this.passNodeIds, canonicalNodeId).sort(),
      },
      selectedSchemas: [...selectedSchemas.values()].sort((a, b) =>
        a.localeCompare(b),
      ),
      exclusions: this.excludedObjectsByCause(),
    };
  }

  /** Groups every excluded object under the first GUI exclusion rule matching it, or under `named` when none does. An object the schema or type filter already removes is left out, so each count states what the rule removes from the selected schemas and types. */
  private excludedObjectsByCause(): ScopeExclusions {
    const group = (): ScopeExclusionGroup => ({ count: 0, byType: {} });
    const rules = this.guiExclusionRules.map((rule) => ({
      pattern: rule.pattern,
      ...group(),
    }));
    const named = group();
    for (const id of this.excludedNodeIds) {
      const node = this.nodeMap.get(id);
      if (!node) continue;
      if (this.excludedSchemas.has(this.identifierKey(node.schema))) continue;
      if (node.type && this.excludedTypes.has(node.type.toLowerCase()))
        continue;
      const ruleIndex = this.guiExclusionRules.findIndex((rule) =>
        rule.matches(node),
      );
      const target = ruleIndex >= 0 ? rules[ruleIndex] : named;
      target.count++;
      (target.byType[node.type ?? 'external'] ??= []).push({
        schema: node.schema,
        name: node.name,
      });
    }
    for (const entry of [...rules, named]) {
      for (const objects of Object.values(entry.byType)) {
        objects.sort(
          (a, b) =>
            a.name.localeCompare(b.name) || a.schema.localeCompare(b.schema),
        );
      }
    }
    return { rules: rules.filter((rule) => rule.count > 0), named };
  }

  /** Applies the shared graph removal policy with this session's scope, anchors and direction legs. */
  private removalSupport(
    removedBefore: ReadonlySet<string>,
    removedAfter: ReadonlySet<string>,
    anchors: ReadonlySet<string> = this.visited,
  ): RemovalAnalysis {
    const protectedAnchors = new Set([
      ...anchors,
      ...(this.tracer?.edges ?? []).flatMap((edge) => [
        edge.from_node,
        edge.to_node,
      ]),
    ]);
    return analyzeRemoval(this.graph, {
      originId: this.originNodeId ?? '',
      scope: this.scopeNodeIds,
      removedBefore,
      removedAfter,
      visited: protectedAnchors,
      currentNodeId: this.currentFocusNodeId ?? undefined,
      sides: this.allowedNoteSides(),
    });
  }

  /** Validates that the given node ids are legitimate targets for neighbor-column inspection (the `get_neighbor_columns` tool). */
  public validateNeighborIds(ids: string[]): string[] {
    const allowed = new Set(this.neighborColumnIds);
    return ids.filter(
      (id) =>
        !allowed.has(
          resolveModelNodeId(id, this.nodeMap, this.identifierCaseSensitive) ??
            '',
        ),
    );
  }

  /** In-scope neighbor ids available for column lookup, including visited evidence. */
  public get neighborColumnIds(): string[] {
    return this.neighborChoices(this.currentFocusNodeId ?? '')
      .filter((neighbor) => this.scopeNodeIds.has(neighbor.id))
      .map((neighbor) => neighbor.id);
  }

  /** The current hop's sub-questions as archived beside its findings: every non-blank task question in dispatch order. The mission question, carried separately as the original question, is left out in either mode and wherever routing re-sends it. `from_node` names the asking hop only for a model-authored question whose asking task, with relay nodes skipped, belongs to a visited node; engine-routed text is kept without a sender. */
  private currentIncomingQuestions(): IncomingQuestion[] {
    const focusId = this.currentFocusNodeId;
    const mission = (this.memory.getUserQuestion() ?? '').trim();
    return this.getCurrentTasks().flatMap((task) => {
      const question = task.question.trim();
      const isMission = task.source === 'mission' && !task.parentTaskId;
      if (isMission || !question || question === mission) return [];
      const from =
        task.source === 'model' ? this.askerTask(task)?.nodeId : undefined;
      return [
        {
          question,
          ...(from && from !== focusId && this.visited.has(from)
            ? { from_node: from }
            : {}),
        },
      ];
    });
  }

  /** The task that raised `task`'s question: its parent, skipping the nodes the engine passed the question through, which only relay it. */
  private askerTask(task: InvestigationTask): InvestigationTask | undefined {
    let parent = task.parentTaskId
      ? this.taskLedger.getTask(task.parentTaskId)
      : undefined;
    while (parent && parent.nodeId === task.passthroughFromNodeId) {
      task = parent;
      parent = parent.parentTaskId
        ? this.taskLedger.getTask(parent.parentTaskId)
        : undefined;
    }
    return parent;
  }

  /** Structured tasks assigned to the current focus node, rendered as the `<current_task>` block. */
  public getCurrentTasks(): ReadonlyArray<InvestigationTask> {
    if (!this.currentFocusNodeId) return [];
    return this.currentFocusTaskIds
      .map((taskId) => this.taskLedger.getTask(taskId))
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
  public init(
    params: NavigationInitParams,
    admission?: {
      references: ReturnType<typeof inspectStartReferences>;
      columns?: ReturnType<typeof inspectTargetColumns>;
    },
  ): { ok: true } | ToolRejection {
    const depthIntent: DepthIntent = params.depthIntent;
    if (bothSidesClosed(depthIntent.upstream, depthIntent.downstream)) {
      return makeRejection({
        code: REJECTION_CODES.invalidInput,
        errors: at('depth_zero', ['depth']),
      });
    }
    const analysisMode: 'bb' | 'ct' =
      params.analysisMode ??
      ((params.targetColumns?.length ?? 0) > 0 ? 'ct' : 'bb');
    const targetColumnsFault = evaluateStartTargetColumnsRule(
      analysisMode,
      params.targetColumns,
    );
    if (targetColumnsFault) return targetColumnsFault;
    const wasRefine = this.initSnapshot !== null;
    const prevScopeSize = this.scopeNodeIds.size;

    const resolveId = (raw: string): string | null =>
      resolveModelNodeId(raw, this.nodeMap, this.identifierCaseSensitive);
    const references =
      admission?.references ?? inspectStartReferences(params, resolveId);
    if (references.rejection) return references.rejection;
    const originNode = references.originId
      ? this.nodeMap.get(references.originId)!
      : null;
    if (!originNode) throw new Error('Validated origin is missing.');

    const effectiveTargetColumns =
      analysisMode === 'ct' ? params.targetColumns : undefined;
    let resolvedActiveColumns: string[] = [];
    if (
      analysisMode === 'ct' &&
      effectiveTargetColumns &&
      effectiveTargetColumns.length > 0
    ) {
      const { resolved, unmatched, rejection } =
        admission?.columns ??
        inspectTargetColumns(
          originNode,
          (
            getNodeColumns(
              originNode.id,
              this.nodeMap,
              this.store ?? undefined,
            ) ?? []
          ).map((column) => column.name),
          effectiveTargetColumns,
          this.identifierCaseSensitive,
        );
      if (rejection) {
        const offending =
          unmatched.length > 0 ? unmatched : effectiveTargetColumns;
        this.log(
          'debug',
          `[AI] [CT] requested columns [${effectiveTargetColumns.join(',')}] offending=[${offending.join(',')}] not on origin ${originNode.id} — rejecting (no partial-trace fallback)`,
        );
        return rejection;
      }
      effectiveTargetColumns.forEach((column, index) => {
        if (column !== resolved[index])
          this.log(
            'debug',
            `[CT] target column matched from=${JSON.stringify(column)} to=${JSON.stringify(resolved[index])}`,
          );
      });
      this.log(
        'debug',
        `[Admit] guard=ct_target_columns phase=init focus=${originNode.id} active=${resolved.length} — tracing [${resolved.join(', ')}]`,
      );
      resolvedActiveColumns = resolved;
    }

    this.visited.clear();
    this.removedSet.clear();
    this.pruneBallots.clear();
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
      this.log(
        'debug',
        `[Mission] provenance=engine_init len=${params.mission_brief.length}`,
      );
    }
    if (params.scopeNotes?.length) {
      this.memory.setScopeNotes(params.scopeNotes);
      this.log(
        'debug',
        `[Mission] scope_notes count=${params.scopeNotes.length}`,
      );
    }

    this.excludedTypes = new Set(
      (params.excludeTypes ?? []).map((t) => t.toLowerCase()),
    );

    const originSchema = this.identifierKey(originNode.schema);
    const originId = this.identifierKey(originNode.id);
    this.excludedSchemas = new Set(
      (params.excludeSchemas ?? [...this.guiHiddenSchemas])
        .map((s) => this.identifierKey(s))
        .filter((s) => s !== originSchema),
    );
    this.excludedNodeIds = new Set(
      references.excludeNodeIds
        .map((s) => this.identifierKey(s))
        .filter((id) => id !== originId),
    );
    if (
      references.excludeNodeIds.some(
        (id) => this.identifierKey(id) === originId,
      )
    ) {
      this.log(
        'debug',
        `[Border] origin ${originNode.id} named in excludeNodeIds — kept in scope as the origin`,
      );
    }
    this.passNodeIds = new Set(
      references.passNodeIds.map((s) => this.identifierKey(s)),
    );
    if (this.userSchemas.size > 0) {
      const openedByProposal =
        params.excludeSchemas === undefined
          ? []
          : [...this.guiHiddenSchemas].filter(
              (schema) => !this.excludedSchemas.has(schema),
            );
      this.sessionAllowedSchemas = new Set([
        ...this.userSchemas,
        originSchema,
        ...openedByProposal,
      ]);
    }

    this.originNodeId = originNode.id;
    const direction = params.direction || 'bidirectional';
    const border = resolveDepthBorder(depthIntent);
    this.depthLimits = border.limits;
    this.depthBudget = border.budget;
    this.depthEnforcement = border.enforcement;
    const sideLabel = (side: DepthSideValue): string =>
      `${side.levels}:${side.exactness}`;
    const depthLabel = `up=${sideLabel(depthIntent.upstream)} down=${sideLabel(depthIntent.downstream)}`;
    const capSide = (value: number): string =>
      Number.isFinite(value) ? String(value) : 'all';
    this.log(
      'debug',
      `[Depth] resolved ${depthLabel} ` +
        `enforcement=${this.depthEnforcement} ` +
        `cap=up:${capSide(this.depthLimits.upstream)}/down:${capSide(this.depthLimits.downstream)} ` +
        `budget=${this.depthBudget ?? 'none'}`,
    );
    this.budgetExpansions = [];
    this.scopeNodeIds = this.computeBfsScope(originNode.id, direction);

    let initialActiveColumns = effectiveTargetColumns;
    if (
      analysisMode === 'ct' &&
      effectiveTargetColumns &&
      effectiveTargetColumns.length > 0
    ) {
      this.tracer = new ColumnTracer(
        effectiveTargetColumns,
        undefined,
        this.model.identifierCaseSensitive,
      );
      initialActiveColumns = resolvedActiveColumns;
      this.tracer.setActiveColumns(initialActiveColumns);
    } else {
      this.tracer = null;
    }

    const breakdown = {
      table: 0,
      view: 0,
      procedure: 0,
      function: 0,
      external: 0,
    } as Record<string, number>;
    for (const id of this.scopeNodeIds) {
      const n = this.nodeMap.get(id);
      if (n) {
        const t = n.type?.toLowerCase() ?? 'external';
        breakdown[t] = (breakdown[t] ?? 0) + 1;
      }
    }
    this._totalNodes = this.scopeNodeIds.size;
    const annotateProvenance = (
      items: Set<string>,
      gui: Set<string>,
      nl: string[],
    ): string => {
      if (items.size === 0) return 'none';
      const nlSet = new Set(nl.map((t) => t.toLowerCase()));
      return Array.from(items)
        .map((t) => {
          const g = gui.has(t);
          const n = nlSet.has(t);
          const tag = g && n ? 'gui+nl' : g ? 'gui' : 'nl';
          return `${t} (${tag})`;
        })
        .join(', ');
    };
    const excludedTypesAnnotated = annotateProvenance(
      this.excludedTypes,
      this.guiHiddenTypes,
      params.excludeTypes ?? [],
    );
    const guiHiddenIgnored = Array.from(this.guiHiddenTypes).filter(
      (t) => !this.excludedTypes.has(t),
    );
    const guiHiddenLine =
      guiHiddenIgnored.length > 0
        ? ` gui_hidden_in_scope=[${guiHiddenIgnored.join(',')}]`
        : '';
    const excludeNodeIdsLine =
      references.excludeNodeIds.length > 0
        ? ` excludeNodeIds=[${trunc(references.excludeNodeIds, 10)}]`
        : '';
    if (wasRefine) {
      this.log(
        'debug',
        `[BFS-refine] cause=user_refine origin=${originNode.id} dir=${direction} depth=${depthLabel}${excludeNodeIdsLine} → scope=Δ (was=${prevScopeSize} now=${this.scopeNodeIds.size}) (tables=${breakdown.table}, views=${breakdown.view}, procs=${breakdown.procedure}, functions=${breakdown.function}) excludeTypes=[${excludedTypesAnnotated}]${guiHiddenLine}`,
      );
    } else {
      this.log(
        'debug',
        `[BFS] origin=${originNode.id} dir=${direction} depth=${depthLabel} → scope=${this.scopeNodeIds.size} (tables=${breakdown.table}, views=${breakdown.view}, procs=${breakdown.procedure}, functions=${breakdown.function}) excludeTypes=[${excludedTypesAnnotated}]${excludeNodeIdsLine}${guiHiddenLine}`,
      );
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
    for (let i = 0; i < contractParts.length; i++)
      h = ((h << 5) + h + contractParts.charCodeAt(i)) | 0;
    const contractHash = Math.abs(h).toString(16).padStart(8, '0').slice(0, 8);
    const filtersDigest = `excludeTypes=${this.excludedTypes.size},excludeSchemas=${this.excludedSchemas.size},excludeNodeIds=${this.excludedNodeIds.size},passNodeIds=${this.passNodeIds.size}`;
    const nlInterp =
      (params.excludeNodeIds?.length ?? 0) + (params.passNodeIds?.length ?? 0) >
      0
        ? 'identifiers→nodeIds'
        : 'none';
    this.log(
      'debug',
      `[Contract] hash=${contractHash} origin=${originNode.id} scope=${this.scopeNodeIds.size} filters=${filtersDigest} nl_interp=${nlInterp}`,
    );

    this._direction = direction;
    this.initSnapshot = {
      question: params.question,
      origin: originNode.id,
      analysisMode,
      ...(analysisMode === 'ct' && effectiveTargetColumns?.length
        ? {
            targetColumns: [...effectiveTargetColumns] as [string, ...string[]],
          }
        : {}),
      direction: this._direction,
      depthIntent,
      mission_brief: params.mission_brief,
    };
    const rootTask = this.taskLedger.ensureTask(
      this.taskInputFor(
        {
          source: 'mission',
          question: params.question,
          nodeId: originNode.id,
          createdHop: 0,
        },
        'root',
        initialActiveColumns,
      ),
    );
    this.enqueueHop(originNode.id, params.question, 0, 3, {
      carry: { kind: 'carry', columns: initialActiveColumns ?? [] },
      existingTaskId: rootTask.id,
    });
    this._status = 'initialized';

    return { ok: true };
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
      if (
        candidate.taskIds.some((taskId) => {
          const task = this.taskLedger.getTask(taskId);
          return task && !this.taskRefsResolve(task);
        })
      ) {
        return this.failInvariant(
          candidate.nodeId,
          'sourceRefs',
          COLUMN_SOURCE_MISSING,
        );
      }
      if (this.passNodeIds.has(this.identifierKey(candidate.nodeId))) {
        this.visited.add(candidate.nodeId);
        this.markNodeState(
          candidate.nodeId,
          'passthrough',
          'user',
          'user_pass_filter',
          {
            columns: candidate.activeColumns,
            atHop: this.hopCount,
          },
        );
        this.memory.recordVerdict('passthrough');
        this.contractThroughPassNode(candidate);
        this.completeTasks(candidate.taskIds);
        this._totalNodes--;
        continue;
      }

      const candidateNode = this.nodeMap.get(candidate.nodeId);
      if (candidateNode && !SCRIPT_TYPES.has(candidateNode.type)) {
        this.visited.add(candidate.nodeId);
        this.markNodeState(
          candidate.nodeId,
          'passthrough',
          'engine',
          'storage_passthrough',
          {
            columns: candidate.activeColumns,
            atHop: this.hopCount,
          },
        );
        this.memory.recordVerdict('passthrough');
        this.forwardStorageTasks(candidate);
        this.completeTasks(candidate.taskIds);
        this._totalNodes--;
        continue;
      }

      for (const taskId of candidate.taskIds) {
        const task = this.taskLedger.getTask(taskId);
        if (
          task?.callerContext &&
          (task.parentTaskId !== task.callerContext.callerTaskId ||
            !this.validFunctionCallerContext(
              candidate.nodeId,
              task.callerContext,
            ))
        ) {
          return this.failInvariant(
            candidate.nodeId,
            'callerContext',
            CALLER_CONTEXT_CHANGED,
          );
        }
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
    for (const taskId of entry.taskIds)
      this.taskLedger.setTaskStatus(taskId, 'active');
    this.currentFocusQuestion =
      this.taskLedger.getTask(entry.taskIds[0])?.question ?? null;

    if (this.tracer) {
      this.tracer.setActiveColumns(entry.activeColumns || []);
    }
    this._pendingLineageQuestions = entry.lineageQuestions
      ? [...entry.lineageQuestions]
      : [];

    const node = this.nodeMap.get(entry.nodeId)!;

    const focusNode = buildHopFocusNode(
      node,
      this.nodeMap,
      buildUnrelatedMap(this.model),
      this.store ?? undefined,
      this.model.neighborIndex,
      this.edgeTypeMap,
      this.identifierCaseSensitive,
    );

    if (this.depthBudget !== null) {
      const d = this.depthFromOrigin.get(entry.nodeId);
      if (d !== undefined) focusNode.depth_from_origin = d;
    }

    const path = bidirectional(this.graph, this.originNodeId!, entry.nodeId);
    const navPath = path
      ? path.map((id) => this.nodeMap.get(id)?.name || id).join(' → ')
      : 'Direct';

    const workingMemory = this.memory.getWorkingMemory(
      this.hopCount,
      this.scopeNodeIds.size,
      {
        rounds_used: this.hopCount,
        scope_growth: this.budgetExpansions.length,
        active_schemas: Array.from(this.sessionAllowedSchemas),
      },
    ) as NavigationWorkingMemory;
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
      schemas: Array.from(this.sessionAllowedSchemas)
        .filter(
          (schema) => !this.excludedSchemas.has(this.identifierKey(schema)),
        )
        .sort(),
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
  private failInvariant(
    nodeId: string,
    field: string,
    reason: string,
  ): HopContext {
    this.log(
      'error',
      `[Invariant] dispatch refused field=${field} hop=${this.hopCount + 1} — engine stopped`,
    );
    this.log(
      'debug',
      `[Invariant] dispatch refused node=${nodeId} field=${field}`,
    );
    this._status = 'error';
    this._errorReason = reason;
    return { done: false, sm_status: 'error' };
  }

  /** Open directional neighbors of this focus, including queued work; exact-depth proposals are marked deferred. */
  private openNeighbors(
    focusId: string,
  ): Array<{ id: string; queued: boolean; deferred: boolean }> {
    const directional = new Set(
      this.directionalNeighbors(focusId, this._direction),
    );
    return this.neighborChoices(focusId).flatMap(({ id, can_question }) => {
      const node = this.nodeMap.get(id);
      if (!node || !can_question || !directional.has(id)) return [];
      const admission = this.admitsRoute(id, node, focusId);
      if (
        !admission.admitted &&
        (admission.border.kind !== 'in_border' ||
          admission.depthBreach === null)
      )
        return [];
      return [
        { id, queued: this._agenda.has(id), deferred: !admission.admitted },
      ];
    });
  }

  /** Open, admitted neighbors that require an AI-authored outcome. */
  private requiredNeighborIds(focusId: string): string[] {
    return this.openNeighbors(focusId)
      .filter((neighbor) => !neighbor.deferred)
      .map((neighbor) => neighbor.id);
  }

  /** The metadata-driven question a passthrough candidate carries to the next object: whether that object touches the forwarded endpoints at all, not an assignment to map them. */
  private candidateQuestion(
    nid: string,
    side: 'upstream' | 'downstream',
    refs: ReadonlyArray<{ node: string; col: string }>,
  ): string {
    return `Analyze column ${refs.map((ref) => `${ref.node}.${ref.col}`).join(', ')} in ${nid} (${side}).`;
  }

  /** Re-renders the current focus hop context without advancing the agenda. */
  public peekHopContext(): HopContext | null {
    const focusId = this.currentFocusNodeId;
    if (!focusId) return null;
    const node = this.nodeMap.get(focusId);
    if (!node) return null;
    const focusNode = buildHopFocusNode(
      node,
      this.nodeMap,
      buildUnrelatedMap(this.model),
      this.store ?? undefined,
      this.model.neighborIndex,
      this.edgeTypeMap,
      this.identifierCaseSensitive,
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
      current_task:
        this.currentFocusQuestion ?? this._lastCurrentTask ?? undefined,
    };
  }

  /** Validates a hop decision's active status and canonical focus before held content or mutation. */
  private validateCurrentHopFocus(rawFocusId: unknown): string | ToolRejection {
    if (this._status === 'complete')
      return makeRejection({
        code: REJECTION_CODES.invalidInput,
        errors: at('exploration_complete'),
        detail: { next_action: 'present_result' },
      });
    if (this._status !== 'awaiting_findings')
      return makeRejection({
        code: REJECTION_CODES.backendFault,
        reason: `A hop decision arrived while the engine is in status '${this._status}', not 'awaiting_findings'.`,
        errors: at('backend_fault'),
        detail: { current_status: this._status },
      });
    const expected = this.currentFocusNodeId ?? '';
    if (rawFocusId === undefined) return expected;
    const focusId = typeof rawFocusId === 'string' ? rawFocusId : undefined;
    if (focusId !== expected)
      return makeRejection({
        code: REJECTION_CODES.invalidInput,
        reason: 'focus_node_id is not the current object.',
        errors: at('not_current_object', ['focus_node_id'], [expected]),
        detail: { expected, got: rawFocusId },
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
    if (
      this._status !== 'awaiting_findings' ||
      !focus ||
      focus === this.originNodeId ||
      !SCRIPT_TYPES.has(this.nodeMap.get(focus)!.type)
    )
      return undefined;
    const tasks = this.getCurrentTasks();
    if (
      !tasks.length ||
      tasks.some(
        (task) =>
          !task.passthroughFromNodeId ||
          SCRIPT_TYPES.has(
            this.nodeMap.get(task.passthroughFromNodeId)?.type ?? 'view',
          ),
      )
    )
      return undefined;
    if (
      this.tracer?.edges.some(
        (edge) => edge.from_node === focus || edge.to_node === focus,
      )
    )
      return undefined;
    return tasks[0]!.passthroughFromNodeId;
  }

  /** Available storage definitions on this route, retained as metadata without inventing loading SQL or column edges. */
  public get currentStorageContext(): ReadonlyArray<Record<string, unknown>> {
    const ids = new Set(
      this.getCurrentTasks().flatMap((task) => [
        ...(task.passthroughFromNodeId ? [task.passthroughFromNodeId] : []),
        ...(this.qualifiedTaskRefs(task) ?? []).map((ref) => ref.node),
      ]),
    );
    return [...ids].flatMap((id) => {
      const node = this.nodeMap.get(id);
      if (!node || SCRIPT_TYPES.has(node.type)) return [];
      const ddl = getNodeDdl(id, this.nodeMap, this.store ?? undefined);
      return [
        {
          ...buildHopFocusNode(
            node,
            this.nodeMap,
            buildUnrelatedMap(this.model),
            this.store ?? undefined,
            this.model.neighborIndex,
            this.edgeTypeMap,
            this.identifierCaseSensitive,
          ),
          columns:
            getNodeColumns(id, this.nodeMap, this.store ?? undefined) ?? [],
          ...(ddl ? { ddl } : {}),
        },
      ];
    });
  }

  /** Removes a whole unrelated hop reached through passthrough and the open nodes the shared directed pruning rule cuts with it. Uses the ordinary structural removal policy in BB and CT; unaffected branches remain. */
  public pruneCurrent(
    focusNodeId: string | undefined,
    reason: string,
  ): SubmitResult {
    if (typeof reason !== 'string' || !reason.trim())
      return makeRejection({
        code: REJECTION_CODES.invalidInput,
        reason: 'A non-empty reason must explain why this object is unrelated.',
        errors: at('missing', ['reason']),
      });
    const plan = this.preparePruneCurrent(focusNodeId);
    return 'code' in plan ? plan : this.commitPruneCurrent(plan, reason);
  }

  /** Stages the current engine-owned removal without publishing it. */
  public preparePruneCurrent(focusNodeId?: string) {
    const focusId = this.validateCurrentHopFocus(focusNodeId);
    if (typeof focusId !== 'string') return focusId;
    const fromNodeId = this.passthroughSender();
    const refused = at('prune_current_refused');
    if (fromNodeId === undefined)
      return makeRejection({
        code: REJECTION_CODES.invalidInput,
        reason: 'The current hop was not reached through passthrough.',
        errors: refused,
      });
    const refusal = this.pruneRefusal([focusId]);
    if (refusal)
      return makeRejection({
        code: REJECTION_CODES.invalidInput,
        reason: refusal,
        errors: refused,
      });
    const removal = this.removalSupport(
      this.removedSet,
      new Set([...this.removedSet, focusId]),
    );
    const removed = new Set([focusId, ...removal.cutIds]);
    const mapped = (this.tracer?.edges ?? []).filter(
      (edge) => removed.has(edge.from_node) || removed.has(edge.to_node),
    );
    if (mapped.length > 0)
      return makeRejection({
        code: REJECTION_CODES.invalidInput,
        reason: `Committed column mappings name ${[...new Set(mapped.flatMap((edge) => [edge.from_node, edge.to_node]).filter((id) => removed.has(id)))].join(', ')}; pruning would remove them.`,
        errors: refused,
      });

    return { focusId, fromNodeId, removal };
  }

  /** Publishes exactly the removal inspected by shared admission. */
  public commitPruneCurrent(
    {
      focusId,
      fromNodeId,
      removal,
    }: { focusId: string; fromNodeId: string; removal: RemovalAnalysis },
    reason: string,
  ): Extract<SubmitResult, { ok: true }> {
    this.beginHopCommit(0);
    this.lastHopDetailChars = 0;
    this.lastHopSummaryChars = reason.length;
    this.archiveChars += reason.length;
    this.memory.storeDetail(this.nodeMap.get(focusId)!, [], reason, {
      incoming_questions: this.currentIncomingQuestions(),
    });
    this.removedSet.add(focusId);
    this.hopRemovals.pruned.push(focusId);
    this.pruneBallots.delete(focusId);
    this.markNodeState(focusId, 'prune', 'ai', 'submitted_prune', {
      viaNodeId: fromNodeId,
      atHop: this.hopCount,
    });
    this.lastHopVerdict = 'prune';
    this.completeTasks(this.currentFocusTaskIds);
    this.recordPruneLead(focusId, fromNodeId, reason);
    this.cutUnreachable(focusId, removal);
    this.finishHopCommit();
    this.log('debug', `[Self-Prune] hop=${this.hopCount} id=${focusId}`);
    return { ok: true, ...this.commitRemovals };
  }

  /** The removals since the current hop commit began: `pruned` for nodes a prune named, `cut_ids` for the open nodes the directed pruning rule cut with them. Includes a pending neighbor prune resolved when the agenda empties after the commit. Empty lists are omitted. */
  public get commitRemovals(): Pick<
    Extract<SubmitResult, { ok: true }>,
    'pruned' | 'cut_ids'
  > {
    const { pruned, cut_ids } = this.hopRemovals;
    return {
      ...(pruned.length > 0 ? { pruned: [...pruned] } : {}),
      ...(cut_ids.length > 0 ? { cut_ids: [...cut_ids] } : {}),
    };
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

  /** Why removing `nodeIds` now is refused, or undefined when the removal is supported. The check counts neighbor prunes still pending resolution, except targets this submission keeps by routing or mapping them. Routed targets and staged column endpoints are protected as committed analysis. */
  private pruneRefusal(
    nodeIds: readonly string[],
    routed: ReadonlySet<string> = new Set(),
    stagedColumnEdges: readonly ColumnEdge[] = [],
  ): string | undefined {
    const kept = new Set([
      ...routed,
      ...stagedColumnEdges.flatMap((edge) => [edge.from_node, edge.to_node]),
    ]);
    const pending = [...this.pruneBallots]
      .filter(
        ([id, ballots]) =>
          !kept.has(id) &&
          [...ballots.values()].every((vote) => vote === 'prune'),
      )
      .map(([id]) => id);
    const analysis = this.removalSupport(
      this.removedSet,
      new Set([...this.removedSet, ...pending, ...nodeIds]),
      new Set([...this.visited, ...kept]),
    );
    if (analysis.rejection) return REMOVAL_REFUSAL[analysis.rejection];
    if (analysis.disconnectedVisited.length > 0)
      return `Removing it would disconnect committed analysis of ${analysis.disconnectedVisited.join(', ')}.`;
    return undefined;
  }

  /** A previously accepted route or mapping from another branch keeps this neighbor globally. */
  private keptByOtherBranch(nodeId: string, focusId: string): boolean {
    return (
      [...(this.pruneBallots.get(nodeId) ?? [])].some(
        ([sender, vote]) => sender !== focusId && vote === 'keep',
      ) ||
      !!this.tracer?.edges.some(
        (edge) =>
          edge.hop_node !== focusId &&
          (edge.from_node === nodeId || edge.to_node === nodeId),
      )
    );
  }

  /** Losing votes remove nothing; same-hop keeps and actual removal proposals retain every protection check. */
  private neighborPruneRefusal(
    focusId: string,
    nodeIds: readonly string[],
    routed: ReadonlySet<string> = new Set(),
    stagedColumnEdges: readonly ColumnEdge[] = [],
  ): string | undefined {
    const localKeeps = new Set([
      ...routed,
      ...stagedColumnEdges.flatMap((edge) => [edge.from_node, edge.to_node]),
    ]);
    const removals = nodeIds.filter(
      (id) => localKeeps.has(id) || !this.keptByOtherBranch(id, focusId),
    );
    return removals.length
      ? this.pruneRefusal(removals, routed, stagedColumnEdges)
      : undefined;
  }

  /** The served finding card: the canonical contract with omissions authorized by this context's held draft. */
  public findingSchema(modelBoundary = true) {
    const schema = this.canonicalFindingSchema(modelBoundary);
    return this.heldFindingDraft.matches(this.findingContext())
      ? this.heldFindingDraft.modelSchema(schema)
      : schema;
  }

  /** The one `submit_findings` admission contract; held fields compose into the candidate before it is checked (D-098). */
  private canonicalFindingSchema(modelBoundary: boolean) {
    return submitFindingsSchemaForMode(
      this.currentHopAnalysisMode,
      this.classification,
      this.memory.getArchivedAngles(this.currentFocusNodeId ?? '').size === 0,
      modelBoundary ? this.hopSubmitColumns : undefined,
    );
  }

  /** Internal already-typed DTO adapter. Untrusted model input enters submitModelFindings; section arrays here already satisfy HopSubmission. */
  public submitFindings(params: HopSubmission): SubmitResult {
    return this.submitWireFindings(this.findingWire(params), false);
  }

  /** The model boundary: compose held wire fields, validate the full schema once, then run the existing domain plan. */
  public submitModelFindings(input: unknown): SubmitResult {
    return this.submitWireFindings(input, true);
  }

  private submitWireFindings(
    input: unknown,
    modelBoundary: boolean,
  ): SubmitResult {
    const raw =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const currentFocusId = this.currentFocusNodeId;
    const archivedAngles = this.memory.getArchivedAngles(currentFocusId ?? '');
    const schema = this.canonicalFindingSchema(modelBoundary);
    const admission = findingAdmissionFacts(schema);
    const bound =
      raw.focus_node_id === undefined || raw.focus_node_id === currentFocusId;
    const authored =
      input && typeof input === 'object' && !Array.isArray(input)
        ? {
            ...raw,
            ...(raw.focus_node_id === undefined
              ? { focus_node_id: currentFocusId }
              : {}),
          }
        : input;
    const owedBefore = this.heldFindingDraft.matches(this.findingContext())
      ? this.failedParts(this.heldFindingDraft.faultPaths)
      : [];
    let alternatives: readonly string[] = [];
    const diagnostics: Parameters<LogFn>[] = [];
    let columns:
      | ReturnType<NavigationEngine['prepareFindingColumns']>
      | undefined;
    const columnReceipt = () =>
      (columns ??= this.prepareFindingColumns(
        currentFocusId ?? '',
        admission,
        (...args) => diagnostics.push(args),
      ));
    admission.facts.nativeIssue = (error, mapped) => {
      if (
        mapped.code === 'unknown_key' &&
        /^column_flow\.\d+\./.test(mapped.path)
      )
        return { ...mapped, category: 'reference' };
      if (error.keyword !== 'enum' && error.keyword !== 'const') return;
      const path = error.instancePath.slice(1).split('/').join('.');
      const question =
        /^questions\.\d+\.nodeId$/.test(path) && typeof error.data === 'string'
          ? this.questionReference(currentFocusId ?? '', error.data, path)
          : undefined;
      const route =
        question && question.kind !== 'valid'
          ? question
          : columnReceipt().columnPlan?.invalidRoutes.find(
              (route) => route.path === path,
            );
      if (!route) return;
      const issue = buildRouteValidationRejection([route]).errors[0];
      return {
        ...issue,
        path,
        values:
          issue.values ??
          (error.params.allowedValues ?? [error.params.allowedValue]).map(
            String,
          ),
      };
    };
    return ingestToolInput<typeof schema, SubmitResult>({
      input: authored,
      schema,
      facts: admission.facts,
      context: this.findingContext(),
      draft: bound ? this.heldFindingDraft : undefined,
      log: (line) => this.log('debug', line),
      committed: (result) => 'ok' in result,
      rejected: bound
        ? (problem, view) => {
            const failed = this.failedParts([
              ...problem.errors.map((error) => error.path),
              ...view.holdPaths,
            ]);
            const held = this.heldDraftOfCurrentFocus();
            problem.resend = [
              ...new Set([
                ...failed,
                ...(held
                  ? [...this.missingRequiredParts(held), ...alternatives]
                  : []),
              ]),
            ];
          }
        : undefined,
      inspect: (view) => {
        const focusCheck = this.validateCurrentHopFocus(
          view.value('focus_node_id'),
        );
        if (typeof focusCheck !== 'string') view.add(focusCheck);
        const callerFault = this.validateCallerContext();
        view.add(callerFault);
        if (
          (typeof focusCheck !== 'string' &&
            focusCheck.errors[0].code !== 'not_current_object') ||
          callerFault
        )
          return undefined;
        const focus = currentFocusId ?? '';
        const fields = admission.fields,
          unavailable = admission.unavailable();
        const { columnPlan, mentions } = columnReceipt();
        mentions.identities = admission.identities;
        for (const field of ['questions', 'prune_neighbors'] as const) {
          if (!unavailable.has(field)) continue;
          const prefix = `/${field}/`;
          const ids = [...admission.identities]
            .filter(([path]) => path.startsWith(prefix))
            .map(([, raw]) =>
              resolveModelNodeId(
                raw,
                this.nodeMap,
                this.identifierCaseSensitive,
              ),
            );
          if (
            admission.arrays.get(`/${field}`) === ids.length &&
            ids.every(
              (id): id is string => !!id && this.graph.areNeighbors(focus, id),
            )
          )
            mentions[field] = new Set(ids);
        }
        const { invalidRoutes, conflictPaths, ...plan } =
          this.collectFindingPlan(
            focus,
            fields,
            unavailable,
            (...args) => diagnostics.push(args),
            columnPlan,
            mentions,
          );
        conflictPaths
          .filter((path) => !path.startsWith('column_flow.'))
          .forEach((path) => view.holdPaths.add(path));
        alternatives = invalidRoutes.flatMap(
          (route) => route.alternatives ?? [],
        );
        if (invalidRoutes.length) {
          const problem = buildRouteValidationRejection(invalidRoutes);
          problem.issuePaths = [
            ...new Set([...(problem.issuePaths ?? []), ...conflictPaths]),
          ];
          view.add(problem);
        }
        if (!view.parsed.success) return undefined;
        const params = toHopFinding(view.parsed.data);
        const owed = missingSectionParts(
          params.sections,
          this.classification,
          archivedAngles,
        );
        if (owed.length)
          view.add(
            makeRejection({
              code: REJECTION_CODES.invalidInput,
              errors: at('missing', owed),
            }),
          );
        return () => {
          const withdrawn = owedBefore.filter(
            (part) =>
              !['summary', 'column_flow'].includes(part) &&
              !part.startsWith('sections') &&
              !hasPart(params, part),
          );
          const result = this.applyValidatedHop({
            ...plan,
            finding: params,
            stagedSections: params.sections,
            stagedDetailChars: params.sections.reduce(
              (sum, section) => sum + section.text.length,
              0,
            ),
            stagedSummaryChars: params.summary.length,
          });
          if ('ok' in result) diagnostics.forEach((args) => this.log(...args));
          return 'ok' in result && withdrawn.length
            ? { ...result, withdrawn }
            : result;
        };
      },
    });
  }

  private validateCallerContext(): ToolRejection | undefined {
    if (
      this.getCurrentTasks().some(
        (task) =>
          task.callerContext &&
          (!task.nodeId ||
            task.parentTaskId !== task.callerContext.callerTaskId ||
            !this.validFunctionCallerContext(task.nodeId, task.callerContext)),
      )
    ) {
      // No model reply can restore the caller's loaded SQL: stop the engine as the dispatch check
      // does, and answer with a backend-fault code so the run ends on this reply.
      this.failInvariant(
        this.currentFocusNodeId ?? '',
        'callerContext',
        CALLER_CONTEXT_CHANGED,
      );
      return makeRejection({
        code: REJECTION_CODES.backendFault,
        reason: CALLER_CONTEXT_CHANGED,
        errors: at('backend_fault'),
      });
    }
  }

  /** Composes pure column owners from one native receipt; unknown lists stay unknown. */
  private prepareFindingColumns(
    focusId: string,
    facts: ReturnType<typeof findingAdmissionFacts>,
    log: LogFn,
  ): {
    columnPlan?: ReturnType<ColumnTracer['finishColumnFlow']>;
    mentions: ActionMentions;
  } {
    const mentions: ActionMentions = {};
    if (!this.tracer) return { mentions };
    const paths = (path: string): string => path.slice(1).split('/').join('.');
    const rowOf = (path: string): string =>
      path.split('/').slice(0, 3).join('/');
    const count = facts.arrays.get('/column_flow');
    let complete = count !== undefined && facts.rows.size === count;
    const mentioned = new Set<string>(),
      invalidRoutes: InvalidRoute[] = [],
      stagedEdges: ColumnEdge[] = [],
      entryEdges = new Map<number, ColumnEdge[]>();
    const verified = new Map<string, LineageNode>();
    const contributors = this.columnContributorIds(focusId);
    for (const [path, col] of facts.columns) {
      const prefix = path.split('/').slice(0, -1).join('/'),
        node = facts.references.get(`${prefix}/node`);
      if (node === undefined) continue;
      const checked = this.tracer.validateColumnSupplier(
        focusId,
        {
          node:
            resolveModelNodeId(
              node,
              this.nodeMap,
              this.identifierCaseSensitive,
            ) ?? node,
          col,
        },
        paths(prefix),
        this.nodeMap,
        this.store ?? null,
        this.removedSet,
        contributors,
        log,
      );
      if ('invalidRoute' in checked) invalidRoutes.push(checked.invalidRoute);
      else verified.set(prefix, checked.neighbor);
    }
    for (const [row, keys] of facts.rows) {
      const supplierCount = facts.arrays.get(`${row}/upstream_columns`);
      if (
        supplierCount === undefined ||
        [...facts.references.keys()].filter((path) =>
          path.startsWith(`${row}/upstream_columns/`),
        ).length !== supplierCount
      )
        complete = false;
      if (keys.has('out_node') && !facts.references.has(`${row}/out_node`))
        complete = false;
    }
    for (const [path, raw] of facts.references) {
      const nid = resolveModelNodeId(
          raw,
          this.nodeMap,
          this.identifierCaseSensitive,
        ),
        node = nid ? this.nodeMap.get(nid) : undefined;
      if (!nid || !node) {
        complete = false;
        continue;
      }
      if (!this.graph.areNeighbors(focusId, nid)) continue;
      // At a procedure an entry pairs only through its out_node; without one it maps no neighbor.
      const row = rowOf(path);
      if (
        this.nodeMap.get(focusId)?.type !== 'procedure' ||
        facts.references.has(`${row}/out_node`)
      )
        mentioned.add(nid);
      if (this.admitsColumnReference(nid, node, focusId)) continue;
      const { border, depthBreach } = this.admitsRoute(nid, node, focusId);
      const outside =
        border.kind === 'excluded'
          ? 'excluded'
          : border.kind === 'out_of_direction'
            ? 'out of direction'
            : depthBreach !== null
              ? `beyond depth ${depthBreach}`
              : null;
      if (outside)
        invalidRoutes.push({
          kind: 'column_out_of_scope',
          id: nid,
          path: paths(path),
          alternatives: ['questions', 'sections'],
          reason: `The object is out of scope (${outside}).`,
        });
    }
    if (complete) mentions.column_flow = mentioned;
    const callerTargets = this.getCurrentTasks().flatMap((task) =>
      task.callerContext &&
      task.nodeId &&
      this.validFunctionCallerContext(task.nodeId, task.callerContext)
        ? [{ node: task.callerContext.node, col: task.callerContext.col }]
        : [],
    );
    const headers = new Map(facts.headers);
    for (const [columnPath, out_col] of facts.outColumns) {
      const row = rowOf(columnPath),
        keys = facts.rows.get(row),
        out_node = facts.references.get(`${row}/out_node`);
      if (headers.has(row) || !keys) continue;
      if (!keys.has('out_node') || out_node !== undefined)
        headers.set(row, {
          out_col,
          ...(out_node !== undefined ? { out_node } : {}),
        });
    }
    for (const [path, header] of headers) {
      const suppliers = [...facts.suppliers].flatMap(([refPath, ref]) => {
        const neighbor = verified.get(refPath);
        return rowOf(refPath) === path && neighbor
          ? [
              {
                ref: { ...ref, node: neighbor.id },
                path: paths(refPath),
                neighbor,
              },
            ]
          : [];
      });
      const prepared = this.tracer.prepareColumnEntry(
        focusId,
        header,
        suppliers,
        paths(path),
        this.nodeMap,
        this.model,
        this.store ?? null,
        log,
        callerTargets,
        this.removedSet,
        contributors,
      );
      invalidRoutes.push(...prepared.invalidRoutes);
      stagedEdges.push(...prepared.stagedEdges);
      entryEdges.set(Number(path.split('/')[2]), prepared.stagedEdges);
    }
    const sides = new Set(
        this.getCurrentTasks().flatMap((task) =>
          task.kind === 'column_lineage' && task.traversalSide
            ? [task.traversalSide]
            : [],
        ),
      ),
      mixed = sides.size > 1;
    return {
      mentions,
      columnPlan: this.tracer.finishColumnFlow(
        focusId,
        facts.fields.column_flow,
        invalidRoutes,
        stagedEdges,
        entryEdges,
        this.nodeMap,
        this.model,
        this.incomingColumnRefs(mixed ? 'upstream' : undefined),
        mixed ? this.incomingColumnRefs('downstream') : [],
        this.columnRoots(),
      ),
    };
  }

  /** Stages deterministic facts only. Unavailable fields block dependent checks, never become authored empty lists. */
  private collectFindingPlan(
    focusId: string,
    finding: Partial<HopFindingKept>,
    unavailable: ReadonlySet<keyof HopFindingKept> = new Set(),
    log: LogFn = this.log,
    columnPlan?: ReturnType<ColumnTracer['finishColumnFlow']>,
    actionMentions: ActionMentions = {},
  ) {
    const invalidRoutes: InvalidRoute[] = [
      ...(columnPlan?.invalidRoutes ?? []),
    ];
    const conflictPaths: string[] = [];
    const routeOutcomes: RouteOutcome[] = [];
    const acceptedNids = new Set<string>();
    const scopeAddNids = new Set<string>();
    const deferredRoutes: ValidatedHop['deferredRoutes'] = [];
    const stagedColumnEdges: ColumnEdge[] = [];
    const stagedColumnFlowEntries = this.tracer
      ? (finding.column_flow?.length ?? 0)
      : 0;
    const traceDirection = this.columnTraceDirection();
    const carryByNode = new Map<string, Set<string>>();
    const routeContexts: ValidatedHop['routeContexts'] = new Map();
    const flowQuestionByNode = new Map<string, string>();
    /** Keeps a carried endpoint in its accepted identity using the declared spelling of its object's column. */
    const addCarry = (
      nid: string,
      accepted: ScalarReturnTarget,
      traversalSide: 'upstream' | 'downstream',
    ): void => {
      const declared = getNodeColumns(
        accepted.node,
        this.nodeMap,
        this.store ?? undefined,
      )?.find(
        (column) =>
          this.columnKey(column.name) === this.columnKey(accepted.col),
      );
      const ref = { node: accepted.node, col: declared?.name ?? accepted.col };
      if (!carryByNode.has(nid)) carryByNode.set(nid, new Set());
      carryByNode.get(nid)!.add(ref.col);
      const legs = routeContexts.get(nid) ?? [];
      const prior = legs.find((leg) => leg.traversalSide === traversalSide);
      if (prior)
        prior.sourceRefs = uniqueScalarReturnTargets(
          [...prior.sourceRefs, ref],
          this.identifierCaseSensitive,
        );
      else legs.push({ sourceRefs: [{ ...ref }], traversalSide });
      routeContexts.set(nid, legs);
    };
    const incomingRefs = this.incomingColumnRefs();
    let entrySides:
      | Array<{ index: number; upstream: boolean; downstream: boolean }>
      | undefined;
    if (columnPlan && !unavailable.has('column_flow')) {
      entrySides = columnPlan.entrySides;
      for (const edge of columnPlan.stagedEdges) edge.hop = this.hopCount;
      stagedColumnEdges.push(...columnPlan.stagedEdges);
    }
    const endpointKey = columnEndpointKeyFactory(
      this.nodeMap,
      this.identifierCaseSensitive,
    );
    const mapped = new Set(
      stagedColumnEdges.flatMap((edge) => [
        endpointKey(edge.from_node, edge.from_col),
        endpointKey(edge.to_node, edge.to_col),
      ]),
    );
    const mappingDecisions = new Set(mapped);
    const mappedNeighborIds = new Set(
      stagedColumnEdges.flatMap((edge) => [edge.from_node, edge.to_node]),
    );
    // A declared output remains a mapping even when it has no in-scope suppliers and stages no edge.
    for (const entry of finding.column_flow ?? []) {
      const target = resolveColumnFlowTarget(
        entry,
        focusId,
        this.nodeMap,
        this.identifierCaseSensitive,
      );
      if (target) {
        mappingDecisions.add(
          endpointKey(target.attributionTo, target.attributionCol),
        );
        mappedNeighborIds.add(target.attributionTo);
      }
    }
    const mappingPaths = (
      matches: (node: string, col: string) => boolean,
    ): string[] =>
      (finding.column_flow ?? []).flatMap((entry, index) => {
        const refs = [
          {
            node: focusId,
            col: entry.out_col,
            path: `column_flow.${index}.out_col`,
          },
          ...entry.upstream_columns.map((ref, refIndex) => ({
            ...ref,
            path: `column_flow.${index}.upstream_columns.${refIndex}`,
          })),
          ...(entry.out_node
            ? [
                {
                  node: entry.out_node,
                  col: entry.out_col,
                  path: `column_flow.${index}.out_node`,
                },
              ]
            : []),
        ];
        return refs
          .filter(
            (ref) =>
              mappingDecisions.has(endpointKey(ref.node, ref.col)) &&
              matches(ref.node, ref.col),
          )
          .map((ref) => ref.path);
      });
    if (this.tracer && finding.column_flow) {
      // A column is carried only when the one closure of the requested outputs holds it.
      const closureEdges = [...this.tracer.edges, ...stagedColumnEdges].filter(
        (edge) => !isIndirectOnly(edge.transforms),
      );
      const attachedUpstream = columnAttachment(
        this.columnRoots(),
        closureEdges,
        'upstream',
        endpointKey,
      ).endpoints;
      const flowingDownstream = columnAttachment(
        this.columnRoots(),
        closureEdges,
        'downstream',
        endpointKey,
      ).flowing;
      if (traceDirection === 'upstream') {
        for (const [index, entry] of finding.column_flow.entries()) {
          if (
            entrySides &&
            !entrySides.some((side) => side.index === index && side.upstream)
          )
            continue;
          if (
            !resolveColumnFlowTarget(
              entry,
              focusId,
              this.nodeMap,
              this.identifierCaseSensitive,
            )
          )
            continue;
          for (const ref of entry.upstream_columns) {
            const nid = resolveModelNodeId(
              ref.node,
              this.nodeMap,
              this.identifierCaseSensitive,
            );
            if (
              nid === null ||
              !attachedUpstream.has(endpointKey(nid, ref.col))
            )
              continue;
            addCarry(nid, { node: nid, col: ref.col }, 'upstream');
            if (!flowQuestionByNode.has(nid)) {
              flowQuestionByNode.set(
                nid,
                `Trace ${nid}.${ref.col} as upstream input for ${focusId}.${entry.out_col}.`,
              );
            }
          }
        }
      }
      // A focus on the downstream side (the origin itself counts) forwards its tracked outputs
      // to its consumers whatever the trace direction — a bidirectional session traces columns
      // upstream while its origin still owes the declared column downstream.
      if (
        this.onDownstreamSide(focusId) &&
        this.graph.hasNode(focusId) &&
        (finding.column_flow.length > 0 ||
          focusId === this.originNodeId ||
          this.currentDestinations().length > 0)
      ) {
        const outputs = new Map<string, { node: string; col: string }>();
        for (const [index, entry] of finding.column_flow.entries()) {
          if (
            entrySides &&
            !entrySides.some((side) => side.index === index && side.downstream)
          )
            continue;
          if (
            focusId !== this.originNodeId &&
            entry.upstream_columns.every((ref) =>
              isIndirectOnly(ref.transforms),
            )
          ) {
            continue;
          }
          const resolved = resolveColumnFlowTarget(
            entry,
            focusId,
            this.nodeMap,
            this.identifierCaseSensitive,
          );
          if (!resolved) continue;
          const output = {
            node: resolved.attributionTo,
            col: resolved.attributionCol,
          };
          const outputKey = endpointKey(output.node, output.col);
          if (flowingDownstream.has(outputKey)) outputs.set(outputKey, output);
        }
        const continuation = [...outputs.values()];
        for (const nid of this.graph.outNeighbors(focusId)) {
          if (!this.onDownstreamSide(nid)) continue;
          // A declared write assigns the destination's endpoints, not the producer's borrowed ports.
          const assigned = continuation.filter(
            (ref) => this.identifierKey(ref.node) === this.identifierKey(nid),
          );
          const routed = assigned.length
            ? assigned
            : continuation.filter(
                (ref) =>
                  this.identifierKey(ref.node) === this.identifierKey(focusId),
              );
          for (const ref of routed) addCarry(nid, ref, 'downstream');
          if (routed.length > 0) {
            flowQuestionByNode.set(
              nid,
              this.candidateQuestion(nid, 'downstream', routed),
            );
          }
        }
      }
    }

    // Validated slices can prove a local prune conflict, never a complete finding or column carry.
    const pruneColumnEdges = unavailable.has('column_flow')
      ? columnPlan?.stagedEdges
      : stagedColumnEdges;
    // A faulty flow still names its objects by structure; a reference resolving to no single object leaves outcomes unknown.
    const outcomeIds =
      invalidRoutes.length === 0
        ? mappedNeighborIds
        : actionMentions.column_flow
          ? new Set([...mappedNeighborIds, ...actionMentions.column_flow])
          : undefined;
    const actions = this.collectNeighborActions(
      focusId,
      unavailable.has('questions') ? null : (finding.questions ?? []),
      unavailable.has('prune_neighbors')
        ? null
        : (finding.prune_neighbors ?? []),
      pruneColumnEdges,
      flowQuestionByNode,
      !this.tracer || !unavailable.has('column_flow')
        ? outcomeIds
        : actionMentions.column_flow,
      actionMentions,
    );
    const { pruneTargets, routeRequests, prunedNeighborNids } = actions;
    invalidRoutes.push(...actions.invalidRoutes);
    for (const id of actions.mutablePruneConflicts)
      conflictPaths.push(...mappingPaths((node) => node === id));

    for (const req of routeRequests) {
      const nid = req.nodeId;
      const nNode = this.nodeMap.get(nid);
      if (!nNode) continue;
      const { admitted, border, depthBreach } = this.admitsRoute(
        nid,
        nNode,
        focusId,
      );
      if (!admitted) {
        const schemaBorder =
          border.kind === 'excluded' &&
          this.isGuiHiddenSchemaBorder(border, nNode);
        const reason =
          border.kind === 'excluded'
            ? schemaBorder
              ? ('schema' as const)
              : ('excluded' as const)
            : border.kind === 'out_of_direction'
              ? ('out_of_direction' as const)
              : ('depth' as const);
        routeOutcomes.push({
          nodeId: nNode.id,
          accepted: false,
          deferred: true,
          reason,
        });
        deferredRoutes.push({
          nodeId: nNode.id,
          schema: nNode.schema,
          question: req.question,
          reason: reason === 'out_of_direction' ? 'direction' : reason,
          depth:
            reason === 'depth' || schemaBorder
              ? (depthBreach ?? undefined)
              : undefined,
        });
        log(
          'debug',
          reason === 'depth'
            ? `[Depth] border reached hop=${this.hopCount} id=${nNode.id} ← ${focusId} depth=${depthBreach} cap=up:${this.depthLimits.upstream}/down:${this.depthLimits.downstream}`
            : `[Agenda] route ignore hop=${this.hopCount} id=${nNode.id} ← ${focusId} reason=${reason}${reason === 'out_of_direction' ? ` direction=${this._direction}` : ''}`,
        );
        continue;
      }

      acceptedNids.add(nid);
      routeOutcomes.push({ nodeId: nNode.id, accepted: true });
      if (!this.scopeNodeIds.has(nid)) scopeAddNids.add(nid);
      log(
        'debug',
        `[Agenda] route accept hop=${this.hopCount} id=${nNode.id} ← ${focusId} subq=${trunc(req.question, 80)}`,
      );
    }
    // CT check 1: a column reference names an object the approved scope reaches; anything else is rejected, never dropped.

    // An arriving column without a mapping ends at this hop; the acknowledgement names it.
    const endedColumns: string[] = [];
    if (this.tracer && !unavailable.has('column_flow')) {
      const accounted = new Set<string>();
      for (const entry of finding.column_flow ?? []) {
        const target = resolveColumnFlowTarget(
          entry,
          focusId,
          this.nodeMap,
          this.identifierCaseSensitive,
        );
        if (target) accounted.add(endpointKey(focusId, entry.out_col));
        if (target)
          accounted.add(
            endpointKey(target.attributionTo, target.attributionCol),
          );
        for (const ref of entry.upstream_columns)
          if (mapped.has(endpointKey(ref.node, ref.col)))
            accounted.add(endpointKey(ref.node, ref.col));
      }
      for (const route of routeRequests)
        if (route.callerContext && acceptedNids.has(route.nodeId))
          accounted.add(
            endpointKey(route.callerContext.node, route.callerContext.col),
          );
      for (const ref of incomingRefs)
        if (!accounted.has(endpointKey(ref.node, ref.col)))
          endedColumns.push(`${ref.node}.${ref.col}`);
      if (endedColumns.length)
        log(
          'debug',
          `[CT] columns end hop=${this.hopCount} focus=${focusId} refs=[${endedColumns.join(', ')}]`,
        );
    }

    const neighbors = this.neighborChoices(focusId);
    const failures = invalidRoutes.map((route) => {
      const action = route.path?.startsWith('prune_neighbors.')
        ? 'can_prune'
        : route.path?.match(/^questions\.\d+\.nodeId$/)
          ? 'can_question'
          : undefined;
      return action
        ? {
            ...route,
            allowed_values: neighbors
              .filter(
                (neighbor) =>
                  neighbor[action] &&
                  (action !== 'can_prune' ||
                    !this.neighborPruneRefusal(
                      focusId,
                      [neighbor.id],
                      acceptedNids,
                      pruneColumnEdges ?? [],
                    )),
              )
              .map((neighbor) => neighbor.id),
          }
        : route;
    });
    const conflictPrunePaths = [
      ...conflictPaths,
      ...failures.flatMap((route) =>
        route.kind === 'prune_question_conflict'
          ? pruneTargets
              .filter(
                (target) =>
                  (target.resolved ?? this.identifierKey(target.raw)) ===
                  route.id,
              )
              .map((target) => target.path)
          : [],
      ),
    ];
    return {
      focusId,
      invalidRoutes: failures,
      conflictPaths: conflictPrunePaths,
      routeRequests,
      flowQuestionByNode,
      routeOutcomes,
      endedColumns,
      acceptedNids,
      scopeAddNids,
      deferredRoutes,
      prunedNeighborNids,
      carryByNode,
      routeContexts,
      stagedColumnEdges,
      stagedColumnFlowEntries,
    };
  }

  /** Canonical FK classification shared by native schema faults and neighbor actions. */
  private questionReference(
    focusId: string,
    raw: string,
    path: string,
    neighbors = new Map(
      this.neighborChoices(focusId).map((neighbor) => [neighbor.id, neighbor]),
    ),
  ): { kind: 'valid'; id: string } | InvalidRoute {
    const id = resolveModelNodeId(
      raw,
      this.nodeMap,
      this.identifierCaseSensitive,
    );
    if (!id)
      return {
        kind: 'question_not_neighbor',
        id: raw,
        path,
        reason: 'The object is not in the loaded model.',
      };
    if (!neighbors.has(id))
      return {
        kind: 'question_not_neighbor',
        id,
        path,
        reason: 'The object is not a neighbor of the focus.',
      };
    if (!neighbors.get(id)!.can_question)
      return {
        kind: 'question_closed',
        id,
        path,
        reason: `The object is already ${this.removedSet.has(id) ? 'pruned' : 'visited'} and cannot receive another investigation in this run.`,
      };
    return { kind: 'valid', id };
  }

  /** Collects neighbor action facts without committing; null means a malformed, unavailable list. */
  private collectNeighborActions(
    focusId: string,
    questions: HopFindingKept['questions'] | null,
    prunes: HopFindingKept['prune_neighbors'] | null,
    stagedColumnEdges: readonly ColumnEdge[] | undefined,
    continuationQuestions: ReadonlyMap<string, string>,
    mappedNeighborIds: ReadonlySet<string> | undefined,
    actionMentions: ActionMentions = {},
  ) {
    const invalidRoutes: InvalidRoute[] = [];
    const prunedNeighborNids = new Set<string>();
    const mutablePruneConflicts: string[] = [];
    const pruneTargets = (prunes ?? []).map((prune, index) => ({
      raw: prune.id,
      resolved: resolveModelNodeId(
        prune.id,
        this.nodeMap,
        this.identifierCaseSensitive,
      ),
      path: `prune_neighbors.${index}.id`,
    }));
    const pruneNeighborIds = new Set(
      pruneTargets.map((t) => t.resolved ?? this.identifierKey(t.raw)),
    );

    const routeRequests: ValidatedHop['routeRequests'] = [];
    const requested = new Set<string>();
    const neighbors = new Map(
      this.neighborChoices(focusId).map((neighbor) => [neighbor.id, neighbor]),
    );
    const identities = [...(actionMentions.identities ?? [])].map(
      ([path, raw]) => ({
        raw,
        path: path.slice(1).split('/').join('.'),
        id: resolveModelNodeId(raw, this.nodeMap, this.identifierCaseSensitive),
      }),
    );
    const questionChecks = new Map(
      identities
        .filter((ref) => /^questions\.\d+\.nodeId$/.test(ref.path))
        .map((ref) => [
          ref.path,
          this.questionReference(focusId, ref.raw, ref.path, neighbors),
        ]),
    );
    const pruneIdentities = new Set([
      ...pruneNeighborIds,
      ...identities
        .filter(
          (ref) =>
            ref.path.startsWith('prune_neighbors.') &&
            ref.id &&
            neighbors.get(ref.id)?.can_prune,
        )
        .map((ref) => ref.id),
    ]);
    for (const checked of questionChecks.values())
      if (checked.kind !== 'valid') invalidRoutes.push(checked);
    const conflictingQuestions = new Set<string>();
    for (const { path, id } of identities) {
      if (
        !path.startsWith('questions.') ||
        !id ||
        !neighbors.get(id)?.can_question ||
        !pruneIdentities.has(id)
      )
        continue;
      conflictingQuestions.add(id);
      invalidRoutes.push({
        kind: 'prune_question_conflict',
        id,
        path,
        reason:
          'The object is also named in prune_neighbors; the same submission cannot prune and investigate it.',
        alternatives: ['prune_neighbors'],
      });
    }
    (questions ?? []).forEach((q, index) => {
      const path = `questions.${index}.nodeId`;
      const receipt = questionChecks.get(path),
        checked =
          receipt ?? this.questionReference(focusId, q.nodeId, path, neighbors);
      if (checked.kind !== 'valid') {
        if (!receipt) invalidRoutes.push(checked);
        return;
      }
      const nid = checked.id;
      // The purpose is authored even if another field makes its proposed action inconsistent.
      requested.add(nid);
      if (conflictingQuestions.has(nid)) return;
      let callerContext: FunctionCallerContext | undefined;
      if (q.caller_context) {
        const target = resolveFunctionCallerTarget(
          nid,
          q.caller_context,
          this.nodeMap,
          this.model,
          this.store,
        );
        const callerTask = this.getCurrentTasks().find(
          (task) =>
            task.kind === 'column_lineage' &&
            task.nodeId === focusId &&
            task.activeColumns.some(
              (col) =>
                this.columnKey(col) === this.columnKey(q.caller_context!.col),
            ),
        );
        const ddl = getNodeDdl(focusId, this.nodeMap, this.store ?? undefined);
        if (
          !target ||
          target.node !== focusId ||
          !callerTask ||
          !ddl ||
          !this.scopeNodeIds.has(focusId)
        ) {
          const activeOutputs = [
            ...new Set(
              this.getCurrentTasks()
                .filter(
                  (task) =>
                    task.kind === 'column_lineage' && task.nodeId === focusId,
                )
                .flatMap((task) => task.activeColumns)
                .filter((col): col is string => !!col),
            ),
          ];
          invalidRoutes.push({
            kind: 'bad_caller_context',
            id: focusId,
            path: `questions.${index}.caller_context`,
            reason:
              'caller_context must name an active real output of the current caller, which reads this loaded function.',
            allowed_values: activeOutputs,
            when: { node: focusId },
          });
          return;
        }
        callerContext = {
          ...target,
          callerTaskId: callerTask.id,
          ddlHash: functionCallerDdlHash(ddl),
        };
      }
      routeRequests.push({
        nodeId: nid,
        question: q.question,
        ...(callerContext ? { callerContext } : {}),
      });
    });
    const outOfScopePruneIds = new Set<string>();
    for (const target of pruneTargets) {
      if (!target.resolved || target.resolved === this.originNodeId) continue;
      if (!neighbors.has(target.resolved)) {
        outOfScopePruneIds.add(target.resolved);
        invalidRoutes.push({
          kind: 'prune_unsupported',
          id: target.resolved,
          path: target.path,
          reason:
            "The object is not a neighbor of the focus; prune_neighbors may name only this hop's neighbors.",
        });
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
          reason:
            'The object is outside the approved exploration scope and cannot be pruned.',
        });
      }
    }
    const actionPolicy = this.pruneActionPolicy(
      focusId,
      pruneTargets.filter(
        (t) => !t.resolved || !outOfScopePruneIds.has(t.resolved),
      ),
    );
    invalidRoutes.push(...actionPolicy.invalidRoutes);

    const acceptedNids = new Set(
      routeRequests
        .filter((req) => {
          const node = this.nodeMap.get(req.nodeId);
          return node && this.admitsRoute(req.nodeId, node, focusId).admitted;
        })
        .map((req) => req.nodeId),
    );
    const pruneIds = actionPolicy.acceptedPruneIds;
    const mappedNodes = new Set(
      [...(this.tracer?.edges ?? []), ...(stagedColumnEdges ?? [])].flatMap(
        (edge) => [edge.from_node, edge.to_node],
      ),
    );
    const aloneRefusals = new Map(
      pruneIds.map((id) => [
        id,
        questions !== null || mappedNodes.has(id)
          ? this.neighborPruneRefusal(
              focusId,
              [id],
              acceptedNids,
              stagedColumnEdges ?? [],
            )
          : undefined,
      ]),
    );
    const jointRefusal =
      questions !== null &&
      pruneIds.length > 1 &&
      ![...aloneRefusals.values()].some(Boolean)
        ? this.neighborPruneRefusal(
            focusId,
            pruneIds,
            acceptedNids,
            stagedColumnEdges ?? [],
          )
        : undefined;
    for (const target of pruneTargets) {
      if (!target.resolved || !aloneRefusals.has(target.resolved)) continue;
      const refusal =
        aloneRefusals.get(target.resolved) ??
        (jointRefusal &&
          `${jointRefusal} (together with the other prune_neighbors entries)`);
      if (refusal) {
        // Only this draft's mapping can be reconsidered; committed or independently routed protection remains binding.
        const mutableMapping =
          !!stagedColumnEdges &&
          !this.neighborPruneRefusal(focusId, [target.resolved], acceptedNids);
        invalidRoutes.push({
          kind: 'prune_unsupported',
          id: target.resolved,
          path: target.path,
          reason: refusal,
          ...(mutableMapping ? { alternatives: ['column_flow'] } : {}),
        });
        if (mutableMapping) mutablePruneConflicts.push(target.resolved);
      }
    }
    for (const nid of pruneIds)
      if (!aloneRefusals.get(nid) && !jointRefusal) prunedNeighborNids.add(nid);
    // Routing follows authored decisions; generated carry alone is not a decision about a neighbor.
    // A missing outcome fails no supplied field, so valid findings remain held for an action-only retry.
    if (
      mappedNeighborIds &&
      (questions !== null || actionMentions.questions) &&
      (prunes !== null || actionMentions.prune_neighbors)
    ) {
      for (const id of this.requiredNeighborIds(focusId)) {
        if (
          requested.has(id) ||
          prunedNeighborNids.has(id) ||
          actionMentions.questions?.has(id) ||
          actionMentions.prune_neighbors?.has(id)
        )
          continue;
        if (!mappedNeighborIds.has(id)) {
          // In CT, column_flow is offered only for a neighbor that can be a value source (incoming edge) or, at a procedure, an out_node; a downstream reader is never mapped as a source.
          const ct = this.currentHopAnalysisMode === 'ct';
          const offerFlow =
            ct &&
            this.mappableNeighborIds(focusId).has(id) &&
            (this.graph.inNeighbors(focusId).includes(id) ||
              this.nodeMap.get(focusId)?.type === 'procedure');
          invalidRoutes.push({
            kind: 'neighbor_outcome_missing',
            id,
            alternatives: [
              'questions',
              ...(neighbors.get(id)?.can_prune &&
              !this.neighborPruneRefusal(
                focusId,
                [id],
                acceptedNids,
                stagedColumnEdges ?? [],
              )
                ? ['prune_neighbors']
                : []),
              ...(offerFlow ? ['column_flow'] : []),
            ],
            reason: `This neighbor has no authored outcome. ${ct && !offerFlow ? 'Keep / question it in questions, or prune it in prune_neighbors if allowed' : 'Map its value in column_flow (CT), prune it in prune_neighbors if allowed, or keep / question it in questions'}. Send the complete list for any action field you change, including entries you keep.`,
          });
          continue;
        }
        // The authored mapping supplies the outcome; its qualified column question travels separately.
        if (continuationQuestions.has(id))
          routeRequests.push({ nodeId: id, question: '' });
      }
    }

    return {
      invalidRoutes,
      pruneTargets,
      routeRequests,
      prunedNeighborNids,
      mutablePruneConflicts,
    };
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
      this.markNodeState(id, 'prune', 'engine', 'bb_prune_neighbor', {
        viaNodeId: cutNodeId,
        atHop: this.hopCount,
      });
      const node = this.nodeMap.get(id);
      if (node && this.scopeNodeIds.has(id)) this._totalNodes--;
    }
    if (dropped.length > 0) {
      this.log(
        'debug',
        `[Cut] hop=${this.hopCount} via=${cutNodeId} dropped=[${dropped.join(', ')}] (total → ${this._totalNodes})`,
      );
    }
  }

  /** Commits a kept hop whose submission passed every validation guard: route deferrals, scope growth, neighbour prunes and their cut, the focus verdict and the enqueued neighbours, each exactly once. */
  private applyValidatedHop(staged: ValidatedHop): SubmitResult {
    const {
      focusId,
      finding,
      routeRequests,
      flowQuestionByNode,
      routeOutcomes,
      endedColumns,
      acceptedNids,
      scopeAddNids,
      deferredRoutes,
      prunedNeighborNids,
      carryByNode,
      routeContexts,
      stagedSections,
      stagedDetailChars,
      stagedSummaryChars,
      stagedColumnEdges,
      stagedColumnFlowEntries,
    } = staged;
    let lineageQuestionsByNode: Map<string, string[]> | undefined;
    this.beginHopCommit(stagedColumnFlowEntries);

    for (const deferred of deferredRoutes) {
      this.deferQuestion(
        {
          nodeId: deferred.nodeId,
          schema: deferred.schema,
          fromFocusNodeId: focusId,
          question: deferred.question,
          reason: deferred.reason,
          depth: deferred.depth,
          atHop: this.hopCount,
        },
        routeContexts.get(deferred.nodeId),
      );
      this.lastRoutedDeferred++;
    }
    for (const nid of scopeAddNids) {
      this.scopeNodeIds.add(nid);
      const focusDepth = this.depthFromOrigin.get(focusId) ?? 0;
      if (!this.depthFromOrigin.has(nid)) {
        this.depthFromOrigin.set(
          nid,
          this.directedDepthFromOrigin(nid)?.depth ?? focusDepth + 1,
        );
      }
      this.budgetExpansions.push({
        nodeId: nid,
        depth: focusDepth + 1,
        atHop: this.hopCount,
      });
      this.log(
        'debug',
        `[Depth] auto-add beyond initial scope id=${nid} depth=${focusDepth + 1} hop=${this.hopCount}`,
      );
    }

    const pruneReasons = new Map(
      (finding.prune_neighbors ?? []).flatMap((prune) =>
        prune.id ? [[prune.id, prune.reason] as const] : [],
      ),
    );
    for (const nid of prunedNeighborNids) {
      const reason = pruneReasons.get(nid);
      if (this.recordBallot(nid, focusId, 'prune') && reason)
        this.recordPruneLead(nid, focusId, reason);
    }
    this.memory.storeDetail(
      this.nodeMap.get(focusId)!,
      stagedSections,
      finding.summary,
      {
        badge_label: finding.badge_label,
        incoming_questions: this.currentIncomingQuestions(),
      },
      (message) => this.log('debug', message),
    );
    this.lastHopDetailChars = stagedDetailChars;
    this.lastHopSummaryChars = stagedSummaryChars;
    this.archiveChars += this.lastHopDetailChars + this.lastHopSummaryChars;

    if (this.tracer && stagedColumnEdges.length > 0) {
      this.tracer.edges.push(...stagedColumnEdges);
      lineageQuestionsByNode = this.tracer.getColumnLineageQuestionsByNode(
        focusId,
        this.hopCount,
        new Map(
          [...routeContexts].map(([nodeId, legs]) => [
            nodeId,
            legs.flatMap((leg) => leg.sourceRefs),
          ]),
        ),
      );
      this.log(
        'debug',
        `[CT] column_flow hop=${this.hopCount} focus=${focusId} entries=${this.lastHopColumnFlowEntries} total_edges=${this.tracer.edges.length} active_cols=${this.tracer.activeColumns.join(',')}`,
      );
    }
    this.tryResolvePrunes([...prunedNeighborNids]);

    this.memory.recordVerdict('analyze');
    this.lastHopVerdict = 'analyze';
    this.markNodeState(focusId, 'analyze', 'ai', 'submitted_analyze', {
      columns: this.tracer?.activeColumns,
      ...(this.tracer
        ? {
            columnRole:
              this.tracer.activeColumns.length > 0
                ? ('carrier' as const)
                : ('row_role_only' as const),
          }
        : {}),
      atHop: this.hopCount,
    });
    this.completeTasks(this.currentFocusTaskIds);

    const freshlyExpandedIds = new Set<string>(scopeAddNids);
    for (const req of routeRequests) {
      const nid = req.nodeId;
      if (!acceptedNids.has(nid)) continue;
      if (this.removedSet.has(nid)) {
        const i = routeOutcomes.findIndex(
          (o) => o.nodeId === nid && o.accepted,
        );
        if (i >= 0)
          routeOutcomes[i] = {
            nodeId: nid,
            accepted: false,
            reason: 'already_pruned',
          };
        continue;
      }

      const agendaSizeBefore = this._agenda.length;
      const isFreshExpansion = freshlyExpandedIds.delete(nid);
      const columnQuestions =
        lineageQuestionsByNode?.get(nid) ??
        (flowQuestionByNode.has(nid)
          ? [flowQuestionByNode.get(nid)!]
          : undefined);
      const dispositions = new Map<string, RouteSkipDisposition>();
      const legs = routeContexts.get(nid) ?? [undefined];
      for (const leg of legs) {
        const legCarry = leg
          ? new Map([[nid, new Set(leg.sourceRefs.map((ref) => ref.col))]])
          : carryByNode;
        this.enqueueHop(nid, req.question, 0, 2, {
          dispositions,
          carry: this.neighborCarryFor(nid, legCarry, req.callerContext),
          sourceRefs: req.callerContext
            ? [{ node: req.callerContext.node, col: req.callerContext.col }]
            : leg?.sourceRefs,
          traversalSide: leg?.traversalSide,
          ...(req.callerContext
            ? {
                callerContext: req.callerContext,
                parentTaskId: req.callerContext.callerTaskId,
              }
            : {}),
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
          if (routeOutcomes[i].nodeId !== nid || !routeOutcomes[i].accepted)
            continue;
          routeOutcomes[i] = {
            nodeId: nid,
            accepted: false,
            reason: directSkip,
          };
          break;
        }
      }
    }

    for (const o of routeOutcomes) {
      if (o.accepted) continue;
      this.log(
        'debug',
        `[Agenda] route outcome hop=${this.hopCount} focus=${focusId} id=${o.nodeId} accepted=false reason=${o.reason ?? 'none'}${o.deferred ? ' deferred=true' : ''}`,
      );
    }
    this.finishHopCommit();
    const outcomes =
      routeOutcomes.length > 0 ? { route_outcomes: routeOutcomes } : {};

    return {
      ok: true,
      ...outcomes,
      ...(endedColumns.length ? { ended_columns: endedColumns } : {}),
      ...this.commitRemovals,
    };
  }

  /** Measures the scope for the exploration admission check: total nodes, rounds (the hops the run takes: those already taken, one per unvisited object not explicitly passed by the user) and the distinct starting trace columns. */
  public measureAdmissionScope(): ProposedScope {
    const ids = new Set(this.scopeNodeIds);
    let rounds = this.hopCount;
    for (const nid of ids) {
      const n = this.nodeMap.get(nid);
      if (!n) continue;
      const takesHop =
        SCRIPT_TYPES.has(n.type) &&
        !this.passNodeIds.has(this.identifierKey(nid)) &&
        !this.visited.has(nid) &&
        !this.removedSet.has(nid);
      if (takesHop) rounds++;
    }
    return {
      nodes: ids.size,
      rounds,
      columns: new Set(this.currentTargetColumns ?? []).size,
    };
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

    const limit = (side: 'upstream' | 'downstream'): number =>
      this.depthLimits[side];
    const hasFilters =
      this.excludedTypes.size > 0 ||
      this.excludedSchemas.size > 0 ||
      this.excludedNodeIds.size > 0;
    const walk = (mode: 'inbound' | 'outbound', maxDepth: number): void => {
      bfsFromNode(
        this.graph,
        startId,
        (key, _attr, depth) => {
          if (hasFilters && key !== startId) {
            const node = this.nodeMap.get(key);
            if (
              node &&
              this.checkBorder(key, node, 'seed_bfs').kind !== 'in_border'
            )
              return true;
          }
          seen.add(key);
          const prior = this.depthFromOrigin.get(key);
          if (prior === undefined || depth < prior)
            this.depthFromOrigin.set(key, depth);
          return depth >= maxDepth;
        },
        { mode },
      );
    };
    if (direction === 'upstream' || direction === 'bidirectional')
      walk('inbound', limit('upstream'));
    if (direction === 'downstream' || direction === 'bidirectional')
      walk('outbound', limit('downstream'));

    return seen;
  }

  /** Returns directional graph neighbors based on the active exploration direction. */
  private directionalNeighbors(
    nodeId: string,
    direction: 'upstream' | 'downstream' | 'bidirectional',
  ): string[] {
    if (direction === 'upstream') return this.graph.inNeighbors(nodeId);
    if (direction === 'downstream') return this.graph.outNeighbors(nodeId);
    return this.graph.neighbors(nodeId);
  }

  /** The note graph the agenda schedules over, read from current engine state. */
  private worklistView(): WorklistView {
    const allowed = this.allowedNoteSides();
    return {
      successors: (nodeId) => this.noteWalk(nodeId, allowed, false),
      distance: (entry) =>
        this.directedDepthFromOrigin(entry.nodeId)?.depth ?? entry.depth,
    };
  }

  /** The note-graph sides the active direction allows ({@link worklistView}). */
  private allowedNoteSides(): ReadonlyArray<'upstream' | 'downstream'> {
    const direction = this.effectiveDirection();
    return direction === 'bidirectional'
      ? ['upstream', 'downstream']
      : [direction];
  }

  /** Finds unfinished adjacent receivers, walking through only explicitly user-passed nodes. */
  private noteWalk(
    nodeId: string,
    allowed: ReadonlyArray<'upstream' | 'downstream'>,
    reversed: boolean,
  ): string[] {
    if (!this.graph.hasNode(nodeId)) return [];
    const sidesOf = (id: string) =>
      id === this.originNodeId
        ? allowed
        : allowed.filter(
            (side) => this.directedDepthsFor(id)?.[side] !== undefined,
          );
    const out = new Set<string>();
    for (const side of sidesOf(nodeId)) {
      const followsInNeighbors = reversed
        ? side === 'downstream'
        : side === 'upstream';
      const step = (id: string) =>
        followsInNeighbors
          ? this.graph.inNeighbors(id)
          : this.graph.outNeighbors(id);
      const carriers = new Set<string>();
      const stack = step(nodeId);
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (id === nodeId) continue;
        const node = this.nodeMap.get(id);
        if (!node) continue;
        const queued = this._agenda.has(id);
        if (!this.passNodeIds.has(this.identifierKey(id))) {
          const unfinished =
            queued ||
            (this.scopeNodeIds.has(id) &&
              !this.visited.has(id) &&
              !this.removedSet.has(id));
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
  private recordBallot(
    nodeId: string,
    focusId: string,
    vote: 'prune' | 'keep',
  ): boolean {
    if (this.removedSet.has(nodeId)) return false;
    let ballots = this.pruneBallots.get(nodeId);
    if (!ballots) {
      ballots = new Map();
      this.pruneBallots.set(nodeId, ballots);
    }
    ballots.set(focusId, vote);
    if (vote === 'prune')
      this.log(
        'debug',
        `[Prune] vote hop=${this.hopCount} via=${focusId} id=${nodeId}`,
      );
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
        if (this.visited.has(nodeId))
          this.taskLedger.dismissNodeLeads(nodeId, 'pruned_by_ai');
        continue;
      }
      const unheard = this.noteWalk(nodeId, this.allowedNoteSides(), true);
      if (unheard.length > 0) {
        if (!runEnded) continue;
        this.log(
          'debug',
          `[Prune] resolve at run end id=${nodeId} unheard=[${trunc(unheard.join(', '), LOG_TRUNC_CONTENT)}] — agenda empty, no sender left to dispatch`,
        );
      }
      const voters = Array.from(ballots.keys());
      const pruneVoters = voters.filter((id) => ballots.get(id) === 'prune');
      this.pruneBallots.delete(nodeId);
      if (
        pruneVoters.length < voters.length ||
        this.tracer?.edges.some(
          (edge) => edge.from_node === nodeId || edge.to_node === nodeId,
        )
      ) {
        this.taskLedger.dismissNodeLeads(nodeId, 'pruned_by_ai');
        if (pruneVoters.length > 0) {
          this.log(
            'debug',
            `[Prune] resolve id=${nodeId} kept votes=${pruneVoters.length}/${voters.length}`,
          );
        }
        continue;
      }
      ready.push({ nodeId, voters });
    }
    const retain = (nodeId: string, analysis: RemovalAnalysis): void => {
      const refusal = analysis.rejection
        ? REMOVAL_REFUSAL[analysis.rejection]
        : `retained because removing it would disconnect previously visited analysis: ${analysis.disconnectedVisited.join(', ')}.`;
      this.memory.recordRejection(nodeId, refusal, this.hopCount);
      this.log(
        'debug',
        `[Prune] reject id=${nodeId} reason=${analysis.rejection ?? 'visited_support'} count=${analysis.disconnectedVisited.length}`,
      );
      this.taskLedger.dismissNodeLeads(nodeId, 'pruned_by_ai');
    };
    const batch = ready.filter(({ nodeId }) => {
      const alone = this.removalSupport(
        this.removedSet,
        new Set([...this.removedSet, nodeId]),
      );
      if (alone.rejection || alone.disconnectedVisited.length) {
        retain(nodeId, alone);
        return false;
      }
      return true;
    });
    if (batch.length === 0) return;
    const removal = this.removalSupport(
      this.removedSet,
      new Set([...this.removedSet, ...batch.map((b) => b.nodeId)]),
    );
    if (removal.rejection || removal.disconnectedVisited.length) {
      for (const { nodeId } of batch) retain(nodeId, removal);
      return;
    }
    const first = [...batch].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1))[0];
    for (const { nodeId, voters } of batch) {
      this.removedSet.add(nodeId);
      this.hopRemovals.pruned.push(nodeId);
      this.markNodeState(nodeId, 'prune', 'ai', 'bb_prune_neighbor', {
        viaNodeId: voters.at(-1) ?? nodeId,
        atHop: this.hopCount,
      });
      if (!this.visited.has(nodeId) && this.scopeNodeIds.has(nodeId)) {
        this._totalNodes--;
        this.log(
          'debug',
          `[Prune] prune_neighbor ${nodeId} — scope node (total −1 → ${this._totalNodes})`,
        );
      }
      this.log(
        'debug',
        `[Prune] resolve id=${nodeId} removed votes=${voters.length}/${voters.length}`,
      );
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
    const columns =
      getNodeColumns(entry.nodeId, this.nodeMap, this.store ?? undefined) ?? [];
    this.memory.storeDetail(
      node,
      [
        {
          angle: this.classification === 'business' ? 'business' : 'technical',
          text: `Storage metadata: ${JSON.stringify({ columns, ...(node.fks?.length ? { foreign_keys: node.fks } : {}) })}. Loading or consuming SQL must establish any value contribution.`,
        },
      ],
      STORAGE_TRAVERSED_PLACEHOLDER_SUMMARY,
      { is_placeholder: true },
    );
    for (const nid of this.directionalNeighbors(
      entry.nodeId,
      this._direction,
    )) {
      const next = this.nodeMap.get(nid);
      if (!next || this.visited.has(nid) || this.removedSet.has(nid)) {
        this.log(
          'debug',
          `[Storage] not forwarded from=${entry.nodeId} next=${nid} — visited, removed or absent`,
        );
        continue;
      }
      const admission = this.admitsRoute(nid, next, entry.nodeId);
      if (admission.border.kind !== 'in_border') {
        this.log(
          'debug',
          `[Storage] not forwarded from=${entry.nodeId} next=${nid} — outside the approved border`,
        );
        continue;
      }
      const forwarded = new Set<string>();
      for (const taskId of entry.taskIds) {
        const task = this.taskLedger.getTask(taskId)!;
        const refs = this.qualifiedTaskRefs(task) ?? [];
        const sides: Array<'upstream' | 'downstream'> = task.traversalSide
          ? [task.traversalSide]
          : this.effectiveDirection() === 'bidirectional'
            ? ['upstream', 'downstream']
            : [this.effectiveDirection() as 'upstream' | 'downstream'];
        const side = sides.find((direction) =>
          this.directionalNeighbors(entry.nodeId, direction).includes(nid),
        );
        const carried = side ? refs : [];
        // Arrivals by different paths that carry the same context go on once, so a chain of shared carriers grows linearly.
        const context = JSON.stringify([
          task.question,
          carried.length ? side : '',
          carried
            .map((ref) => [
              this.identifierKey(ref.node),
              this.columnKey(ref.col),
            ])
            .sort(),
        ]);
        if (forwarded.has(context)) {
          this.log(
            'debug',
            `[Storage] same context already forwarded from=${entry.nodeId} next=${nid} task=${task.id}`,
          );
          continue;
        }
        forwarded.add(context);
        if (!admission.admitted && !this.scopeNodeIds.has(nid)) {
          this.deferQuestion(
            {
              nodeId: nid,
              schema: next.schema,
              fromFocusNodeId: this.askerTask(task)?.nodeId ?? entry.nodeId,
              question: task.question,
              reason: 'depth',
              depth: admission.depthBreach ?? undefined,
              atHop: this.hopCount,
            },
            carried.length && side
              ? [{ sourceRefs: carried, traversalSide: side }]
              : [],
          );
          this.log(
            'debug',
            `[Storage] deferred from=${entry.nodeId} next=${nid} — depth`,
          );
          continue;
        }
        const fresh = !this.scopeNodeIds.has(nid);
        this.scopeNodeIds.add(nid);
        if (!this.depthFromOrigin.has(nid))
          this.depthFromOrigin.set(
            nid,
            this.directedDepthFromOrigin(nid)?.depth ?? entry.depth + 1,
          );
        const carry: ColumnCarry = carried.length
          ? {
              kind: 'carry',
              columns: [...new Set(carried.map((ref) => ref.col))],
            }
          : { kind: 'row_role_only' };
        this.enqueueHop(nid, task.question, entry.depth + 1, entry.priority, {
          carry,
          parentTaskId: task.id,
          sourceRefs: carried.length ? carried : undefined,
          traversalSide: carried.length ? side : undefined,
          passthroughFromNodeId: entry.nodeId,
          lineageQuestions:
            carried.length && side
              ? [this.candidateQuestion(nid, side, carried)]
              : undefined,
          freshScopeExpansion: fresh,
        });
        this.log(
          'debug',
          `[Storage] forwarded from=${entry.nodeId} next=${nid} refs=${carried.length}`,
        );
      }
    }
  }

  /** Forwards a pass-tagged node's intent to its in-direction bodied neighbours. */
  private contractThroughPassNode(entry: AgendaEntry): void {
    for (const nid of this.directionalNeighbors(
      entry.nodeId,
      this._direction,
    )) {
      const forwarded = new Set<string>();
      for (const taskId of entry.taskIds) {
        const task = this.taskLedger.getTask(taskId)!;
        const continues =
          !task.traversalSide ||
          this.directionalNeighbors(entry.nodeId, task.traversalSide).includes(
            nid,
          );
        const validCaller =
          continues &&
          task.callerContext &&
          this.validFunctionCallerContext(nid, task.callerContext)
            ? task.callerContext
            : undefined;
        const targets =
          continues && task.kind === 'column_lineage'
            ? (this.qualifiedTaskRefs(task) ?? []).filter((target) =>
                this.resolveCallerEndpoint(nid, target, [task.id]),
              )
            : undefined;
        const unresolved =
          continues && task.kind === 'column_lineage' && !targets?.length
            ? this.passNodeUnresolvedQuestion(
                entry.nodeId,
                this.qualifiedTaskRefs(task) ?? [],
              )
            : '';
        // Arrivals by different paths that carry the same context go on once, as at a table.
        const refKeys = (
          refs: ReadonlyArray<{ node: string; col: string }> | undefined,
        ) =>
          (refs ?? [])
            .map((ref) => [
              this.identifierKey(ref.node),
              this.columnKey(ref.col),
            ])
            .sort();
        const context = JSON.stringify([
          task.question,
          unresolved,
          continues ? (task.traversalSide ?? '') : '',
          refKeys(targets),
          targets?.length && task.kind === 'column_lineage'
            ? refKeys(task.sourceRefs)
            : [],
          validCaller
            ? [
                this.identifierKey(validCaller.node),
                this.columnKey(validCaller.col),
                validCaller.callerTaskId,
                validCaller.ddlHash,
              ]
            : [],
        ]);
        if (forwarded.has(context)) {
          this.log(
            'debug',
            `[Agenda] same context already forwarded through pass node=${entry.nodeId} next=${nid} task=${task.id}`,
          );
          continue;
        }
        forwarded.add(context);
        this.enqueueHop(
          nid,
          unresolved
            ? `${task.question}${task.question ? '\n' : ''}${unresolved}`
            : task.question,
          entry.depth + 1,
          entry.priority,
          {
            carry: targets?.length
              ? { kind: 'carry', columns: targets.map((target) => target.col) }
              : { kind: 'row_role_only' },
            parentTaskId: validCaller?.callerTaskId ?? task.id,
            ...(validCaller ? { callerContext: validCaller } : {}),
            lineageQuestions: targets?.length
              ? entry.lineageQuestions
              : undefined,
            traversalSide: continues ? task.traversalSide : undefined,
            sourceRefs:
              targets?.length && task.kind === 'column_lineage'
                ? task.sourceRefs
                : undefined,
            passthroughFromNodeId: entry.nodeId,
          },
        );
      }
    }
  }

  /** The source-qualified question a column continuation leaves at a pass node it cannot cross. */
  private passNodeUnresolvedQuestion(
    passNodeId: string,
    refs: ReadonlyArray<{ node: string; col: string }>,
  ): string {
    const named = refs.map((ref) => `\`${ref.node}.${ref.col}\``).join(', ');
    this.log(
      'debug',
      `[Agenda] column continuation stops at pass node=${passNodeId} refs=[${named}] — unresolved, dispatched as BB`,
    );
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
      existingTaskId,
      callerContext,
      sourceRefs,
      traversalSide,
      parentTaskId,
      passthroughFromNodeId,
      dispositions,
    } = opts;
    if (!this.scopeNodeIds.has(targetId)) {
      dispositions?.set(targetId, 'not_enqueued');
      this.log(
        'debug',
        `[Disposition] enqueue drop ${targetId} — out-of-scope target`,
      );
      return;
    }
    if (this.visited.has(targetId) || this.removedSet.has(targetId)) {
      const removed = this.removedSet.has(targetId);
      this.log(
        'debug',
        `[Disposition] enqueue skip ${targetId} — already ${removed ? 'removed' : 'visited'} via focus=${this.currentFocusNodeId ?? this.originNodeId ?? '(none)'} hop=${this.hopCount}`,
      );
      dispositions?.set(
        targetId,
        removed ? 'already_pruned' : 'already_visited',
      );
      return;
    }
    const focusId = this.currentFocusNodeId;
    if (
      focusId &&
      this._status === 'awaiting_findings' &&
      this.visited.has(focusId) &&
      this.recordBallot(targetId, focusId, 'keep')
    ) {
      this.tryResolvePrunes([targetId]);
    }
    const node = this.nodeMap.get(targetId);
    if (!node) {
      this.log(
        'debug',
        `[Disposition] enqueue drop ${targetId} — absent from the loaded graph model`,
      );
      return;
    }

    const activeColumns =
      carry.kind === 'carry' ? carry.columns.filter(Boolean) : undefined;
    if (!this.tracer && activeColumns?.length) {
      throw new Error('BB agenda tasks must not carry active columns');
    }
    if (
      this.tracer &&
      node.type === 'function' &&
      carry.kind === 'row_role_only' &&
      !getNodeColumns(node.id, this.nodeMap, this.store ?? undefined)?.length
    ) {
      question = `${question}${question ? '\n' : ''}No declared scalar caller output binding is available for this function. This visit does not resolve a caller's column contribution; do not invent function columns or return destinations.`;
    }
    const task = this.ensureExecutableTask(
      targetId,
      question,
      priority,
      activeColumns,
      existingTaskId,
      parentTaskId,
      callerContext,
      sourceRefs,
      traversalSide,
      passthroughFromNodeId,
    );
    const alreadyQueued = this._agenda.has(targetId);
    const agendaColumns = !this.tracer
      ? undefined
      : carry.kind === 'row_role_only'
        ? []
        : activeColumns;
    const columnCarry = !this.tracer
      ? {}
      : {
          columnCarry:
            carry.kind === 'carry'
              ? { kind: 'carry' as const, columns: [...carry.columns] }
              : { ...carry },
        };
    this._agenda.push({
      taskIds: [task.id],
      nodeId: targetId,
      priority,
      depth,
      activeColumns: agendaColumns,
      ...columnCarry,
      ...(lineageQuestions?.length ? { lineageQuestions } : {}),
    });
    if (!alreadyQueued && freshScopeExpansion) this._totalNodes++;
  }

  /** Derives one neighbor's continuation from accepted flow, explicit qualified passthrough or a validated caller context. */
  private neighborCarryFor(
    nodeId: string,
    carryByNode: ReadonlyMap<string, ReadonlySet<string>>,
    callerContext?: FunctionCallerContext,
  ): ColumnCarry {
    if (!this.tracer) return { kind: 'carry', columns: [] };
    if (
      callerContext &&
      !getNodeColumns(nodeId, this.nodeMap, this.store ?? undefined)?.length &&
      this.validFunctionCallerContext(nodeId, callerContext)
    ) {
      return { kind: 'carry', columns: [callerContext.col] };
    }
    const byKey = new Map<string, string>();
    for (const col of carryByNode.get(nodeId) ?? [])
      if (!byKey.has(this.columnKey(col))) byKey.set(this.columnKey(col), col);
    const columns = [...byKey.values()];
    return columns.length > 0
      ? { kind: 'carry', columns }
      : { kind: 'row_role_only' };
  }

  /** Creates the typed task attached to a concrete agenda hop. */
  private ensureExecutableTask(
    nodeId: string,
    question: string,
    priority: number,
    activeColumns: string[] | undefined,
    existingTaskId?: string,
    parentTaskId: string | undefined = this.currentFocusTaskIds[0],
    callerContext?: FunctionCallerContext,
    sourceRefs?: readonly ScalarReturnTarget[],
    traversalSide?: 'upstream' | 'downstream',
    passthroughFromNodeId?: string,
  ): InvestigationTask {
    const existing = existingTaskId
      ? this.taskLedger.getTask(existingTaskId)
      : undefined;
    if (existing) return existing;
    return this.taskLedger.ensureTask(
      this.taskInputFor(
        {
          source: priority === 2 ? 'model' : 'engine',
          question,
          nodeId,
          parentTaskId,
          createdHop: this.hopCount,
          ...(callerContext ? { callerContext } : {}),
          ...(traversalSide ? { traversalSide } : {}),
          ...(passthroughFromNodeId ? { passthroughFromNodeId } : {}),
        },
        'analytical',
        activeColumns,
        sourceRefs,
      ),
    );
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
    const mappable =
      this.currentHopAnalysisMode === 'ct'
        ? this.mappableNeighborIds(focusId)
        : null;
    return this.neighborChoices(focusId).map(({ id: nid, ...capabilities }) => {
      const n = this.nodeMap.get(nid)!;
      const boundary = this.visited.has(nid) ? 'cycle' : 'none';
      const edgeDirection = inSet.has(nid) ? 'upstream' : 'downstream';
      // A table the focus writes carries its column constraints: the focus SQL alone cannot show
      // whether a value it inserts is accepted, e.g. a NULL into a NOT NULL column.
      const writtenColumns =
        edgeVerb.get(nid) === 'write' && n.type === 'table'
          ? getNodeColumns(nid, this.nodeMap, this.store ?? undefined)?.map(
              (c) => presentColumnCompact(c),
            )
          : undefined;
      const cols =
        writtenColumns ??
        (this.tracer
          ? getNodeColumns(nid, this.nodeMap, this.store ?? undefined)?.map(
              (c) => c.name,
            )
          : undefined);
      const attributedColumns =
        this.tracer?.spineColumnsFor(nid, this.columnTraceDirection()) ?? [];
      const neighbor: HopNeighborDisclosure = {
        id: nid,
        s: n.schema,
        n: n.name,
        t: n.type,
        edge_direction: edgeDirection,
        edge_type: edgeVerb.get(nid) ?? 'read',
        boundary,
        ...(cols?.length ? { cols } : {}),
        ...capabilities,
        ...(mappable ? { can_map: mappable.has(nid) } : {}),
        ...(this.isCarrierInto(nid, focusId) ? { prune_protected: true } : {}),
        ...(this.visited.has(nid) ? { already_visited: true } : {}),
        ...(this.removedSet.has(nid) ? { already_removed: true } : {}),
        ...(attributedColumns.length
          ? { attributed_columns: attributedColumns }
          : {}),
        ...(!this.isReachableInApprovedDirection(nid)
          ? { out_of_direction: true }
          : {}),
      };

      const d = this.depthFromOrigin.get(nid);
      if (d !== undefined) neighbor.depth_from_origin = d;
      neighbor.in_budget = this.scopeNodeIds.has(nid);

      neighbor.in_approved_scope = this.admitsRoute(nid, n, focusId).admitted;
      return neighbor;
    });
  }

  /** One neighbor projection for context, schemas, routing and repair choices. Only committed state constrains choices: a repair may explicitly replace its uncommitted flow. Effective submitted mappings remain protected at validation. */
  private neighborChoices(
    focusId: string,
  ): Array<Pick<HopNeighborDisclosure, 'id' | 'can_question' | 'can_prune'>> {
    const ids = this.graph.hasNode(focusId)
      ? this.graph.neighbors(focusId)
      : [];
    const prunable = new Set(
      this.pruneActionPolicy(
        focusId,
        ids.map((id, index) => ({
          raw: id,
          resolved: id,
          path: `prune_neighbors.${index}.id`,
        })),
      ).acceptedPruneIds,
    );
    return ids.map((id) => {
      const node = this.nodeMap.get(id);
      const open = !!node && !this.visited.has(id) && !this.removedSet.has(id);
      return {
        id,
        can_question: open,
        can_prune:
          !!node &&
          prunable.has(id) &&
          this.scopeNodeIds.has(id) &&
          this.admitsRoute(id, node, focusId).admitted &&
          !this.neighborPruneRefusal(focusId, [id]),
      };
    });
  }

  /** The same action-state facts feed advertised prune choices and final submission validation. */
  private pruneActionPolicy(
    focusId: string,
    pruneTargets: CurrentHopActionTarget[],
  ) {
    return evaluateCurrentHopActionPolicy({
      originId: this.originNodeId ?? '',
      pruneTargets,
      visitedIds: new Set([
        ...this.visited,
        ...pruneTargets.flatMap((target) =>
          target.resolved && this.isCarrierInto(target.resolved, focusId)
            ? [target.resolved]
            : [],
        ),
      ]),
      removedIds: this.removedSet,
      notedIds: new Set(this.memory.notedNodeIds),
      keptIds: new Set(
        pruneTargets.flatMap((target) =>
          target.resolved && this.keptByOtherBranch(target.resolved, focusId)
            ? [target.resolved]
            : [],
        ),
      ),
      agendaIds: new Set(this._agenda.entries.map((entry) => entry.nodeId)),
    });
  }

  /** Packages exploration records into the final presentation topology. */
  public getResult(): SmResult {
    if (this._status !== 'complete') {
      throw new Error(
        `Exploration result requested in status '${this._status}': a result exists only for a complete exploration.`,
      );
    }
    const nodeStates = Array.from(this.nodeStates.values());
    const direction = this.effectiveDirection();
    const columnAspect =
      this.tracer?.deliveredState(
        this.columnRoots(),
        direction === 'bidirectional' ? 'both' : direction,
        this.log,
      ) ?? null;
    const rendered = new Set(
      nodeStates
        .filter((state) => state.action !== 'prune')
        .map((state) => state.nodeId),
    );
    for (const edge of columnAspect?.edges ?? []) {
      rendered.add(edge.from_node);
      rendered.add(edge.to_node);
    }
    return {
      status: 'complete',
      originNodeId: this.originNodeId!,
      fullNodes: Array.from(rendered, (id) => {
        const n = this.nodeMap.get(id)!;
        return { id: n.id, s: n.schema, n: n.name, t: n.type };
      }),
      edges: this.model.edges
        .filter((e) => rendered.has(e.source) && rendered.has(e.target))
        .map((e) => [
          e.source,
          e.target,
          edgeApiType(e.type, this.nodeMap.get(e.source)?.type ?? ''),
        ]),
      detail_slots: this.memory
        .getResult()
        .detail_slots.filter((slot) => rendered.has(slot.nodeId)),
      node_states: nodeStates,
      columnAspect,
    };
  }

  /** Emits the serializable active map state used by diagnostics and the presentation artifact's run record. */
  public toJSON(): SmState {
    const snapshot: SmState = {
      identifierCaseSensitive: this.identifierCaseSensitive,
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
      ctDeclaredRouteIds: [
        ...new Set(
          (this.tracer?.edges ?? []).flatMap((edge) => [
            edge.from_node,
            edge.to_node,
          ]),
        ),
      ],
      ...(this.tracer
        ? { lineageQuestionsLastHop: [...this._pendingLineageQuestions] }
        : {}),
    };
    try {
      return parseNavigationSnapshot(snapshot);
    } catch (err) {
      if (err instanceof InvalidEngineCheckpointError) {
        this.log(
          'error',
          `[Checkpoint] serialize rejected — paths=${trunc(err.diagnostic, LOG_TRUNC_CONTENT)}`,
          err,
        );
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
        upstream: Number.isFinite(this.depthLimits.upstream)
          ? this.depthLimits.upstream
          : null,
        downstream: Number.isFinite(this.depthLimits.downstream)
          ? this.depthLimits.downstream
          : null,
      },
      depthFromOrigin: Array.from(this.depthFromOrigin.entries()),
      budgetExpansions: this.budgetExpansions.map((b) => ({ ...b })),
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
      investigationTasks: this.taskLedger.investigationTasks.map((task) => ({
        ...task,
      })),
      pendingLeads: this.taskLedger.pendingLeads.map((lead) => ({ ...lead })),
      initSnapshot: this.initSnapshot,
      continuationVersion: 1,
      pruneBallots: [...this.pruneBallots].map(([nodeId, votes]) => ({
        nodeId,
        votes: [...votes].map(([senderId, vote]) => ({ senderId, vote })),
      })),
    };
  }
}
