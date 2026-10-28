/** Session-phase finite state machine — types and runtime schema. */

/** Typed control outcome a tool handler records beside its result text, so routing never parses that text (MW-2). The proposal behind a gate is the session's pending exploration. */
export type ToolControlSignal = { readonly kind: 'gate' } | { readonly kind: 'refused'; readonly reason: string };

/** Persistent session phase — the source of truth for what the next chat turn should do. Survives across VS Code chat turns via the `AiSession` singleton. */
export type SessionPhase =
  /** No exploration active. Next turn goes through discovery. */
  | { kind: 'idle' }
  /** Engine is paused on a consent gate; awaiting user's yes / no / redirect reply. */
  | { kind: 'awaiting_gate' }
  /** Engine is in the hop loop; next turn resumes or finishes. */
  | { kind: 'exploring' }
  /** Synthesis turn finished; archive is frozen but addressable. Follow-up turns route through the follow-up protocol. */
  | { kind: 'completed' };
