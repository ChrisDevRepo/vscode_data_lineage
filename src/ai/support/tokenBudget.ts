/**
 * Token budget — single source of truth for AI delivery-mode decisions.
 *
 * Two discovery caps control SM escalation:
 *   1. ai.discoveryNodeCap (default 10) — max projected scope nodes allowed in
 *      discovery before the engine forces SM via the gate.
 *   2. ai.discoveryTokenBudget (default 10000) — max projected DDL token estimate
 *      for that same scope. Either cap exceeded → request rejected at the tool boundary with
 *      a structured `over_discovery_budget` envelope pointing the AI at
 *      `lineage_start_exploration`.
 *
 * ZERO-TRUNCATION GUARANTEE:
 *   No tool response is ever truncated, capped, or sliced.
 *   No data is ever lost. Over-budget requests are HARD-REJECTED with a hint;
 *   the AI escalates to SM via the gate.
 *
 * Zero VS Code imports — pure functions for testability.
 */

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
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** The heuristic ratio behind {@link estimateTokens} — exported so char caps derived from token caps stay in sync. */
const CHARS_PER_TOKEN = 4;

// ─── Shared budget-guard state ───────────────────────────────────────────────

/**
 * One (nodeCap, tokenBudget) pair with clamped setters and the shared threshold test.
 * Both phase guards instantiate this; the rejection envelopes stay with their phase
 * because their shapes are distinct contracts (`over_discovery_budget` carries a hint
 * and byte counts, the active guard token counts).
 */
function createBudgetState(defaultNodeCap: number, defaultTokenBudget: number) {
  let nodeCap = defaultNodeCap;
  let tokenBudget = defaultTokenBudget;
  return {
    get nodeCap() { return nodeCap; },
    get tokenBudget() { return tokenBudget; },
    setNodeCap(value: number): void { nodeCap = Math.max(1, value | 0); },
    setTokenBudget(value: number): void { tokenBudget = Math.max(1000, value | 0); },
    exceeds(nodes: number, tokens: number): boolean { return nodes > nodeCap || tokens > tokenBudget; },
  };
}

// ─── Discovery-phase budget guard ────────────────────────────────────────────

/** Default node cap for discovery-phase catalog requests — overridden via VS Code `ai.discoveryNodeCap`. */
export const DEFAULT_DISCOVERY_NODE_CAP = 10;

/** Default DDL-token budget for discovery-phase catalog requests — overridden via `ai.discoveryTokenBudget`. */
export const DEFAULT_DISCOVERY_TOKEN_BUDGET = 10_000;

const discoveryBudget = createBudgetState(DEFAULT_DISCOVERY_NODE_CAP, DEFAULT_DISCOVERY_TOKEN_BUDGET);

/** Configures the runtime discovery node cap from VS Code settings. */
export function setDiscoveryNodeCap(value: number): void {
  discoveryBudget.setNodeCap(value);
}

/** Configures the runtime discovery token budget from VS Code settings. */
export function setDiscoveryTokenBudget(value: number): void {
  discoveryBudget.setTokenBudget(value);
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
  if (!discoveryBudget.exceeds(requestedNodes, tokens)) return { ok: true };
  return {
    ok: false,
    reason: 'over_discovery_budget',
    counts: { nodes: requestedNodes, ddl_bytes: requestedDdlBytes },
    limits: { node_cap: discoveryBudget.nodeCap, token_budget: discoveryBudget.tokenBudget },
    hint: 'Scope exceeds the discovery budget. Stop this tool loop; the host will route the validated request to the consent-gated exploration path.',
  };
}

// ─── Active-phase (exploration) admission guard ──────────────────────────────

/** Default total-scope node cap during active exploration — overridden via `ai.explorationNodeCap`. Sized well above the discovery cap (hop loop legitimately grows scope) but far below the 500-item DoS ceiling. */
export const DEFAULT_EXPLORATION_NODE_CAP = 150;

/** Default cumulative DDL-token budget for the active scope — overridden via `ai.explorationTokenBudget`. */
export const DEFAULT_EXPLORATION_TOKEN_BUDGET = 80_000;

/** Fraction of the selected model's input window the discovery budget may claim — the setting is a ceiling, the window share the floor for small BYOK models. */
export const DISCOVERY_WINDOW_SHARE = 0.125;

/** Fraction of the selected model's input window the exploration budget may claim. */
export const EXPLORATION_WINDOW_SHARE = 0.5;

const explorationBudget = createBudgetState(DEFAULT_EXPLORATION_NODE_CAP, DEFAULT_EXPLORATION_TOKEN_BUDGET);

/** Configures the runtime exploration node cap from VS Code settings. */
export function setExplorationNodeCap(value: number): void {
  explorationBudget.setNodeCap(value);
}

/** Configures the runtime exploration token budget from VS Code settings. */
export function setExplorationTokenBudget(value: number): void {
  explorationBudget.setTokenBudget(value);
}

/**
 * Active-phase scope admission check — fires per hop before staged scope growth commits.
 *
 * @remarks
 * The discovery guard ({@link checkScopeBudget}) protects the pre-consent phase; this guard
 * bounds the hop loop, where accepted routes otherwise grow scope for up to `maxRounds` hops
 * with no ceiling. Run BEFORE mutating scope; on overflow the engine holds the submission and
 * returns a structured rejection so the model prunes, defers, or synthesizes — no fallback,
 * no truncation, per the zero-truncation guarantee above.
 *
 * @param projectedNodes - Scope size if the staged additions were committed.
 * @param projectedDdlChars - Cumulative DDL characters of the projected scope.
 * @returns `{ ok: true }` when the projection fits both caps; otherwise the counts and limits.
 */
export function checkActiveScopeAdmission(
  projectedNodes: number,
  projectedDdlChars: number,
): { ok: true } | { ok: false; reason: 'over_active_scope_budget'; counts: { nodes: number; tokens: number }; limits: { node_cap: number; token_budget: number } } {
  const tokens = estimateTokens(projectedDdlChars);
  if (!explorationBudget.exceeds(projectedNodes, tokens)) return { ok: true };
  return {
    ok: false,
    reason: 'over_active_scope_budget',
    counts: { nodes: projectedNodes, tokens },
    limits: { node_cap: explorationBudget.nodeCap, token_budget: explorationBudget.tokenBudget },
  };
}

/**
 * Maximum allowed length for a regular expression query.
 *
 * @remarks
 * Used during input validation to mitigate the risk of ReDoS (Regular Expression Denial of Service)
 * and ensure catastrophic backtracking does not occur during model searching.
 */
export const REGEX_MAX_LENGTH = 200;
