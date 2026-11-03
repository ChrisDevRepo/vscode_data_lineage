import type { ClassificationValue } from '../session/classification';
import type {
  CapturedSection,
  DetailSlot,
  MemoryStateSnapshot,
} from '../session/memoryManager';
import type {
  ColumnTransformClass,
  IndirectFact,
  StepIndirectFact,
} from '../../engine/shared/bridgeContract';
import type { DepthSideValue } from '../../engine/shared/explorationDepthContract';
import type { ToolRejection } from '../support/toolErrorEnvelope';

/** Represents the current lifecycle stage of an SM exploration session. */
export type SmStatus =
  | 'created'
  | 'initialized'
  | 'exploring'
  | 'awaiting_findings'
  | 'complete'
  | 'error';

/**
 * Live progress for the hop loop: completed AI hops, queued nodes, display-safe total work, and
 * cumulative prunes.
 */
export type HopProgress = {
  current: number;
  open: number;
  total: number;
  pruned: number;
  added: number;
};

/** Engine-owned lifecycle action for a node in an SM result. */
export type SmNodeAction = 'analyze' | 'passthrough' | 'prune';

/** Who made the lifecycle decision for a node. */
export type SmNodeStateSource = 'ai' | 'engine' | 'user';

/** Why a node received its lifecycle action. Keeps the public action vocabulary small. */
export type SmNodeStateReason =
  | 'submitted_analyze'
  | 'submitted_passthrough'
  | 'storage_passthrough'
  | 'submitted_prune'
  | 'bb_prune_neighbor'
  | 'user_pass_filter';

/** Process state for one node in the SM traversal. */
export interface SmNodeState {
  nodeId: string;
  action: SmNodeAction;
  source: SmNodeStateSource;
  reason: SmNodeStateReason;
  /** Traced columns bound to the node; absent in BB sessions. */
  columns?: string[];
  /** Column-trace role at the hop that dispatched this node; absent in BB and before dispatch. */
  columnRole?: SmNodeColumnRole;
  /** Focus node this state was recorded from. */
  viaNodeId?: string;
  atHop?: number;
}

/** State and constraints for the column-tracing aspect of an exploration. */
export interface ColumnAspect {
  /** Target columns requested at session start. Immutable. */
  target_columns: string[];
  /** Columns relevant to the current focus node. Updated per-hop from the agenda entry. */
  active_columns: string[];
  /**
   * Accumulated validated dependencies recorded within the requested trace; absence of an edge does
   * not establish complete SQL provenance.
   */
  edges: ColumnEdge[];
  /** Indirect facts with the step node that uses each; never edges, never traced. */
  indirect?: StepIndirectFact[];
}

/** Structured attribution of data flow for a specific output column. */
export interface ColumnFlowEntry {
  /** SQL-established output column on `out_node`, else on the focus. */
  out_col: string;
  /**
   * Object owning `out_col` when it is not the focus; required at a procedure focus. Never inferred
   * from topology or matching column names.
   */
  out_node?: string;
  /**
   * Supported dependencies recorded within the requested trace; sections retain known outside
   * dependencies and unresolved evidence.
   */
  upstream_columns: ColumnRef[];
}

/**
 * A single upstream real column in the column trace chain.
 * @public
 */
interface ColumnRef {
  node: string;
  /** Name of the column in that neighbor (or `@param` for procedures). */
  col: string;
  /** Model-supplied transform classes; never defaulted. */
  transforms?: ColumnTransformClass[];
  /** One-clause model note ("SUM of line totals"), printed verbatim by the webview. */
  note?: string;
}

/**
 * One directed edge in the accumulated column lineage chain: one AI-supplied pair from a validated
 * `column_flow` entry's upstream column to its destination column.
 */
export interface ColumnEdge {
  hop_node: string;
  hop: number;
  from_node: string;
  /** Column name on the upstream node (or `@param` for procedures). */
  from_col: string;
  to_node: string;
  to_col: string;
  /** Transform classes carried verbatim from the contributor; absent when unclassified. */
  transforms?: ColumnTransformClass[];
  /** Model note carried verbatim beside {@link transforms}. */
  note?: string;
}

