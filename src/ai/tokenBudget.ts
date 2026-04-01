/**
 * Token budget — single source of truth for all AI data-inclusion decisions.
 *
 * Two numbers drive the entire system:
 *   1. INLINE_TOKEN_BUDGET (this file) — max estimated tokens for inline payloads
 *   2. ai.maxRounds (VS Code setting)  — hard stop on tool rounds
 *
 * Every per-tool cap is derived as a proportion of INLINE_TOKEN_BUDGET.
 * Zero VS Code imports — pure functions for testability.
 */

// ─── The single budget constant ─────────────────────────────────────────────

/** Max estimated tokens for an inline data payload (getContext catalog, CT classic fallback). */
export const INLINE_TOKEN_BUDGET = 20_000; // ~80K chars — exercises on-demand path for most real DBs; large schemas (59K+) always on-demand

// ─── Estimation ─────────────────────────────────────────────────────────────

/** Estimate tokens from a char count (rough: 1 token ≈ 4 chars for JSON). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Should this payload be provided inline or fetched on demand (state machine / tools)? */
export function shouldInline(payloadChars: number): boolean {
  return estimateTokens(payloadChars) <= INLINE_TOKEN_BUDGET;
}

// ─── Derived caps ───────────────────────────────────────────────────────────

/** All per-tool caps derived from INLINE_TOKEN_BUDGET. */
export interface DerivedCaps {
  BFS_MAX_NODES:       number;
  BFS_MAX_EDGES:       number;
  SEARCH_MAX_RESULTS:  number;
  REGEX_MAX_LENGTH:    number;
  ANALYSIS_MAX_GROUPS: number;
  MAX_DDL_CHARS:       number;
  DDL_BATCH_CAP:       number;
}

/**
 * Derive all per-tool caps from INLINE_TOKEN_BUDGET.
 * Changing the budget scales everything proportionally.
 */
export function deriveCaps(): DerivedCaps {
  const B = INLINE_TOKEN_BUDGET;
  return {
    BFS_MAX_NODES:       Math.floor(B / 100),      // ~200 at 20K
    BFS_MAX_EDGES:       Math.floor(B / 66),       // ~300 at 20K
    SEARCH_MAX_RESULTS:  Math.floor(B / 400),      // ~50 at 20K
    REGEX_MAX_LENGTH:    200,                       // fixed — query validation, not payload
    ANALYSIS_MAX_GROUPS: Math.floor(B / 200),       // ~100 at 20K
    MAX_DDL_CHARS:       Math.floor(B * 0.5 * 4),  // ~40K chars at 20K
    DDL_BATCH_CAP:       Math.floor(B / 1000),     // ~20 at 20K
  };
}
