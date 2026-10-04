/**
 * Navigation Engine hop lifecycle types.
 *
 * Concrete types for the IHopStateMachine contract — replaces `any` returns.
 * Keep this file dependency-free (only imports `memoryManager` types + scalar
 * types from smBase) so it can be unit-tested without a live engine.
 */

import type { ClassificationValue } from '../session/classification';
import type { CapturedSection, DetailSlot, MemoryStateSnapshot } from '../session/memoryManager';
import type { ColumnTransformClass } from '../../engine/shared/bridgeContract';
import type { DepthSideValue } from '../../engine/shared/explorationDepthContract';
import type { ToolRejection } from '../support/toolErrorEnvelope';


/**
 * Represents the current lifecycle stage of an SM exploration session.
 */
export type SmStatus = 'created' | 'initialized' | 'exploring' | 'awaiting_findings' | 'complete' | 'error';

/** Live progress for the hop loop: completed AI hops, queued nodes, display-safe total work, and cumulative prunes. */
export type HopProgress = { current: number; open: number; total: number; pruned: number; added: number };

/**
 * Flags identifying structural boundaries encountered during graph traversal.
 */
export type BoundaryFlag = 'none' | 'source' | 'sink' | 'external' | 'cycle';

/**
 * The focus node's self-status submitted each hop. Two states:
 * `analyze` = the node applies business logic on the data path (sections stored, featured in the answer);
 * `passthrough` = the node is on the data path but applies no logic (a raw source / bridge / target
 *   table, a SELECT * or synonym) — it is KEPT in the lineage and linked by flow role, and the trace
 *   continues *through* it, or it carries nothing further (a dead end).
 * Off-path neighbors leave through `prune_neighbors` (recorded as node action `prune`).
 */
export type Verdict = 'analyze' | 'passthrough';

/** Engine-owned lifecycle action for a node in an SM result. Mirrors {@link Verdict}. */
export type SmNodeAction = 'analyze' | 'passthrough' | 'prune';

/** Who made the lifecycle decision for a node. */
export type SmNodeStateSource = 'ai' | 'engine' | 'user';

/** Why a node received its lifecycle action. Keeps the public action vocabulary small. */
export type SmNodeStateReason =
  | 'submitted_analyze'
  | 'submitted_passthrough'
  | 'submitted_prune'
  | 'bb_prune_neighbor'
  | 'user_pass_filter'
  | 'non_bodied_passthrough';

/**
 * Process state for one node in the SM traversal.
 *
 * @remarks
 * This is the source of truth for lifecycle state. `DetailSlot` remains only
 * the text/evidence bucket; a node can be `passthrough` without having a detail slot.
 */
export interface SmNodeState {
  /** Canonical id of the node this state describes. */
  nodeId: string;
  /** Lifecycle action taken on the node. */
  action: SmNodeAction;
  /** Who made the lifecycle decision. */
  source: SmNodeStateSource;
  /** Why the node received its action. */
  reason: SmNodeStateReason;
  /** Traced columns bound to the node; absent in BB sessions. */
  columns?: string[];
  /**
   * Column-trace role at the hop that dispatched this node — a carrier of traced columns, or a
   * node that only decides which rows the answer returns. Absent in BB and on any node no hop has
   * dispatched yet; `columns` cannot express it, because an empty column set and an unstated one
   * are both dropped from the record.
   */
  columnRole?: SmNodeColumnRole;
  /** Focus node this state was recorded from. */
  viaNodeId?: string;
  /** Hop index at which this state was recorded. */
  atHop?: number;
}

/**
 * State and constraints for the column-tracing aspect of an exploration.
 */
export interface ColumnAspect {
  /** Target columns requested at session start. Immutable. */
  target_columns: string[];
  /** Columns relevant to the current focus node. Updated per-hop from the agenda entry. */
  active_columns: string[];
  /**
   * Accumulated validated column lineage edges, appended each hop.
   * A branch is terminal when a submitted flow entry has no upstream real columns.
   * Completeness is structural — derivable from this array; no completion flag needed.
   */
  edges: ColumnEdge[];
}

/**
 * Structured attribution of data flow for a specific output column.
 */
export interface ColumnFlowEntry {
  /** Column name on the focus node, or procedure parameter prefixed with @. */
  out_col: string;
  /**
   * Explicit destination column written by this focus. A named destination stages
   * `focus_node.out_col → writes_to.node.writes_to.col`, including terminal writes with no
   * upstream contributors. Contributor attribution lands on the named destination.
   * Explicit null records no table write; omission attributes to the focus without inferring
   * a destination from topology or matching column names.
   */
  writes_to?: { node: string; col: string } | null;
  /** Declared real caller output supplied by a scalar-return task; never a table write. */
  returns_to?: ScalarReturnTarget;
  /**
   * Real upstream columns that continue this trace. Empty means the active column is
   * produced/terminates here and there is no upstream real column to route.
   */
  upstream_columns: ColumnRef[];
}

/**
 * A single upstream real column in the column trace chain.
 */