/** Metadata for a neighbor node encountered during a navigation hop. */
export interface HopNeighbor {
  id: string;
  /** Schema name. */
  s: string;
  /** Object name. */
  n: string;
  /** Object type (e.g., 'table', 'view', 'procedure'). */
  t: string;
  /** Direction relative to the focus node. */
  edge_direction: 'upstream' | 'downstream';
  /** The type of dependency (e.g., 'SELECT', 'INSERT', 'FK'). */
  edge_type: string;
  /**
   * For a table the focus writes, every column as `name, type, nullability[, PK|UQ|CK]`, the same
   * compact form a table focus carries. Otherwise, in a column trace, the neighbor's column names.
   */
  cols?: string[];
  /** Depth from origin (always surfaced when a depth budget is set). */
  depth_from_origin?: number;
  /**
   * The one served border flag: whether the neighbor lies inside the approved scope (border and
   * depth), the verdict the route, question and column scope checks apply.
   */
  in_approved_scope: boolean;
}

/** Enriched node JSON shipped to the AI; the keys vary with node type and DDL truncation. */
type HopFocusNode = Record<string, unknown>;

/** Encapsulates all information delivered to the AI for a single navigation hop. */
export interface HopContext {
  /** Set to `true` if there are no more nodes to visit in the agenda. */
  done?: boolean;
  /** Explicit engine status, delivered every hop. */
  sm_status?: SmStatus;
  hop?: number;
  /** Contract this hop is dispatched under. */
  analysis_mode?: 'bb' | 'ct';
  agenda_remaining?: number;
  focus_node?: HopFocusNode;
  /** Loaded caller SQL supplied beside formal parameters for semantic argument binding. */
  caller_objects?: Array<{ node: string; ddl: string }>;
  /** Explicit requested caller outputs; TVF investigations retain their own real output columns. */
  caller_requested_outputs?: ScalarReturnTarget[];
  neighbors?: HopNeighbor[];
  /** The specific sub-goal guiding this hop. */
  current_task?: string;
  /** Implementation-specific state carried across hops. */
  working_memory?: unknown;
  /**
   * Canonical mission statement, AI-composed at discovery and delivered verbatim every hop;
   * survives sliding-memory wipes.
   */
  mission_brief?: string;
}

/** One `prune_neighbors` entry: an unvisited neighbor removed on this node's SQL alone. */
interface PruneNeighbor {
  /** Neighbor id from `<hop_context>`. */
  id: string;
  /** Why this node's SQL shows the neighbor is off the answer. */
  reason: string;
}

/** One `questions` entry: a specific check the neighbor's own hop should establish. */
interface NeighborQuestion {
  /** Neighbor id from `<hop_context>`. */
  nodeId: string;
  /** The rule, filter or calculation to establish at that neighbor. */
  question: string;
  /** Real current caller output whose function contribution this investigation establishes. */
  caller_context?: ScalarReturnTarget;
}

/** Findings for the current SQL object. */
export interface HopFindingKept {
  /** ID of the node that was analyzed; omitted means the dispatched hop. */
  focus_node_id?: string;
  /**
   * Captured sections, one per fired `*_capture` template; the locked classification narrows
   * `angle`.
   */
  sections: CapturedSection[];
  /** One-line digest of the whole node, echoed via `short_term_memory`. */
  summary: string;
  /** Unvisited neighbors removed on this node's SQL alone, each with its reason. */
  prune_neighbors?: PruneNeighbor[];
  /** Purpose for each open kept neighbor; merged with existing tasks at that object. */
  questions?: NeighborQuestion[];
  /** Optional hop-time role hint for synthesis; not rendered directly. */
  badge_label?: string;
  /**
   * Structured attribution of column-level data flow. Required (and validated) on every CT hop;
   * ignored when the column aspect is inactive.
   */
  column_flow?: ColumnFlowEntry[];
  /** CT indirect columns of this step; they map, route and protect no neighbor. */
  indirect_columns?: IndirectFact[];
}

/** Data structure used by the AI to submit its findings after analyzing a hop. */
export type HopSubmission = HopFindingKept;

/** A qualified object-column endpoint, retaining its owning object. */
export interface ScalarReturnTarget {
  readonly node: string;
  readonly col: string;
}

/** Engine-validated provenance of a caller-authored function investigation. */
export interface FunctionCallerContext extends ScalarReturnTarget {
  readonly callerTaskId: string;
  readonly ddlHash: string;
}

