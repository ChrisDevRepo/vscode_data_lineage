import type { InvalidRoute, DepthIntent, HeldSubmissionParts, ColumnFlowEntry } from './smTypes';
import { buildRouteValidationRejection, HELD_CORRECTION_ORDER, isAbsentKind, ROUTE_REJECTION_CODE, ROUTE_REJECTION_DIRECTIVE, routeRejectionDetail, routeRejectionDirectives, routeRejectionReason } from './smRouteValidation';
import { activeSubmitFindingsRecoveryHint, extractRawSectionAngles, validateSectionsAgainstClassification } from '../interaction/rules/submitFindingsRules';
import { COLUMN_FLOW_NOTE_MAX, SUBMIT_FINDINGS_BADGE_LABEL_MAX, heldEntriesRepairLine, heldSubmissionRepairHint, validateHopSubmissionShape, type SubmitFindingsHopColumns } from '../tools/toolSchemas';

import type Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path/unweighted';
import { bfsFromNode } from 'graphology-traversal';
import type { DatabaseModel, LineageNode } from '../../engine/types';
import type { ColumnStore } from '../../engine/columnStore';
import { ASYMMETRIC_DEPTH_BOTH_ZERO, bothSidesClosed, directionFromDepth, type DepthSideValue } from '../../engine/shared/explorationDepthContract';
import type { SerializedFilterState } from '../../engine/projectStore';
import { buildEdgeTypeMap, buildHopFocusNode, buildUnrelatedMap } from '../tools/tools';
import { buildNodeMap, getNodeColumns, getNodeDdl, SCRIPT_TYPES } from '../support/graphUtils';
import { buildPassthroughReAnchor } from '../prompting/smPrompts';
import { edgeApiType, presentColumnCompact } from '../support/aiPresenter';
import { analyzeRemoval, bfsReachable, type LogFn, type RemovalAnalysis } from '../../engine/graphGuards';
import { trunc, LOG_TRUNC_CONTENT, LOG_TRUNC_LIST } from '../../utils/log';
import { compileExclusionMatcher, normalizeColName, quoteIdentifier, schemaKey, splitSqlName, stripBrackets } from '../../utils/sql';
import { AiMemoryManager, type DetailSlot, type IncomingQuestion, type WorkingMemory } from '../session/memoryManager';
import type { ClassificationValue } from '../session/classification';
import { RepairDraftStore } from '../support/repairDraftStore';
import { resolveModelNodeId } from '../support/inputNormalization';
import { evaluateCurrentHopActionPolicy } from './currentHopActionPolicy';
import type { ApprovedBorder, ColumnAspect, ColumnCarry, ColumnEdge, ScalarReturnTarget, FunctionCallerContext, DeferredQuestion, DiagnosticsSnapshot, EngineInitSnapshot, EngineInternalsSnapshot, HopContext, HopNeighbor, HopProgress, HopFindingKept, HopSubmission, InvestigationTask, NavigationInitParams, PendingLead, PrunedBranch, RouteOutcome, RouteSkipDisposition, ScopeExclusionGroup, ScopeExclusions, ScopeSummary, SettledRouteReason, ScopeSummaryLeaf, SmNodeAction, SmNodeColumnRole, SmNodeState, SmNodeStateReason, SmNodeStateSource, SmResult, SmState, SmStatus, SubmitResult, SupplementChain, SupplementSkip } from '../sm/smTypes';
import { estimateTokens, type ProposedScope } from '../support/tokenBudget';
import { ColumnTracer, columnAttachment, columnClosure, columnEndpointKeyFactory, resolveColumnFlowTarget } from "./columnTracer";
import { AgendaManager, type AgendaEntry, type WorklistView } from './agendaManager';
import { TaskLedger, taskPromptText, type InvestigationTaskInput } from './taskLedger';
import { resolveScalarReturnTarget, resolveFunctionCallerTarget, functionCallerDdlHash, uniqueScalarReturnTargets } from './scalarReturnBinding';
import { parseNavigationSnapshot, InvalidEngineCheckpointError } from './navigationSnapshotSchema';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { makeRejection, type ToolRejection } from '../support/toolErrorEnvelope';

/**
 * A hop neighbour plus the engine decisions already taken about it.
 *
 * @remarks
 * The non-bodied carrier contracted into the current focus is already visited and cannot be
 * pruned at that focus. Column evidence does not create additional retention protections.
 */
export interface HopNeighborDisclosure extends HopNeighbor {
  /**
   * The non-bodied carrier already contracted into this focus, protected by the visit-once rule.
   */
  prune_protected?: boolean;
  /** Already analyzed on an earlier hop; a prune cannot remove committed analysis. */
  already_visited?: boolean;
  /** Already pruned on an earlier hop; a removed node stays removed. */
  already_removed?: boolean;
  /** Columns a committed `column_flow` edge attributes to this neighbour, as evidence only. */
  attributed_columns?: string[];
  /**
   * This neighbour is unreachable from the origin in the approved direction (a downstream write
   * target during an upstream-only run, or the reverse), in BB and CT alike. In a bidirectional
   * session it marks a neighbour outside both the upstream and the downstream closure of the
   * origin, reached only sideways through a shared node. An out-of-direction neighbour is never
   * visited, and a prune on it is a no-op.
   */
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
  'visited': 'not removed — it was already visited on an earlier hop and is retained.',
};
/** Fields a held finding draft restores when the retry omits them and the field did not fail; `column_flow` included, so a CT retry never retypes a valid flow. */
const HELD_CARRIED_FIELDS = ['badge_label', 'prune_neighbors', 'questions', 'column_flow'] as const;

/** Held neighbor lists, each entry keyed by the neighbor id it names; naming a neighbor in one list drops its held entry from the other. */
const NEIGHBOR_ENTRY_KEYS = { questions: 'nodeId', prune_neighbors: 'id' } as const;
type NeighborEntryList = keyof typeof NEIGHBOR_ENTRY_KEYS;
/** Held lists whose entries fail, hold and merge one by one: the neighbor lists and `column_flow`, keyed by `out_col`. */
type HeldEntryList = NeighborEntryList | 'column_flow';
const HELD_ENTRY_LISTS: readonly HeldEntryList[] = ['questions', 'prune_neighbors', 'column_flow'];
const isHeldEntryList = (field: string): field is HeldEntryList => (HELD_ENTRY_LISTS as readonly string[]).includes(field);
/** Held fields restored or replaced as one value: a retry that sends one replaces the held value whole. */
const HELD_WHOLE_FIELDS = HELD_CARRIED_FIELDS.filter((field): field is Exclude<typeof field, HeldEntryList> => !isHeldEntryList(field));

/** A rejection's issue paths split into whole failed fields, failed neighbor-list entries and failed section angles. */
interface FailedParts {
  /** Top-level fields that failed as a whole and are not held. */
  readonly fields: Set<string>;
  /** Indexes of failed entries per neighbor list whose list did not fail as a whole. */
  readonly entries: Map<HeldEntryList, Set<number>>;
  /** Section angles that failed while `sections` itself did not. */
  readonly angles: Set<string>;
}

/**
 * Splits dotted issue paths so a rejection fails the narrowest part it names: `questions.1.nodeId`
 * and `column_flow.0.upstream_columns.1.col` fail that entry only, `sections.technical` fails that
 * angle only, and any other path (`questions`, `column_flow`, `badge_label`) fails its whole
 * top-level field.
 */
function splitFailedParts(paths: readonly string[]): FailedParts {
  const fields = new Set<string>();
  const entries = new Map<HeldEntryList, Set<number>>();
  const angles = new Set<string>();
  for (const path of paths) {
    const [top, second] = path.split('.');
    if (!top) continue;
    if (isHeldEntryList(top) && second !== undefined && /^\d+$/.test(second)) {
      entries.set(top, (entries.get(top) ?? new Set()).add(Number(second)));
    } else if (top === 'sections' && (second === 'business' || second === 'technical')) {
      angles.add(second);
    } else {
      fields.add(top);
    }
  }
  for (const list of HELD_ENTRY_LISTS) if (fields.has(list)) entries.delete(list);
  if (fields.has('sections')) angles.clear();
  return { fields, entries, angles };
}

/**
 * Defines the core interface for the state machine handling exploration modes.
 */
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
  supplementAgenda(nodeIds: string[], leadIds?: string[], chain?: SupplementChain): { ok: true; agendaed: number; contracted: number; skipped: number; skippedDetails: SupplementSkip[] } | ToolRejection;
}

/**
 * The write path a border test serves. Every purpose tests the exclusion sets; `route` and
 * `contraction` also test approved-direction reachability, while `supplement` (an already-surfaced
 * lead) and `seed_bfs` (the walk that defines the direction) do not.
 */
type BorderPurpose = 'route' | 'contraction' | 'supplement' | 'seed_bfs';

/**
 * First failing border axis for a candidate node, or `in_border` when it clears every
 * participating axis. A discriminated verdict (not a boolean bag) so a caller can route each
 * outcome distinctly — e.g. the route path rejects `excluded` but *defers* `out_of_direction`.
 */
type BorderVerdict =
  | { kind: 'in_border' }
  | { kind: 'excluded'; axis: 'type' | 'schema' | 'node_id' }
  | { kind: 'out_of_direction' };