interface ColumnRef {
  /** ID of the neighbor node providing the data. */
  node: string;
  /** Name of the column in that neighbor (or `@param` for procedures). */
  col: string;
  /**
   * Optional transform classification for this contributor. Absent when the model did not classify
   * it; the engine never substitutes a default.
   */
  transforms?: ColumnTransformClass[];
  /**
   * Optional one-clause model note for the contributor ("SUM of line totals"). Surface text the
   * webview prints verbatim; nothing parses it, so an absent note degrades to the structural
   * description.
   */
  note?: string;
}

/**
 * One directed edge in the accumulated column lineage chain.
 * Built from validated `column_flow` submissions: one edge per upstream real column, plus the
 * focus→carrier writer edge each entry with a resolved write target stages.
 */
export interface ColumnEdge {
  /** Focus node where this edge was analyzed. */
  hop_node: string;
  /** Hop number when this edge was captured. */
  hop: number;
  /** Upstream node. */
  from_node: string;
  /** Column name on the upstream node (or `@param` for procedures). */
  from_col: string;
  /** Downstream consumer node. */
  to_node: string;
  /** Column name on the consumer. */
  to_col: string;
  /**
   * Transform classification carried verbatim from the submitting contributor. Absent when the
   * model supplied none — an unclassified edge stays unclassified across the hop.
   */
  transforms?: ColumnTransformClass[];
  /**
   * One-clause model note carried verbatim beside {@link transforms}. Absent whenever the model
   * offered none — the webview then describes the edge structurally instead.
   */
  note?: string;
}


/**
 * Metadata for a neighbor node encountered during a navigation hop.
 *
 * @remarks
 * This structure provides the AI with enough context to decide whether to visit
 * a node without needing to fetch its full DDL.
 */
export interface HopNeighbor {
  /** Unique identifier for the neighbor node. */
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
  /** Indicates if this node is a traversal boundary. */
  boundary: BoundaryFlag;
  /** Human-readable explanation for the boundary flag. */
  boundary_reason?: string;
  /** Current state of this node within the navigation engine's agenda. */
  scope?: 'visited' | 'agenda' | 'pruned' | 'available' | 'external';
  /** List of columns pertinent to the current trace, if applicable. */
  cols?: string[];
  /** Depth from origin (always surfaced when a depth budget is set). */
  depth_from_origin?: number;
  /** False when this node is beyond the active depth budget. Always surfaced when budget is set. */
  in_budget?: boolean;
  /**
   * Whether a route to this node would be admitted: inside the approved border (exclusions,
   * direction) and the stated depth. Always surfaced; it is the same verdict the
   * prune and route validators apply.
   *
   * @remarks
   * In SM sessions the approved scope is locked at `confirm_sm_start`; routes to out-of-scope
   * neighbors are deferred (not rejected) and surfaced at synthesis.
   */
  in_approved_scope?: boolean;
}

/**
 * Enriched-node shape built by `buildHopFocusNode` and shipped to the AI as JSON.
 * Always a plain object; the keys present depend on node type (DDL vs columns) and
 * whether the DDL was truncated.
 */
type HopFocusNode = Record<string, unknown>;

/**
 * Encapsulates all information delivered to the AI for a single navigation hop.
 *
 * @remarks
 * SM ships one focus node per hop. CT activates when `targetColumns` is provided
 * at `start_exploration` and operates within the same SM hop loop.
 */
export interface HopContext {
  /** Set to `true` if there are no more nodes to visit in the agenda. */
  done?: boolean;
  /** Explicit engine status, delivered every hop. */
  sm_status?: SmStatus;
  /** The current hop index. */
  hop?: number;
  /**
   * The contract this hop is dispatched under — mode as data, not as prose the model must infer.
   *
   * @remarks
   * `ct` when this hop carries at least one traced column, `bb` otherwise — per hop, therefore per
   * edge, so the same node reached on a carrying edge and a row-shaping edge is dispatched under
   * each contract in turn.
   */
  analysis_mode?: 'bb' | 'ct';
  /** Count of nodes still on the agenda. */
  agenda_remaining?: number;
  /** The node currently being analyzed. */
  focus_node?: HopFocusNode;
  /** Exact compiler-declared real destinations for the active scalar return task. */
  caller_output_targets?: ScalarReturnTarget[];
  /** Loaded caller SQL supplied beside formal parameters for semantic argument binding. */
  caller_objects?: Array<{ node: string; ddl: string }>;
  /** Explicit requested caller outputs; TVF investigations retain their own real output columns. */
  caller_requested_outputs?: ScalarReturnTarget[];
  /** List of immediate neighbors available for further exploration. */
  neighbors?: HopNeighbor[];
  /** The specific sub-goal guiding this hop. */
  current_task?: string;
  /** Implementation-specific state carried across hops. */
  working_memory?: unknown;
  /**
   * Canonical mission statement — AI-composed at discovery, delivered verbatim every hop.
   * Survives sliding-memory wipes. Anchors verdicts and respects NL filters the user expressed.
   */
  mission_brief?: string;
}

/** One `prune_neighbors` entry: an unvisited neighbor removed on this node's SQL alone. */
export interface PruneNeighbor {
  /** Neighbor id from `<hop_context>`. */
  id: string;
  /** Why this node's SQL shows the neighbor is off the answer. */
  reason: string;
}