/**
 * Explicit per-neighbor column demand: carried column names or row-only investigation. Qualified
 * endpoint identities stay on their tasks.
 */
export type ColumnCarry =
  | { readonly kind: 'carry'; readonly columns: readonly string[] }
  | { readonly kind: 'row_role_only' };

/** How a node served the traced columns at the hop that dispatched it. */
export type SmNodeColumnRole = 'carrier' | 'row_role_only';

/** Per-route outcome in a successful `submitFindings` return. */
export interface RouteOutcome {
  /** Node id of the route request (verbatim from submission, not lowercased). */
  nodeId: string;
  /** True when added to the agenda for exploration. */
  accepted: boolean;
  /** True when queued as a post-synthesis follow-up offer (SM mode, out of scope). */
  deferred?: boolean;
  /**
   * Reason for deferral: `depth`, `out_of_direction`, `excluded`, `schema` (each recorded as a
   * follow-up offer, never loaded), `already_visited` or `already_pruned` (visit-once, no new hop).
   */
  reason?:
    | 'depth'
    | 'out_of_direction'
    | 'excluded'
    | 'schema'
    | SettledRouteReason;
}

/** Route reasons for a target an earlier hop already settled (visit-once). */
type SettledRouteReason = 'already_visited' | 'already_pruned';

/** Per-node enqueue disposition: settled earlier or not enqueued for a scope/depth reason. */
export type RouteSkipDisposition = SettledRouteReason | 'not_enqueued';

/** Result of `submitFindings`: an ack or a reject. */
export type SubmitResult =
  | {
      /** Indicates the submission was accepted (the `ack` side of the ack/reject contract). */
      ok: true;
      /**
       * Disposition of every neighbor this hop enqueued, deferred, did not follow or found settled.
       */
      route_outcomes?: RouteOutcome[];
      /**
       * Arriving columns `node.col` that no mapping carried on; their trace ends at this hop.
       * Absent when none.
       */
      ended_columns?: string[];
      /**
       * Optional fields an earlier rejection found faulty and this call omitted: not committed.
       * Absent when none.
       */
      withdrawn?: string[];
      /**
       * Nodes this commit removed because a prune named them: a resolved `prune_neighbors` entry or
       * the pruned current node. Absent when none.
       */
      pruned?: string[];
      /**
       * Open nodes this commit removed only because every directed path from the origin to them ran
       * through a pruned node. Absent when none.
       */
      cut_ids?: string[];
    }
  | ToolRejection;

/** Per-hop engine diagnostics — single structured snapshot for logging + AI visibility. */
export interface DiagnosticsSnapshot {
  /** 1-based hop index. */
  hop: number;
  focus: string;
  schema: string;
  depth: number;
  /** Active depth budget (null if none was passed). */
  depthBudget: number | null;
  depthEnforcement: 'strict' | 'silent';
  inSchema: boolean;
  /** Verdict the AI emitted for this hop (`null` before any submit_findings). */
  verdict: 'analyze' | 'passthrough' | 'prune' | null;
  detailChars: number;
  summaryChars: number;
  archiveChars: number;
  routedNew: number;
  /** Neighbor references rejected this hop (validation, schema gate, depth gate). */
  routedRejected: number;
  /**
   * Neighbors deferred this hop (SM mode — out-of-approved-scope neighbors captured for synthesis).
   */
  routedDeferred: number;
  /** Cumulative size of the SM deferred-questions bucket across the session. */
  deferredQueued: number;
  agendaRemaining: number;
  /**
   * Rolling tally across the session: analyze/passthrough verdicts + cumulative engine prune count.
   */
  tally: { analyze: number; passthrough: number; prune: number };
  /** Count of soft/silent-mode scope expansions since session start. */
  scopeExpansions: number;
  /** Count of schemas the user has confirmed mid-session (session allowlist size). */
  allowedSchemaCount: number;
  columnEdgeCount?: number;
  /** Number of active target columns for the current hop (CT only). */
  activeColumnCount?: number;
  /** Number of column_flow entries submitted this hop (CT only). */
  columnFlowEntries?: number;
}