/**
 * Combined border + depth admission test for one route candidate. A record, not a boolean: the two
 * axes are reported to the model differently (schema gate name vs level count), so callers that
 * need the distinction read the axes while others read only `admitted`.
 */
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
  return {
    taskIds: [...entry.taskIds],
    nodeId: entry.nodeId,
    priority: entry.priority,
    depth: entry.depth,
    ...(entry.activeColumns ? { activeColumns: [...entry.activeColumns] } : {}),
    ...(entry.columnCarry
      ? { columnCarry: entry.columnCarry.kind === 'carry' ? { kind: 'carry' as const, columns: [...entry.columnCarry.columns] } : entry.columnCarry.kind === 'scalar_return' ? { kind: 'scalar_return' as const, outputs: entry.columnCarry.outputs.map(target => ({ ...target })) } : { ...entry.columnCarry } }
      : {}),
    ...(entry.lineageQuestions ? { lineageQuestions: [...entry.lineageQuestions] } : {}),
  };
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
  /** Neighbours this hop enqueues, resolved: model questions, column_flow-named nodes, then every open neighbour not pruned. */
  routeRequests: Array<{ nodeId: string; question: string; callerContext?: FunctionCallerContext }>;
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
  stagedCtNodeStates: Array<{ nodeId: string; action: SmNodeAction; source: SmNodeStateSource; reason: SmNodeStateReason; meta: { columns?: string[]; viaNodeId?: string; atHop?: number } }>;
  stagedColumnFlowEntries: number;
  /** CT tracked columns this hop's column_flow left unaccounted; informational, never a rejection. */
  unaccountedColumns: string[];
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
  /** Lazily built keys (`writer→target`) of the model's delete-only write edges. */
  private deleteOnlyWrites?: Set<string>;
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
   * excluded from {@link toJSON}; `AiSession.classification` is the single source of truth.
   */
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
  /**
   * A neighbor prune not yet resolved: nodeId → each sender's own vote on its edge into the node
   * (`'prune'` from `prune_neighbors`, `'keep'` from an ordinary route, a question, or — CT — a
   * `column_flow` reference). One sender casts at most one ballot, keyed by its own focus id, so a
   * reactivated sender's fresh verdict replaces its own earlier one rather than adding a second
   * vote — {@link tryResolvePrunes} removes the node only once every live sender has finished and
   * every recorded ballot reads `'prune'`, or when the agenda empties. Checkpoints preserve
   * accepted ballots so resuming does not change a shared node's fate.
   */
  private pruneBallots = new Map<string, Map<string, 'prune' | 'keep'>>();
  /**
   * Nodes the last {@link getResult} removed from the render as undispositioned sinks, surfaced as
   * `renderDroppedNodeIds` so the render states its own disposition explicitly.
   */
  protected renderDroppedIds = new Set<string>();
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
   * Per-side depth ceilings from the approved intent; `Infinity` where that side is unbounded. A
   * side at `levels: 0` is `0` whatever its exactness.
   *
   * @remarks
   * Kept alongside {@link depthBudget} because a single scalar cannot express an asymmetric ask:
   * collapsing `{upstream: 2, downstream: 1}` to its maximum enforces 2 on both sides, admitting
   * a node the user capped out. Only consulted when {@link depthEnforcement} is `'strict'`.
   */
  protected depthLimits: { upstream: number; downstream: number } = NavigationEngine.UNBOUNDED_DEPTH_LIMITS;
  /**
   * Whether the approved depth is a hard border (`'strict'`) or an initial seed the model may grow
   * (`'silent'`). Set from the AI's own `depthIntent`: an `'exact'` side binds and a `levels: 0`
   * side is always closed; an open `'approximate'` side does not bind.
   */
  protected depthEnforcement: 'strict' | 'silent' = 'silent';
  /**
   * Resolves the per-side ceilings, published budget and enforcement of an approved depth intent.
   *
   * @remarks
   * The rule `init()` applies. A side at `levels: 0` is closed (`0`) whatever its exactness;
   * otherwise only an `'exact'` side binds and an `'approximate'` side is `Infinity`. The budget is
   * the larger ceiling when both are finite, and enforcement is `'strict'` once either is finite.
   */
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
   * Submission held after a rejection a retry can correct without re-authoring the analysis — a
   * schema rejection in the `submit_findings` handler ({@link holdRejectedSubmission}), a route/column
   * fault, or a field over its length cap — so {@link applyHeldContent} restores what the retry
   * omits. Other rejections never establish held state.
   */
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

  /**
   * Object types the GUI filter hid at session start.
   *
   * @remarks
   * The default `excludeTypes` baseline a fresh proposal is seeded with when the model states
   * none of its own — a plain approve then keeps them out; an explicit `excludeTypes` on a later
   * call replaces this default rather than adding to it.
   */
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

  /**
   * Whether the draft held for the current focus carries a `column_flow` that did not fail as a
   * whole, so a retry may omit it or resend only the entries of the out_cols it changes.
   */
  public get heldColumnFlow(): boolean {
    const held = this.heldFindingDraft.get();
    return this.heldFindingFocus !== null && held?.column_flow !== undefined
      && !(this.heldFindingDraft.getAuthorization()?.failed ?? []).includes('column_flow');
  }

  /**
   * Canonical focus id of a currently-held finding, or `null` when none is held.
   *
   * @remarks
   * Non-null means a rejected submit_findings of this focus left correctable parts held.
   */
  public get heldFindingFocus(): string | null {
    const held = this.heldFindingDraft.get();
    const authorization = this.heldFindingDraft.getAuthorization();
    if (!held || !authorization || authorization.focusId !== this.currentFocusNodeId
      || authorization.hop !== this.hopCount || authorization.mode !== this.currentHopAnalysisMode) return null;
    return authorization.focusId;
  }

  /**
   * Overlays a correction retry on the held draft of the same focus: sections merge by angle
   * ({@link RepairDraftStore.mergeByKey}), so an angle the retry omits keeps its held body, and an
   * empty summary keeps the held one.
   *
   * A held `badge_label` is restored when the retry omits it. Held list entries merge by their key
   * ({@link mergeHeldEntries}): `questions` and `prune_neighbors` by the neighbor they name, where a
   * neighbor resent in one list also drops its held entry from the other, and `column_flow` by
   * `out_col`, where `column_flow: []` clears the held entries. A resent entry replaces the held
   * entries of its key and an unnamed held entry is kept. A field the rejection that held it named
   * as failed as a whole is never restored. Merging is idempotent: a retry that already carries the
   * held entries merges to the same list.
   *
   * @returns The submission to apply, or a `missing_field` rejection when a kept verdict carries no
   *   sections and no summary and no held draft of this focus supplies them, or when neither the
   *   retry nor a held draft supplies a non-empty summary. Empty sections with an authored summary
   *   pass on: a revisit credits the angles already archived.
   */
  public applyHeldContent(incoming: HopSubmission): HopSubmission | ToolRejection {
    const held = this.heldFindingDraft.get();
    const inFocus = resolveModelNodeId(incoming.focus_node_id, this.nodeMap, this.model.identifierCaseSensitive) ?? this.identifierKey(incoming.focus_node_id);
    const heldForFocus = this.heldFindingFocus === inFocus && held
      && (resolveModelNodeId(held.focus_node_id, this.nodeMap, this.model.identifierCaseSensitive) ?? this.identifierKey(held.focus_node_id)) === inFocus
      && inFocus === this.currentFocusNodeId
      ? held
      : null;
    if (!heldForFocus) {
      if (incoming.sections.length === 0 && !incoming.summary.trim()) {
        return makeRejection({
          code: REJECTION_CODES.missingField,
          hint: 'sections is empty and no draft is held for this node; resend the full call with authored sections and a non-empty summary.',
        });
      }
      return incoming.summary.trim() ? incoming : this.emptySummaryRejection();
    }
    this.log('debug', `[Hold] held sections restored hop=${this.hopCount} focus=${inFocus}`);
    const failed = this.heldFindingDraft.getAuthorization()?.failed ?? [];
    const carried: Partial<HopFindingKept> = {};
    for (const field of HELD_WHOLE_FIELDS) {
      if (incoming[field] === undefined && heldForFocus[field] !== undefined && !failed.includes(field)) {
        Object.assign(carried, { [field]: heldForFocus[field] });
      }
    }
    for (const list of HELD_ENTRY_LISTS) {
      if (failed.includes(list)) continue;
      const merged = this.mergeHeldEntries(list, heldForFocus[list], incoming, new Set());
      if (merged !== undefined) Object.assign(carried, { [list]: structuredClone(merged) });
    }
    const summary = incoming.summary.trim() ? incoming.summary : heldForFocus.summary;
    if (!summary.trim()) return this.emptySummaryRejection();
    return {
      ...incoming,
      ...carried,
      sections: RepairDraftStore.mergeByKey(heldForFocus.sections, incoming.sections, section => section.angle ?? ''),
      summary,
    };
  }

  /**
   * What identifies an entry of a held list, or `null` when the entry names nothing: the canonical
   * neighbor id of a `questions` / `prune_neighbors` entry, and the `out_col` of a `column_flow`
   * entry, compared under the model's identifier policy. Every `column_flow` entry of one out_col
   * shares its key, so a resent or failed entry replaces or drops all of them, as the served
   * contract states.
   */
  private heldEntryKey(list: HeldEntryList, entry: unknown): string | null {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    if (list === 'column_flow') {
      return typeof record.out_col === 'string' && record.out_col.trim() !== '' ? this.columnKey(record.out_col) : null;
    }
    const raw = record[NEIGHBOR_ENTRY_KEYS[list]];
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    return resolveModelNodeId(raw, this.nodeMap, this.model.identifierCaseSensitive) ?? this.identifierKey(raw);
  }

  /**
   * Merges one held list of a retry over its held entries: a held entry survives unless the retry
   * names its key (for a neighbor list, in either neighbor list) or `dropped` holds that key; the
   * retry's own entries follow, as sent, or lead with `resentFirst` so that an issue path into the
   * merged list indexes the entry the model sent. A resent `column_flow: []` clears the held flow.
   *
   * @returns The merged list, or `undefined` when neither side leaves an entry and the retry sent no list.
   */
  private mergeHeldEntries<L extends HeldEntryList>(
    list: L,
    held: HopFindingKept[L],
    resent: Pick<HopFindingKept, HeldEntryList>,
    dropped: ReadonlySet<string>,
    resentFirst = false,
  ): HopFindingKept[L] {
    if (list === 'column_flow' && resent.column_flow?.length === 0) return [] as unknown as HopFindingKept[L];
    const sides: readonly HeldEntryList[] = list === 'column_flow' ? [list] : [list, list === 'questions' ? 'prune_neighbors' : 'questions'];
    const named = new Set<string>(dropped);
    for (const side of sides) {
      for (const entry of (resent[side] ?? []) as unknown[]) {
        const key = this.heldEntryKey(side, entry);
        if (key !== null) named.add(key);
      }
    }
    const kept = ((held ?? []) as unknown[]).filter(entry => !named.has(this.heldEntryKey(list, entry) ?? ''));
    const sent = (resent[list] ?? []) as unknown[];
    const merged = resentFirst ? [...sent, ...kept] : [...kept, ...sent];
    return (merged.length > 0 || resent[list] !== undefined ? merged : undefined) as HopFindingKept[L];
  }

  /** A kept verdict whose summary is empty with no held summary to restore. */
  private emptySummaryRejection(): ToolRejection {
    return makeRejection({
      code: REJECTION_CODES.missingField,
      hint: 'summary is empty and no summary is held for this node; resend the full call with summary: one sentence on what this node does to the data and hands on.',
      issuePaths: ['summary'],
    });
  }

  /**
   * Holds the valid parts of a `submit_findings` call its handler's schema check rejected, merged
   * over a held draft of the same focus, so {@link applyHeldContent} restores them on the retry.
   *
   * @remarks
   * A failure is held at the narrowest part its issue path names: `sections.<angle>` fails that
   * angle, `questions.<i>…` / `prune_neighbors.<i>…` / `column_flow.<i>…` fail that entry, and any
   * other path fails its whole top-level field. The valid entries of a list merge over the held
   * entries as a retry does ({@link mergeHeldEntries}); a failed entry is never held, and the held
   * entries of its key (neighbor or out_col) are dropped, since the model's correction for that key
   * is still owed. A list whose every entry failed is not held.
   *
   * @param input - The rejected payload as the model sent it.
   * @param failedPaths - Dotted Zod issue paths of the rejection.
   * @returns What the retry gets restored — held `sections` angles, whether a held `summary`, the
   *   other held field names (a field this call failed as a whole excluded) and the neighbor ids of
   *   held list entries. Any call that is not a kept verdict of the current focus holds nothing new
   *   and reports the draft already held for the current focus; `null` when nothing is held.
   */
  public holdRejectedSubmission(input: unknown, failedPaths: readonly string[]): HeldSubmissionParts | null {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return this.heldPartsOfCurrentFocus();
    const raw = input as Record<string, unknown> & { focus_node_id?: unknown; verdict?: unknown };
    if ((raw.verdict !== 'analyze' && raw.verdict !== 'passthrough') || typeof raw.focus_node_id !== 'string') return this.heldPartsOfCurrentFocus();
    const focus = resolveModelNodeId(raw.focus_node_id, this.nodeMap, this.model.identifierCaseSensitive) ?? this.identifierKey(raw.focus_node_id);
    if (focus !== this.currentFocusNodeId) return this.heldPartsOfCurrentFocus();
    const parts = splitFailedParts(failedPaths);
    const failed = parts.fields;
    const sections = failed.has('sections')
      ? []
      : extractRawSectionAngles(raw.sections).filter(section => !parts.angles.has(section.angle ?? ''));
    const summary = !failed.has('summary') && typeof raw.summary === 'string' ? raw.summary.trim() : '';
    const resent: Pick<HopFindingKept, HeldEntryList> = {};
    const dropped = this.droppedEntryKeys();
    // Collect every failed key of every list first, so a valid entry sharing a key with a failed
    // entry (another entry of the same out_col, or the same neighbor in the other neighbor list) is
    // owed with it rather than held, whatever the order of the entries.
    for (const list of HELD_ENTRY_LISTS) {
      const value = raw[list];
      if (failed.has(list) || !Array.isArray(value)) continue;
      const failedIndexes = parts.entries.get(list) ?? new Set<number>();
      value.forEach((entry, index) => {
        const key = this.heldEntryKey(list, entry);
        if (failedIndexes.has(index) && key !== null) dropped(list).add(key);
      });
    }
    for (const list of HELD_ENTRY_LISTS) {
      const value = raw[list];
      if (failed.has(list) || !Array.isArray(value)) continue;
      const failedIndexes = parts.entries.get(list) ?? new Set<number>();
      const valid = value.filter((entry, index) => {
        const key = this.heldEntryKey(list, entry);
        return !failedIndexes.has(index) && key !== null && !dropped(list).has(key);
      }).map(entry => structuredClone(entry));
      // A list whose every entry failed resends nothing: it neither clears nor names a held entry.
      if (valid.length > 0 || value.length === 0) Object.assign(resent, { [list]: valid });
    }
    const prior = this.heldFindingDraft.get();
    const held = prior !== null && (resolveModelNodeId(prior.focus_node_id, this.nodeMap, this.model.identifierCaseSensitive) ?? this.identifierKey(prior.focus_node_id)) === focus
      ? prior
      : null;
    const priorFailed = held ? this.heldFindingDraft.getAuthorization()?.failed ?? [] : [];
    const restorable = (field: string): boolean => held !== null && !priorFailed.includes(field);
    const draft: HopFindingKept = {
      ...(held ?? {}),
      focus_node_id: raw.focus_node_id,
      verdict: raw.verdict,
      sections: held
        ? RepairDraftStore.mergeByKey(held.sections.filter(section => !parts.angles.has(section.angle ?? '')), sections, section => section.angle ?? '')
        : sections,
      summary: summary || (held?.summary ?? ''),
    };
    for (const field of HELD_WHOLE_FIELDS) {
      const value = raw[field];
      if (!failed.has(field) && value !== undefined && value !== null) Object.assign(draft, { [field]: structuredClone(value) });
      else if (!restorable(field)) delete draft[field];
    }
    for (const list of HELD_ENTRY_LISTS) {
      if (failed.has(list)) continue;
      const merged = this.mergeHeldEntries(list, restorable(list) ? held?.[list] : undefined, resent, dropped(list)) as unknown[] | undefined;
      if (merged !== undefined && (merged.length > 0 || this.explicitEmptyFlow(list, resent))) Object.assign(draft, { [list]: merged });
      else delete draft[list];
    }
    const restored = HELD_CARRIED_FIELDS.filter(field => draft[field] !== undefined && !failed.has(field));
    if (draft.sections.length === 0 && !draft.summary.trim() && restored.length === 0) return null;
    this.holdFinding(draft, [...failed]);
    return this.heldParts(draft, [...failed]);
  }

  /**
   * Per-list sets of entry keys a rejection owes a correction for. The two neighbor lists share one
   * set, since a neighbor's correction may move it between them; `column_flow` keys are its own.
   */
  private droppedEntryKeys(): (list: HeldEntryList) => Set<string> {
    const neighbors = new Set<string>();
    const flow = new Set<string>();
    return list => (list === 'column_flow' ? flow : neighbors);
  }

  /** Whether a held list resolves to a sent `column_flow: []`, which is held as "this node carries no tracked column". */
  private explicitEmptyFlow(list: HeldEntryList, resent: Pick<HopFindingKept, HeldEntryList>): boolean {
    return list === 'column_flow' && resent.column_flow?.length === 0;
  }

  /**
   * Holds a finding the engine rejected, minus the parts the rejection's issue paths name
   * ({@link splitFailedParts}): a failed section angle is removed from the held draft, a failed
   * list entry is removed with every held entry of the same key (a `column_flow` out_col, or a
   * neighbor in either neighbor list), since the correction for that key is still owed; a list left
   * empty that way is not held. A whole failed field is held but marked failed so a retry never
   * restores it.
   */
  private holdValidParts(finding: HopFindingKept, issuePaths: readonly string[]): void {
    const parts = splitFailedParts(issuePaths);
    const draft: HopFindingKept = { ...finding, sections: finding.sections.filter(section => !parts.angles.has(section.angle ?? '')) };
    const dropped = this.droppedEntryKeys();
    for (const [list, failedIndexes] of parts.entries) {
      ((draft[list] ?? []) as unknown[]).forEach((entry, index) => {
        const key = this.heldEntryKey(list, entry);
        if (failedIndexes.has(index) && key !== null) dropped(list).add(key);
      });
    }
    for (const list of HELD_ENTRY_LISTS) {
      const failedIndexes = parts.entries.get(list) ?? new Set<number>();
      const value = draft[list] as unknown[] | undefined;
      if (!value || (failedIndexes.size === 0 && dropped(list).size === 0)) continue;
      const kept = value.filter((entry, index) => !failedIndexes.has(index) && !dropped(list).has(this.heldEntryKey(list, entry) ?? ''));
      if (kept.length === value.length) continue;
      if (kept.length > 0) Object.assign(draft, { [list]: kept });
      else delete draft[list];
    }
    this.holdFinding(draft, [...parts.fields]);
  }

  /** Holds repair content under the exact dispatched contract that authorized it. */
  private holdFinding(finding: HopFindingKept, failed: readonly string[]): void {
    if (!this.currentFocusNodeId) return;
    this.heldFindingDraft.hold(structuredClone(finding), { failed: failed.filter(Boolean), focusId: this.currentFocusNodeId, hop: this.hopCount, mode: this.currentHopAnalysisMode });
  }

  /** The restorable parts of a held draft, as a rejection names them to the model. */
  private heldParts(held: HopFindingKept, failed: readonly string[]): HeldSubmissionParts {
    const fields = HELD_CARRIED_FIELDS.filter(field => held[field] !== undefined && !failed.includes(field));
    const entries: { questions?: string[]; prune_neighbors?: string[]; column_flow?: string[] } = {};
    for (const list of HELD_ENTRY_LISTS) {
      if (!(fields as readonly string[]).includes(list)) continue;
      const labels = new Map<string, string>();
      for (const entry of (held[list] ?? []) as unknown[]) {
        const key = this.heldEntryKey(list, entry);
        if (key !== null && !labels.has(key)) labels.set(key, list === 'column_flow' ? this.columnFlowEntryLabel(entry as ColumnFlowEntry) : key);
      }
      if (labels.size > 0) entries[list] = [...labels.values()];
    }
    return {
      sections: held.sections.map(section => section.angle ?? ''),
      summary: held.summary.trim().length > 0,
      fields,
      ...(Object.keys(entries).length > 0 ? { entries } : {}),
    };
  }

  /** A held `column_flow` entry as a rejection names it: its `out_col` as authored, with its `returns_to` target when named. */
  private columnFlowEntryLabel(entry: ColumnFlowEntry): string {
    return entry.returns_to ? `${entry.out_col} -> ${entry.returns_to.node}.${entry.returns_to.col}` : entry.out_col;
  }

  /** The parts a draft already held for the current focus still restores, unchanged; `null` when none is held. */
  private heldPartsOfCurrentFocus(): HeldSubmissionParts | null {
    const held = this.heldFindingDraft.get();
    if (held === null || (resolveModelNodeId(held.focus_node_id, this.nodeMap, this.model.identifierCaseSensitive) ?? this.identifierKey(held.focus_node_id)) !== this.currentFocusNodeId) return null;
    return this.heldParts(held, this.heldFindingDraft.getAuthorization()?.failed ?? []);
  }

  /** Projection of unresolved scope-boundary leads for synthesis. */
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

  /**
   * Neighbours removed by a resolved AI prune, each with the sender's own reason — follow-up
   * material for the completed chat, not report content.
   */
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

  /**
   * Records a deferred route — the sole entry point for mutating the bucket.
   *
   * @remarks
   * Deduplicates on `(nodeId, fromFocusNodeId)`: a later deferral for the same pair replaces the
   * earlier one. Also records a rejection in memory so `recent_rejections` reflects the same event.
   */
  protected deferQuestion(entry: DeferredQuestion, legs: ReadonlyArray<ContinuationLeg> = []): void {
    this.recordPendingLead(entry, legs);
    this.memory.recordRejection(entry.nodeId, `deferred: out of approved scope (${entry.reason})`, entry.atHop);
  }

  /**
   * Records the structured task and lead corresponding to an accepted scope-boundary deferral.
   *
   * @remarks
   * Each deferral reason maps to its `PendingLead['reason']` through {@link LEAD_REASON_BY_DEFERRAL}.
   */
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

  /**
   * Records one sender's prune reason as a `pending` `pruned_by_ai` lead, re-arming one an earlier
   * vote left dismissed. A vote that keeps the node, its dispatch or its return to the graph
   * dismisses the lead.
   *
   * @param nodeId - Resolved neighbour the sender voted to prune.
   * @param fromNodeId - The sender focus.
   * @param reason - The sender's `prune_neighbors[].reason`, verbatim.
   */
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

  /**
   * Applies the mode's task shape to one set of common task fields.
   *
   * @remarks
   * The single home for the CT/BB task fork: a CT task is `column_lineage` carrying the columns the
   * hop tracks, a BB task is the plain kind with no column state.
   *
   * @param preferredColumns - Columns this task tracks; an empty list creates an object task.
   */
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

  /**
   * Creates a structurally mode-valid deferred task without changing agenda state.
   *
   * @remarks
   * A deferred continuation keeps the qualified leg that arrived for it, so a later follow-up
   * resumes from those exact endpoints; without a leg the task is an object task.
   */
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
    const id = resolveModelNodeId(nodeId, this.nodeMap, this.model.identifierCaseSensitive) ?? this.identifierKey(nodeId);
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

  /**
   * Whether `carrierId` is a node the engine already passed through whose walk in the traversal
   * direction leads to `focusId` — the routed non-bodied carrier contracted into this focus.
   *
   * @remarks
   * Mirrors the contraction walk in {@link enqueueHop} (a passed-through carrier forwards to its
   * {@link directionalNeighbors}), so the carrier that produced this hop sits on the answer path
   * like a visited node, and a prune of it from this focus is a no-op.
   */
  private isCarrierInto(carrierId: string, focusId: string): boolean {
    return this.nodeStates.get(carrierId)?.action === 'passthrough'
      && this.directionalNeighbors(carrierId, this._direction).includes(focusId);
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

  /**
   * Continuation questions carried on the dequeued {@link AgendaEntry} for the hop currently in
   * flight — set at dispatch in {@link getHopContext}, from that entry's own `lineageQuestions`,
   * never from whichever node happened to commit most recently. Both the live per-hop worker message
   * and {@link toJSON} read this, so the state dump records the questions the hop was dispatched with.
   */
  public get pendingLineageQuestions(): string[] {
    return this._pendingLineageQuestions;
  }

  /**
   * Returns every captured detail slot in insertion order.
   *
   * @remarks
   * Mirrors `getResult().detail_slots` but is callable mid-exploration. Slot count equals the
   * number of nodes that produced at least one `submit_findings.sections[]` entry.
   */
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

  /**
   * Engine code for a CT target list that names objects instead of columns, emitted by the
   * CT-target adoption site {@link init}.
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
    return columns.filter((column) => resolveModelNodeId(column, this.nodeMap, this.model.identifierCaseSensitive) !== null);
  }

  /**
   * Reject envelope for a CT target list containing object references. Verb-led, with both
   * legitimate alternatives built in so the model never has to guess: BB for the object, real
   * columns for CT.
   */
  private rejectNodeRefColumnTargets(nodeRefs: string[]): ToolRejection {
    return makeRejection({
      code: NavigationEngine.TARGET_COLUMNS_NAME_OBJECTS,
      hint: `targetColumns [${nodeRefs.join(', ')}] resolve to objects in the loaded model, not columns. To trace an object, resend without targetColumns and analysisMode "bb". To trace columns, name the user-named columns of the origin instead.`,
    });
  }

  /**
   * Matches requested CT column strings against a node's declared columns (case/bracket-insensitive
   * exact name or dotted-suffix). When the node exposes no column metadata, every requested entry
   * is accepted as a bare, deduped name — procedures/functions may write columns elsewhere, so
   * absence of local columns is not proof that the target is absent there, and `unmatched` stays
   * empty in that case. `unmatched` is populated only when the node *does* declare columns and a
   * requested entry matches none of them — the signal a fresh CT origin uses to reject a foreign
   * column instead of silently dropping it.
   */
  private matchColumnsToNode(nodeId: string, columns: string[]): { resolved: string[]; unmatched: string[] } {
    const nodeColumns = getNodeColumns(nodeId, this.nodeMap, this.store ?? undefined) ?? [];
    if (nodeColumns.length === 0) {
      const bare: string[] = [];
      const seen = new Set<string>();
      for (const requested of columns) {
        const name = stripBrackets(splitSqlName(requested).pop() ?? requested).trim();
        const key = this.columnKey(name);
        if (name.length === 0 || seen.has(key)) continue;
        seen.add(key);
        bare.push(name);
      }
      return { resolved: bare, unmatched: [] };
    }
    const byNorm = new Map<string, string>(nodeColumns.map((c) => [this.columnKey(c.name), c.name]));
    const resolved: string[] = [];
    const unmatched: string[] = [];
    for (const requested of columns) {
      const exact = byNorm.get(this.columnKey(requested));
      const lastSegment = requested.split('.').pop() ?? requested;
      const suffix = exact === undefined ? byNorm.get(this.columnKey(lastSegment)) : undefined;
      const match = exact ?? suffix;
      if (match !== undefined) {
        if (!resolved.includes(match)) resolved.push(match);
      } else {
        unmatched.push(requested);
      }
    }
    return { resolved, unmatched };
  }

  /**
   * Names a requested CT target explicitly qualified to a *different* loaded node
   * (`Table.Column`, `[schema].[Table].[Column]`, …) — proof the model itself named another
   * object, not merely a bare name that happens to also appear elsewhere. Used only by the
   * fresh/refine CT origin validation in {@link init}; a bare, unqualified name keeps
   * {@link matchColumnsToNode}'s charitable bare-acceptance for a column-metadata-less origin
   * untouched — a procedure may legitimately write out a column declared on a table it reads.
   * A qualifier the origin itself satisfies (its name, and its schema when one is given) is never
   * foreign, even when another schema holds a same-named object.
   */
  private explicitlyForeignColumns(originNodeId: string, requested: readonly string[]): string[] {
    const origin = this.nodeMap.get(originNodeId);
    const foreign: string[] = [];
    for (const raw of requested) {
      const parts = splitSqlName(raw).map((part) => stripBrackets(part).trim()).filter((part) => part.length > 0);
      if (parts.length < 2) continue;
      const qualifier = this.columnKey(parts[parts.length - 2]);
      const schemaQualifier = parts.length >= 3 ? this.columnKey(parts[parts.length - 3]) : null;
      const names = (node: LineageNode): boolean => this.columnKey(node.name) === qualifier
        && (schemaQualifier === null || this.columnKey(node.schema) === schemaQualifier);
      if (origin && names(origin)) continue;
      for (const [otherId, node] of this.nodeMap) {
        if (otherId === originNodeId) continue;
        if (names(node)) {
          foreign.push(raw);
          break;
        }
      }
    }
    return foreign;
  }

  /**
   * Bounds CT active columns to the focus node's declared columns when the node has a column
   * surface. Used for mid-trace narrowing (a downstream node may carry only some tracked columns);
   * never for validating a fresh CT origin's requested columns — that needs {@link matchColumnsToNode}'s
   * `unmatched` list, since silently dropping a foreign column here would be the same defect this
   * method exists to avoid at the boundary.
   */
  private resolveActiveColumnsForNode(nodeId: string, columns?: string[]): string[] | undefined {
    if (!columns) return undefined;
    if (columns.length === 0) return [];
    return this.matchColumnsToNode(nodeId, columns).resolved;
  }

  /** The requested output columns on the origin, resolved to its declared names: the roots every committed column edge must attach to. */
  private columnRoots(): Array<{ node: string; col: string }> {
    const origin = this.originNodeId;
    return origin && this.tracer ? this.matchColumnsToNode(origin, this.tracer.targetColumns).resolved.map(col => ({ node: origin, col })) : [];
  }

  /** The approved column-closure direction of the session: one traversal direction, or both. */
  private columnClosureDirection(): 'upstream' | 'downstream' | 'both' {
    const direction = this.effectiveDirection();
    return direction === 'bidirectional' ? 'both' : direction;
  }

  /**
   * The qualified (node, column) identities a column task continues from.
   *
   * @remarks
   * A non-root task carries its own `sourceRefs` or scalar `returnTargets`, set from the committed
   * edge or carry that created it. The root task's only anchor is the origin with its explicitly
   * requested target columns. Nothing is recovered from task ancestry, historical edges or a
   * column name that merely exists on a node.
   *
   * @param task - The task to read.
   * @returns The qualified endpoints, `[]` for an object task, or `null` for a column task that
   *   carries none — an engine invariant violation that stops the dispatch.
   */
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

  /**
   * The qualified tracked-column identities this hop received, read only from its current tasks
   * ({@link qualifiedTaskRefs}); dispatch refuses a task without them.
   *
   * @param traversalSide - Restricts the result to tasks arriving on that routing leg.
   */
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

  /**
   * Collapses `this._direction` plus a depth side of exactly `0` into the single traversal
   * direction actually approved for later hop growth.
   *
   * @remarks
   * Only narrows a `'bidirectional'` session — a fixed direction already fully restricts. A side
   * of exactly `0` is a permanent exclusion of that direction (not just the initial seed); both
   * sides `0` cannot reach here (rejected at the Zod boundary before `init()`).
   */
  private effectiveDirection(): 'upstream' | 'downstream' | 'bidirectional' {
    if (this._direction !== 'bidirectional') return this._direction;
    return directionFromDepth(this.currentDepthIntent);
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
   * side — breadth-first order guarantees it. The walk stops at an object the exclusion border
   * refuses, exactly as the scope seed does ({@link computeBfsScope}), so a distance is never
   * measured along a path the approved scope does not hold.
   */
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
   * Consolidates the exclusion-set / direction checks every write path shares, axes selected by
   * `purpose` ({@link BorderPurpose}), check order fixed (exclusions → direction). A GUI-hidden
   * schema is a default exclusion, so the exclusion axis is the one schema wall. The schema axis is
   * tested last among the exclusions, so an `excluded` verdict names `schema` only when no
   * user-authored type or node-id exclusion also holds the node.
   *
   * @param purpose - Which write path is asking, fixing the participating axes.
   */
  private checkBorder(nodeId: string, node: LineageNode, purpose: BorderPurpose): BorderVerdict {
    const checkDirection = purpose === 'route' || purpose === 'contraction';

    if (this.excludedTypes.has(node.type.toLowerCase())) return { kind: 'excluded', axis: 'type' };
    if (this.excludedNodeIds.has(this.identifierKey(nodeId))) return { kind: 'excluded', axis: 'node_id' };
    if (this.excludedSchemas.has(this.identifierKey(node.schema))) return { kind: 'excluded', axis: 'schema' };
    if (checkDirection && !this.isReachableInApprovedDirection(nodeId)) return { kind: 'out_of_direction' };
    return { kind: 'in_border' };
  }

  /**
   * Whether an `excluded` border verdict traces to the GUI schema filter (the node's schema is
   * unticked) rather than a user-authored exclusion pattern (`excludeTypes`/`excludeNodeIds`, or a
   * schema the user typed that the GUI did not already hide), so a supplement skip or route
   * deferral can tell the model the `confirm_sm_start` repair.
   */
  private isGuiHiddenSchemaBorder(border: BorderVerdict, node: LineageNode): boolean {
    return border.kind === 'excluded' && border.axis === 'schema' && this.guiHiddenSchemas.has(this.identifierKey(node.schema));
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
      admitted: border.kind === 'in_border' && depthBreach === null,
    };
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

  /**
   * The column facts that narrow this hop's served `column_flow`: the tracked columns when an
   * upstream trace accepts only those as `out_col`, and whether the focus is a procedure (the one
   * node that may name a `writes_to` target). Eligible function neighbors narrow caller-context questions;
   * stored column metadata narrows the admissible `upstream_columns` sources.
   */
  public get hopSubmitColumns(): SubmitFindingsHopColumns {
    const focus = this.currentFocusNodeId ? this.nodeMap.get(this.currentFocusNodeId) : undefined;
    const active = this.tracer?.activeColumns.filter(Boolean) ?? [];
    return {
      outCols: this.columnTraceDirection() === 'upstream' && !this.getCurrentTasks().some(task => task.kind === 'column_lineage' && task.traversalSide === 'downstream') && active.length > 0
        ? this.resolveActiveColumnsForNode(focus?.id ?? '', active) ?? [...active] : null,
      writesTo: focus?.type === 'procedure',
      callerContextNodeIds: focus && this.graph.hasNode(focus.id) && getNodeDdl(focus.id, this.nodeMap, this.store ?? undefined)
        ? this.graph.neighbors(focus.id).filter(id => this.neighborCapabilities(focus.id, id).can_question
          && this.getCurrentTasks().some(task => task.kind === 'column_lineage' && task.nodeId === focus.id
            && task.activeColumns.some(col => resolveFunctionCallerTarget(id, { node: focus.id, col }, this.nodeMap, this.model, this.store)))).sort()
        : [],
      columnSourceNodeIds: focus && this.graph.hasNode(focus.id) ? this.columnSourceNodeIds(focus.id) : [],
      ...(this.currentReturnTargets().length ? { returnTargets: this.currentReturnTargets() } : {}),
    };
  }

  /**
   * Object-graph ids an `upstream_columns` contributor may name at one hop: the focus's neighbors
   * plus the read suppliers of its declared scalar callers. The served `node` enum and the
   * contributor admission both read it, so a column edge never leaves the object graph.
   */
  private columnContributorIds(focusId: string): Set<string> {
    const callers = uniqueScalarReturnTargets([
      ...this.currentReturnTargets(),
      ...this.getCurrentTasks().flatMap(task => task.callerContext ? [{ node: task.callerContext.node, col: task.callerContext.col }] : []),
    ], this.model.identifierCaseSensitive).map(target => target.node);
    const candidates = new Set(this.graph.hasNode(focusId) ? this.graph.neighbors(focusId) : []);
    for (const caller of callers) {
      if (this.graph.hasNode(caller)) for (const supplier of this.graph.inNeighbors(caller)) candidates.add(supplier);
    }
    return candidates;
  }

  /**
   * Metadata-derived `upstream_columns` source ids for one hop: {@link columnContributorIds} kept
   * when stored columns exist or the procedure/external missing-metadata fallback applies and not
   * already pruned — mirroring the engine's contributor admission, so a columnless scalar function
   * is never offered as a column source.
   */
  private columnSourceNodeIds(focusId: string): string[] {
    return [...this.columnContributorIds(focusId)].filter(id => {
      const node = this.nodeMap.get(id);
      if (!node || this.removedSet.has(id)) return false;
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
   * from this object so the count and the tree never diverge. Every in-scope name is listed;
   * `omitted` counts the names past `namesPerType` when a caller bounds the list.
   * `ambiguousObjectNames` is computed from the full {@link nodeMap}, not the proposed scope
   * alone, so a name is flagged even when only one of its colliding schemas is in scope.
   *
   * @param namesPerType - Names listed under each (schema,type) pair; every name by default.
   */
  public getScopeSummary(namesPerType = Number.POSITIVE_INFINITY): ScopeSummary {
    const bySchema: Record<string, { hops: number; scope: number; byType: Record<string, ScopeSummaryLeaf> }> = Object.create(null);
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
      const key = resolveModelNodeId(id, this.nodeMap, this.model.identifierCaseSensitive) ?? id;
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

  /**
   * Groups every excluded object under the first GUI exclusion rule matching it, or under `named`
   * when none does. An object the schema or type filter already removes is left out, so each count
   * states what the rule removes from the selected schemas and types.
   */
  private excludedObjectsByCause(): ScopeExclusions {
    const group = (): ScopeExclusionGroup => ({ count: 0, byType: {} });
    const rules = this.guiExclusionRules.map(rule => ({ pattern: rule.pattern, ...group() }));
    const named = group();
    for (const id of this.excludedNodeIds) {
      const node = this.nodeMap.get(resolveModelNodeId(id, this.nodeMap, this.model.identifierCaseSensitive) ?? id);
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
  private removalSupport(removedBefore: ReadonlySet<string>, removedAfter: ReadonlySet<string>): RemovalAnalysis {
    const analysis = analyzeRemoval(this.graph, {
      originId: this.originNodeId ?? '', scope: this.scopeNodeIds, removedBefore, removedAfter,
      visited: this.visited, currentNodeId: this.currentFocusNodeId ?? undefined, sides: this.allowedNoteSides(),
    });
    if (analysis.rejection || !this.originNodeId || this.supplementNodeIds.size === 0) return analysis;
    const connectedBefore = bfsReachable(this.graph, this.originNodeId, removedBefore, undefined, this.scopeNodeIds);
    const connectedAfter = bfsReachable(this.graph, this.originNodeId, removedAfter, undefined, this.scopeNodeIds);
    for (const id of this.supplementNodeIds) {
      if (!this.visited.has(id)) continue;
      if (connectedBefore.has(id)) analysis.before.add(id);
      if (connectedAfter.has(id)) analysis.after.add(id);
      if (!removedAfter.has(id) && connectedBefore.has(id) && !connectedAfter.has(id)
        && !analysis.disconnectedVisited.includes(id)) analysis.disconnectedVisited.push(id);
    }
    return analysis;
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
    return ids.filter(id => !this.scopeNodeIds.has(this.identifierKey(id)) || !directNeighbors.has(this.identifierKey(id)));
  }

  /**
   * The current hop's sub-questions as archived beside its findings: every non-blank task question
   * in dispatch order. The mission question, carried separately as the original question, is left
   * out in either mode and wherever routing re-sends it. `from_node` names the asking hop only for
   * a model-authored question whose parent task belongs to a visited node; engine-routed text is
   * kept without a sender.
   */
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

    const resolveId = (raw: string): string | null => resolveModelNodeId(raw, this.nodeMap, this.model.identifierCaseSensitive);
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
        hint: "These ids don't exist in the loaded model after bracket/case normalization. Call lineage_search_objects with each user-named identifier to resolve the canonical schema-qualified id, then re-call lineage_start_exploration with the corrected list.",
        detail: { unresolved_excludeNodeIds: excludeIds.unresolved, unresolved_passNodeIds: passIds.unresolved },
      });
    }
    if (excludeIds.resolved.length + passIds.resolved.length > 0) {
      this.log('debug', `[NL] excludeNodeIds resolved=[${trunc(excludeIds.resolved, LOG_TRUNC_LIST)}] passNodeIds resolved=[${trunc(passIds.resolved, LOG_TRUNC_LIST)}]`);
    }

    const resolvedOriginId = resolveModelNodeId(params.origin, this.nodeMap, this.model.identifierCaseSensitive);
    const originNode = resolvedOriginId ? this.nodeMap.get(resolvedOriginId) : null;
    if (!originNode) {
      return makeRejection({
        code: 'origin_not_found',
        hint: 'Verify the origin node id with lineage_search_objects first. Use the exact id it returns.',
      });
    }

    const analysisMode: 'bb' | 'ct' = params.analysisMode ?? ((params.targetColumns?.length ?? 0) > 0 ? 'ct' : 'bb');
    const effectiveTargetColumns = analysisMode === 'ct' ? params.targetColumns : undefined;
    let resolvedActiveColumns: string[] = [];
    if (analysisMode === 'ct' && effectiveTargetColumns && effectiveTargetColumns.length > 0) {
      const nodeRefs = this.nodeRefColumnTargets(effectiveTargetColumns);
      if (nodeRefs.length > 0) {
        this.log('debug', `[AI] [CT] target columns [${trunc(nodeRefs.join(','), 120)}] resolve to objects, not columns — rejecting start`);
        return this.rejectNodeRefColumnTargets(nodeRefs);
      }
      const declared = getNodeColumns(originNode.id, this.nodeMap, this.store ?? undefined) ?? [];
      const { resolved, unmatched } = this.matchColumnsToNode(originNode.id, effectiveTargetColumns);
      const explicitlyForeign = this.explicitlyForeignColumns(originNode.id, effectiveTargetColumns);
      if (resolved.length === 0 || unmatched.length > 0 || explicitlyForeign.length > 0) {
        const declaredNames = declared.map((c) => c.name);
        const offending = unmatched.length > 0 ? unmatched : (explicitlyForeign.length > 0 ? explicitlyForeign : effectiveTargetColumns);
        this.log('debug', `[AI] [CT] requested columns [${effectiveTargetColumns.join(',')}] offending=[${offending.join(',')}] not on origin ${originNode.id} — rejecting (no partial-trace fallback)`);
        return makeRejection({
          code: 'unknown_columns',
          hint: declaredNames.length > 0
            ? `targetColumns [${offending.join(', ')}] are not columns on ${originNode.id}. Its columns are: [${declaredNames.join(', ')}]. Provide valid columns, ask the user to clarify, or switch analysisMode to "bb".`
            : `targetColumns [${offending.join(', ')}] are not columns on ${originNode.id}, which exposes no column metadata of its own. Provide valid columns, ask the user to clarify, or switch analysisMode to "bb".`,
        });
      }
      this.log('debug', `[Admit] guard=ct_target_columns phase=init focus=${originNode.id} active=${resolved.length} — tracing [${resolved.join(', ')}]`);
      resolvedActiveColumns = resolved;
    }

    this.visited.clear();
    this.removedSet.clear();
    this.pruneBallots.clear();
    this.renderDroppedIds.clear();
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
    this._bodiedScopeSize = (breakdown.view ?? 0) + (breakdown.procedure ?? 0) + (breakdown.function ?? 0);
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
      this.log('info', `[BFS-refine] cause=user_refine origin=${originNode.id} dir=${direction} depth=${depthLabel}${excludeNodeIdsLine} → scope=Δ (was=${prevScopeSize} now=${this.scopeNodeIds.size}) (tables=${breakdown.table}, views=${breakdown.view}, procs=${breakdown.procedure}, functions=${breakdown.function}) excludeTypes=[${excludedTypesAnnotated}]${guiHiddenLine}`);
    } else {
      this.log('info', `[BFS] origin=${originNode.id} dir=${direction} depth=${depthLabel} → scope=${this.scopeNodeIds.size} (tables=${breakdown.table}, views=${breakdown.view}, procs=${breakdown.procedure}, functions=${breakdown.function}) excludeTypes=[${excludedTypesAnnotated}]${excludeNodeIdsLine}${guiHiddenLine}`);
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

  /**
   * Nodes physically connected to the traced graph, plus every batch id reachable from it —
   * directly or transitively through another batch id.
   *
   * @remarks
   * Multi-source BFS seeded from `scopeNodeIds ∪ visited` minus `removedSet` — the retained trace,
   * the same support {@link removalSupport} requires of every visited node — and walking
   * only into nodes already seeded or named in `batchIds`. A batch id whose only path back runs
   * through a pruned object or one outside both sets is never discovered here; the pruned case is
   * bridged by {@link prunedConnectorsTo}.
   *
   * @param batchIds - Candidate ids from one `supplement` call, so a chain within the same request
   *   can connect through each other even before any of them is itself admitted.
   * @returns Every seed plus every batch id reachable from a seed or another reachable batch id.
   */
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

  /**
   * Finds follow-up targets that clear the border but have no dependency path to the traced graph.
   *
   * @remarks
   * Unresolvable and excluded ids are left to the caller, which reports them with their own
   * reasons ({@link checkBorder} is the same test). A target is connected when the retained trace
   * reaches it ({@link tracedGraphReachable}) or when pruned connectors bridge it
   * ({@link prunedConnectorsTo}): a target the user names is their decision and wins over the AI's
   * earlier prune, and the connectors on its path come back with it so the render needs no repair.
   * A resolved, non-excluded id with no path even through pruned objects is refused here rather than
   * admitted into a view `present_result`'s closed-graph invariant could never close.
   *
   * @param nodeIds - Follow-up targets, canonical or free-cased.
   * @returns The connected ids (logged), the pruned connectors to restore with them, plus one
   *   {@link SupplementSkip} per unconnected id.
   */
  private admitSupplementTargets(nodeIds: readonly string[]): { admitted: string[]; connectors: string[]; skipped: SupplementSkip[] } {
    const admitted: string[] = [];
    const connectors = new Set<string>();
    const skipped: SupplementSkip[] = [];
    const candidates: Array<{ raw: string; node: LineageNode }> = [];
    for (const raw of nodeIds) {
      const id = resolveModelNodeId(raw, this.nodeMap, this.model.identifierCaseSensitive);
      const node = id ? this.nodeMap.get(id) : undefined;
      if (!node) continue;
      const border = this.checkBorder(node.id, node, 'supplement');
      if (border.kind === 'excluded') continue;
      candidates.push({ raw, node });
    }
    const batchIds = new Set(candidates.map(c => c.node.id));
    const tracedReachable = this.tracedGraphReachable(batchIds);
    for (const { node } of candidates) {
      const bridge = tracedReachable.has(node.id) ? [] : this.prunedConnectorsTo(node.id, batchIds);
      if (!bridge) {
        skipped.push({
          nodeId: node.id,
          reason: REJECTION_CODES.notConnectedToTrace,
          hint: `${node.id} is not connected to this trace; trace it on its own with lineage_start_exploration origin=${node.id}.`,
        });
        this.log('debug', `[Border] supplement refuse hop=${this.hopCount} id=${node.id} reason=${REJECTION_CODES.notConnectedToTrace}`);
        continue;
      }
      for (const id of bridge) connectors.add(id);
      admitted.push(node.id);
    }
    if (admitted.length > 0) this.log('info', `[Border] supplement admit ids=[${admitted.join(',')}]`);
    return { admitted, connectors: [...connectors], skipped };
  }

  /**
   * The pruned objects on the shortest scope-bounded path between a supplement target and the
   * retained trace, or null when no such path exists.
   *
   * @remarks
   * Reuses {@link scopeBoundedPathToOrigin}, along the approved legs first so the target keeps the
   * directed support ordinary exploration requires, else undirected (a follow-up crossing the initial
   * direction); the connectors are the path objects after the last retained one (scope and visited minus `removedSet`). Every connector must clear the border, so a
   * user exclusion stays a wall. Objects named in the same batch are admitted on their own.
   */
  private prunedConnectorsTo(nodeId: string, batchIds: ReadonlySet<string>): string[] | null {
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

  /** Returns pruned connectors to the kept set, so a named target arrives with the path that joins it to the trace. */
  private restoreConnectors(ids: readonly string[]): void {
    const restored = ids.filter(id => this.removedSet.has(id));
    for (const id of restored) this.unprune(id);
    if (restored.length > 0) this.log('info', `[Supplement] restore pruned connector(s) ids=[${restored.join(', ')}] — on the path joining the named target to the trace; state prune → kept`);
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
    this.taskLedger.dismissNodeLeads(id, 'pruned_by_ai');
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
   * The walk stops at an object the border refuses — a user exclusion or the GUI schema filter —
   * so the branch reachable only through it stays out too; the refused object itself is still
   * reported (`admitSupplementTargets` names it `excluded` or `out_of_allowlist`) rather than
   * silently swallowed. Objects already analysed are not re-queued — only the named ids are
   * re-analysed on request.
   *
   * @returns Named ids first, then reached ids in breadth-first order, without duplicates.
   */
  private expandSupplementChain(nodeIds: readonly string[], chain: SupplementChain): string[] {
    const maxDepth = chain.depth === 'all' ? Number.POSITIVE_INFINITY : chain.depth;
    const mode = chain.direction === 'upstream' ? 'inbound' : 'outbound';
    const result: string[] = [...nodeIds];
    const seen = new Set(nodeIds.map(id => this.identifierKey(id)));
    for (const raw of nodeIds) {
      const start = resolveModelNodeId(raw, this.nodeMap, this.model.identifierCaseSensitive);
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

  /**
   * The qualified continuation a follow-up starts from, without inferring new callers or columns.
   *
   * @remarks
   * A selected task keeps its own qualified context. A follow-up named by object continues from
   * the committed endpoints that object owns on the traced spine
   * ({@link ColumnTracer.spineEndpointsFor}); with none it is an object visit, never a column task
   * bound by a requested column name. Established scalar obligations are recovered from the task ledger.
   *
   * @returns The carry and qualified leg, or `null` when a recorded scalar binding no longer resolves.
   */
  private supplementCarryFor(nodeId: string, selectedTask?: InvestigationTask): { carry: ColumnCarry; leg?: ContinuationLeg } | null {
    if (!this.tracer) return { carry: { kind: 'carry', columns: [] } };
    const scalar = this.supplementScalarCarryFor(nodeId, selectedTask);
    if (scalar === 'unbound') return null;
    if (scalar) return { carry: scalar };
    if (selectedTask?.kind === 'column_lineage' && (selectedTask.callerContext || this.qualifiedTaskRefs(selectedTask)?.length)) {
      return { carry: { kind: 'carry', columns: selectedTask.activeColumns } };
    }
    if (selectedTask) return { carry: { kind: 'row_role_only' } };
    const side = this.columnTraceDirection();
    const refs = this.tracer.spineEndpointsFor(nodeId, this.writtenCarrierIds(nodeId), side);
    if (refs.length === 0) return { carry: { kind: 'row_role_only' } };
    return {
      carry: { kind: 'carry', columns: [...new Map(refs.map(ref => [this.columnKey(ref.col), ref.col])).values()] },
      leg: { sourceRefs: refs, traversalSide: side },
    };
  }

  /**
   * Recovers established scalar obligations for a follow-up without inferring new callers.
   *
   * @returns The scalar or row-only carry, `null` when the function has no scalar obligation, or
   *   `'unbound'` when a recorded caller binding no longer resolves in the loaded model.
   */
  private supplementScalarCarryFor(nodeId: string, selectedTask?: InvestigationTask): ColumnCarry | 'unbound' | null {
    if (!this.tracer || this.nodeMap.get(nodeId)?.type !== 'function') return null;
    const targets = uniqueScalarReturnTargets(
      selectedTask?.kind === 'column_lineage' && selectedTask.returnTargets
        ? selectedTask.returnTargets
        : this.taskLedger.investigationTasks.flatMap(task =>
          task.nodeId === nodeId && task.kind === 'column_lineage' ? task.returnTargets ?? [] : []), this.model.identifierCaseSensitive);
    if (targets.length) {
      const outputs = targets.flatMap(target => {
        const bound = this.resolveReturnTarget(nodeId, target);
        return bound && this.scopeNodeIds.has(bound.node) ? [bound] : [];
      });
      return outputs.length === targets.length ? { kind: 'scalar_return', outputs } : 'unbound';
    }
    return getNodeColumns(nodeId, this.nodeMap, this.store ?? undefined)?.length
      ? null
      : { kind: 'row_role_only' };
  }

  /**
   * Extends a completed exploration with additional nodes for analysis.
   *
   * @remarks
   * Only callable when `status === 'complete'`. A prune this run made is not a veto here (see
   * {@link unprune}) — the exclusion sets, a GUI-hidden schema included, remain a hard wall, whether
   * the id is named directly or reached only through a chain walk. Status moves to `awaiting_findings`
   * only when at least one id was agendaed; an all-refused call leaves `status` at `complete` so a
   * fresh {@link NavigationInitParams} proposal is not blocked by a live-engine check.
   *
   * @param leadIds - Host-selected pending leads; never accepted from a model tool payload.
   * @returns Counts for agendaed, contracted, and skipped ids, plus per-node `skippedDetails`
   *   naming which id was dropped and why (`excluded` | `out_of_allowlist` | `unresolved` |
   *   `not_connected_to_trace`, the last two refusals carrying a `hint`), or a structured error. A
   *   partial admit — some ids agendaed, others skipped — is always `{ ok: true, ... }`, never
   *   silent: every skip is named.
   */
  public supplementAgenda(nodeIds: string[], leadIds: string[] = [], chain?: SupplementChain): { ok: true; agendaed: number; contracted: number; skipped: number; skippedDetails: SupplementSkip[] } | ToolRejection {
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

    if (chain) nodeIds = this.expandSupplementChain(nodeIds, chain);
    const requested = [
      ...nodeIds.flatMap(nodeId => {
        const id = resolveModelNodeId(nodeId, this.nodeMap, this.model.identifierCaseSensitive);
        const contexts = this.taskLedger.investigationTasks.filter(task => task.nodeId === id && task.callerContext);
        return contexts.length ? contexts.map(task => ({ nodeId, question: task.question, taskId: task.id as string | undefined, leadId: undefined as string | undefined }))
          : [{ nodeId, question: '', taskId: undefined as string | undefined, leadId: undefined as string | undefined }];
      }),
      ...leadEntries.map(entry => ({ nodeId: entry!.lead.nodeId, question: entry!.task.question, taskId: entry!.task.id, leadId: entry!.lead.id })),
    ];

    const admission = this.admitSupplementTargets(requested.map(request => request.nodeId));
    const unconnectedIds = new Set(admission.skipped.map(skip => this.identifierKey(skip.nodeId)));
    const admittedIds = new Set(admission.admitted);
    // Validate every recovered binding before any target is unpruned or queued.
    const unbound: string[] = [];
    const prepared = requested.map(request => {
      const id = resolveModelNodeId(request.nodeId, this.nodeMap, this.model.identifierCaseSensitive);
      const selectedTask = request.taskId ? this.taskLedger.getTask(request.taskId) : undefined;
      const recovered = id && admittedIds.has(id)
        ? this.supplementCarryFor(id, selectedTask)
        : { carry: { kind: 'row_role_only' } as ColumnCarry, leg: undefined };
      if (!recovered) unbound.push(id!);
      const { carry, leg } = recovered ?? { carry: { kind: 'row_role_only' } as ColumnCarry, leg: undefined };
      const replaceTask = !!selectedTask && (carry.kind === 'row_role_only'
        || (carry.kind === 'scalar_return' && !(selectedTask.kind === 'column_lineage' && selectedTask.returnTargets)));
      return {
        ...request,
        carry,
        leg,
        existingTaskId: replaceTask ? undefined : request.taskId,
        parentTaskId: replaceTask ? request.taskId : undefined,
      };
    });

    if (unbound.length > 0) {
      this.log('debug', `[Supplement] refuse hop=${this.hopCount} ids=[${unbound.join(',')}] reason=scalar_binding_unresolved`);
      return makeRejection({
        code: REJECTION_CODES.routeValidationFailed,
        hint: `The recorded scalar caller binding of ${unbound.join(', ')} no longer resolves in the loaded model, so this follow-up cannot continue it. Nothing was changed; start a new exploration for that function.`,
      });
    }
    this.restoreConnectors(admission.connectors);
    const agendaBefore = this._agenda.length;
    let skipped = admission.skipped.length;
    const skippedDetails: SupplementSkip[] = [...admission.skipped];
    for (const request of prepared) {
      const raw = request.nodeId;
      const id = resolveModelNodeId(raw, this.nodeMap, this.model.identifierCaseSensitive);
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
      if (wasNewToScope) {
        this.scopeNodeIds.add(id);
        const node = this.nodeMap.get(id);
        if (node && SCRIPT_TYPES.has(node.type)) this._bodiedScopeSize++;
      }
      if (wasVisited) this.visited.delete(id);
      const existingDepth = this.depthFromOrigin.get(id);
      const depth = typeof existingDepth === 'number' ? existingDepth : 0;
      if (request.leadId) this.taskLedger.scheduleLead(request.leadId);
      for (const lead of this.taskLedger.pendingLeads) {
        if (lead.status === 'pending' && this.identifierKey(lead.nodeId) === this.identifierKey(id)) this.taskLedger.scheduleLead(lead.id);
      }
      this.enqueueHop(id, request.question, depth, 3, {
        carry: request.carry,
        sourceRefs: request.leg?.sourceRefs,
        traversalSide: request.leg?.traversalSide,
        freshScopeExpansion: wasNewToScope,
        reactivated: wasVisited,
        existingTaskId: request.existingTaskId,
        parentTaskId: request.parentTaskId,
      });
      this.supplementNodeIds.add(id);
    }

    const agendaed = this._agenda.length - agendaBefore;
    const contracted = requested.length - agendaed - skipped;

    if (agendaed > 0) this._status = 'awaiting_findings';

    const modeLabel = this.tracer ? 'sm (ct)' : 'sm';
    this.log('info', `[Supplement] added ${requested.length} requested tasks → agendaed=${agendaed} contracted=${contracted} skipped=${skipped}; mode=${modeLabel}, status=${this._status}`);

    return { ok: true, agendaed, contracted, skipped, skippedDetails };
  }

  /**
   * Gets the details for the next scheduled navigation hop.
   *
   * @remarks
   * CT is selected from this entry's merged demand. A row-only arrival cannot recover
   * columns from another branch's historical evidence.
   */
  public getHopContext(): HopContext {
    let entry: AgendaEntry | undefined;
    while (this._agenda.length > 0) {
      const candidate = this._agenda.dequeue(this.worklistView());
      if (!candidate) break;

      if (this.visited.has(candidate.nodeId)) {
        this.completeTasks(candidate.taskIds);
        continue;
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

      for (const taskId of candidate.taskIds) {
        const task = this.taskLedger.getTask(taskId);
        if (task?.callerContext && (task.parentTaskId !== task.callerContext.callerTaskId || !this.validFunctionCallerContext(candidate.nodeId, task.callerContext))) {
          return this.failInvariant(candidate.nodeId, 'callerContext', CALLER_CONTEXT_CHANGED);
        }
        if (task && this.qualifiedTaskRefs(task) === null) {
          return this.failInvariant(candidate.nodeId, 'sourceRefs', COLUMN_SOURCE_MISSING);
        }
      }
      if (candidate.columnCarry?.kind === 'scalar_return') {
        for (const target of candidate.columnCarry.outputs) {
          if (!this.scopeNodeIds.has(target.node) || !this.resolveReturnTarget(candidate.nodeId, target, candidate.taskIds)) {
            return this.failInvariant(candidate.nodeId, 'columnCarry.outputs', SCALAR_BINDING_CHANGED);
          }
        }
        candidate.activeColumns = [...new Set(candidate.columnCarry.outputs.map(target => target.col))];
      } else if (this.tracer && candidate.columnCarry?.kind !== 'row_role_only' && candidate.activeColumns?.length) {
        candidate.activeColumns = this.columnsForEntry(candidate);
      }

      entry = candidate;
      break;
    }

    if (!entry) {
      this.resolvePendingPrunes(true);
      // A prune refused at run end routes its object: the hop it enqueued is dispatched before the run completes.
      if (this._agenda.length > 0) return this.getHopContext();
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
    const focusTask = this.taskLedger.getTask(entry.taskIds[0]);
    this.currentFocusQuestion = focusTask ? taskPromptText(focusTask) : null;

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
      neighbors: this.buildNeighborList(entry.nodeId),
      working_memory: workingMemory,
    };
  }

  /**
   * Stops the live run on an engine invariant a dispatch or a submission cannot satisfy.
   *
   * @remarks
   * The status becomes `error` with a user-facing reason; the active worker and the coordinator
   * settle it through the incomplete-run path. Nothing is visited or committed and nothing else
   * changes.
   *
   * @param nodeId - Node whose dispatch or submission failed, for the debug line only.
   * @param field - Failing engine field, for the debug line only.
   * @param reason - User-facing reason exposed as {@link errorReason}.
   */
  private failInvariant(nodeId: string, field: string, reason: string): HopContext {
    this.log('error', `[Invariant] dispatch refused field=${field} hop=${this.hopCount + 1} — engine stopped`);
    this.log('debug', `[Invariant] dispatch refused node=${nodeId} field=${field}`);
    this._status = 'error';
    this._errorReason = reason;
    return { done: false, sm_status: 'error' };
  }

  /**
   * Unvisited, un-queued, un-removed directional neighbors of `focusId` that the router would
   * currently admit a route to — the open neighbours a kept submit enqueues unless it prunes them,
   * in both modes.
   *
   * @remarks
   * Single source for that set: the submit path and the per-hop envelope render both read it, so
   * the rendered list can never drift from what the engine enqueues. No prior
   * {@link scopeNodeIds} membership is required — a route the router would accept commits the
   * neighbor into scope itself, so "in scope" is an outcome of routing here, never a precondition.
   * The set is budget-blind: the scope budget is checked only at admission (proposal, scope change,
   * supplement), never per route.
   *
   * @returns Directional neighbor ids that must be routed or accounted for before the walk advances.
   */
  private requiredNeighborIds(focusId: string): string[] {
    return Array.from(this.directionalNeighbors(focusId, this._direction))
      .filter(nid => !this.visited.has(nid) && !this._agenda.has(nid) && !this.removedSet.has(nid))
      .filter(nid => {
        const node = this.nodeMap.get(nid);
        return node !== undefined && this.admitsRoute(nid, node, focusId).admitted;
      });
  }

  /**
   * Unvisited, un-queued, un-removed directional neighbours of `focusId` that sit inside the
   * exclusion, direction and schema borders but past a user-stated depth ceiling — the open
   * neighbours a submit defers as follow-ups rather than enqueues.
   *
   * @param focusId - The hop the neighbours hang off.
   * @returns Neighbour ids {@link requiredNeighborIds} leaves out only because the depth border defers them.
   */
  private borderDeferredNeighborIds(focusId: string): string[] {
    return Array.from(this.directionalNeighbors(focusId, this._direction))
      .filter(nid => !this.visited.has(nid) && !this._agenda.has(nid) && !this.removedSet.has(nid))
      .filter(nid => {
        const node = this.nodeMap.get(nid);
        if (node === undefined) return false;
        const admission = this.admitsRoute(nid, node, focusId);
        if (admission.admitted) return false;
        return admission.border.kind === 'in_border' && admission.depthBreach !== null;
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
      neighbors: this.buildNeighborList(focusId),
      current_task: this.currentFocusQuestion ?? this._lastCurrentTask ?? undefined,
    };
  }

  /**
   * Processes the findings from a completed hop and adjusts the agenda.
   *
   * @remarks
   * Neighbour decisions, both modes: a kept verdict (`analyze`/`passthrough`) enqueues every open,
   * admitted neighbour the payload did not name in `prune_neighbors`, and `questions` attach a
   * check to one neighbour's queued hop; pruned neighbours and what only they reach are cut
   * ({@link cutUnreachable}). In CT the carry each
   * neighbour is enqueued with is derived from this submit's own `column_flow`.
   *
   * The round and starting-column limits are checked only at admission (proposal, scope change,
   * supplement), against the same full-reach preview this hop loop then walks — nothing here stops
   * or defers a route for scope size once the run is approved.
   */
  public submitFindings(params: HopSubmission): SubmitResult {
    if (this._status === 'complete') {
      return makeRejection({
        code: REJECTION_CODES.explorationComplete,
        hint: 'Hop loop is closed - every scope node has been analyzed and the archive is sealed. Call lineage_present_result to assemble the final report from the archive. Do not retry submit_findings.',
        detail: { next_action: 'present_result' },
      });
    }
    if (this._status !== 'awaiting_findings') {
      return makeRejection({
        code: REJECTION_CODES.invalidStatus,
        reason: `Findings arrived while the engine is in status '${this._status}', not 'awaiting_findings'.`,
        detail: { current_status: this._status },
      });
    }

    // The focus is checked before any held merge: a retry naming another object is told so, and the
    // draft held for the current object stays untouched.
    const rawFocusId = params.focus_node_id;
    const focusId = resolveModelNodeId(rawFocusId, this.nodeMap, this.model.identifierCaseSensitive) ?? (rawFocusId === undefined ? undefined : this.identifierKey(rawFocusId));
    if (!focusId || !this.nodeMap.has(focusId)) {
      return makeRejection({
        code: REJECTION_CODES.invalidInput,
        reason: `focus_node_id \`${rawFocusId ?? ''}\` not found in the loaded model.`,
        hint: activeSubmitFindingsRecoveryHint(this.currentFocusNodeId ?? undefined),
      });
    }
    if (focusId !== this.currentFocusNodeId) {
      const expected = this.currentFocusNodeId ?? '';
      return makeRejection({
        code: REJECTION_CODES.focusNodeIdMismatch,
        reason: `focus_node_id names \`${focusId}\`; the current object is \`${expected}\`.`,
        hint: `Resend the same call with focus_node_id \`${expected}\`.`,
        issuePaths: ['focus_node_id'],
        detail: { expected, got: focusId },
      });
    }

    const submitted = params;
    const archivedAngles = this.memory.getArchivedAngles(focusId);
    // A retry keeps the held, already admitted flow entries of every out_col it does not resend; the
    // merged flow is then validated as strictly as a fresh call. The resent entries lead, so a
    // rejection's `column_flow.<i>` path names the entry the model sent.
    if (this.heldColumnFlow) {
      const heldFlow = structuredClone(this.heldFindingDraft.get()!.column_flow);
      params = { ...params, column_flow: this.mergeHeldEntries('column_flow', heldFlow, params, new Set(), true) };
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
      const stagedCtNodeStates: ValidatedHop['stagedCtNodeStates'] = [];
      const stagedColumnFlowEntries = this.tracer
        ? finding.column_flow?.length ?? 0
        : 0;
      const traceDirection = this.columnTraceDirection();
      const carryByNode = new Map<string, Set<string>>();
      const routeContexts: ValidatedHop['routeContexts'] = new Map();
      const flowQuestionByNode = new Map<string, string>();
      const addCarry = (nid: string, ref: ScalarReturnTarget, traversalSide: 'upstream' | 'downstream'): void => {
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
      const downstreamRefs = mixedSides ? this.incomingColumnRefs('downstream') : incomingRefs;
      let entrySides: Array<{ index: number; upstream: boolean; downstream: boolean }> | undefined;
      if (this.tracer && (finding.column_flow || this.currentReturnTargets().length)) {
        const validated = this.tracer.validateColumnFlow(focusId, finding, this.nodeMap, this.model, this.store ?? null, this.log, this.removedSet, traceDirection, mixedSides ? this.incomingColumnRefs('upstream') : incomingRefs, this.currentReturnTargets(), this.getCurrentTasks().flatMap(task => task.callerContext && task.nodeId && this.validFunctionCallerContext(task.nodeId, task.callerContext) ? [{ node: task.callerContext.node, col: task.callerContext.col }] : []), mixedSides ? downstreamRefs : [], this.columnRoots(), this.columnContributorIds(focusId));
        invalidRoutes.push(...validated.invalidRoutes);
        entrySides = validated.entrySides;
        for (const edge of validated.stagedEdges) edge.hop = this.hopCount;
        stagedColumnEdges.push(...validated.stagedEdges);
      }
      if (this.tracer && finding.column_flow) {
        // A column is carried only when the one closure of the requested outputs holds it.
        const key = columnEndpointKeyFactory(this.nodeMap, this.model.identifierCaseSensitive);
        const closureEdges = [...this.tracer.edges, ...stagedColumnEdges];
        const attachedUpstream = columnClosure(this.columnRoots(), closureEdges, 'upstream', key);
        const flowingDownstream = columnAttachment(this.columnRoots(), closureEdges, 'downstream', key).flowing;
        if (traceDirection === 'upstream') {
          for (const [index, entry] of finding.column_flow.entries()) {
            if (entrySides && !entrySides.some(side => side.index === index && side.upstream)) continue;
            for (const ref of entry.upstream_columns) {
              const nid = resolveModelNodeId(ref.node, this.nodeMap, this.model.identifierCaseSensitive) ?? this.identifierKey(ref.node);
              if (!attachedUpstream.has(key(nid, ref.col))) continue;
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
          const links = stagedColumnEdges.map(edge => ({ from: key(edge.from_node, edge.from_col), to: key(edge.to_node, edge.to_col) }));
          const outputs = new Map<string, { node: string; col: string }>();
          const terminalColumns = new Set<string>();
          for (const [index, entry] of finding.column_flow.entries()) {
            if (entrySides && !entrySides.some(side => side.index === index && side.downstream)) continue;
            if (focusId !== this.originNodeId && entry.upstream_columns.length === 0) {
              terminalColumns.add(this.columnKey(entry.out_col));
              continue;
            }
            const resolved = resolveColumnFlowTarget(entry, focusId, this.nodeMap, this.model.identifierCaseSensitive);
            if (!resolved) continue;
            const output = { node: resolved.attributionTo, col: resolved.attributionCol };
            const outputKey = key(output.node, output.col);
            if (flowingDownstream.has(outputKey)) {
              outputs.set(outputKey, output);
              const writer = resolved.writerEdge;
              if (writer && stagedColumnEdges.some(edge => edge.from_node === focusId
                && this.columnKey(edge.from_col) === this.columnKey(entry.out_col)
                && edge.to_node === writer.toNode && this.columnKey(edge.to_col) === this.columnKey(writer.toCol))) {
                const localOutput = { node: focusId, col: entry.out_col };
                if (flowingDownstream.has(key(localOutput.node, localOutput.col))) outputs.set(key(localOutput.node, localOutput.col), localOutput);
              }
            }
          }
          const mappedInputs = new Set(links.map(link => link.from));
          for (const ref of downstreamRefs) {
            const endpoint = key(ref.node, ref.col);
            if (!mappedInputs.has(endpoint) && !terminalColumns.has(this.columnKey(ref.col)) && flowingDownstream.has(endpoint)) {
              outputs.set(endpoint, ref);
            }
          }
          const continuation = [...outputs.values()];
          for (const nid of this.graph.outNeighbors(focusId)) {
            if (!this.onDownstreamSide(nid)) continue;
            for (const ref of continuation) addCarry(nid, ref, 'downstream');
            if (continuation.length > 0) {
              flowQuestionByNode.set(nid, `Trace downstream use of ${continuation.map(ref => `${ref.node}.${ref.col}`).join(', ')} in ${nid}; record any output mapping from its SQL.`);
            }
          }
        }
      }

      const pruneTargets = (finding.prune_neighbors ?? []).map((prune, index) => ({
        raw: prune.id,
        resolved: resolveModelNodeId(prune.id, this.nodeMap, this.model.identifierCaseSensitive),
        path: `prune_neighbors.${index}.id`,
      }));
      const pruneNeighborIds = new Set(pruneTargets.map(t => t.resolved ?? this.identifierKey(t.raw)));

      const routeRequests: ValidatedHop['routeRequests'] = [];
      const requested = new Set<string>();
      const unresolvedQuestions: string[] = [];
      const focusNeighborIds = this.graph.hasNode(focusId) ? new Set(this.graph.neighbors(focusId)) : new Set<string>();
      (finding.questions ?? []).forEach((q, index) => {
        const nid = resolveModelNodeId(q.nodeId, this.nodeMap, this.model.identifierCaseSensitive);
        if (!nid) {
          unresolvedQuestions.push(q.nodeId);
          return;
        }
        if (!focusNeighborIds.has(nid)) {
          invalidRoutes.push({
            kind: 'question_not_neighbor',
            id: nid,
            path: `questions.${index}.nodeId`,
            reason: `\`${nid}\` is not a neighbor of the focus \`${focusId}\`.`,
          });
          return;
        }
        if (this.visited.has(nid) || this.removedSet.has(nid)) {
          invalidRoutes.push({ kind: 'question_closed', id: nid, path: `questions.${index}.nodeId`,
            reason: `\`${nid}\` is already ${this.removedSet.has(nid) ? 'pruned' : 'visited'} and cannot receive another investigation in this run.`,
            available_routes: [...focusNeighborIds].filter(id => this.neighborCapabilities(focusId, id).can_question),
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
              .flatMap(task => task.activeColumns))];
            invalidRoutes.push({ kind: 'bad_caller_context', id: nid, path: `questions.${index}.caller_context`,
              reason: `caller_context must name an active real output of the current caller, which reads this loaded function.${activeOutputs.length > 0 ? ` Active outputs of \`${focusId}\`: ${activeOutputs.join(', ')}.` : ''}` });
            return;
          }
          callerContext = { ...target, callerTaskId: callerTask.id, ddlHash: functionCallerDdlHash(ddl) };
        }
        requested.add(nid);
        routeRequests.push({ nodeId: nid, question: q.question, ...(callerContext ? { callerContext } : {}) });
      });
      for (const [nid, question] of flowQuestionByNode) {
        if (requested.has(nid) || pruneNeighborIds.has(nid) || !this.nodeMap.has(nid) || this.visited.has(nid) || this.removedSet.has(nid)) continue;
        requested.add(nid);
        routeRequests.push({ nodeId: nid, question });
      }
      // A queued function may owe a second caller even though no new traversal is required.
      for (const nid of focusNeighborIds) {
        if (!this._agenda.has(nid) || requested.has(nid) || pruneNeighborIds.has(nid)) continue;
        if (this.neighborCarryFor(nid, carryByNode).kind !== 'scalar_return') continue;
        requested.add(nid);
        routeRequests.push({ nodeId: nid, question: '' });
      }
      for (const nid of this.requiredNeighborIds(focusId)) {
        if (requested.has(nid) || pruneNeighborIds.has(nid)) continue;
        requested.add(nid);
        routeRequests.push({ nodeId: nid, question: '' });
        this.log('debug', `[Agenda] open neighbor hop=${this.hopCount} focus=${focusId} id=${nid} — routed, not pruned`);
      }
      for (const nid of this.borderDeferredNeighborIds(focusId)) {
        if (requested.has(nid) || pruneNeighborIds.has(nid)) continue;
        requested.add(nid);
        routeRequests.push({ nodeId: nid, question: '' });
      }
      const outOfScopePruneIds = new Set<string>();
      for (const target of pruneTargets) {
        if (!target.resolved || target.resolved === this.originNodeId) continue;
        const targetNode = this.nodeMap.get(target.resolved);
        if (!targetNode) continue;
        const { border, depthBreach } = this.admitsRoute(target.resolved, targetNode, focusId);
        if (border.kind === 'excluded' || border.kind === 'out_of_direction'
          || depthBreach !== null) {
          outOfScopePruneIds.add(target.resolved);
          invalidRoutes.push({
            kind: 'prune_noop_out_of_scope',
            id: target.resolved,
            path: target.path,
            reason: `\`${target.resolved}\` is outside the approved scope and was never loaded into the graph — there is nothing to prune.`,
          });
        }
      }
      const actionPolicy = evaluateCurrentHopActionPolicy({
        originId: this.originNodeId!,
        pruneTargets: pruneTargets.filter(t => !t.resolved || !outOfScopePruneIds.has(t.resolved)),
        visitedIds: new Set([
          ...this.visited,
          ...pruneTargets.flatMap(t => t.resolved && this.isCarrierInto(t.resolved, focusId) ? [t.resolved] : []),
        ]),
        removedIds: this.removedSet,
        notedIds: new Set(this.memory.notedNodeIds),
        agendaIds: new Set(this._agenda.entries.map(entry => entry.nodeId)),
      });

      for (const req of routeRequests) {
        const nid = req.nodeId;
        const nNode = this.nodeMap.get(nid);
        if (!nNode) continue;
        const admission = this.admitsRoute(nid, nNode, focusId);
        const routeBorder = admission.border;
        if (routeBorder.kind === 'excluded') {
          const isAllowlistBoundary = this.isGuiHiddenSchemaBorder(routeBorder, nNode);
          const deferReason = isAllowlistBoundary ? 'schema' as const : 'excluded' as const;
          routeOutcomes.push({ nodeId: nNode.id, accepted: false, deferred: true, reason: deferReason });
          deferredRoutes.push({
            nodeId: nNode.id,
            schema: nNode.schema,
            question: req.question,
            reason: deferReason,
            depth: isAllowlistBoundary ? admission.depthBreach ?? undefined : undefined,
          });
          this.log('debug', `[Agenda] route ignore hop=${this.hopCount} id=${nNode.id} ← ${focusId} reason=${deferReason}`);
          continue;
        }
        if (routeBorder.kind === 'out_of_direction') {
          routeOutcomes.push({ nodeId: nNode.id, accepted: false, deferred: true, reason: 'out_of_direction' });
          deferredRoutes.push({ nodeId: nNode.id, schema: nNode.schema, question: req.question, reason: 'direction', depth: undefined });
          this.log('debug', `[Agenda] route ignore hop=${this.hopCount} id=${nNode.id} ← ${focusId} reason=out_of_direction direction=${this._direction}`);
          continue;
        }

        const { depthBreach } = admission;
        if (depthBreach !== null) {
          deferredRoutes.push({
            nodeId: nNode.id,
            schema: nNode.schema,
            question: req.question,
            reason: 'depth',
            depth: depthBreach,
          });
          routeOutcomes.push({ nodeId: nNode.id, accepted: false, deferred: true, reason: 'depth' });
          this.log(
            'debug',
            `[Depth] border reached hop=${this.hopCount} id=${nNode.id} ← ${focusId} `
            + `depth=${depthBreach} cap=up:${this.depthLimits.upstream}/down:${this.depthLimits.downstream}`,
          );
          continue;
        }

        acceptedNids.add(nid);
        routeOutcomes.push({ nodeId: nNode.id, accepted: true });
        if (!this.scopeNodeIds.has(nid)) scopeAddNids.add(nid);
        this.log('debug', `[Agenda] route accept hop=${this.hopCount} id=${nNode.id} ← ${focusId} subq=${trunc(req.question, 80)}`);
      }
      for (const nid of actionPolicy.acceptedPruneIds) {
        prunedNeighborNids.add(nid);
      }

      const stagedSections: ValidatedHop['stagedSections'] = finding.sections ?? [];
      const stagedDetailChars = stagedSections.reduce((sum, s) => sum + (s.text?.length ?? 0), 0);
      const stagedSummaryChars = finding.summary?.length ?? 0;

      if (this.tracer && finding.column_flow) {
        for (const entry of finding.column_flow) {
          const resolved = resolveColumnFlowTarget(entry, focusId, this.nodeMap, this.model.identifierCaseSensitive);
          const targets: Array<readonly [string, string]> = resolved
            ? [[resolved.attributionTo, resolved.attributionCol]]
            : [];
          for (const [targetId, targetCol] of targets) {
            const targetObj = this.nodeMap.get(targetId);
            if (targetObj && !SCRIPT_TYPES.has(targetObj.type)) {
              stagedCtNodeStates.push({
                nodeId: targetId,
                action: 'passthrough',
                source: 'engine',
                reason: 'non_bodied_passthrough',
                meta: { columns: [targetCol], viaNodeId: focusId, atHop: this.hopCount },
              });
            }
          }
          for (const ref of entry.upstream_columns) {
            const fromNode = resolveModelNodeId(ref.node, this.nodeMap, this.model.identifierCaseSensitive);
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

      let unaccountedColumns: string[] = [];
      if (this.tracer) {
        const submittedFlow = finding.column_flow ?? [];
        unaccountedColumns = submittedFlow.length === 0 && focusId !== this.originNodeId && this.currentReturnTargets().length === 0
          ? [] : this.tracer.unaccountedActiveColumns(submittedFlow, traceDirection);
        if (unaccountedColumns.length > 0) {
          this.log('debug', `[Admit] guard=ct_completeness phase=active focus=${focusId} reason=unaccounted columns=[${unaccountedColumns.join(', ')}] — left to the model, not rejected`);
        } else {
          this.log('debug', `[Admit] guard=ct_completeness phase=active focus=${focusId} reason=all_accounted active=${this.tracer.activeColumns.length}`);
        }
      }

      const fatalRoutes = invalidRoutes.filter(r => !isAbsentKind(r.kind));
      if (classViolation || lengthViolations.length > 0 || fatalRoutes.length > 0) {
        return this.rejectFinding(focusId, finding, submitted, classViolation, lengthViolations, fatalRoutes, pruneTargets);
      }

      const notices = [...actionPolicy.notices, ...invalidRoutes.filter(r => isAbsentKind(r.kind))];
      for (const notice of notices) {
        this.memory.recordRejection(notice.id, `\`${notice.id}\`: ${ROUTE_REJECTION_DIRECTIVE[notice.kind]}`, this.hopCount);
        this.log('debug', `[Notice] hop=${this.hopCount} id=${notice.id} kind=${notice.kind} code=${ROUTE_REJECTION_CODE[notice.kind]}`);
      }
      for (const raw of unresolvedQuestions) {
        this.log('debug', `[Agenda] question dropped hop=${this.hopCount} id=${raw} ← ${focusId} reason=unresolved`);
        this.memory.recordRejection(raw, `\`${raw}\`: not in the loaded model — the question was dropped.`, this.hopCount);
        routeOutcomes.push({ nodeId: raw, accepted: false, reason: 'unresolved' });
      }

      return this.applyValidatedHop({
        focusId, finding, routeRequests, routeOutcomes, acceptedNids, scopeAddNids, deferredRoutes, prunedNeighborNids,
        carryByNode, routeContexts, stagedSections, stagedDetailChars, stagedSummaryChars, stagedColumnEdges, stagedCtNodeStates,
        stagedColumnFlowEntries, unaccountedColumns,
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

  /**
   * One rejection for every engine-side fault of a submission — a missing locked section angle, an
   * over-cap `badge_label` or `column_flow` note, and each fatal route/column failure — so one round
   * corrects them all. Nothing is committed: the valid parts are held ({@link holdValidParts}) and
   * the failed ones named. A missing angle fails no sent part; a failed list entry fails only that
   * entry and the held entries of its key.
   *
   * @returns A single-category rejection keeps that category's code and wording; a mixed one is
   *   `invalid_input` with every reason line, every directive and the shared held-parts sentence.
   */
  private rejectFinding(
    focusId: string,
    finding: HopFindingKept,
    submitted: HopSubmission,
    classViolation: string | null | undefined,
    lengthViolations: ReadonlyArray<{ path: string; chars: number; limit: number }>,
    fatalRoutes: InvalidRoute[],
    pruneTargets: ReadonlyArray<{ raw: string; resolved: ReturnType<typeof resolveModelNodeId>; path: string }>,
  ): ToolRejection {
    // Retention uses merged indexes; resent-entry diagnostics use submitted indexes.
    const conflictPrunePaths = fatalRoutes.flatMap(route => route.kind === 'prune_question_conflict'
      ? pruneTargets.filter(target => (target.resolved ?? this.identifierKey(target.raw)) === route.id).map(target => target.path)
      : []);
    this.holdValidParts(finding, [...lengthViolations.map(v => v.path), ...fatalRoutes.flatMap(route => route.path ? [route.path] : []), ...conflictPrunePaths]);
    const submittedPath = (path: string): string => {
      const match = /^(questions|prune_neighbors)\.(\d+)(.*)$/.exec(path);
      if (!match) return path;
      const list = match[1] as HeldEntryList;
      const count = submitted[list]?.length ?? 0;
      const index = Number(match[2]) - ((finding[list]?.length ?? 0) - count);
      return index >= 0 && index < count ? `${list}.${index}${match[3]}` : path;
    };
    lengthViolations = lengthViolations.map(v => ({ ...v, path: submittedPath(v.path) }));
    fatalRoutes = fatalRoutes.map(route => ({ ...route, ...(route.path ? { path: submittedPath(route.path) } : {}) }));
    const measured = lengthViolations.map(v => `${v.path}: ${v.chars} chars, limit ${v.limit}`).join('; ');
    if (measured) this.memory.recordRejection(focusId, `${REJECTION_CODES.fieldLengthExceeded}: ${measured}`, this.hopCount);
    if (fatalRoutes.length > 0) {
      this.lastRoutedRejected = fatalRoutes.length;
      for (const r of fatalRoutes) this.memory.recordRejection(r.id, r.reason, this.hopCount);
    }
    const lengthPaths = lengthViolations.map(v => v.path);
    const routePaths = [...fatalRoutes.flatMap(route => route.path ? [route.path] : []), ...conflictPrunePaths.map(submittedPath)];
    const held = this.heldPartsOfCurrentFocus();
    const sectionReason = classViolation ? `sections: ${classViolation}` : '';
    const issuePaths = [...(sectionReason ? ['sections'] : []), ...lengthPaths, ...routePaths];
    const lengthDetail = lengthViolations.map(v => ({ path: v.path, chars: v.chars, limit: v.limit }));
    const categories = [sectionReason !== '', lengthViolations.length > 0, fatalRoutes.length > 0].filter(Boolean).length;
    if (categories === 1 && sectionReason) {
      return makeRejection({ code: REJECTION_CODES.invalidInput, reason: sectionReason, ...(held ? { hint: heldSubmissionRepairHint(held) } : {}), issuePaths });
    }
    if (categories === 1 && measured) {
      return makeRejection({
        code: REJECTION_CODES.fieldLengthExceeded,
        hint: `${measured}. Nothing was committed. Shorten the listed field(s) for ${focusId}. ${HELD_CORRECTION_ORDER}`,
        detail: lengthDetail,
        issuePaths,
      });
    }
    if (categories === 1) {
      const rejection = buildRouteValidationRejection(fatalRoutes, held ? heldEntriesRepairLine(held) : '');
      return { ...rejection, issuePaths: [...new Set([...(rejection.issuePaths ?? []), ...conflictPrunePaths.map(submittedPath)])] };
    }
    return makeRejection({
      code: REJECTION_CODES.invalidInput,
      reason: [sectionReason, measured, fatalRoutes.length > 0 ? routeRejectionReason(fatalRoutes) : ''].filter(Boolean).join('\n'),
      hint: [
        measured ? `Shorten the listed field(s) for ${focusId}.` : '',
        fatalRoutes.length > 0 ? routeRejectionDirectives(fatalRoutes) : '',
        'Nothing was committed.',
        held ? heldSubmissionRepairHint(held) : `${HELD_CORRECTION_ORDER}.`,
      ].filter(Boolean).join(' '),
      detail: [...lengthDetail, ...routeRejectionDetail(fatalRoutes)],
      issuePaths,
    });
  }

  /**
   * Whether `nodeId` sits on the approved downstream side of the origin (the origin itself counts).
   *
   * @param nodeId - Canonical node id.
   * @returns True when the approved direction reaches the node by a downstream walk.
   */
  private onDownstreamSide(nodeId: string): boolean {
    if (this.effectiveDirection() === 'upstream') return false;
    if (nodeId === this.originNodeId) return true;
    return this.directedDepthsFor(nodeId)?.downstream !== undefined;
  }

  /**
   * Removes the open nodes the latest removals left without a directed path to the origin.
   *
   * @remarks
   * A still-surviving directed origin route on an approved leg protects a join.
   * The shared graph policy computes the cut before the hop applies any mutation.
   *
   * @param cutNodeId - The node whose hop made the removals, recorded as `viaNodeId`.
   * @param removal - The admitted shared removal analysis, computed before mutation.
   */
  private cutUnreachable(cutNodeId: string, removal: RemovalAnalysis): void {
    const dropped = removal.cutIds;
    for (const id of dropped) {
      this.removedSet.add(id);
      this.pruneBallots.delete(id);
      const queued = this._agenda.remove(id);
      if (queued) this.completeTasks(queued.taskIds);
      this.markNodeState(id, 'prune', 'engine', 'bb_prune_neighbor', { viaNodeId: cutNodeId, atHop: this.hopCount });
      const node = this.nodeMap.get(id);
      if (node && SCRIPT_TYPES.has(node.type) && this.scopeNodeIds.has(id)) this._totalNodes--;
    }
    if (dropped.length > 0) {
      this.log('debug', `[Cut] hop=${this.hopCount} via=${cutNodeId} dropped=[${dropped.join(', ')}] (total → ${this._totalNodes})`);
    }
  }

  /**
   * Commits a kept hop whose submission passed every validation guard: route deferrals, scope
   * growth, neighbour prunes and their cut, the focus verdict and the enqueued neighbours, each
   * exactly once.
   */
  private applyValidatedHop(staged: ValidatedHop): SubmitResult {
    const {
      focusId, finding, routeRequests, routeOutcomes, acceptedNids, scopeAddNids, deferredRoutes, prunedNeighborNids,
      carryByNode, routeContexts, stagedSections, stagedDetailChars, stagedSummaryChars, stagedColumnEdges, stagedCtNodeStates,
      stagedColumnFlowEntries, unaccountedColumns,
    } = staged;
    let lineageQuestionsByNode: Map<string, string[]> | undefined;
    this.committedHops++;
    this.lastRoutedNew = 0;
    this.lastRoutedRejected = 0;
    this.lastRoutedDeferred = 0;
    this.lastHopColumnFlowEntries = stagedColumnFlowEntries;
    this._pendingLineageQuestions = [];

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
      const id = resolveModelNodeId(prune.id, this.nodeMap, this.model.identifierCaseSensitive);
      return id && prune.reason.trim() ? [[id, prune.reason.trim()] as const] : [];
    }));
    for (const nid of prunedNeighborNids) {
      const reason = pruneReasons.get(nid);
      if (this.recordBallot(nid, focusId, 'prune') && reason) this.recordPruneLead(nid, focusId, reason);
    }
    this.tryResolvePrunes([...prunedNeighborNids]);
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
      const targetNode = this.nodeMap.get(nid);
      const targetIsBodied = !!targetNode && SCRIPT_TYPES.has(targetNode.type);
      const wasAlreadyVisited = this.visited.has(nid);
      const isFreshExpansion = freshlyExpandedIds.delete(nid);
      const columnQuestions = lineageQuestionsByNode?.get(nid);
      const dispositions = new Map<string, RouteSkipDisposition>();
      // A ref names an endpoint inside the active scope; a written destination the depth or border left out is not an input to carry.
      const legs = (routeContexts.get(nid) ?? [undefined]).map(leg => leg && { ...leg, sourceRefs: leg.sourceRefs.filter(ref => this.scopeNodeIds.has(ref.node)) });
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
          admitContractedBodiedTarget: !targetIsBodied,
        });
      }
      const added = this._agenda.length - agendaSizeBefore;
      this.lastRoutedNew += Math.max(0, added);

      const settled = [...dispositions].filter((entry): entry is [string, SettledRouteReason] => entry[1] !== 'not_enqueued');
      for (const [skippedId, reason] of settled) {
        if (skippedId === nid || skippedId === focusId) continue;
        if (routeOutcomes.some(o => o.nodeId === skippedId)) continue;
        routeOutcomes.push({ nodeId: skippedId, accepted: false, reason });
      }
      const directSkip = dispositions.get(nid);
      const carrierSettled = added === 0 && !targetIsBodied && !wasAlreadyVisited
        && settled.length > 0 && settled.length === dispositions.size;
      const correctedReason: RouteOutcome['reason'] | undefined = directSkip && directSkip !== 'not_enqueued' && added === 0
        ? directSkip
        : carrierSettled
          ? (settled.some(([, reason]) => reason === 'already_visited') ? 'already_visited' : 'already_pruned')
          : undefined;
      for (let i = routeOutcomes.length - 1; i >= 0; i--) {
        if (routeOutcomes[i].nodeId !== nid || !routeOutcomes[i].accepted) continue;
        if (correctedReason) {
          routeOutcomes[i] = { nodeId: nid, accepted: false, reason: correctedReason };
        } else if (added === 0 && !targetIsBodied && !wasAlreadyVisited) {
          routeOutcomes[i] = { nodeId: nid, accepted: false, reason: 'non_bodied_passthrough' };
        }
        break;
      }
    }

    for (const o of routeOutcomes) {
      if (o.accepted) continue;
      this.log('debug', `[Agenda] route outcome hop=${this.hopCount} focus=${focusId} id=${o.nodeId} accepted=false reason=${o.reason ?? 'none'}${o.deferred ? ' deferred=true' : ''}`);
    }
    this.resolvePendingPrunes();

    this._status = 'exploring';
    this.heldFindingDraft.clear();
    const outcomes = routeOutcomes.length > 0 ? { route_outcomes: routeOutcomes } : {};
    const columnStatus = unaccountedColumns.length > 0 ? { unaccounted_columns: unaccountedColumns } : {};

    return { ok: true, ...outcomes, ...columnStatus };
  }

  /**
   * Measures the scope for the exploration admission check: total nodes, rounds (the hops the run
   * takes: those already taken, one per unvisited procedure, view or function, one per queued
   * table, and one per supplement target — a table or an already-visited node takes a fresh hop)
   * and the distinct starting trace columns.
   *
   * @param extraIds - Node ids a pending supplement would add; measured together with the scope so
   *   the check is cumulative.
   */
  public measureAdmissionScope(extraIds: readonly string[] = []): ProposedScope {
    const extra = new Set(extraIds);
    const ids = new Set(this.scopeNodeIds);
    for (const id of extra) ids.add(id);
    let rounds = this.hopCount;
    for (const nid of ids) {
      const n = this.nodeMap.get(nid);
      if (!n) continue;
      const takesHop = extra.has(nid)
        || (SCRIPT_TYPES.has(n.type) ? !this.visited.has(nid) && !this.removedSet.has(nid) : this._agenda.has(nid));
      if (takesHop) rounds++;
    }
    return { nodes: ids.size, rounds, columns: new Set(this.currentTargetColumns ?? []).size };
  }

  /**
   * Measures the scope a supplement would produce — the existing scope plus every object the
   * supplement would admit — without changing the engine. A supplement selects no starting columns.
   */
  public measureSupplementScope(nodeIds: readonly string[], chain?: SupplementChain): ProposedScope {
    const named = chain ? this.expandSupplementChain(nodeIds, chain) : nodeIds;
    return { ...this.measureAdmissionScope(this.admitSupplementTargets(named).admitted), columns: 0 };
  }

  /**
   * Calculates the approximate number of DDL characters required by the scope.
   *
   * @returns The total character count.
   */
  private estimateScopeDdlChars(): number {
    let total = 0;
    for (const nid of this.scopeNodeIds) {
      const ddl = getNodeDdl(nid, this.nodeMap, this.store ?? undefined);
      if (ddl) total += ddl.length;
    }
    return total;
  }

  /**
   * Evaluates the breadth-first search reachability for initializing traversal scope.
   *
   * @remarks
   * Walks to {@link depthLimits}, already resolved by `init()` for the approved intent — an exact
   * side there is finite (or `Infinity` for `'all'`) exactly as enforced at hop time, a `levels: 0`
   * side is `0`, and an open approximate side is `Infinity`, so the dry-run preview this feeds sees the same full reach the
   * approval it proposes would actually admit.
   *
   * @param startId - Starting node identifier.
   * @param direction - Direction of graph traversal ('upstream', 'downstream', 'bidirectional').
   * @returns A set of valid node identifiers reachable within the depth parameters.
   */
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

  /**
   * The note graph the agenda schedules over, read from current engine state.
   *
   * @remarks
   * `u ⇒ v` when a note written at `u`'s hop can reach `v`: on the upstream side `u` reads what
   * `v` writes (a consumer asks its producer), on the downstream side `v` reads what `u` writes.
   * A node's sides are the entries of {@link directedDepthsFor} the approved direction allows (the
   * origin holds every allowed side), and an edge only follows a side both ends share — the same
   * "upstream closure plus downstream closure" as {@link isReachableInApprovedDirection}, so no
   * edge crosses from one side of the origin to the other. Distance is the directed distance from
   * the origin, falling back to the entry's recorded depth when no directed path resolves.
   */
  private worklistView(): WorklistView {
    const allowed = this.allowedNoteSides();
    return {
      successors: nodeId => this.noteSuccessors(nodeId, allowed),
      distance: entry => this.directedDepthFromOrigin(entry.nodeId)?.depth ?? entry.depth,
    };
  }

  /** The note-graph sides the active direction allows ({@link worklistView}, {@link liveSenders}). */
  private allowedNoteSides(): ReadonlyArray<'upstream' | 'downstream'> {
    const direction = this.effectiveDirection();
    return direction === 'bidirectional' ? ['upstream', 'downstream'] : [direction];
  }

  /**
   * Unfinished note-graph successors of `nodeId` ({@link worklistView}), or — reversed — the
   * unfinished nodes that can still reach `nodeId` as a receiver ({@link liveSenders}): the same
   * bipartite contraction walked in the opposite step direction.
   *
   * @remarks
   * A non-bodied, non-origin, unqueued neighbor is a carrier and is walked through on the same
   * side (the bipartite contraction of {@link enqueueHop}); a removed carrier ends the walk. Any
   * other node is a receiver: it is returned when unfinished — queued, or in scope and neither
   * visited nor removed — and never walked through.
   */
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
        if (queued || id === this.originNodeId || SCRIPT_TYPES.has(node.type)) {
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

  /** Unfinished note-graph successors of `nodeId` ({@link worklistView}). */
  private noteSuccessors(nodeId: string, allowed: ReadonlyArray<'upstream' | 'downstream'>): string[] {
    return this.noteWalk(nodeId, allowed, false);
  }

  /**
   * Live senders of `nodeId` — unfinished nodes whose hop could still cast a neighbor-prune vote
   * (or a keep) on the edge into `nodeId`: the note-graph walk {@link worklistView} readiness uses,
   * in the reverse step direction.
   *
   * @remarks
   * A neighbor prune ({@link recordBallot}) resolves once this returns empty: no live sender
   * remains that could still vote on `nodeId`, so its fate is decided by the votes already cast.
   * An unfinished sender reachable only through `nodeId` itself (a cycle) is never dispatched while
   * the vote is pending; {@link getHopContext} resolves such a vote when the agenda empties.
   */
  private liveSenders(nodeId: string): string[] {
    return this.noteWalk(nodeId, this.allowedNoteSides(), true);
  }

  /**
   * Records `focusId`'s own ballot on the edge into `nodeId` and attempts resolution.
   *
   * @remarks
   * One sender casts at most one ballot: a second call from the same `focusId` (a reactivated
   * hop revising its own earlier verdict) replaces its prior entry rather than adding a second
   * vote, so a sender's fresh judgement always supersedes its own earlier one. A vote is not a
   * removal — `nodeId` is cut only once {@link tryResolvePrunes} finds no live sender left standing
   * between it and every focus that could still name it.
   */
  private castBallot(nodeId: string, focusId: string, vote: 'prune' | 'keep'): void {
    if (this.recordBallot(nodeId, focusId, vote)) this.tryResolvePrunes([nodeId]);
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

  /**
   * Records the current focus's keep on `nodeId`: a live route or question reached it
   * ({@link castBallot}). A keep from the same sender that voted to prune it on an
   * earlier, reactivated hop supersedes that sender's own earlier vote — it never overrides a
   * different sender's still-standing vote, which `tryResolvePrunes` reads fresh off every ballot
   * on every resolution attempt.
   */
  private resolveKept(nodeId: string): void {
    const focusId = this.currentFocusNodeId;
    // Only a hop being committed is a sender's decision. Initial scheduling, reactivated work and
    // supplement scheduling run with the last focus left set by the completed run, so the status is
    // the evidence that a sender is deciding; the focus alone is not.
    if (!focusId || this._status !== 'awaiting_findings' || !this.visited.has(focusId)) return;
    this.castBallot(nodeId, focusId, 'keep');
  }

  /**
   * Removes every node of `nodeIds` whose live senders have finished and whose ballots all read
   * `'prune'` — the resolution point of a neighbor-prune vote ({@link castBallot}) — as ONE removal
   * proposal, so the removed set is a function of the set of resolved prunes, never of their order.
   *
   * @remarks
   * `cutUnreachable` runs here, at resolution, never at vote time. The ballot
   * map is read fresh at every attempt, so a sender's ballot decides the outcome for as long as it
   * stands, and a later, different sender's opposite vote never overrides it. A node whose removal
   * alone would disconnect visited analysis is retained; the rest are analysed together by
   * {@link removalSupport}, the same atomic proposal shape the shared cut policy defines.
   *
   * @param runEnded - The agenda is empty, so no remaining sender can be dispatched; the vote
   *   resolves on the ballots cast and the unheard senders are named in the log.
   */
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
      const unheard = this.liveSenders(nodeId);
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
      // A refused prune leaves the object in scope: it is routed like any other kept neighbour (visit-once and scope checks stay in enqueueHop).
      this.enqueueHop(nodeId, this.memory.getUserQuestion() ?? '', 0, 2, { carry: this.tracer ? { kind: 'row_role_only' } : { kind: 'carry', columns: [] } });
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
      this.markNodeState(nodeId, 'prune', 'ai', 'bb_prune_neighbor', { viaNodeId: voters.at(-1) ?? nodeId, atHop: this.hopCount });
      if (!this.visited.has(nodeId) && SCRIPT_TYPES.has(this.nodeMap.get(nodeId)!.type) && this.scopeNodeIds.has(nodeId)) {
        this._totalNodes--;
        this.log('debug', `[Prune] prune_neighbor ${nodeId} — bodied scope node (total −1 → ${this._totalNodes})`);
      }
      this.log('debug', `[Prune] resolve id=${nodeId} removed votes=${voters.length}/${voters.length}`);
    }
    this.cutUnreachable(first.voters.at(-1) ?? first.nodeId, removal);
  }

  /**
   * Re-attempts resolution for every neighbor prune still pending — the end of each hop, and once
   * more when the agenda empties ({@link tryResolvePrunes} `runEnded`).
   */
  private resolvePendingPrunes(runEnded = false): void {
    this.tryResolvePrunes(Array.from(this.pruneBallots.keys()), runEnded);
  }

  /**
   * Forwards a pass-tagged node's intent to its in-direction bodied neighbours.
   *
   * @remarks
   * Mirrors `enqueueHop`'s non-bodied contraction branch: when a node is in
   * {@link passNodeIds} the AI is not asked to analyse it, yet its descendants must stay
   * reachable. Walk in-direction neighbours and re-enqueue each via
   * `enqueueHop` (which respects scope, visited, and the bipartite rule).
   *
   * A pass node is topology only: no hop records how its columns map to its inputs, so an
   * ordinary column continuation cannot attach beyond it. Its neighbours receive the shared BB
   * visit with the source-qualified unresolved question instead of a CT task whose every link
   * would be detached. Qualified scalar caller outputs keep their binding.
   */
  private contractThroughPassNode(entry: AgendaEntry): void {
    for (const nid of this.directionalNeighbors(entry.nodeId, this._direction)) {
      for (const taskId of entry.taskIds) {
        const task = this.taskLedger.getTask(taskId)!;
        const continues = !task.traversalSide || this.directionalNeighbors(entry.nodeId, task.traversalSide).includes(nid);
        const validCaller = continues && task.callerContext && this.validFunctionCallerContext(nid, task.callerContext) ? task.callerContext : undefined;
        const targets = continues && task.kind === 'column_lineage' ? task.returnTargets?.filter(target => this.resolveReturnTarget(nid, target, [task.id])) : undefined;
        const unresolved = continues && task.kind === 'column_lineage' && !targets?.length
          ? this.passNodeUnresolvedQuestion(entry.nodeId, this.qualifiedTaskRefs(task) ?? task.activeColumns.map(col => ({ node: entry.nodeId, col })))
          : '';
        this.enqueueHop(nid, unresolved ? `${task.question}${task.question ? '\n' : ''}${unresolved}` : task.question, entry.depth + 1, entry.priority, {
          carry: targets?.length ? { kind: 'scalar_return', outputs: targets } : { kind: 'row_role_only' },
          parentTaskId: validCaller?.callerTaskId ?? task.id,
          ...(validCaller ? { callerContext: validCaller } : {}),
          lineageQuestions: targets?.length ? entry.lineageQuestions : undefined,
          traversalSide: continues ? task.traversalSide : undefined,
          sourceRefs: targets?.length && task.kind === 'column_lineage' ? task.sourceRefs ?? task.returnTargets : undefined,
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
   * @param priority - Agenda priority (2 = routed, 3 = origin or follow-up).
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
      /** Best depth already expanded for each carried context in this contraction walk. */
      readonly contractedContexts?: Map<string, number>;
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
      readonly callerContext?: FunctionCallerContext;
      /** Source-qualified input context retained without asserting a local output mapping. */
      readonly sourceRefs?: readonly ScalarReturnTarget[];
      /** The accepted task's read/write leg; dual-role carriers never choose a side by guessing. */
      readonly traversalSide?: 'upstream' | 'downstream';
      readonly existingTaskId?: string;
      /** Parent task assigned when a new task is created. */
      readonly parentTaskId?: string;
      /**
       * Passthrough re-anchor sentence for a bodied target reached through a non-bodied node; stored
       * on the created task beside the authored `question`, never concatenated into it.
       */
      readonly reAnchor?: string;
      /**
       * Whether this call is the bodied leaf of an accepted route through a non-bodied carrier
       * (a routed table contracts to its bodied writers) and may therefore extend the initial
       * seed after filter checks. Shared walk machinery — BB and CT behave alike.
       */
      readonly admitContractedBodiedTarget?: boolean;
      /**
       * Records every node this call (and its contraction recursion) left un-enqueued, keyed by node id: `already_visited` /
       * `already_pruned` for the visit-once skip, `not_enqueued` for an out-of-scope or depth-deferred contraction.
       * The route
       * commit turns the settled entries into `route_outcomes` so a route with no effect is stated, never left `accepted:true`.
       */
      readonly dispositions?: Map<string, RouteSkipDisposition>;
    },
  ): void {
    const {
      carry,
      lineageQuestions,
      visitedRefs = new Set<string>(),
      contractedContexts = new Map<string, number>(),
      freshScopeExpansion = !this.scopeNodeIds.has(targetId),
      reactivated = false,
      existingTaskId,
      callerContext,
      sourceRefs,
      traversalSide,
      parentTaskId,
      reAnchor,
      admitContractedBodiedTarget = false,
      dispositions,
    } = opts;
    if (!this.scopeNodeIds.has(targetId) && priority !== 3) {
      const contractedTarget = this.nodeMap.get(targetId);
      const canAdmitContraction = admitContractedBodiedTarget
        && !!contractedTarget
        && SCRIPT_TYPES.has(contractedTarget.type)
        && !this.visited.has(targetId)
        && !this.removedSet.has(targetId)
        && this.checkBorder(targetId, contractedTarget, 'contraction').kind === 'in_border';
      if (!canAdmitContraction) {
        dispositions?.set(targetId, 'not_enqueued');
        this.log('debug', `[Disposition] enqueue drop ${targetId} — out-of-scope target (priority=${priority}, not deferred) via focus=${this.currentFocusNodeId ?? this.originNodeId ?? '(none)'}`);
        return;
      }
      const contractionBreach = this.depthBorderBreach(targetId, depth);
      if (contractionBreach !== null) {
        const via = this.currentFocusNodeId ?? this.originNodeId;
        this.log(
          'debug',
          `[Depth] contraction deferred hop=${this.hopCount} id=${targetId} ← ${via ?? '(none)'} `
          + `depth=${contractionBreach} cap=up:${this.depthLimits.upstream}/down:${this.depthLimits.downstream}`,
        );
        if (via) this.deferQuestion({
          nodeId: targetId, schema: contractedTarget!.schema, fromFocusNodeId: via,
          question, reason: 'depth', depth: contractionBreach, atHop: this.hopCount,
        }, carry.kind === 'carry' && carry.columns.length > 0 && sourceRefs?.length
          ? [{ sourceRefs: [...sourceRefs], traversalSide: traversalSide ?? this.columnTraceDirection() }]
          : []);
        dispositions?.set(targetId, 'not_enqueued');
        return;
      }
      const admittedDepth = this.directedDepthFromOrigin(targetId)?.depth ?? depth;
      this.scopeNodeIds.add(targetId);
      this._bodiedScopeSize++;
      this.depthFromOrigin.set(targetId, admittedDepth);
      this.budgetExpansions.push({ nodeId: targetId, depth: admittedDepth, atHop: this.hopCount });
      this.log('debug', `[Depth] contraction add beyond initial scope id=${targetId} depth=${admittedDepth} hop=${this.hopCount}`);
    }
    if (this.visited.has(targetId) || this.removedSet.has(targetId)) {
      const removed = this.removedSet.has(targetId);
      this.log('debug', `[Disposition] enqueue skip ${targetId} — already ${removed ? 'removed' : 'visited'} via focus=${this.currentFocusNodeId ?? this.originNodeId ?? '(none)'} hop=${this.hopCount}`);
      dispositions?.set(targetId, removed ? 'already_pruned' : 'already_visited');
      return;
    }
    this.resolveKept(targetId);
    const node = this.nodeMap.get(targetId);
    if (!node) {
      this.log('debug', `[Disposition] enqueue drop ${targetId} — absent from the loaded graph model`);
      return;
    }

    const activeColumns = carry.kind === 'carry' ? carry.columns.filter(Boolean) : carry.kind === 'scalar_return' ? [...new Set(carry.outputs.map(target => target.col))] : undefined;
    if (!this.tracer && activeColumns?.length) {
      throw new Error('BB agenda tasks must not carry active columns');
    }
    if (SCRIPT_TYPES.has(node.type)) {
      if (this.tracer && node.type === 'function' && carry.kind === 'row_role_only' && !getNodeColumns(node.id, this.nodeMap, this.store ?? undefined)?.length) {
        question = `${question}${question ? '\n' : ''}No declared scalar caller output binding is available for this function. This visit does not resolve a caller's column contribution; do not invent function columns or return destinations.`;
      }
      const task = this.ensureExecutableTask(targetId, question, priority, activeColumns, existingTaskId, parentTaskId, carry.kind === 'scalar_return' ? carry.outputs : undefined, callerContext, sourceRefs, traversalSide, reAnchor);
      const alreadyQueued = this._agenda.has(targetId);
      this._agenda.push({ taskIds: [task.id], nodeId: targetId, priority, depth, activeColumns: this.agendaColumnsFor(carry), ...(this.carryToRecord(carry)), ...(lineageQuestions?.length ? { lineageQuestions } : {}) });
      if (!alreadyQueued && (freshScopeExpansion || reactivated)) {
        this._totalNodes++;
        const agendaReason = freshScopeExpansion ? 'out-of-scope expansion' : 'reactivated';
        this.log('debug', `[Agenda] enqueue ${targetId} — ${agendaReason} (total +1 → ${this._totalNodes})`);
      }
      return;
    }

    if (priority === 3) {
      const task = this.ensureExecutableTask(targetId, question, priority, activeColumns, existingTaskId, parentTaskId, carry.kind === 'scalar_return' ? carry.outputs : undefined, callerContext, sourceRefs, traversalSide, reAnchor);
      const alreadyQueued = this._agenda.has(targetId);
      this._agenda.push({ taskIds: [task.id], nodeId: targetId, priority, depth, activeColumns: this.agendaColumnsFor(carry), ...(this.carryToRecord(carry)), ...(lineageQuestions?.length ? { lineageQuestions } : {}) });
      if (!alreadyQueued && !SCRIPT_TYPES.has(node.type)) {
        this._totalNodes++;
        this.log('debug', `[Agenda] enqueue ${targetId} — non-bodied direct push (total +1 → ${this._totalNodes})`);
      }
      return;
    }

    if (visitedRefs.has(targetId)) return;
    const contextKey = JSON.stringify([
      targetId, carry.kind,
      carry.kind === 'carry' ? carry.columns.map(col => this.columnKey(col)).sort()
        : carry.kind === 'scalar_return' ? carry.outputs : [],
      question, parentTaskId, callerContext, traversalSide, sourceRefs, lineageQuestions,
    ]);
    const expandedDepth = contractedContexts.get(contextKey);
    if (expandedDepth !== undefined && expandedDepth <= depth) return;
    contractedContexts.set(contextKey, depth);
    visitedRefs.add(targetId);
    const ctCarried = this.tracer
      ? (this.columnTraceDirection() === 'downstream' ? this.agendaColumnsFor(carry) ?? [] : this.resolveActiveColumnsForNode(targetId, this.agendaColumnsFor(carry)) ?? [])
      : undefined;
    const carried = ctCarried ?? activeColumns;
    const forwardedCarry: ColumnCarry = carry.kind === 'row_role_only' ? carry : { kind: 'carry', columns: carried ?? [] };
    // The carrier resolves the carried names to its own columns; an arrival whose column the carrier
    // does not hold is not an input of the bodied neighbour behind it, so its source ref narrows with the columns.
    const carriedKeys = new Set((carried ?? []).map(col => this.columnKey(col)));
    const carriedRefs = sourceRefs?.filter(ref => carriedKeys.has(this.columnKey(ref.col)));
    this.markNodeState(targetId, 'passthrough', 'engine', 'non_bodied_passthrough', {
      columns: carried,
      ...(carry.kind === 'row_role_only' ? { columnRole: 'row_role_only' as const } : {}),
      viaNodeId: this.currentFocusNodeId ?? this.originNodeId ?? undefined,
      atHop: this.hopCount,
    });
    const side = traversalSide ?? (this.tracer && carried?.length ? this.columnTraceDirection() : undefined);
    const columnContinuation = side ? new Set(this.directionalNeighbors(targetId, side)) : null;
    for (const nid of this.directionalNeighbors(targetId, this._direction)) {
      const neighbor = this.nodeMap.get(nid);
      // Only a walk toward the writers reaches `nid` through its delete: downstream, the same node is a reader of `targetId`.
      const deleteOnly = !!this.tracer && (side ?? this.columnTraceDirection()) === 'upstream' && this.isDeleteOnlyWrite(nid, targetId);
      const continues = !deleteOnly && (columnContinuation === null || columnContinuation.has(nid));
      const neighborCarry = forwardedCarry.kind === 'row_role_only' || deleteOnly
        ? { kind: 'row_role_only' as const }
        : continues ? forwardedCarry : { kind: 'carry' as const, columns: [] };
      const reAnchor = continues && neighbor && SCRIPT_TYPES.has(neighbor.type)
        ? buildPassthroughReAnchor(targetId, nid, this.carryAnalysisMode(neighborCarry), question.trim().length > 0)
        : '';
      if (!continues) {
        this.log('debug', `[Agenda] question not forwarded hop=${this.hopCount} id=${nid} ← ${targetId} reason=${deleteOnly ? 'delete_only' : 'other_side'}`);
      }
      this.enqueueHop(nid, continues ? question : '', depth + 1, priority, {
        carry: neighborCarry, lineageQuestions: continues ? lineageQuestions : undefined,
        visitedRefs: new Set(visitedRefs), contractedContexts, parentTaskId, callerContext, sourceRefs: continues && carriedRefs?.length ? carriedRefs : undefined,
        traversalSide: continues ? side : undefined, admitContractedBodiedTarget, dispositions,
        ...(reAnchor ? { reAnchor } : {}),
      });
    }
  }

  /**
   * Whether `writerId` writes `targetId` only by DELETE or TRUNCATE (the engine's `deleteOnly` edge
   * mark): the write removes rows and supplies no column data, so it owes no source for any column of
   * `targetId`. The node stays reachable and is analysed for its business logic.
   */
  private isDeleteOnlyWrite(writerId: string, targetId: string): boolean {
    this.deleteOnlyWrites ??= new Set(this.model.edges.filter(edge => edge.deleteOnly).map(edge => `${edge.source}→${edge.target}`));
    return this.deleteOnlyWrites.has(`${writerId}→${targetId}`);
  }

  /**
   * CT: the non-bodied carriers a node writes — the carriers whose committed column ends it owes at
   * dispatch (a column a `column_flow` edge attributed to a carrier is answered by its producer).
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

  /** Resolves an authenticated local binding or retains the qualified unresolved arrival; never a session-wide restart. */
  private columnsForEntry(entry: AgendaEntry): string[] {
    const columns = entry.activeColumns ?? [];
    if (!this.tracer || entry.columnCarry?.kind === 'row_role_only') return [];
    if (this.columnTraceDirection() === 'downstream') return [...columns];
    const tasks = entry.taskIds.flatMap(id => this.taskLedger.getTask(id) ?? []);
    const refs = tasks.flatMap(task => task.kind === 'column_lineage' ? task.sourceRefs ?? [] : []);
    const carriers = this.writtenCarrierIds(entry.nodeId);
    const key = columnEndpointKeyFactory(this.nodeMap, this.identifierCaseSensitive);
    const wanted = new Set((refs.length ? refs : [entry.nodeId, ...carriers].flatMap(node => columns.map(col => ({ node, col })))).map(ref => key(ref.node, ref.col)));
    const bound = this.tracer.edges.filter(edge => edge.from_node === entry.nodeId
      && (wanted.has(key(edge.from_node, edge.from_col)) || wanted.has(key(edge.to_node, edge.to_col))))
      .map(edge => edge.from_col);
    return bound.length ? this.resolveActiveColumnsForNode(entry.nodeId, [...new Set(bound)]) ?? [...new Set(bound)] : [...columns];
  }

  /**
   * Derives one neighbor's continuation solely from the accepted flow or a qualified scalar
   * obligation. Routing prose and historical evidence cannot reactivate a terminal arrival.
   */
  private neighborCarryFor(nodeId: string, carryByNode: ReadonlyMap<string, ReadonlySet<string>>, callerContext?: FunctionCallerContext): ColumnCarry {
    if (!this.tracer) return { kind: 'carry', columns: [] };
    if (callerContext && !getNodeColumns(nodeId, this.nodeMap, this.store ?? undefined)?.length && this.validFunctionCallerContext(nodeId, callerContext)) {
      return { kind: 'scalar_return', outputs: [{ node: callerContext.node, col: callerContext.col }] };
    }
    const endpoints = [
      ...this.incomingColumnRefs(),
      ...(this.currentFocusNodeId ? this.tracer.activeColumns.map(col => ({ node: this.currentFocusNodeId!, col })) : []),
    ];
    const outputs = uniqueScalarReturnTargets(endpoints.flatMap(target => {
      if (!this.scopeNodeIds.has(target.node)) return [];
      const bound = resolveScalarReturnTarget(nodeId, target, this.nodeMap, this.store, this.model.identifierCaseSensitive);
      return bound ? [bound] : [];
    }), this.model.identifierCaseSensitive);
    if (outputs.length) return { kind: 'scalar_return', outputs };
    const byKey = new Map<string, string>();
    for (const col of carryByNode.get(nodeId) ?? []) if (!byKey.has(this.columnKey(col))) byKey.set(this.columnKey(col), col);
    const columns = [...byKey.values()];
    return columns.length > 0 ? { kind: 'carry', columns } : { kind: 'row_role_only' };
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
    return this.hopModeFromColumnList(carry.kind === 'row_role_only' ? [] : carry.kind === 'scalar_return' ? carry.outputs.map(target => target.col) : carry.columns);
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
   * BB entries never record one: the mode has no column channel.
   *
   * @param carry - The caller's column decision for this hop.
   * @returns A spreadable `columnCarry` fragment, or an empty object.
   */
  private carryToRecord(carry: ColumnCarry): { columnCarry?: ColumnCarry } {
    if (!this.tracer) return {};
    return { columnCarry: carry.kind === 'carry' ? { kind: 'carry', columns: [...carry.columns] } : carry.kind === 'scalar_return' ? { kind: 'scalar_return', outputs: carry.outputs.map(target => ({ ...target })) } : { ...carry } };
  }

  /**
   * Projects the agenda entry's persisted `activeColumns` for one CT hop, read only from the carry.
   *
   * @returns `undefined` in BB, `[]` for a row-only arrival, otherwise the carried column names.
   */
  private agendaColumnsFor(carry: ColumnCarry): string[] | undefined {
    if (!this.tracer) return undefined;
    if (carry.kind === 'row_role_only') return [];
    if (carry.kind === 'scalar_return') return [...new Set(carry.outputs.map(target => target.col))];
    return carry.columns.filter(Boolean);
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
    reAnchor?: string,
  ): InvestigationTask {
    const existing = existingTaskId ? this.taskLedger.getTask(existingTaskId) : undefined;
    if (existing) return existing;
    return this.taskLedger.ensureTask(this.taskInputFor({
      source: priority === 2 ? 'model' : 'engine',
      question,
      ...(reAnchor ? { reAnchor } : {}),
      nodeId,
      parentTaskId,
      createdHop: this.hopCount,
      ...(callerContext ? { callerContext } : {}),
      ...(traversalSide ? { traversalSide } : {}),
    }, 'analytical', activeColumns, returnTargets, sourceRefs));
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
        ...this.neighborCapabilities(focusId, nid),
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

  /** Question eligibility includes deferred proposals; pruning still requires routing admission. */
  private neighborCapabilities(focusId: string, nodeId: string): Pick<HopNeighborDisclosure, 'can_question' | 'can_prune'> {
    const node = this.nodeMap.get(nodeId);
    const open = !!node && !this.visited.has(nodeId) && !this.removedSet.has(nodeId);
    return { can_question: open,
      can_prune: open && this.admitsRoute(nodeId, node!, focusId).admitted
        && !this._agenda.has(nodeId) && !this.memory.notedNodeIds.includes(nodeId)
        && nodeId !== this.originNodeId && !this.isCarrierInto(nodeId, focusId),
    };
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
   *   Off the border every in-scope node is inside the approved schema set, so a schema the approval opened through `excludeSchemas`
   *   is classified exactly like one the GUI filter ticked.
   * @returns Ids to drop; reachable ones leave the render, border ones leave the delivered chain.
   */
  private undispositionedSinkIds(reachable: ReadonlySet<string>, columnBorder: ReadonlySet<string>): Set<string> {
    const candidates: string[] = [];
    for (const id of [...reachable, ...columnBorder]) {
      if (id === this.originNodeId) continue;
      const state = this.nodeStates.get(id);
      const onBorder = columnBorder.has(id);
      const engineRecord = onBorder && state?.source === 'engine' && state.reason === 'non_bodied_passthrough';
      const borderPruned = onBorder && state?.action === 'prune';
      if (state !== undefined && !engineRecord && !borderPruned) continue;
      if (this.taskLedger.investigationTasks.some(task => task.nodeId === id && task.status !== 'deferred')) continue;
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

    let stranded: string[] = [];
    for (let pass = sinks.size; pass >= 0; pass--) {
      const kept = bfsReachable(this.graph, this.originNodeId!, new Set([...this.removedSet, ...sinks]), undefined, this.scopeNodeIds);
      stranded = Array.from(reachable).filter(id => !sinks.has(id) && !kept.has(id));
      if (stranded.length === 0) return sinks;
      for (const id of stranded) for (const nid of this.graph.neighbors(id)) sinks.delete(nid);
    }
    this.log('debug', `[Disposition] sink trim abandoned — ${stranded.length} node(s) still stranded (${trunc(stranded.join(', '), 200)})`);
    return new Set();
  }

  /**
   * Shortest node chain from origin to a node, ignoring `removedSet` but bounded to `scopeNodeIds`
   * (plus the target itself) so a chain is never assembled from ground the run never explored.
   *
   * @param targetId - The node id to connect back to origin.
   * @param sides - Approved legs the path may walk, each in its own direction from the origin; omitted,
   *   the walk is undirected.
   * @returns Path node ids inclusive of both ends, or null when no scope-bounded path exists.
   */
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

  /**
   * Packages exploration records into the final presentation topology.
   *
   * @returns Detailed analysis metrics matching the outcome format.
   * @throws When the exploration is not `complete`: a result exists only once no agenda entry and
   *   no focus is left, so a stopped run never yields one.
   */
  public getResult(): SmResult {
    if (this._status !== 'complete') {
      throw new Error(`Exploration result requested in status '${this._status}': a result exists only for a complete exploration.`);
    }
    const mem = this.memory.getResult();

    const reachableNodeIds = bfsReachable(this.graph, this.originNodeId!, this.removedSet, undefined, this.scopeNodeIds);
    const finalNodeIds = new Set<string>(reachableNodeIds);
    finalNodeIds.add(this.originNodeId!);

    const columnBorder = this.columnEndpointsOutsideRender(finalNodeIds);
    const undispositioned = this.undispositionedSinkIds(finalNodeIds, columnBorder);
    const borderSinks = new Set<string>();
    for (const id of columnBorder) if (undispositioned.delete(id)) borderSinks.add(id);
    this.renderDroppedIds = new Set(undispositioned);
    if (borderSinks.size > 0) {
      this.log('debug', `[Disposition] getResult withholds ${borderSinks.size} column-chain endpoint(s) — ${trunc(Array.from(borderSinks).join(', '), 200)} (past the render border, never analyzed, routed, contracted or pruned, and supplying nothing the render keeps)`);
    }
    if (undispositioned.size > 0) {
      for (const id of undispositioned) finalNodeIds.delete(id);
      this.log('debug', `[Disposition] getResult drops ${undispositioned.size} undispositioned sink node(s) — ${trunc(Array.from(undispositioned).join(', '), 200)} (in scope, never analyzed, routed, contracted or pruned, and supplying nothing the render keeps)`);
    }

    const orphaned = Array.from(this.scopeNodeIds).filter(
      id => !finalNodeIds.has(id) && !this.removedSet.has(id) && !undispositioned.has(id));
    if (orphaned.length > 0) {
      for (const id of orphaned) this.renderDroppedIds.add(id);
      this.log('debug', `[Disposition] getResult drops ${orphaned.length} scope node(s) unreachable from origin under removedSet — ${trunc(orphaned.join(', '), 200)} (orphaned by a prune; never dispositioned themselves)`);
    }

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

    return {
      status: 'complete',
      originNodeId: this.originNodeId!,
      fullNodes: Array.from(finalNodeIds).map(id => {
        const n = this.nodeMap.get(id)!;
        return { id: n.id, s: n.schema, n: n.name, t: n.type };
      }),
      edges: finalEdges,
      detail_slots: mem.detail_slots.filter(slot => finalNodeIds.has(slot.nodeId)),
      node_states: Array.from(this.nodeStates.values()),
      columnAspect: this.tracer?.deliveredState(borderSinks, this.columnRoots(), this.columnClosureDirection(), this.log, finalNodeIds) ?? null,
    };
  }

  /**
   * Emits the serializable active map state used by diagnostics and the presentation artifact's run record.
   *
   * @returns Plain object suitable for JSON output routines.
   */
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
      ...(this.renderDroppedIds.size > 0 ? { renderDroppedNodeIds: Array.from(this.renderDroppedIds) } : {}),
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

  /**
   * Flattens the engine's private working state into a serializable projection.
   *
   * @remarks
   * The companion to {@link toJSON}'s top-level fields: the private state the saved run records.
   * Maps and sets are flattened to arrays for the JSON boundary.
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
