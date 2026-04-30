/**
 * Navigation Engine hop lifecycle types.
 *
 * Concrete types for the IHopStateMachine contract — replaces `any` returns.
 * Keep this file dependency-free (only imports `memoryManager` types + scalar
 * types from smBase) so it can be unit-tested without a live engine.
 */

import { z } from 'zod';
import type { CaptureAngle, CapturedSection, DetailSlot, MemoryStateSnapshot } from './memoryManager';


/**
 * Represents the current lifecycle stage of an SM exploration session.
 */
export type SmStatus = 'created' | 'initialized' | 'exploring' | 'awaiting_findings' | 'complete' | 'error';

/** Live progress for the hop loop: completed AI hops, queued nodes, and total acknowledged nodes. */
export type HopProgress = { current: number; open: number; total: number };

/** 
 * Flags identifying structural boundaries encountered during graph traversal.
 */
export type BoundaryFlag = 'none' | 'source' | 'sink' | 'external' | 'cycle';

/** 
 * The AI's qualitative assessment of a node's relevance to the current lineage investigation.
 */
export type Verdict = 'analyze' | 'pass' | 'prune';

/**
 * Semantic role of a column contribution in the lineage chain.
 * `source` means this branch is terminal — no further upstream exists.
 * `filter_only` means the column appears in WHERE/JOIN-ON only and is excluded from data-flow edges.
 */
export type ColumnFlowRole =
  'formula' | 'rename' | 'case' | 'coalesce' |
  'join_value' | 'aggregate' | 'filter_only' | 'source';

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
   * A branch is terminal when its last edge carries `role="source"`.
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
   * For writer procedures: the table column this node writes to.
   * When present, the lineage edge is `focus_node.out_col → writes_to.node.writes_to.col`.
   */
  writes_to?: { node: string; col: string };
  /** Upstream contributors. Empty array declares a terminal source (magic number, stored column, @param). */
  contributors: ColumnFlowContributor[];
}

/**
 * A single upstream contributor to a column's value.
 */
export interface ColumnFlowContributor {
  /** ID of the neighbor node providing the data. */
  from_node: string;
  /** Name of the column in that neighbor (or @param for procedures). */
  from_col: string;
  /** Semantic role of the contribution. */
  role: ColumnFlowRole;
}

/**
 * One directed edge in the accumulated column lineage chain.
 * Built from validated `column_flow` submissions, one edge per (out_col, contributor) pair.
 */
export interface ColumnEdge {
  /** Focus node where this edge was analyzed. */
  hop_node: string;
  /** Hop number when this edge was captured. */
  hop: number;
  /** Upstream contributor node. */
  from_node: string;
  /** Column name on the contributor (or @param for procedures). */
  from_col: string;
  /** Downstream consumer node. */
  to_node: string;
  /** Column name on the consumer. */
  to_col: string;
  /** Semantic role. `source` means this branch terminates here — no further upstream in graph. */
  role: ColumnFlowRole;
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
   * False when this node's schema is outside the session's approved scope. Surfaced when a filter is active.
   *
   * @remarks
   * In SM sessions the approved scope is locked at `confirm_sm_start`; routes to out-of-scope
   * neighbors are deferred (not rejected) and surfaced at synthesis. In inline sessions the flag
   * still drives the `schema_out_of_filter` consent gate.
   */
  in_approved_scope?: boolean;
  /**
   * True when routing here would trigger engine-level handling:
   * inline sessions raise an `action_required` gate; SM sessions record the route as a deferred
   * question for post-session review.
   */
  would_trigger_action_required?: boolean;
}

/**
 * Structured envelope for a user-confirmation gate emitted by the engine.
 *
 * @remarks
 * Implements the LangGraph `interrupt_on` pattern: the engine halts with a structured
 * reason, the participant surfaces it in chat, and the user's next reply resumes or
 * aborts. One envelope can carry multiple violations (schema + depth in a single gate).
 */
export interface ActionRequiredGate {
  /** Discriminator for participant routing. */
  error: 'action_required';
  /**
   * The gate sub-type — drives the cache key used for "don't ask again this session".
   *
   * @remarks
   * - `confirm_sm_start` — session-entry consent (SM mode).
   * - `schema_out_of_filter` / `depth_cap_exceeded` / `schema_and_depth` — inline-mode mid-session expansion.
   *
   * SM-mode out-of-scope exploration is surfaced as a post-synthesis button
   * (`dataLineageViz.showDeferredQuestions`), not as a gate.
   */
  gate: 'schema_out_of_filter' | 'depth_cap_exceeded' | 'schema_and_depth' | 'confirm_sm_start';
  /** The specific class being requested (e.g. "schema:dbo" or "depth:+1"). Confirmations cache per-class. */
  classes: string[];
  /** Human-readable question rendered in chat, ready for yes/no reply. */
  detail: string;
  /** Node IDs that triggered the gate, so the engine can replay the route on confirm. */
  nodeIds: string[];
  /** Next-action hint for the AI if the gate returns before user reply. */
  hint: string;
}

