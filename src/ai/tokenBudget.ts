/**
 * Token budget — single source of truth for all AI delivery-mode decisions.
 *
 * Two guards drive the entire system:
 *   1. INLINE_TOKEN_BUDGET (this file) — delivery mode gate: inline vs state machine
 *   2. ai.maxRounds (VS Code setting)  — hard stop on tool rounds (user-configurable)
 *
 * ZERO-TRUNCATION GUARANTEE:
 *   No tool response is ever truncated, capped, or sliced.
 *   - Fits budget → return full data inline
 *   - Exceeds budget → state machine delivers per-hop, or lightweight response with follow-up hint
 *   No data is ever lost. Only delivery mode changes.
 *
 * Zero VS Code imports — pure functions for testability.
 */

// ─── The single budget constant ─────────────────────────────────────────────

/** Delivery mode gate: max estimated tokens for inline delivery. */
export const INLINE_TOKEN_BUDGET = 30_000; // ~120K chars — fits most scopes under 50 nodes

// ─── Estimation ─────────────────────────────────────────────────────────────

/** Estimate tokens from a char count (rough: 1 token ≈ 4 chars for JSON). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Should this payload be delivered inline (one-shot) or on-demand (state machine / follow-up tools)?
 *
 * @param payloadChars  Character count of the payload (used for heuristic estimation)
 * @param precomputedTokens  Optional: accurate token count from countTokens() API. Overrides heuristic when available.
 */
export function shouldInline(payloadChars: number, precomputedTokens?: number): boolean {
  const tokens = precomputedTokens ?? estimateTokens(payloadChars);
  return tokens <= INLINE_TOKEN_BUDGET;
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
