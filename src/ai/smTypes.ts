/**
 * Navigation Engine hop lifecycle types.
 *
 * Concrete types for the IHopStateMachine contract — replaces `any` returns.
 * Keep this file dependency-free (only imports `memoryManager` types + scalar
 * types from smBase) so it can be unit-tested without a live engine.
 */

import type { DetailSlot, ShortMemory } from './memoryManager';

// ─── Shared scalars ──────────────────────────────────────────────────────────

export type SmMode = 'blackboard' | 'column_trace';
export type SmStatus = 'created' | 'initialized' | 'exploring' | 'awaiting_findings' | 'complete' | 'error';
export type BoundaryFlag = 'none' | 'source' | 'sink' | 'external' | 'cycle';
export type Verdict = 'relevant' | 'pass' | 'irrelevant';

// ─── Hop lifecycle ───────────────────────────────────────────────────────────

/** Neighbor metadata delivered with each hop. */
export interface HopNeighbor {
  id: string;
  s: string;   // schema
  n: string;   // name
  t: string;   // type
  edge_direction: 'upstream' | 'downstream';
  edge_type: string;
  boundary: BoundaryFlag;
  boundary_reason?: string;
  scope?: 'visited' | 'agenda' | 'pruned' | 'available' | 'external';
  cols?: string[];
}

/** Context delivered to the AI for a single hop. */
export interface HopContext {
  /** When the agenda is empty, only `done: true` is set. */
  done?: boolean;
  hop?: number;
  focus_node?: unknown;
  neighbors?: HopNeighbor[];
  current_question?: string;
  working_memory?: unknown;
}

/** AI's submission after analyzing a hop. */
export interface HopSubmission {
  focus_node_id: string;
  narrative_update: string;
  detail_analysis: string;
  summary: string;
  verdict: Verdict;
  route_requests?: RouteRequest[];
  complete?: boolean;
  badge_label?: string;
  note_caption?: string;
}

export interface RouteRequest {
  nodeId: string;
  question: string;
  columns?: string[];
}

/** Result of submitFindings — either success with optional metadata, or an error object for AI self-correction. */
export type SubmitResult =
  | { ok: true; cascaded_count?: number; early_complete?: SmResult }
  | { error: string; detail?: unknown; expected?: string; got?: string; current_status?: SmStatus };

// ─── Final result ────────────────────────────────────────────────────────────

export interface ResultNode {
  id: string;
  s: string;
  n: string;
  t: string;
  role?: 'origin' | 'noted' | 'bridge';
}

export interface SmResult {
  status: 'complete';
  originNodeId: string;
  fullNodes: ResultNode[];
  edges: Array<[string, string, string]>;
  suggested_sections?: Array<{ label: string; node_ids: string[] }>;
  short_memory: ShortMemory;
  detail_slots: DetailSlot[];
}

// ─── Session telemetry ──────────────────────────────────────────────────────

export interface HopLogEntry {
  tool: string;
  input: unknown;
  output: unknown;
  timestamp: string;
}