/**
 * Enriched-node shape built by `buildHopFocusNode` and shipped to the AI as JSON.
 * Always a plain object; the keys present depend on node type (DDL vs columns) and
 * whether the DDL was truncated.
 */
export type HopFocusNode = Record<string, unknown>;

/**
 * Encapsulates all information delivered to the AI for a single navigation hop.
 *
 * @remarks
 * `mode` is stamped once at `start_exploration` based on the two metrics (scope node
 * count + token budget) and never flips. CT is always `sm`. Consumers can narrow
 * `focus_node` by reading `mode` (or by `Array.isArray(focus_node)`).
 */
export interface HopContext {
  /** Execution mode — decided once at engine init. `inline` ships a batch; `sm` ships one node per hop. */
  mode?: 'inline' | 'sm';
  /** Set to `true` if there are no more nodes to visit in the agenda. */
  done?: boolean;
  /** Explicit engine status, delivered every hop. */
  sm_status?: SmStatus;
  /** The current hop index. */
  hop?: number;
  /** Count of nodes still on the agenda. */
  agenda_remaining?: number;
  /** The node(s) currently being analyzed. Single object in SM mode; array in inline (batch) mode. */
  focus_node?: HopFocusNode | HopFocusNode[];
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

/**
 * A single technical finding for a focus node, including analysis and routing.
 */
export interface HopFinding {
  /** ID of the node that was analyzed. */
  focus_node_id: string;
  /**
   * Captured sections — one per fired `*_capture` YAML template. Length 1 for
   * single-angle classification (`business` or `technical`); length 2 for `both`.
   * Each section is lifted verbatim by synthesis as a peer entry in
   * `present_result.sections[]`. Mechanically validated against the locked
   * session classification at the tool handler boundary
   * (`toolProvider.validateSectionsAgainstClassification`).
   *
   * @remarks
   * Each entry is one fired `*_capture` template's output. The split lets
   * prompts and synthesis treat each angle independently and lifts verbatim
   * into a peer entry of `present_result.sections[]` at synthesis.
   */
  sections: CapturedSection[];
  /** One-line digest of the whole node (across all captured angles), echoed via `short_term_memory`. */
  summary: string;
  /** The relevance verdict for the focus node. */
  verdict: Verdict;
  /** List of new nodes the AI wishes to add to the exploration agenda. */
  route_requests?: RouteRequest[];
  /** List of neighbor node IDs to aggressively prune from the exploration agenda. */
  prune_neighbors?: string[];
  /** Reserved. The engine owns completion in sliding-memory mode; setting it is rejected. */
  complete?: boolean;
  /** Optional UI label (badge) to apply to this node in the final view. */
  badge_label?: string;
  /** Optional short descriptive text to attach to this node in the final view. */
  note_caption?: string;
  /**
   * Structured attribution of column-level data flow.
   * Required (and validated) when the column aspect is active and `verdict === 'analyze'`.
   * Ignored when the column aspect is inactive — submit only in column-trace sessions.
   */
  column_flow?: ColumnFlowEntry[];
}

/**
 * Data structure used by the AI to submit its findings after analyzing a hop.
 * In True Inline Mode, this can be an array of findings for batch processing.
 */
export type HopSubmission = HopFinding | HopFinding[];

/** 
 * A request to add a specific node to the navigation agenda.
 */
export interface RouteRequest {
  /** The ID of the node to visit. */
  nodeId: string;
  /** The specific question or sub-goal the AI intends to answer at this node. */
  question: string;
  /** Specific columns to track at the target node (used in Column Trace mode). */
  columns?: string[];
}

/**
 * Per-route outcome in a successful `submitFindings` return.
 *
 * @remarks
 * Reported to the AI so it can distinguish accepted routes (added to agenda)
 * from deferred routes (queued for post-synthesis follow-up offer). The AI
 * should only reference `accepted: true` nodes inside captured section text;
 * deferred nodes are surfaced exclusively via the post-synthesis follow-up
 * pill — the report should not enumerate them.
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
   * - `schema` / `depth` / `schema_and_depth` — route target is outside the approved border; user will see it as a follow-up offer.
   * - `depth_contracted_beyond_budget` — route target was a non-bodied node (table) whose bipartite contraction reached bodied neighbours that fell outside the active BFS scope, so no hop was enqueued. The route is structurally valid but produced no new agenda item.
   */
  reason?: 'schema' | 'depth' | 'schema_and_depth' | 'depth_contracted_beyond_budget';
}