/** Per-(schema,type) leaf in the scope tree. */
export interface ScopeSummaryLeaf {
  /** Bodied-node count (view / procedure / function) at this leaf — agenda candidates. */
  hops: number;
  /** Total node count at this leaf, including non-bodied (table / external) entries. */
  scope: number;
  /** Object names at this leaf, alphabetised for stable rendering. */
  nodeNames: string[];
  /** Names beyond a caller's bound — `nodeNames.length + omitted === scope` for the leaf. */
  omitted: number;
}

/**
 * Excluded objects of one group: the total and every object, keyed by object type, alphabetised.
 */
export interface ScopeExclusionGroup {
  /** Objects in the group across every type. */
  count: number;
  /** Object type → the excluded objects of that type. */
  byType: Record<string, Array<{ schema: string; name: string }>>;
}

/** Excluded objects split by cause. */
export interface ScopeExclusions {
  rules: Array<ScopeExclusionGroup & { pattern: string }>;
  named: ScopeExclusionGroup;
}

/** Snapshot of the proposed scope, computed once per `confirm_sm_start` gate emission. */
export interface ScopeSummary {
  /** Source comparison policy for rendering object and schema identities; absent retains CI. */
  identifierCaseSensitive?: boolean;
  /** Total bodied-node count across the scope — drives the "N hops" header in the gate. */
  hopCount: number;
  /** Total node count across the scope (bodied + non-bodied) — drives the "N nodes" header. */
  scopeCount: number;
  /** Origin node id captured at `start_exploration` — anchors the BFS root. */
  origin: string;
  /** Human-readable origin label for gate/UI summaries; falls back to `origin` when unresolved. */
  originLabel?: string;
  /**
   * Model-authored goal statement from `mission_brief`, verbatim. Undefined when the model sent
   * none — the gate renders no Goal line rather than backend-authored placeholder prose.
   */
  missionBrief?: string;
  /** Effective depth budget set at `start_exploration`; `null` when unbounded ("all"). */
  depth: number | null;
  /** AI-owned depth verdict that seeded the scope — drives the gate's depth chip label. */
  depthIntent: DepthIntent;
  direction: 'upstream' | 'downstream' | 'bidirectional';
  /** Explicit exploration mode approved before hop-by-hop analysis. */
  analysisMode: 'bb' | 'ct';
  /** True when the session has `targetColumns` (column-trace aspect). */
  columnAspectActive: boolean;
  /** Target columns being traced, present when `columnAspectActive` is true. */
  targetColumns?: string[];
  /** Approximate UTF-16 DDL character count across the proposed scope. */
  estimatedDdlChars: number;
  /** Approximate DDL token count (1 token ~= 4 chars) across the proposed scope. */
  estimatedDdlTokens: number;
  /** Schema → type → leaf rollup used by `renderScopeSummaryMd` to reproduce the approval tree. */
  bySchema: Record<
    string,
    { hops: number; scope: number; byType: Record<string, ScopeSummaryLeaf> }
  >;
  /**
   * Per object type, lowercased names that recur in more than one schema of the loaded model, so
   * the card renderer can schema-qualify them.
   */
  ambiguousObjectNames?: Record<string, readonly string[]>;
  /** Active filter set on the engine — surfaces what the user has narrowed so far. */
  activeFilters: {
    schemas: string[];
    types: string[];
    nodeIds: string[];
    passNodeIds: string[];
  };
  /**
   * Every schema of the loaded model that `activeFilters` does not exclude, alphabetised, so a
   * renderer can state the filter from its shorter side.
   */
  selectedSchemas?: string[];
  /**
   * Excluded objects of `activeFilters` grouped by what excluded them, for the approval card and
   * full plan.
   */
  exclusions?: ScopeExclusions;
  /**
   * Analysis constraints the user stated that no filter field can express, verbatim; echoed at the
   * approval gate for confirmation.
   */
  scopeNotes: string[];
  /**
   * Gate-locked mission-type verdict; the per-dispatch `submit_findings` schema narrows `sections`
   * to the angle(s) it keeps.
   */
  classification?: ClassificationValue;
}

/** Represents a node within the final synthesized result set. */
interface ResultNode {
  id: string;
  /** Schema name. */
  s: string;
  /** Object name. */
  n: string;
  /** Object type. */
  t: string;
}

