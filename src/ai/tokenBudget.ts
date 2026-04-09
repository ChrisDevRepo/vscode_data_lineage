/**
 * Token budget — single source of truth for AI delivery-mode decisions.
 *
 * Two guards drive the system:
 *   1. INLINE_TOKEN_BUDGET (this file) — catalog/detail delivery: inline vs on_demand hint
 *   2. ai.maxRounds (VS Code setting)  — hard stop on tool rounds (user-configurable)
 *
 * CT and BB always use state machine delivery (hop-by-hop) regardless of budget.
 * The budget gate applies to getContext() catalog delivery and getObjectDetail() DDL.
 *
 * ZERO-TRUNCATION GUARANTEE:
 *   No tool response is ever truncated, capped, or sliced.
 *   No data is ever lost. Only delivery mode changes.
 *
 * Zero VS Code imports — pure functions for testability.
 */

// ─── The single budget constant ─────────────────────────────────────────────

/** Delivery mode gate for catalog/detail tools: max estimated tokens for inline delivery. */
export const INLINE_TOKEN_BUDGET = 5_000; // ~20K chars — lowered to force SM hop-by-hop for smaller scopes

/** Effective budget: returns INLINE_TOKEN_BUDGET (no runtime override since ai.inlineTokenBudget setting was removed). */
export function getEffectiveBudget(): number {
  return INLINE_TOKEN_BUDGET;
}

// ─── Estimation ─────────────────────────────────────────────────────────────

/** Estimate tokens from a char count (rough: 1 token ≈ 4 chars for JSON). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Should this payload be delivered inline (one-shot) or on-demand (follow-up tools)?
 * Used by getContext() for catalog delivery and getObjectDetail() for DDL delivery.
 */
export function shouldInline(payloadChars: number, precomputedTokens?: number): boolean {
  const tokens = precomputedTokens ?? estimateTokens(payloadChars);
  return tokens <= getEffectiveBudget();
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