/** One `questions` entry: a specific check the neighbor's own hop should establish. */
export interface NeighborQuestion {
  /** Neighbor id from `<hop_context>`. */
  nodeId: string;
  /** The rule, filter or calculation to establish at that neighbor. */
  question: string;
  /** Real current caller output whose function contribution this investigation establishes. */
  caller_context?: ScalarReturnTarget;
}

/**
 * A kept (`analyze` / `passthrough`) finding for a focus node.
 *
 * @remarks
 * Neighbor decisions are exceptions only: the engine enqueues every open in-scope neighbor not
 * named in `prune_neighbors`, and `questions` attaches a check to one of them. In CT the column
 * carry each neighbor receives is derived from this finding's own `column_flow`.
 */
export interface HopFindingKept {
  /** ID of the node that was analyzed. */
  focus_node_id: string;
  /**
   * Captured sections, one per fired `*_capture` template; the locked classification narrows
   * `angle` to the approved angle(s) before dispatch, so an off-classification angle is never authored.
   */
  sections: CapturedSection[];
  /** One-line digest of the whole node (across all captured angles), echoed via `short_term_memory`. */
  summary: string;
  /** The relevance verdict for the focus node. */
  verdict: 'analyze' | 'passthrough';
  /** Unvisited neighbors removed on this node's SQL alone, each with its reason; the cut takes what only they lead to. */
  prune_neighbors?: PruneNeighbor[];
  /** Optional per-neighbor checks, attached to that neighbor's queued hop. */
  questions?: NeighborQuestion[];
  /** Optional hop-time role hint for synthesis; not rendered directly. */
  badge_label?: string;
  /**
   * Structured attribution of column-level data flow.
   * Required (and validated) on every CT hop; ignored when the column aspect is inactive.
   */
  column_flow?: ColumnFlowEntry[];
}

/** A single finding for a focus node. Off-path neighbors leave through `prune_neighbors`. */
export type HopFinding = HopFindingKept;

/**
 * Data structure used by the AI to submit its findings after analyzing a hop.
 */
export type HopSubmission = HopFinding;

/** A qualified real caller column whose expression declares the scalar function. */
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
 * Explicit per-neighbor column demand: ordinary columns, row-only investigation, or compiler-declared
 * scalar caller outputs. Qualified outputs stay separate when callers share a column name.
 */
export type ColumnCarry =
  | { readonly kind: 'carry'; readonly columns: readonly string[] }
  | { readonly kind: 'row_role_only' }
  | { readonly kind: 'scalar_return'; readonly outputs: readonly ScalarReturnTarget[] };

/**
 * How a node served the traced columns at the hop that dispatched it.
 *
 * @remarks
 * Orthogonal to {@link SmNodeAction} and {@link SmNodeStateReason}, which answer what happened to
 * the node and why. A node can be analyzed, passed through, or pruned under either role, so the
 * role is its own field and survives a later, stronger verdict instead of being overwritten by it.
 */
export type SmNodeColumnRole = 'carrier' | 'row_role_only';

/**
 * Per-route outcome in a successful `submitFindings` return.
 *
 * @remarks
 * Engine-side record only: the `lineage_submit_findings` tool returns the ack and the next focus,
 * never this array, so the model does not see it. The engine writes one debug host-log line per
 * non-accepted outcome where the hop's outcomes are finalized. Every deferred route is also recorded as a
 * {@link DeferredQuestion}, which reaches the synthesis completion envelope and post-synthesis
 * follow-up offers. An excluded target requires a new scope proposal before analysis.
 */
export interface RouteOutcome {
  /** Node id of the route request (verbatim from submission, not lowercased). */
  nodeId: string;
  /** True when added to the agenda for exploration. */
  accepted: boolean;
  /** True when queued as a post-synthesis follow-up offer (SM mode, out of scope). */
  deferred?: boolean;
  /**
   * Reason for deferral:
   * - `depth` — route target lies past a depth border the user stated; user will see it as a follow-up offer.
   * - `depth_contracted_beyond_budget` — legacy outcome for a non-bodied route without an enqueued hop.
   * - `non_bodied_passthrough` — the in-scope non-bodied neighbor is retained without a separate analysis hop; no follow-up is created for it.
   * - `unresolved` — route target is absent from the loaded model and was skipped with a notice.
   * - `out_of_direction` — route target exists but is not reachable in the approved traversal direction; never loaded, so a named question is recorded as a follow-up offer.
   * - `excluded` — route target exists but is outside the user's approved exclude filters; never loaded, so a named question is recorded as a follow-up offer.
   * - `schema` — route target's schema is outside the session's GUI schema filter, not a
   *   user-authored exclusion; never loaded, so a named question is recorded as a follow-up offer
   *   that can be granted through a new proposal.
   * - `already_visited` — route target (or a bodied writer a non-bodied target contracted to) was already analyzed on an earlier hop; visit-once, no new hop.
   * - `already_pruned` — same as `already_visited`, for a node pruned on an earlier hop.
   * - `carries_no_tracked_column` — legacy checkpoint reason; no longer emitted.
   */
  reason?: 'depth' | 'depth_contracted_beyond_budget' | 'non_bodied_passthrough' | 'unresolved' | 'out_of_direction' | 'excluded' | 'schema' | SettledRouteReason;
}

/** Settled route reasons. `carries_no_tracked_column` is retained only for historical checkpoints. */
export type SettledRouteReason = 'already_visited' | 'already_pruned' | 'carries_no_tracked_column';