/**
 * The outcome of a `submitFindings` operation.
 *
 * @remarks
 * If `error` is present, it indicates a validation failure (e.g., invalid node ID)
 * that the AI should attempt to self-correct.
 */
export type SubmitResult =
  | {
      /** Indicates the submission was accepted. */
      ok: true;
      /** Number of agenda items cascade-removed because the focus was marked prune. */
      cascaded_count?: number;
      /** Per-route disposition for every entry in the submitted `route_requests` (accepted vs deferred). */
      route_outcomes?: RouteOutcome[];
      /**
       * Signals the engine has auto-completed. Present when:
       * (a) the session is in inline mode and `complete=true` was submitted, or
       * (b) the session is in SM sliding-memory mode and this verdict just drained the agenda.
       */
      done?: true;
      /** Final synthesized result. Present iff `done: true`. */
      result?: SmResult;
    }
  | ActionRequiredGate
  | {
      /** Human-readable error code for AI feedback. */
      error: string;
      /** Optional technical details about the error. */
      detail?: unknown;
      /** The value that was expected by the validator. */
      expected?: string;
      /** The value that was actually received. */
      got?: string;
      /** Current state of the state machine. */
      current_status?: SmStatus;
      /** Next-action hint for the AI. */
      hint?: string;
      /**
       * Subset of `route_requests[].nodeId` values that did not resolve to a
       * real graph node. Surfaced separately on `route_validation_failed` so
       * the AI gets a clean handle on which ids to re-resolve via
       * `lineage_search_objects` / `lineage_get_neighbor_columns`.
       */
      unresolved_route_target_ids?: string[];
      /**
       * For each unresolved route target, up to 3 closest in-scope candidate
       * node ids (lower-cased, schema-qualified) ranked by fuzzy similarity.
       * Empty array when no candidate scored above the noise floor. Populated
       * on `route_validation_failed` so the AI can pick a real id without an
       * extra `lineage_search_objects` round-trip when the typo is small.
       */
      route_target_candidates?: Record<string, string[]>;
    };

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
  depthEnforcement: 'strict' | 'soft' | 'silent';
  /** Was the focus in the active schema allowlist? */
  inSchema: boolean;
  /** Verdict the AI emitted for this hop (`null` before any submit_findings). */
  verdict: 'analyze' | 'pass' | 'prune' | null;
  /** Detail-archive chars added this hop. */
  detailChars: number;
  /** Summary chars added this hop. */
  summaryChars: number;
  /** Cumulative archive size across the session. */
  archiveChars: number;
  /** Route_requests accepted this hop. */
  routedNew: number;
  /** Route_requests rejected this hop (validation, schema gate, depth gate). */
  routedRejected: number;
  /** Route_requests deferred this hop (SM mode — out-of-approved-scope routes captured for synthesis). */
  routedDeferred: number;
  /** Cumulative size of the SM deferred-questions bucket across the session. */
  deferredQueued: number;
  /** Nodes remaining on the agenda. */
  agendaRemaining: number;
  /** Rolling verdict tally across the whole session. */
  tally: { analyze: number; pass: number; prune: number };
  /** Count of soft/silent-mode scope expansions since session start. */
  scopeExpansions: number;
  /** Count of schemas the user has confirmed mid-session (session allowlist size). */
  allowedSchemaCount: number;
  // --- CT fields (only present when Column Aspect is active) ---
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
 * surfaced. Names are capped at the renderer's display limit; `omitted` carries
 * the overflow count so the caller can render `+K more` without recounting.
 */
export interface ScopeSummaryLeaf {
  /** Bodied-node count (view / procedure / function) at this leaf — agenda candidates. */
  hops: number;
  /** Total node count at this leaf, including non-bodied (table / external) entries. */
  scope: number;
  /** Display-capped list of object names at this leaf, alphabetised by the renderer. */
  nodeNames: string[];
  /** Names beyond the display cap — `nodeNames.length + omitted === scope` for the leaf. */
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
  /** Total bodied-node count across the scope — drives the "N hops" header in the gate. */
  hopCount: number;
  /** Total node count across the scope (bodied + non-bodied) — drives the "N nodes" header. */
  scopeCount: number;
  /** Origin node id captured at `start_exploration` — anchors the BFS root. */
  origin: string;
  /** Depth budget set at `start_exploration`; `null` when unbounded. */
  depth: number | null;
  /** Exploration direction set at `start_exploration`. */
  direction: 'upstream' | 'downstream' | 'bidirectional';
  /** True when the gate proposes inline (one-shot) mode; false for sliding-memory. */
  inlineMode: boolean;
  /** True when the session has `targetColumns` (column-trace aspect). */
  columnAspectActive: boolean;
  /** Target columns being traced, present when `columnAspectActive` is true. */
  targetColumns?: string[];
  /** Schema → type → leaf rollup used by `renderScopeSummaryMd` to build the tree. */
  bySchema: Record<string, { hops: number; scope: number; byType: Record<string, ScopeSummaryLeaf>; }>;
  /** Active filter set on the engine — surfaces what the user has narrowed so far. */
  activeFilters: { schemas: string[]; types: string[]; nodeIds: string[]; passNodeIds: string[] };
}