/** The final, immutable output of a completed State Machine exploration. */
export interface SmResult {
  /** Always `complete`: the engine builds a result only once its agenda is drained. */
  status: 'complete';
  originNodeId: string;
  fullNodes: ResultNode[];
  edges: Array<[string, string, string]>;
  /** High-fidelity analysis artifacts for each visited node. */
  detail_slots: DetailSlot[];
  /** Engine-owned lifecycle state for result nodes and pruned/contracted nodes. */
  node_states: SmNodeState[];
  /** Column lineage chain. Present when CT was active for this session; null otherwise. */
  columnAspect: ColumnAspect | null;
}

/** A route request to an out-of-approved-scope node, captured during an SM session. */
export interface DeferredQuestion {
  nodeId: string;
  /** Schema of the target — the reason for schema-class deferral. */
  schema: string;
  fromFocusNodeId: string;
  question: string;
  reason: 'schema' | 'depth' | 'direction' | 'excluded';
  /** Depth-from-origin of the target. Populated when `reason` includes 'depth'. */
  depth?: number;
  atHop: number;
}

/** Fields shared by every engine-owned investigation task. */
interface InvestigationTaskBase {
  /** Stable deterministic identifier derived from the normalized task identity. */
  id: string;
  source: 'mission' | 'model' | 'engine';
  /** Question the hop must answer, as authored; synthesis receives only this text. */
  question: string;
  nodeId?: string;
  /** Parent task for a routed or contracted continuation. */
  parentTaskId?: string;
  /** Engine-owned storage object through which this task arrived. */
  passthroughFromNodeId?: string;
  /** Directed routing leg retained through table and user-pass contraction. */
  traversalSide?: 'upstream' | 'downstream';
  status: 'pending' | 'active' | 'resolved' | 'deferred';
  createdHop: number;
  resolvedHop?: number;
  /** Explicit caller declaration anchored to its originating task and SQL snapshot. */
  callerContext?: FunctionCallerContext;
}

/**
 * Engine-owned unit of investigation. Questions remain structured state rather than agenda prose.
 */
export type InvestigationTask = InvestigationTaskBase &
  (
    | {
        /** BB root mission or analytical sub-question. */
        kind: 'root' | 'analytical';
        /** BB tasks structurally forbid column state. */
        activeColumns?: never;
      }
    | {
        /** CT lineage continuation, including the CT root mission. */
        kind: 'column_lineage';
        /** Non-empty canonical column context for this CT task. */
        activeColumns: [string, ...string[]];
        /** Qualified incoming column context; a task does not itself create a column edge. */
        sourceRefs?: Array<{ node: string; col: string }>;
      }
  );

/** Valuable investigation deliberately left outside the approved run boundary. */
export interface PendingLead {
  id: string;
  /** Deferred task that retains the original question. */
  taskId: string;
  nodeId: string;
  fromNodeId: string;
  /** Mechanical boundary that prevented exploration in the current run. */
  reason:
    | 'schema_boundary'
    | 'depth_boundary'
    | 'contracted_scope'
    | 'budget'
    | 'insufficient_evidence'
    | 'out_of_direction'
    | 'excluded'
    | 'pruned_by_ai';
  /** Target schema used by the derived synthesis projection. */
  schema?: string;
  /** Target depth retained when a depth boundary created the lead. */
  depth?: number;
  /** Concise grounded explanation shown to the user. */
  valueToUser: string;
  status: 'pending' | 'scheduled' | 'resolved' | 'dismissed';
  createdHop: number;
}

/** A neighbour a resolved AI prune removed, with the sender's own reason. */
export interface PrunedBranch {
  nodeId: string;
  /** Focus whose hop voted the prune. */
  fromFocusNodeId: string;
  /** The sender's `prune_neighbors[].reason`, verbatim. */
  reason: string;
}

/** The border the user approved at session start — locked for the rest of the SM session. */
export interface ApprovedBorder {
  /** Lower-cased schemas in scope. */
  schemas: string[];
  /**
   * Effective depth ceiling including mode headroom and any session extensions, or null when no
   * depth budget is set.
   */
  depth_cap: number | null;
}

/**
 * The `init` parameters captured so the refine path can re-run init without the AI resending them.
 */
