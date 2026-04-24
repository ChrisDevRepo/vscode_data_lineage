/**
 * Session-phase finite state machine — types and runtime schema.
 *
 * The `@lineage` chat participant owns multi-turn state across one-shot VS Code chat
 * turns. A single session progresses through a small set of discrete phases, and each
 * invocation of the hop loop exits for exactly one typed reason. Promoting these to
 * discriminated unions lets the TypeScript compiler enforce exhaustive handling in
 * every dispatch site — no post-hoc guards, no "forgot to check flag X" regressions.
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
 * Parses the tool-result boundary where untrusted JSON flows from the engine into
 * the participant. The shape mirrors `ActionRequiredGate` in `smTypes.ts` — the
 * engine is the producer, this schema is the consumer-side guard.
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
});

/**
 * A validated consent gate waiting on a user reply. Produced by the engine, resolved
 * by the next user chat turn. Shape matches `ActionRequiredGate` minus the `error`
 * and `hint` fields (those are envelope plumbing, not session state).
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
 * - `synthesis` — engine completed, final report being produced.
 * - `completed` — synthesis turn finished, archive survives on the session singleton. Next turn is a refinement
 *   (text edit, node prune, deferred-question supplement) handled by the follow-up protocol without starting a
 *   fresh exploration.
 */
export type SessionPhase =
  /** No exploration active. Next turn goes through discovery. */
  | { kind: 'idle' }
  /** Engine is paused on a consent gate; awaiting user's yes / no / redirect reply. */
  | { kind: 'awaiting_gate'; gate: PendingGate }
  /** Engine is in the hop loop; next turn resumes or finishes. */
  | { kind: 'exploring' }
  /** Engine completed; synthesis prose is being produced. */
  | { kind: 'synthesis' }
  /** Synthesis turn finished; archive is frozen but addressable. Follow-up turns route through the follow-up protocol. */
  | { kind: 'completed' };

/**
 * Mutually-exclusive outcomes of one hop-loop invocation. Drives the single dispatch
 * that owns all post-loop cleanup (partial-result storage, phase transitions, chat
 * messages). Adding a variant forces every dispatch switch to be updated — the
 * compiler surfaces missed cases.
 */
export type HopLoopExit =
  /** AI produced a final chat response (no tool calls this round). No additional cleanup needed. */
  | { kind: 'final_answer' }
  /** Engine emitted a consent gate; transition to `awaiting_gate` and pause the turn. */
  | { kind: 'gate'; gate: PendingGate }
  /** Hop budget (MAX_ROUNDS) reached without completion. Partial result stored if slots exist. */
  | { kind: 'hop_cap' }
  /** Repeat-reject guard tripped — same tool call failed N times in a row. Partial result stored if slots exist. */
  | { kind: 'aborted'; reason: string }
  /** User cancelled the turn (Stop button, new prompt typed, panel closed). Stream is already closed; no further UI. */
  | { kind: 'cancelled' }
  /** Unhandled exception inside the hop loop. */
  | { kind: 'error'; message: string };

/**
 * Classifies a user's free-text reply to a consent gate into one of three actions.
 *
 * @remarks
 * Three-way classification avoids the ReAct deferral-collapse pattern: anything
 * that is not clearly yes or no is treated as `redirect` (a fresh question), not
 * a "please reply yes or no" loop. Short affirmations map to `yes`, short denials
 * to `no`, everything else to `redirect`.
 *
 * Lives here (not in the participant) so unit tests can exercise it without pulling
 * in the `vscode` module.
 *
 * @param reply - The user's chat message, verbatim.
 * @returns `'yes'` for affirmations, `'no'` for denials, `'redirect'` for anything else.
 */
export function classifyGateReply(reply: string): 'yes' | 'no' | 'redirect' {
  const trimmed = reply.trim().toLowerCase();
  if (/^(y|yes|ok|okay|allow|approve|sure|proceed|do it|go ahead|continue)\b/.test(trimmed)) return 'yes';
  if (/^(n|no|nope|deny|skip|stop|cancel|abort|hold|pause)\b/.test(trimmed)) return 'no';
  return 'redirect';
}