/**
 * Represents a node within the final synthesized result set.
 */
export interface ResultNode {
  /** Unique node identifier. */
  id: string;
  /** Schema name. */
  s: string;
  /** Object name. */
  n: string;
  /** Object type. */
  t: string;
  /** Special semantic role within the result set. */
  role?: 'origin' | 'noted' | 'bridge';
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
  /** Column lineage chain. Present when CT was active for this session; null otherwise. */
  columnAspect: ColumnAspect | null;
  /**
   * Node IDs visited during CT exploration that contributed no column_flow edges.
   * Present only when `columnAspect` is non-null. Nodes that were analyzed or passed
   * but produced no edges (validation-failed or zero column_flow entries). Synthesis
   * should exclude these from the column chain narrative.
   */
  ctPrunedNodeIds?: string[];
}


/**
 * A route request to an out-of-approved-scope node, captured during an SM session.
 *
 * @remarks
 * Produced by the engine when a `submit_findings` route targets a node whose schema is
 * outside `approved_border.schemas` or whose depth exceeds `approved_border.depth_cap`.
 * Surfaced to the AI at synthesis (rendered as an "Unanswered" section) and to the user
 * post-turn via the `dataLineageViz.showDeferredQuestions` button. Never silently
 * dropped — this is the scope-gap audit trail that keeps SM closed-loop honest.
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
  /** Discriminator for why the route was deferred. */
  reason: 'schema' | 'depth' | 'schema_and_depth';
  /** Depth-from-origin of the target. Populated when `reason` includes 'depth'. */
  depth?: number;
  /** Hop number at which the deferral was recorded. */
  atHop: number;
}

/**
 * Runtime schema for {@link DeferredQuestion}. Parses untrusted payloads crossing the
 * engine → participant → command boundary (synthesis memory and the
 * `dataLineageViz.showDeferredQuestions` command argument). Inner layers consume the
 * typed interface without re-validation.
 */
export const DeferredQuestionSchema = z.object({
  nodeId: z.string(),
  schema: z.string(),
  fromFocusNodeId: z.string(),
  question: z.string(),
  reason: z.enum(['schema', 'depth', 'schema_and_depth']),
  depth: z.number().int().nonnegative().optional(),
  atHop: z.number().int().nonnegative(),
}).strict();

/** The border the user approved at session start — locked for the rest of the SM session. */
export interface ApprovedBorder {
  /** Lower-cased schemas in scope. */
  schemas: string[];
  /** Effective depth ceiling including mode headroom and any session extensions, or null when no depth budget is set. */
  depth_cap: number | null;
}

/**
 * Serialized state of the state machine, used for telemetry, debugging, and persistence.
 */
export interface SmState {
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
  /** Whether the session is operating in True Inline mode. */
  inlineMode: boolean;
  /** Set of node IDs already visited by the engine. */
  visited: string[];
  /** Set of node IDs explicitly pruned from the exploration. */
  removedSet: string[];
  /** Current number of nodes waiting on the agenda. */
  agendaSize: number;
  /** The list of upcoming tasks on the engine's agenda. */
  agenda: Array<{
    nodeId: string;
    priority: number;
    question: string;
  }>;
  /** ID of the node currently under analysis, if any. */
  currentFocusNodeId: string | null;
  /** Serialized snapshot of the associated memory manager. */
  memory: MemoryStateSnapshot;
  /**
   * Engine-generated lineage sub-questions from the last successful hop (CT only).
   * Populated from `getColumnLineageQuestions()` at dump time — shows what questions
   * would be fed to the next hop, critical for diagnosing CT tracking failures.
   */
  lineageQuestionsLastHop?: string[];
  /**
   * Node IDs visited during CT exploration that contributed no column_flow edges.
   * Computed at dump time from `columnAspect.edges` vs visited detail slots.
   * Present only when `columnAspect` is non-null.
   */
  ctPrunedNodeIds?: string[];
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
