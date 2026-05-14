/**
 * Token budget — single source of truth for AI delivery-mode decisions.
 *
 * Two budgets in play:
 *   1. ai.discoveryNodeCap (default 10) — max projected scope nodes allowed in
 *      discovery before the engine forces SM via the gate.
 *   2. ai.discoveryTokenBudget (default 10000) — max projected DDL token estimate
 *      for that same scope. Either cap exceeded → request rejected at the tool boundary with
 *      a structured `over_discovery_budget` envelope pointing the AI at
 *      `lineage_start_exploration`.
 *
 * Plus catalog payload sizing for `lineage_get_context`:
 *   - `shouldInline` decides catalog inline-vs-summary delivery for the
 *     get_context call. Different concept from SM execution mode (which is
 *     gone) — this is about whether the catalog full payload fits.
 *
 * ZERO-TRUNCATION GUARANTEE:
 *   No tool response is ever truncated, capped, or sliced.
 *   No data is ever lost. Over-budget requests are HARD-REJECTED with a hint;
 *   the AI escalates to SM via the gate.
 *
 * Zero VS Code imports — pure functions for testability.
 */


/** Default catalog-inline token budget — overridden per-request via `ai.contextPayloadBudget`. */
const DEFAULT_CATALOG_INLINE_TOKEN_BUDGET = 10_000;

/** Runtime budget for `lineage_get_context` catalog inline-vs-summary delivery. */
let catalogInlineTokenBudget = DEFAULT_CATALOG_INLINE_TOKEN_BUDGET;

/**
 * Configures the catalog inline budget from VS Code settings.
 *
 * @param value - Token budget for catalog full-payload-vs-summary decision.
 */
export function setCatalogInlineTokenBudget(value: number): void {
  catalogInlineTokenBudget = value;
}

/**
 * Retrieves the catalog inline budget — used by `shouldInline` for catalog delivery decisions.
 */
export function getEffectiveBudget(): number {
  return catalogInlineTokenBudget;
}


/**
 * Provides a heuristic estimation of token count from a character count.
 *
 * @remarks
 * Uses a standard approximation of 1 token ≈ 4 characters for JSON/SQL payloads.
 *
 * @param chars - The number of characters in the payload string.
 * @returns An estimated token count.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Determines if a catalog payload should be delivered inline (full) or via on-demand summary.
 *
 * @remarks
 * Used only by `lineage_get_context` for full-catalog vs. summary-only delivery.
 * Has nothing to do with the (removed) SM inline execution mode.
 *
 * @param payloadChars - The character count of the payload.
 * @param precomputedTokens - Optional pre-calculated token count to skip estimation.
 * @returns `true` if the payload fits within the effective budget for full delivery.
 */
export function shouldInline(payloadChars: number, precomputedTokens?: number): boolean {
  const tokens = precomputedTokens ?? estimateTokens(payloadChars);
  return tokens <= getEffectiveBudget();
}


// ─── Discovery-phase budget guard ────────────────────────────────────────────

/** Default node cap for discovery-phase catalog requests — overridden via VS Code `ai.discoveryNodeCap`. */
const DEFAULT_DISCOVERY_NODE_CAP = 10;

/** Default DDL-token budget for discovery-phase catalog requests — overridden via `ai.discoveryTokenBudget`. */
const DEFAULT_DISCOVERY_TOKEN_BUDGET = 10_000;

let discoveryNodeCap = DEFAULT_DISCOVERY_NODE_CAP;
let discoveryTokenBudget = DEFAULT_DISCOVERY_TOKEN_BUDGET;

/** Configures the runtime discovery node cap from VS Code settings. */
export function setDiscoveryNodeCap(value: number): void {
  discoveryNodeCap = Math.max(1, value | 0);
}

/** Configures the runtime discovery token budget from VS Code settings. */
export function setDiscoveryTokenBudget(value: number): void {
  discoveryTokenBudget = Math.max(1000, value | 0);
}

/** Retrieves the active discovery caps for diagnostics + the rejection envelope. */
export function getDiscoveryLimits(): { node_cap: number; token_budget: number } {
  return { node_cap: discoveryNodeCap, token_budget: discoveryTokenBudget };
}

/**
 * Discovery scope budget check — fires per scope-expanding catalog request.
 *
 * @remarks
 * Run BEFORE executing the underlying catalog handler. On overflow, the caller
 * returns the structured rejection envelope (with `hint` pointing at
 * `lineage_start_exploration`) instead of running the handler. No fallback —
 * over-budget requests are hard rejections per the project's "no fallback paths"
 * rule.
 *
 * @param requestedNodes - Number of nodes the request would load (e.g. BFS result size).
 * @param requestedDdlBytes - Total DDL bytes that would be returned.
 * @returns `{ ok: true }` when the request fits both caps; otherwise `{ ok: false, ... }`
 *          with the counts, limits, and AI-facing hint.
 */
export function checkScopeBudget(
  requestedNodes: number,
  requestedDdlBytes: number,
): { ok: true } | { ok: false; reason: 'over_discovery_budget'; counts: { nodes: number; ddl_bytes: number }; limits: { node_cap: number; token_budget: number }; hint: string } {
  const tokens = estimateTokens(requestedDdlBytes);
  const overNodes = requestedNodes > discoveryNodeCap;
  const overTokens = tokens > discoveryTokenBudget;
  if (!overNodes && !overTokens) return { ok: true };
  return {
    ok: false,
    reason: 'over_discovery_budget',
    counts: { nodes: requestedNodes, ddl_bytes: requestedDdlBytes },
    limits: { node_cap: discoveryNodeCap, token_budget: discoveryTokenBudget },
    hint: 'Scope exceeds discovery budget. Call lineage_start_exploration to begin SM mode; the user must approve via the gate before the engine will load this scope.',
  };
}


/**
 * The threshold (0.0 to 1.0) at which context pressure triggers history eviction.
 *
 * @remarks
 * When the input token count exceeds this fraction of the model's `maxInputTokens`,
 * the oldest conversation turns are evicted to ensure the AI remains responsive.
 */
export const CONTEXT_PRESSURE_THRESHOLD = 0.75;


/**
 * Maximum allowed length for a regular expression query.
 *
 * @remarks
 * Used during input validation to mitigate the risk of ReDoS (Regular Expression Denial of Service)
 * and ensure catastrophic backtracking does not occur during model searching.
 */
export const REGEX_MAX_LENGTH = 200;
