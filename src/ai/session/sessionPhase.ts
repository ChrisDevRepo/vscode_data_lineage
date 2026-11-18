/**
 * Session-phase finite state machine: types and runtime schema. {@link AiSession} owns multi-turn
 * phase state and LangGraph routes each invocation from the discriminated phase union, keeping
 * phase handling exhaustive. Lives beside `smTypes.ts` and `session.ts`; dependency-light so unit
 * tests need no live engine.
 */

import { z } from 'zod';

/**
 * Runtime schema for an engine-emitted `action_required` envelope, validating gate payloads before
 * the host graph/runtime publishes native gate events.
 */
export const PendingGateSchema = z.object({
  gate: z.literal('confirm_sm_start'),
  classes: z.array(z.string()),
  nodeIds: z.array(z.string()),
  detail: z.string(),
  /** Revision of the exact exploration proposal shown to the user. */
  proposalRevision: z.number().int().positive().optional(),
});

/**
 * A validated consent gate waiting on a user reply, produced by the engine and resolved by the next
 * chat turn. Envelope plumbing fields (`error`, `hint`) are absent: they are transport concerns,
 * not session state.
 */
export type PendingGate = z.infer<typeof PendingGateSchema>;

/**
 * Persistent session phase, the source of truth for what the next chat turn does; survives across
 * chat turns via the `AiSession` singleton.
 * - `idle`: no exploration in progress; the next turn enters discovery.
 * - `awaiting_gate`: engine paused on a consent gate; the next turn resolves the user's reply (yes
 *   / no / redirect).
 * - `exploring`: engine running hops; the next turn continues or completes.
 * - `completed`: synthesis finished, archive kept on the session. The next turn runs the follow-up
 *   protocol: a refinement (text edit, node prune, explicit-node supplement), an answer from a
 *   graph walk, or a fresh proposal opening a new approval card.
 */
export type SessionPhase =
  /** No exploration active. Next turn goes through discovery. */
  | { kind: 'idle' }
  /** Engine is paused on a consent gate; awaiting user's yes / no / redirect reply. */
  | { kind: 'awaiting_gate'; gate: PendingGate }
  /** Engine is in the hop loop; next turn resumes or finishes. */
  | { kind: 'exploring' }
  /**
   * Synthesis turn finished; archive is frozen but addressable. Follow-up turns route through the
   * follow-up protocol.
   */
  | { kind: 'completed' };