export interface EngineInitSnapshot {
  question: string;
  origin: string;
  /** Explicit exploration mode approved before hop-by-hop analysis. */
  analysisMode: 'bb' | 'ct';
  /** Target columns when a column-trace aspect is active. */
  targetColumns?: [string, ...string[]];
  direction: 'upstream' | 'downstream' | 'bidirectional';
  depthIntent: DepthIntent;
  mission_brief?: string;
}

/**
 * AI-owned depth verdict consumed by `NavigationEngine.init()`: a level and an exactness per side.
 */
export interface DepthIntent {
  /** Verdict for the upstream side; `levels: 0` permanently closes it. */
  upstream: DepthSideValue;
  /** Verdict for the downstream side; `levels: 0` permanently closes it. */
  downstream: DepthSideValue;
}

/**
 * Placeholder question stored on {@link NavigationInitParams.question} when the model proposes an
 * exploration without restating the user's ask.
 */
export const DEFAULT_EXPLORATION_QUESTION = 'Explore lineage';

/** Fully resolved mechanical inputs used to preview or initialize one exploration. */
export interface NavigationInitParams {
  /**
   * Canonical user question the exploration answers; the {@link DEFAULT_EXPLORATION_QUESTION}
   * placeholder when no user text is available.
   */
  question: string;
  origin: string;
  /** Exploration mode; omitted resolves to `ct` when `targetColumns` is set, `bb` otherwise. */
  analysisMode?: 'bb' | 'ct';
  /** Columns the column-trace aspect follows; required for `ct`, forbidden in `bb`. */
  targetColumns?: string[];
  /** Exploration direction; defaults to `bidirectional`. */
  direction?: 'upstream' | 'downstream' | 'bidirectional';
  /**
   * Depth verdict that seeds and bounds the scope, one binding per side; required on every fresh
   * proposal.
   */
  depthIntent: DepthIntent;
  excludeTypes?: string[];
  excludeSchemas?: string[];
  excludeNodeIds?: string[];
  /** Node ids kept in scope but skipped for analysis (auto pass-through). */
  passNodeIds?: string[];
  /** Analysis constraints the user stated that no filter field expresses; carried verbatim. */
  scopeNotes?: string[];
  /** Sanitized mission brief carried verbatim into every hop. */
  mission_brief?: string;
}

/**
 * Serializable projection of the {@link NavigationEngine}'s private working state not already
 * carried by the top-level fields of {@link SmState}.
 */
export interface EngineInternalsSnapshot {
  originNodeId: string | null;
  direction: 'upstream' | 'downstream' | 'bidirectional';
  /** User-declared depth budget, or null when unbounded. */
  depthBudget: number | null;
  depthEnforcement: 'strict' | 'silent';
  /** Per-side ceilings, `null` where that side is unbounded; absent in a v1 saved run. */
  depthLimits?: { upstream: number | null; downstream: number | null };
  /** BFS depth-from-origin, flattened to `[nodeId, depth]` pairs (insertion order preserved). */
  depthFromOrigin: Array<[string, number]>;
  /** Out-of-budget expansions allowed in soft/silent mode. */
  budgetExpansions: Array<{ nodeId: string; depth: number; atHop: number }>;
  /** Total acknowledged bodied nodes (drives `hopProgress.total`). */
  totalNodes: number;
  /** Schemas in the user's active filter (initial route-validation allowlist). */
  userSchemas: string[];
  /** Session-scoped schema allowlist (grows via mid-session confirmations). */
  sessionAllowedSchemas: string[];
  excludedTypes: string[];
  excludedSchemas: string[];
  excludedNodeIds: string[];
  /** Object types hidden by the GUI filter at session start (advisory diagnostics). */
  guiHiddenTypes: string[];
  passNodeIds: string[];
  /** Agenda-entry question captured at dequeue for the current focus. */
  currentFocusQuestion: string | null;
  currentFocusTaskIds: string[];
  lastCurrentTask: string;
  /** AI-composed discovery summary memo (survives sliding-memory wipes). */
  discoverySummary: string | null;
  archiveChars: number;
  lastHopDetailChars: number;
  lastHopSummaryChars: number;
  lastHopVerdict: 'analyze' | 'passthrough' | 'prune' | null;
  lastHopColumnFlowEntries: number;
  lastRoutedNew: number;
  lastRoutedRejected: number;
  lastRoutedDeferred: number;
  investigationTasks: InvestigationTask[];
  pendingLeads: PendingLead[];
  /** The `init` params snapshot kept for the refine re-run. */
  initSnapshot: EngineInitSnapshot | null;
  /** Accepted when reading older snapshots; current runs omit it. */
  supplementNodeIds?: string[];
  /** Accepted prune/keep votes not yet resolved because another sender remains live. */
  pruneBallots?: Array<{
    nodeId: string;
    votes: Array<{ senderId: string; vote: 'prune' | 'keep' }>;
  }>;
  /** Held finding and its authorization, recorded together. */
  heldFinding?: {
    focusId: string;
    hop: number;
    mode: 'bb' | 'ct';
    failed: string[];
    alternatives?: string[];
    finding: HopFindingKept;
  } | null;
  /** Continuation-state format marker, written as `1`. */
  continuationVersion?: 1;
}