/** Per-node enqueue disposition: settled by an earlier hop or not enqueued for a scope/depth reason. */
export type RouteSkipDisposition = SettledRouteReason | 'not_enqueued';

/**
 * Chain extension of a supplement: walk from each named id in one direction, `depth` steps or to
 * the end (`'all'`).
 */
export interface SupplementChain {
  /** Direction to walk from each named id. */
  direction: 'upstream' | 'downstream';
  /** Steps to walk, or `'all'` to walk to the end of the chain. */
  depth: number | 'all';
}

/**
 * Per-node drop notice from `supplementAgenda`.
 *
 * @remarks
 * Reported alongside the aggregate `skipped` count so a caller can surface WHICH id was
 * refused and WHY, mirroring {@link RouteOutcome}'s drop-with-notice shape.
 */
export interface SupplementSkip {
  /** Node id as supplied in the supplement request (verbatim, not lowercased). */
  nodeId: string;
  /**
   * Reason for the drop:
   * - `unresolved` — node id does not exist in the loaded graph model.
   * - `excluded` — node exists but is outside the user's own approved exclude filters
   *   (`excludedNodeIds` / `excludedTypes` / a schema the user typed that the GUI does not hide).
   * - `out_of_allowlist` — node exists, but its schema is unticked in the GUI schema filter (the
   *   session allowlist) — including a schema the user also typed, since the GUI hides it anyway.
   *   `hint` always accompanies this reason.
   * - `not_connected_to_trace` — node exists and is not excluded, but has no dependency path to the
   *   traced graph — the wire form of `REJECTION_CODES.notConnectedToTrace`. `hint` always
   *   accompanies this reason.
   *
   * Both `excluded` and `out_of_allowlist` are a hard wall for every supplement id, named directly
   * or chain-reached: a follow-up asking for an out-of-filter object does not itself widen the
   * border — it reopens approval for that object instead of admitting it.
   */
  reason: 'excluded' | 'out_of_allowlist' | 'unresolved' | 'not_connected_to_trace';
  /**
   * Recovery text for the model, populated for `not_connected_to_trace` — a separate exploration on
   * the id directly is the repair. Also populated for `out_of_allowlist` — starting a new
   * `lineage_start_exploration` proposal that names it reopens the `confirm_sm_start` gate for the
   * user's approval.
   */
  hint?: string;
}

/**
 * The outcome of a `submitFindings` operation — a discriminated **ack | reject** union (the engine's
 * only two responses to a hop submission, looping until the engine drains the agenda).
 *
 * @remarks
 * `{ ok: true }` = **ack** (recorded, advance). A {@link ToolRejection} = **reject** — a Zod-/topology-only,
 * mode-pure validation failure the AI self-corrects from. There is no third outcome and no AI "done"
 * signal: termination is engine-owned (agenda drain), surfaced separately via `getHopContext().done`.
 */
export type SubmitResult =
  | {
      /** Indicates the submission was accepted (the `ack` side of the ack/reject contract). */
      ok: true;
      /** Per-neighbor disposition for every neighbor this hop enqueued, deferred or found already settled; engine-side, never returned to the model. */
      route_outcomes?: RouteOutcome[];
      /**
       * CT tracked columns this hop's `column_flow` left unaccounted, by name — plain data, never a
       * rejection. Whether a chain starts, ends, or stays incomplete at a hop is the model's
       * decision. Absent when every active column was accounted for, or in BB.
       */
      unaccounted_columns?: string[];
      /** Set only on the supplement path when the supplemented agenda was already drained. */
      done?: true;
      /** Final synthesized result. Present iff `done: true`. */
      result?: SmResult;
    }
  | ToolRejection;

/**
 * Per-hop engine diagnostics — single structured snapshot for logging + AI visibility.
 *
 * @remarks
 * Produced by `engine.getHopDiagnostics()` after each successful `submitFindings`. Feeds
 * the `[AI] [Hop N]` structured log line and the working-memory fields the AI reads each
 * hop. Counts are cumulative since `start_exploration`.
 */
export interface DiagnosticsSnapshot {
  /** 1-based hop index. */
  hop: number;
  /** Node id of the focus just submitted. */
  focus: string;
  /** Schema of the focus. */
  schema: string;
  /** Depth from origin for the focus. */
  depth: number;
  /** Active depth budget (null if none was passed). */
  depthBudget: number | null;
  /** Enforcement mode as configured. */
  depthEnforcement: 'strict' | 'silent';
  /** Was the focus in the active schema allowlist? */
  inSchema: boolean;
  /** Verdict the AI emitted for this hop (`null` before any submit_findings). */
  verdict: 'analyze' | 'passthrough' | 'prune' | null;
  /** Detail-archive chars added this hop. */
  detailChars: number;
  /** Summary chars added this hop. */
  summaryChars: number;
  /** Cumulative archive size across the session. */
  archiveChars: number;
  /** Neighbor hops enqueued this hop. */
  routedNew: number;
  /** Neighbor references rejected this hop (validation, schema gate, depth gate). */
  routedRejected: number;
  /** Neighbors deferred this hop (SM mode — out-of-approved-scope neighbors captured for synthesis). */
  routedDeferred: number;
  /** Cumulative size of the SM deferred-questions bucket across the session. */
  deferredQueued: number;
  /** Nodes remaining on the agenda. */
  agendaRemaining: number;
  /** Rolling tally across the session: analyze/passthrough verdicts + cumulative engine prune count. */
  tally: { analyze: number; passthrough: number; prune: number };
  /** Count of soft/silent-mode scope expansions since session start. */
  scopeExpansions: number;
  /** Count of schemas the user has confirmed mid-session (session allowlist size). */
  allowedSchemaCount: number;
  /** Cumulative column edges accumulated across the session (CT only). */
  columnEdgeCount?: number;
  /** Number of active target columns for the current hop (CT only). */
  activeColumnCount?: number;
  /** Number of column_flow entries submitted this hop (CT only). */
  columnFlowEntries?: number;
}


