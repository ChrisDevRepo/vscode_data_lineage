/**
 * Navigation Engine hop lifecycle types.
 *
 * Concrete types for the IHopStateMachine contract — replaces `any` returns.
 * Keep this file dependency-free (only imports `memoryManager` types + scalar
 * types from smBase) so it can be unit-tested without a live engine.
 */

import type { DetailSlot, ShortMemory } from './memoryManager';


/** 
 * Defines the operational mode of the State Machine (SM) exploration.
 */
export type SmMode = 'blackboard' | 'column_trace';

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
}

/** 
 * Encapsulates all information delivered to the AI for a single navigation hop. 
 */
export interface HopContext {
  /** Set to `true` if there are no more nodes to visit in the agenda. */
  done?: boolean;
  /** The current hop index. */
  hop?: number;
  /** The node currently being analyzed (type varies by implementation). */
  focus_node?: unknown;
  /** List of immediate neighbors available for further exploration. */
  neighbors?: HopNeighbor[];
  /** The specific question or sub-goal guiding this hop. */
  current_question?: string;
  /** Implementation-specific state carried across hops. */
  working_memory?: unknown;
}

/** 
 * Data structure used by the AI to submit its findings after analyzing a hop.
 */
export interface HopSubmission {
  /** ID of the node that was analyzed. */
  focus_node_id: string;
  /** Incremental update to the shared narrative (Short Memory). */
  narrative_update: string;
  /** High-fidelity technical analysis for storage in Detail Slots. */
  detail_analysis: string;
  /** A concise, human-readable summary of the hop's findings. */
  summary: string;
  /** The relevance verdict for the focus node. */
  verdict: Verdict;
  /** List of new nodes the AI wishes to add to the exploration agenda. */
  route_requests?: RouteRequest[];
  /** If `true`, signals that the exploration goal has been met early. */
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
      /** Number of nodes automatically cascaded into the agenda. */
      cascaded_count?: number; 
      /** Final exploration result if the session completed. */
      early_complete?: SmResult 
    }
  | { 
      /** Human-readable error message for AI feedback. */
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
  /** The final state of the shared narrative memory. */
  short_memory: ShortMemory;
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