/** Serialized state-machine projection: the state dump and the saved run's snapshot. */
export interface SmState {
  /** Current fail-closed persistence contract version. */
  snapshotVersion: 1 | 2;
  /** Source identifier policy at capture; an absent field denotes a legacy CI saved run. */
  identifierCaseSensitive?: boolean;
  columnAspect: ColumnAspect | null;
  status: SmStatus;
  hopCount: number;
  scopeSize: number;
  scopeNodeIds: string[];
  visited: string[];
  removedSet: string[];
  nodeStates: SmNodeState[];
  agendaSize: number;
  agenda: Array<{
    /** All task ids answered by the node's single hop. */
    taskIds: string[];
    nodeId: string;
    /** The priority of this visit; higher dequeues first. */
    priority: number;
    depth: number;
    activeColumns?: string[];
    /**
     * CT chain-continuation questions opened for this node by an earlier hop, owned by this entry.
     */
    lineageQuestions?: string[];
    /**
     * Per-neighbour column-carry decision that survived contraction (`carry` / `row_role_only`).
     */
    columnCarry?:
      | ColumnCarry
      | {
          readonly kind: 'scalar_return';
          readonly outputs: readonly ScalarReturnTarget[];
        };
  }>;
  currentFocusNodeId: string | null;
  memory: MemoryStateSnapshot;
  engineInternals: EngineInternalsSnapshot;
  /**
   * Lineage questions owned by the in-flight hop's {@link AgendaEntry}, captured at dispatch (CT
   * only).
   */
  lineageQuestionsLastHop?: string[];
  /** Ignored; accepted for old saved runs. */
  ctPrunedNodeIds?: string[];
  /** Recorded column-edge endpoint IDs; the key is kept readable for old checkpoints. */
  ctDeclaredRouteIds?: string[];
  /** Ignored; accepted for old saved runs. */
  renderDroppedNodeIds?: string[];
}

/** Log entry representing a single tool invocation within the SM lifecycle. */
export interface HopLogEntry {
  tool: string;
  input: unknown;
  output: unknown;
  timestamp: string;
}

/** Kinds of invalid routes during exploration. */
export type InvalidRouteKind =
  | 'absent_contributor'
  | 'bad_out_col'
  | 'bad_contributor_col'
  | 'self_loop_column'
  | 'bad_caller_context'
  | 'pruned_contributor'
  | 'column_out_of_scope'
  | 'prune_absent'
  | 'prune_noop_removed'
  | 'prune_noop_visited'
  | 'prune_noop_analyzed'
  | 'prune_noop_out_of_scope'
  | 'prune_unsupported'
  | 'prune_question_conflict'
  | 'question_not_neighbor'
  | 'question_closed'
  | 'neighbor_outcome_missing';

/** Represents an invalid route returned during validation. */
export interface InvalidRoute {
  kind: InvalidRouteKind;
  id: string;
  reason: string;
  /**
   * Alternative fields that can supply a missing decision without invalidating supplied content.
   */
  alternatives?: string[];
  /** Exact submit_findings field path that must be corrected. */
  path?: string;
  /** Possible values for the failing field, disclosed by the shared rejection escalation. */
  allowed_values?: string[];
  /** Object qualifier for column choices. */
  when?: { node: string };
}
