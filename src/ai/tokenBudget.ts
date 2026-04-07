/**
 * Token budget — utilities for AI delivery decisions.
 *
 * Guard: ai.maxRounds (VS Code setting) — hard stop on tool rounds (user-configurable).
 * CT and BB always use state machine delivery (hop-by-hop).
 *
 * ZERO-TRUNCATION GUARANTEE:
 *   No tool response is ever truncated, capped, or sliced.
 *   State machine delivers per-hop — no data is ever lost.
 *
 * Zero VS Code imports — pure functions for testability.
 */

// ─── Estimation ─────────────────────────────────────────────────────────────

/** Estimate tokens from a char count (rough: 1 token ≈ 4 chars for JSON). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

// ─── Context pressure ──────────────────────────────────────────────────────

/**
 * History eviction threshold: evict oldest turns when input tokens exceed
 * this fraction of the model's maxInputTokens.
 */
export const CONTEXT_PRESSURE_THRESHOLD = 0.75;

// ─── Input validation (not response truncation) ────────────────────────────

/** Max regex query length — prevents catastrophic backtracking. Input validation only. */
export const REGEX_MAX_LENGTH = 200;
