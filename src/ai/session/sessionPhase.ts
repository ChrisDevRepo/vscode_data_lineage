/** Session-phase finite state machine — types and runtime schema. */

import { z } from 'zod';

/** Runtime schema for an engine-emitted `action_required` envelope. */
export const PendingGateSchema = z.object({
  gate: z.literal('confirm_sm_start'),
  classes: z.array(z.string()),
  nodeIds: z.array(z.string()),
  detail: z.string(),
  /** Revision of the exact exploration proposal shown to the user. */
  proposalRevision: z.number().int().positive().optional(),
});

/** A validated consent gate waiting on a user reply. Produced by the engine, resolved by the next user chat turn. Envelope plumbing fields (`error`, `hint`) are deliberately absent — they are transport concerns, not session state. */
export type PendingGate = z.infer<typeof PendingGateSchema>;

/** Persistent session phase — the source of truth for what the next chat turn should do. Survives across VS Code chat turns via the `AiSession` singleton. */
export type SessionPhase =
  /** No exploration active. Next turn goes through discovery. */
  | { kind: 'idle' }
  /** Engine is paused on a consent gate; awaiting user's yes / no / redirect reply. */
  | { kind: 'awaiting_gate'; gate: PendingGate }
  /** Engine is in the hop loop; next turn resumes or finishes. */
  | { kind: 'exploring' }
  /** Synthesis turn finished; archive is frozen but addressable. Follow-up turns route through the follow-up protocol. */
  | { kind: 'completed' };