/**
 * Per-(schema,type) leaf in the scope tree.
 *
 * @remarks
 * `hops` counts bodied nodes (view / procedure / function — agenda candidates);
 * `scope` is the total node count including non-bodied (table) nodes that BFS
 * surfaced. Names are listed in full unless the caller bounds them; `omitted` carries
 * the overflow count of a bounded list.
 */
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
 * Snapshot of the proposed scope, computed once per `confirm_sm_start` gate emission.
 *
 * @remarks
 * Single source of truth for the gate detail markdown and the live "Scope: N nodes"
 * line — both come from this snapshot so the count and the tree never diverge. The
 * snapshot reflects the post-filter scope (after `excludeSchemas` / `excludeTypes` /
 * `excludeNodeIds`) and includes the `passNodeIds` membership so the renderer can
 * mark pass-through nodes distinctly from analyzed nodes.
 */
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
  /** Exploration direction set at `start_exploration`. */
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
  bySchema: Record<string, { hops: number; scope: number; byType: Record<string, ScopeSummaryLeaf> }>;
  /**
   * Per object-type list of lowercased names that recur in more than one schema of the loaded
   * model — a model fact, computed once from the full node map, never from the proposed scope
   * alone. The card renderer schema-qualifies a name in this set so a bare name never reads as a
   * specific object when the model holds more than one by that name and type. Absent or empty
   * for a type with no repeated name.
   */
  ambiguousObjectNames?: Record<string, readonly string[]>;
  /** Active filter set on the engine — surfaces what the user has narrowed so far. */
  activeFilters: { schemas: string[]; types: string[]; nodeIds: string[]; passNodeIds: string[] };
  /**
   * Analysis constraints the user stated that no filter field can express, verbatim from the
   * model's reading. Echoed at the approval gate so the user can confirm the instruction landed
   * before an autonomous run begins.
   */
  scopeNotes: string[];
  /**
   * Gate-locked mission-type verdict. Surfaced at the approval gate because it is the field that
   * constrains captured analysis: the per-dispatch `submit_findings` schema narrows the `sections` keys
   * to the angle(s) this value keeps, so a section of another angle is never authored. Undefined
   * until the AI sets it.
   */
  classification?: ClassificationValue;
}

/**
 * Represents a node within the final synthesized result set.
 */
interface ResultNode {
  /** Unique node identifier. */
  id: string;
  /** Schema name. */
  s: string;
  /** Object name. */
  n: string;
  /** Object type. */
  t: string;
}

/**
 * The final, immutable output of a completed State Machine exploration.
 */
export interface SmResult {
  /** Hardcoded status to 'complete'. */
  status: 'complete';
  /** The ID of the node where the exploration began. */
  originNodeId: string;
  /** Full list of nodes included in the final report. */
  fullNodes: ResultNode[];
  /** List of edges connecting the nodes in the result set. */
  edges: Array<[string, string, string]>;
  /** AI-suggested grouping of nodes into narrative sections. */
  suggested_sections?: Array<{ label: string; node_ids: string[] }>;
  /** High-fidelity analysis artifacts for each visited node. */
  detail_slots: DetailSlot[];
  /** Engine-owned lifecycle state for result nodes and pruned/contracted nodes. */
  node_states: SmNodeState[];
  /** Column lineage chain. Present when CT was active for this session; null otherwise. */
  columnAspect: ColumnAspect | null;
}


/**
 * A route request to an out-of-approved-scope node, captured during an SM session.
 *
 * @remarks
 * Produced by the engine when a `submit_findings` route targets a node outside the approved
 * border (schema, exclusion or direction), past an exact depth, pruned, or reached only as a
 * contracted non-bodied carrier; a lead restored from an older record may still carry `budget`.
 * Derived from typed pending leads for the synthesis evidence envelope and native-chat follow-up
 * action.
 */
export interface DeferredQuestion {
  /** Fully-qualified id of the out-of-scope target. */
  nodeId: string;
  /** Schema of the target — the reason for schema-class deferral. */
  schema: string;
  /** Focus node id from which the route was proposed. */
  fromFocusNodeId: string;
  /** Sub-question the AI wanted to ask at the target. */
  question: string;
  /**
   * Discriminator for why the route was deferred. `'budget'` — in-border but over the active
   * scope budget. `'pruned'` — a legacy checkpoint lead from a prune/question combination;
   * new submissions reject that combination. `'contracted'` — retained in approved scope but
   * not given separate hop analysis;
   * still a real, answerable continuation.
   */
  reason: 'schema' | 'depth' | 'budget' | 'direction' | 'excluded' | 'pruned' | 'contracted';
  /** Depth-from-origin of the target. Populated when `reason` includes 'depth'. */
  depth?: number;
  /** Hop number at which the deferral was recorded. */
  atHop: number;
}

