/**
 * Navigation Engine hop lifecycle types.
 *
 * Concrete types for the IHopStateMachine contract — replaces `any` returns.
 * Keep this file dependency-free (only imports `memoryManager` types + scalar
 * types from smBase) so it can be unit-tested without a live engine.
 */

import type { DetailSlot } from './memoryManager';


/**
 * Defines the operational mode of the State Machine (SM) exploration.
 */
export type SmMode = 'blackboard' | 'column_trace' | 'dependency';
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
export type Verdict = 'relevant' | 'pass' | 'irrelevant';


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
  /** List of columns relevant to the current trace, if applicable. */
  cols?: string[];
  /** Depth from origin (always surfaced when a depth budget is set). */
  depth_from_origin?: number;
  /** False when this node is beyond the active depth budget. Always surfaced when budget is set. */
  in_budget?: boolean;
  /** False when this node's schema is outside the session's allowed schemas. Surfaced when a filter is active. */
  in_user_filter?: boolean;
  /** True when routing here would trigger an `action_required` gate (out-of-depth and/or out-of-schema). */
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
  /** The gate sub-type — drives the cache key used for "don't ask again this session". */
  gate: 'schema_out_of_filter' | 'depth_cap_exceeded' | 'schema_and_depth';
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
}

/**
 * Data structure used by the AI to submit its findings after analyzing a hop.
 */
export interface HopSubmission {
  /** ID of the node that was analyzed. */
  focus_node_id: string;
  /** High-fidelity technical analysis stored in the detail archive. */
  detail_analysis: string;
  /** One-line digest of the findings — echoed in future hops via `all_summaries`. */
  summary: string;
  /** The relevance verdict for the focus node. */
  verdict: Verdict;
  /** List of new nodes the AI wishes to add to the exploration agenda. */
  route_requests?: RouteRequest[];
  /** Reserved. The engine owns completion in sliding-memory mode; setting it is rejected. */
  complete?: boolean;
  /** Optional UI label (badge) to apply to this node in the final view. */
  badge_label?: string;
  /** Optional short descriptive text to attach to this node in the final view. */
  note_caption?: string;
}

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
      /** Number of agenda items cascade-removed because the focus was marked irrelevant. */
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
      current_status?: SmStatus
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
  /** Nodes remaining on the agenda. */
  agendaRemaining: number;
  /** Rolling verdict tally across the whole session. */
  tally: { relevant: number; pass: number; irrelevant: number };
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
