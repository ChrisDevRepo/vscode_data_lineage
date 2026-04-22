/**
 * Navigation Engine hop lifecycle types.
 *
 * Concrete types for the IHopStateMachine contract — replaces `any` returns.
 * Keep this file dependency-free (only imports `memoryManager` types + scalar
 * types from smBase) so it can be unit-tested without a live engine.
 */

import { z } from 'zod';
import type { DetailSlot } from './memoryManager';


/**
 * Represents the current lifecycle stage of an SM exploration session.
 */
export type SmStatus = 'created' | 'initialized' | 'exploring' | 'awaiting_findings' | 'complete' | 'error';

/** 
 * Flags identifying structural boundaries encountered during graph traversal.
 */
export type BoundaryFlag = 'none' | 'source' | 'sink' | 'external' | 'cycle';

/** 
 * The AI's qualitative assessment of a node's relevance to the current lineage investigation.
 */
export type Verdict = 'analyze' | 'pass' | 'prune';

/**
 * State and constraints for the column-tracing aspect of an exploration.
 */
export interface ColumnAspect {
  /** Target columns requested at session start. */
  target_columns: string[];
  /** Columns that have reached a terminal physical source. */
  done_columns: string[];
  /** Columns currently being tracked in the focus node. */
  active_columns: string[];
}

/**
 * Structured attribution of data flow for a specific output column.
 */
export interface ColumnFlowEntry {
  /** Name of the column in the focus node. */
  out_col: string;
  /** List of upstream contributors for this column. */
  contributors: ColumnFlowContributor[];
}

/**
 * A single upstream contributor to a column's value.
 */
export interface ColumnFlowContributor {
  /** ID of the neighbor node providing the data. */
  from_node: string;
  /** Name of the column in that neighbor. */
  from_col: string;
  /** Semantic role of the contribution. */
  role: 'formula' | 'rename' | 'case' | 'coalesce' | 'join_value' | 'aggregate' | 'filter_only' | 'source';
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
   * - `confirm_scope_extension` — optional post-synthesis offer when deferred questions accumulated.
   */
  gate: 'schema_out_of_filter' | 'depth_cap_exceeded' | 'schema_and_depth' | 'confirm_sm_start' | 'confirm_scope_extension';
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
 * Encapsulates all information delivered to the AI for a single navigation hop.
 */
export interface HopContext {
  /** Set to `true` if there are no more nodes to visit in the agenda. */
  done?: boolean;
  /** Explicit engine status, delivered every hop. */
  sm_status?: SmStatus;
  /** The current hop index. */
  hop?: number;
  /** Count of nodes still on the agenda. */
  agenda_remaining?: number;
  /** The node currently being analyzed (type varies by implementation). */
  focus_node?: unknown;
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
  /** High-fidelity technical analysis stored in the detail archive. */
  detail_analysis: string;
  /** One-line digest of the findings — echoed in future hops via `short_term_memory`. */
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
  /** Structured attribution of column-level data flow, present when the column aspect is active. */
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
}


/**
 * A route request to an out-of-approved-scope node, captured during an SM session.
 *
 * @remarks
 * Produced by the engine when a `submit_findings` route targets a node whose schema is
 * outside `approved_border.schemas` or whose depth exceeds `approved_border.depth_cap`.
 * Surfaced to the AI at synthesis (rendered as an "Unanswered" section) and to the user
 * as an optional `confirm_scope_extension` checkpoint post-session. Never silently
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
 * engine → participant boundary (synthesis memory, `confirm_scope_extension` envelope).
 * Inner layers consume the typed interface without re-validation.
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