/** Fields shared by every engine-owned investigation task. */
interface InvestigationTaskBase {
  /** Stable deterministic identifier derived from the normalized task identity. */
  id: string;
  /** Authority that created the task. */
  source: 'mission' | 'model' | 'engine';
  /** Question the hop must answer. */
  question: string;
  /** Node the task applies to, when known. */
  nodeId?: string;
  /** Parent task for a routed or contracted continuation. */
  parentTaskId?: string;
  /** Directed routing leg retained through table and user-pass contraction. */
  traversalSide?: 'upstream' | 'downstream';
  /** Lifecycle controlled by the navigation engine. */
  status: 'pending' | 'active' | 'resolved' | 'deferred';
  /** Hop at which the task was created. */
  createdHop: number;
  /** Hop at which the task was resolved. */
  resolvedHop?: number;
  /** Explicit caller declaration anchored to its originating task and SQL snapshot. */
  callerContext?: FunctionCallerContext;
}

/** Engine-owned unit of investigation. Questions remain structured state rather than agenda prose. */
export type InvestigationTask = InvestigationTaskBase & (
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
      /** Qualified compiler-declared caller outputs; absent on ordinary column tasks. */
      returnTargets?: ScalarReturnTarget[];
    }
);

/** Valuable investigation deliberately left outside the approved run boundary. */
export interface PendingLead {
  /** Stable deterministic lead identifier. */
  id: string;
  /** Deferred task that retains the original question. */
  taskId: string;
  /** Target node worth investigating. */
  nodeId: string;
  /** In-scope node from which the lead was discovered. */
  fromNodeId: string;
  /** Mechanical boundary that prevented exploration in the current run. */
  reason: 'schema_boundary' | 'depth_boundary' | 'contracted_scope' | 'budget' | 'insufficient_evidence' | 'out_of_direction' | 'excluded' | 'pruned_by_ai';
  /** Target schema used by the derived synthesis projection. */
  schema?: string;
  /** Target depth retained when a depth boundary created the lead. */
  depth?: number;
  /** Concise grounded explanation shown to the user. */
  valueToUser: string;
  /** Follow-up lifecycle. */
  status: 'pending' | 'scheduled' | 'resolved' | 'dismissed';
  /** Hop at which the lead was created. */
  createdHop: number;
}

/** The border the user approved at session start — locked for the rest of the SM session. */
export interface ApprovedBorder {
  /** Lower-cased schemas in scope. */
  schemas: string[];
  /** Effective depth ceiling including mode headroom and any session extensions, or null when no depth budget is set. */
  depth_cap: number | null;
}

/**
 * The `init` parameters captured so the refine path (gate cycle) can re-run init without the
 * AI re-sending origin / direction / depth / mission_brief. Named here (rather than inlined on
 * the engine field) so {@link EngineInternalsSnapshot} can round-trip it for resume.
 */
export interface EngineInitSnapshot {
  /** Original user question. */
  question: string;
  /** Resolved origin node id. */
  origin: string;
  /** Explicit exploration mode approved before hop-by-hop analysis. */
  analysisMode: 'bb' | 'ct';
  /** Target columns when a column-trace aspect is active. */
  targetColumns?: [string, ...string[]];
  /** Exploration direction. */
  direction: 'upstream' | 'downstream' | 'bidirectional';
  /** AI-owned depth verdict that seeded the scope. */
  depthIntent: DepthIntent;
  /** Sanitized mission brief. */
  mission_brief?: string;
}

/**
 * AI-owned depth verdict, consumed by `NavigationEngine.init()`. The engine never parses prose
 * for depth — every call names a level and an exactness for both sides, and the engine seeds and
 * enforces the scope mechanically from this record; the backend never supplies a level of its own.
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
 *
 * @remarks
 * It is a filler, not user intent: hosts that need a human-authored prompt (for example the native
 * "Change scope" reproposal) must treat this value as absent and fall back to the real prompt.
 */
export const DEFAULT_EXPLORATION_QUESTION = 'Explore lineage';

