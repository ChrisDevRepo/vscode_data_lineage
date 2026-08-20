/**
 * Session-phase finite state machine — types and runtime schema.
 *
 * {@link AiSession} owns multi-turn phase state. LangGraph routes each invocation from
 * the discriminated phase union so phase handling remains exhaustive.
 *
 * Lives alongside `smTypes.ts` (engine-facing types) and `session.ts` (session
 * container). Kept dependency-light so unit tests can consume it without wiring a
 * live engine.
 */

import { z } from 'zod';

/**
 * Runtime schema for an engine-emitted `action_required` envelope.
 *
 * @remarks
 * Validates engine-emitted gate payloads before the host graph/runtime publishes native gate
 * events.
 */
export const PendingGateSchema = z.object({
  gate: z.enum([
    'confirm_sm_start',
    'schema_out_of_filter',
    'depth_cap_exceeded',
    'schema_and_depth',
  ]),
  classes: z.array(z.string()),
  nodeIds: z.array(z.string()),
  detail: z.string(),
  /** Revision of the exact exploration proposal shown to the user. */
  proposalRevision: z.number().int().positive().optional(),
});

/**
 * A validated consent gate waiting on a user reply. Produced by the engine, resolved
 * by the next user chat turn. Envelope plumbing fields (`error`, `hint`) are
 * deliberately absent — they are transport concerns, not session state.
 */
export type PendingGate = z.infer<typeof PendingGateSchema>;

/**
 * Persistent session phase — the source of truth for what the next chat turn should
 * do. Survives across VS Code chat turns via the `AiSession` singleton.
 *
 * @remarks
 * - `idle` — no exploration in progress; next turn enters discovery.
 * - `awaiting_gate` — engine paused on a consent gate; next turn resolves the user's reply (yes / no / redirect).
 * - `exploring` — engine is running hops; next turn continues or completes.
 * - `completed` — synthesis turn finished, archive survives on the session singleton. Next turn is a refinement
 *   (text edit, node prune, or explicit-node supplement) handled by the follow-up protocol without starting a
 *   fresh exploration.
 */
export type SessionPhase =
  /** No exploration active. Next turn goes through discovery. */
  | { kind: 'idle' }
  /** Engine is paused on a consent gate; awaiting user's yes / no / redirect reply. */
  | { kind: 'awaiting_gate'; gate: PendingGate }
  /** Engine is in the hop loop; next turn resumes or finishes. */
  | { kind: 'exploring' }
  /** Synthesis turn finished; archive is frozen but addressable. Follow-up turns route through the follow-up protocol. */
  | { kind: 'completed' };
