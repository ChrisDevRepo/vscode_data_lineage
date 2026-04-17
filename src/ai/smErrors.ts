/**
 * Typed SM error envelopes (Zod).
 *
 * Centralizes structured error shapes that cross the SM ↔ participant boundary.
 */

import { z } from 'zod';

/**
 * Envelope emitted by {@link RepeatRejectGuard} when the session is aborted
 * because the AI sent three identical tool calls in a row that all failed.
 */
export const RepeatRejectAbort = z.object({
  error: z.literal('session_aborted_repeat_reject'),
  tool: z.string(),
  last_error: z.string(),
  repeat_count: z.literal(3),
});

export type RepeatRejectAbort = z.infer<typeof RepeatRejectAbort>;