/** Fully resolved mechanical inputs used to preview or initialize one exploration. */
export interface NavigationInitParams {
  /** Canonical user question the exploration answers; the {@link DEFAULT_EXPLORATION_QUESTION} placeholder when no user text is available. */
  question: string;
  /** Origin node id the BFS root resolves from. */
  origin: string;
  /** Exploration mode; omitted resolves to `ct` when `targetColumns` is set, `bb` otherwise. */
  analysisMode?: 'bb' | 'ct';
  /** Columns the column-trace aspect follows; required for `ct`, forbidden in `bb`. */
  targetColumns?: string[];
  /** Exploration direction; defaults to `bidirectional`. */
  direction?: 'upstream' | 'downstream' | 'bidirectional';
  /**
   * Depth verdict that seeds and bounds the scope, one binding per side. The `lineage_start_exploration`
   * tool boundary requires it on every fresh proposal — never a backend default for the AI.
   */
  depthIntent: DepthIntent;
  /** Object types excluded from the scope. */
  excludeTypes?: string[];
  /** Schemas excluded from the scope. */
  excludeSchemas?: string[];
  /** Specific node ids excluded from the scope. */
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
 * carried by the top-level checkpoint fields.
 *
 * @remarks
 * Runtime handles (model, graph, logger, store, node map, and edge map) are rebuilt by the caller
 * from the active host and are deliberately not serialized. Maps and sets are flattened to arrays
 * for the JSON boundary. Restore accepts only a snapshot validated against the current strict
 * checkpoint schema; it does not synthesize omitted state.
 */
export interface EngineInternalsSnapshot {
  /** Resolved origin/root node id (anchors the trace). */
  originNodeId: string | null;
  /** Exploration direction set at init. */
  direction: 'upstream' | 'downstream' | 'bidirectional';
  /** User-declared depth budget, or null when unbounded. */
  depthBudget: number | null;
  /** How strictly the depth budget is enforced. */
  depthEnforcement: 'strict' | 'silent';
  /** Per-side ceilings, `null` where that side is unbounded; absent in a v1 checkpoint. */
  depthLimits?: { upstream: number | null; downstream: number | null };
  /** BFS depth-from-origin, flattened to `[nodeId, depth]` pairs (insertion order preserved). */
  depthFromOrigin: Array<[string, number]>;
  /** Out-of-budget expansions allowed in soft/silent mode. */
  budgetExpansions: Array<{ nodeId: string; depth: number; atHop: number }>;
  /** Count of bodied (view/proc/function) nodes in scope — the hop denominator. */
  bodiedScopeSize: number;
  /** Total acknowledged bodied nodes (drives `hopProgress.total`). */
  totalNodes: number;
  /** Schemas in the user's active filter (initial route-validation allowlist). */
  userSchemas: string[];
  /** Session-scoped schema allowlist (grows via mid-session confirmations). */
  sessionAllowedSchemas: string[];
  /** Object types the user excluded at init. */
  excludedTypes: string[];
  /** Schemas the user excluded at init. */
  excludedSchemas: string[];
  /** Specific node ids the user excluded at init. */
  excludedNodeIds: string[];
  /** Object types hidden by the GUI filter at session start (advisory diagnostics). */
  guiHiddenTypes: string[];
  /** Node ids kept in scope but skipped for analysis (auto pass-through). */
  passNodeIds: string[];
  /** Agenda-entry question captured at dequeue for the current focus. */
  currentFocusQuestion: string | null;
  /** Task ids being answered by the current focus hop. */
  currentFocusTaskIds: string[];
  /** Last current-task question delivered with a hop context. */
  lastCurrentTask: string;
  /** AI-composed discovery summary memo (survives sliding-memory wipes). */
  discoverySummary: string | null;
  /** Cumulative detail + summary char count across the session. */
  archiveChars: number;
  /** Detail chars written in the most recent hop (diagnostics). */
  lastHopDetailChars: number;
  /** Summary chars written in the most recent hop (diagnostics). */
  lastHopSummaryChars: number;
  /** Verdict of the most recent hop (diagnostics). */
  lastHopVerdict: 'analyze' | 'passthrough' | 'prune' | null;
  /** column_flow entries submitted in the most recent hop (CT diagnostics). */
  lastHopColumnFlowEntries: number;
  /** Routes accepted in the most recent submit (diagnostics). */
  lastRoutedNew: number;
  /** Routes rejected in the most recent submit (diagnostics). */
  lastRoutedRejected: number;
  /** Routes deferred in the most recent submit (diagnostics). */
  lastRoutedDeferred: number;
  /** Typed investigation tasks, including deferred follow-up questions. */
  investigationTasks: InvestigationTask[];
  /** Stable user-facing follow-up leads. */
  pendingLeads: PendingLead[];
  /** The `init` params snapshot kept for the refine re-run. */
  initSnapshot: EngineInitSnapshot | null;
  /** Explicit post-completion follow-up targets; absent in older checkpoints. */
  supplementNodeIds?: string[];
  /** Accepted prune/keep votes not yet resolved because another sender remains live. */
  pruneBallots?: Array<{ nodeId: string; votes: Array<{ senderId: string; vote: 'prune' | 'keep' }> }>;
  /** Held finding and its authorization must resume together or restart explicitly. */
  heldFinding?: { focusId: string; hop: number; mode: 'bb' | 'ct'; failed: string[]; finding: HopFindingKept } | null;
  /** Complete continuation-state format; unfinished older checkpoints require a fresh run. */
  continuationVersion?: 1;
}

/**
 * Current-format serialized state-machine checkpoint and diagnostic projection.
 *
 * @remarks
 * Unknown restore input must pass the strict `NavigationSnapshot` schema before reconstruction.
 */
export interface SmState {
  /** Current fail-closed persistence contract version. */
  snapshotVersion: 1 | 2;
  /** Source identifier policy at capture; an absent field denotes a legacy CI checkpoint. */
  identifierCaseSensitive?: boolean;
  /** The current aspect mode (e.g. column tracing). */
  columnAspect: ColumnAspect | null;
  /** The current lifecycle status. */
  status: SmStatus;
  /** Total number of hops completed in this session. */
  hopCount: number;
  /** Total number of nodes within the discovered exploration scope. */
  scopeSize: number;
  /** List of all node IDs currently in the exploration scope. */
  scopeNodeIds: string[];
  /** Set of node IDs already visited by the engine. */
  visited: string[];
  /** Set of node IDs explicitly pruned from the exploration. */
  removedSet: string[];
  /** Engine-owned node lifecycle states keyed by node id. */
  nodeStates: SmNodeState[];
  /** Current number of nodes waiting on the agenda. */
  agendaSize: number;
  /** The list of upcoming tasks on the engine's agenda. */
  agenda: Array<{
    /** All task ids answered by the node's single hop. */
    taskIds: string[];
    /** The unique identifier of the node to visit. */
    nodeId: string;
    /** The priority of this visit; higher dequeues first. */
    priority: number;
    /** Topological depth relative to origin. */
    depth: number;
    /** Column-trace columns of interest for this node. */
    activeColumns?: string[];
    /** CT chain-continuation questions opened for this node by an earlier hop, owned by this entry. */
    lineageQuestions?: string[];
    /** Per-neighbour column-carry decision that survived contraction (`carry` / `row_role_only`). */
    columnCarry?: ColumnCarry;
  }>;
  /** ID of the node currently under analysis, if any. */
  currentFocusNodeId: string | null;
  /** Serialized snapshot of the associated memory manager. */
  memory: MemoryStateSnapshot;
  /**
   * Engine working-state projection required by the current checkpoint version.
   *
   * @remarks
   * Missing or malformed internals reject before engine reconstruction. The restore path does not
   * infer fields from older telemetry projections.
   */
  engineInternals: EngineInternalsSnapshot;
  /**
   * Lineage questions owned by the in-flight hop's own {@link AgendaEntry}, captured at
   * dispatch time (CT only) — shows what questions would be fed to the next hop, critical
   * for diagnosing CT tracking failures.
   */
  lineageQuestionsLastHop?: string[];
  /** Legacy key from checkpoints written before focus cuts were removed; accepted and ignored on restore. */
  ctPrunedNodeIds?: string[];
  /**
   * Recorded column-edge endpoint IDs. The historical checkpoint key remains readable;
   * object retention is independent of this projection.
   */
  ctDeclaredRouteIds?: string[];
  /**
   * Node IDs the last `getResult` removed from the render as undispositioned write sinks.
   * Present only when that call dropped something; a drop is a recorded disposition, not a gap
   * between this snapshot's scope and the rendered node set for a reader to infer.
   */
  renderDroppedNodeIds?: string[];
}

/**
 * Log entry representing a single tool invocation within the SM lifecycle.
 */
export interface HopLogEntry {
  /** Name of the tool called. */
  tool: string;
  /** The input payload passed to the tool. */
  input: unknown;
  /** The response received from the tool. */
  output: unknown;
  /** ISO timestamp of the execution. */
  timestamp: string;
}

/**
 * Kinds of invalid routes during exploration.
 *
 * @remarks
 * Absent/no-op kinds are nonfatal notices. Content, completeness, action-conflict, origin, and
 * topology kinds reject atomically. The pure current-hop policy owns route/prune classification;
 * ColumnTracer owns indexed CT content paths.
 */
export type InvalidRouteKind = | 'absent_contributor'
      | 'bad_out_col'
      | 'untracked_out_col'
      | 'bad_contributor_col'
      | 'non_writer_continuation'
      | 'self_loop_column'
      | 'bad_writes_to_target'
      | 'bad_return_target'
      | 'bad_caller_context'
      | 'pruned_contributor'
      | 'prune_absent'
      | 'prune_noop_removed'
      | 'prune_noop_visited'
      | 'prune_noop_analyzed'
      | 'prune_noop_queued'
      | 'prune_noop_out_of_scope'
      | 'prune_question_conflict'
      | 'question_not_neighbor'
      | 'question_closed';

/**
 * Represents an invalid route returned during validation.
 */
export interface InvalidRoute {
    /** Classification of the route or prune failure. */
    kind: InvalidRouteKind;
    /** Node id the failure applies to. */
    id: string;
    /** Human-readable explanation for the failure. */
    reason: string;
    /** Exact submit_findings field path that must be corrected. */
    path?: string;
    /** Valid column set for a column-content failure, or the tracked columns a refused prune carries; emitted in `detail`. */
    available_columns?: string[];
    /** Complete catalog column names of this object, never tracked subsets or procedure input unions. */
    actual_columns?: string[];
    /** Carrier-side neighbours a body-less focus may name (`non_writer_continuation`); emitted in `detail`. */
    available_routes?: string[];
}

/** Discriminated union representing the engine's current aspect mode. */
export type EngineAspectMode =  { kind: 'bb' } | { kind: 'ct' };

/** Parts of a rejected `lineage_submit_findings` call the session holds for its retry: section angles, whether the summary, other field names. */
export interface HeldSubmissionParts {
  readonly sections: readonly string[];
  readonly summary: boolean;
  /** Names of the other held fields (`badge_label`, `prune_neighbors`, `questions`). */
  readonly fields: readonly string[];
}
