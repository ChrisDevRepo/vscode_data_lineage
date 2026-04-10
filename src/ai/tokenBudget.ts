/**
 * Token budget — single source of truth for AI delivery-mode decisions.
 *
 * Two guards drive the system:
 *   1. ai.inlineTokenBudget (VS Code setting, default 10K) — delivery mode gate:
 *      - Below budget → inline: AI gets all DDL at once, reasons in one pass (no sliding memory)
 *      - Above budget → hop-by-hop: state machine with short_memory + detail_slots
 *      Applies to: CT, BB, getContext(), runBfsTrace()
 *   2. ai.maxRounds (VS Code setting)  — hard stop on tool rounds (user-configurable)
 *
 * ZERO-TRUNCATION GUARANTEE:
 *   No tool response is ever truncated, capped, or sliced.
 *   No data is ever lost. Only delivery mode changes.
 *
 * Zero VS Code imports — pure functions for testability.
 */

// ─── Inline token budget (configurable via VS Code setting) ────────────────

/** Default inline token budget — overridden per-request from VS Code setting `ai.inlineTokenBudget`. */
const DEFAULT_INLINE_TOKEN_BUDGET = 10_000;

/** Runtime budget — set from VS Code setting at each request start. */
let _inlineTokenBudget = DEFAULT_INLINE_TOKEN_BUDGET;

/** Set from VS Code setting (called per-request in extension.ts). */
export function setInlineTokenBudget(value: number): void {
  _inlineTokenBudget = value;
}

/** Returns the configured inline token budget. */
export function getEffectiveBudget(): number {
  return _inlineTokenBudget;
}

// ─── Estimation ─────────────────────────────────────────────────────────────

/** Estimate tokens from a char count (rough: 1 token ≈ 4 chars for JSON). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Should this payload be delivered inline (one-shot) or on-demand (follow-up tools)?
 * Used by getContext(), runBfsTrace(), start_column_trace, and start_exploration.
 */
export function shouldInline(payloadChars: number, precomputedTokens?: number): boolean {
  const tokens = precomputedTokens ?? estimateTokens(payloadChars);
  return tokens <= getEffectiveBudget();
}

// ─── SM inline node cap ───────────────────────────────────────────────────

/** Max scope nodes for inline SM delivery. Above this, always use hop-by-hop even if tokens fit. */
export const SM_INLINE_NODE_CAP = 10;

/**
 * Should CT/BB use inline delivery? Checks BOTH token budget AND node count.
 * Small scopes (≤10 nodes, under token budget) → inline.
 * Larger scopes → hop-by-hop with sliding memory (deep traces need memory for rename tracking).
 */
export function shouldSmInline(payloadChars: number, scopeNodeCount: number): boolean {
  return scopeNodeCount <= SM_INLINE_NODE_CAP && shouldInline(payloadChars);
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
