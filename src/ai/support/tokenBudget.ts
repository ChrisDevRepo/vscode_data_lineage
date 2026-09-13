/**
 * Token budget — single source of truth for AI delivery-mode decisions.
 *
 * Two discovery caps control whether a catalog request stays inline:
 *   1. ai.discoveryNodeCap (default 10) — max projected scope nodes allowed in
 *      discovery. Over cap → hard-rejected with `over_discovery_budget`; discovery stays in
 *      chat and the existing SM-offer pill is the opt-in for a detailed analysis.
 *   2. ai.discoveryTokenBudget (default 10000) — max projected DDL token estimate
 *      for that same scope. Either cap exceeded → the same envelope. `/trace` and
 *      column-trace still enter SM via entryRouting, not this overflow.
 *
 * ZERO-TRUNCATION GUARANTEE:
 *   No tool response is ever truncated, capped, or sliced.
 *   No data is ever lost. An over-budget request is rejected as a whole and answered
 *   with a partial bundle plus the referral hint below (report-and-offer) — the
 *   partial payload is a different bounded payload, never a slice of the rejected
 *   request. Naming `lineage_start_exploration` in a tool hint is precedented
 *   (`RESULT_TOO_LARGE_HINT`).
 *
 * Zero VS Code imports — pure functions for testability.
 */
import { REJECTION_CODES } from './rejectionCodes';

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

// ─── The turn's budget ───────────────────────────────────────────────────────

/** Default node cap for discovery-phase catalog requests — overridden via VS Code `ai.discoveryNodeCap`. */
export const DEFAULT_DISCOVERY_NODE_CAP = 10;

/** Default DDL-token budget for discovery-phase catalog requests — overridden via `ai.discoveryTokenBudget`. */
export const DEFAULT_DISCOVERY_TOKEN_BUDGET = 10_000;

/** Default total-scope node cap during active exploration — overridden via `ai.explorationNodeCap`. Sized well above the discovery cap (hop loop legitimately grows scope) but far below the 500-item DoS ceiling. */
export const DEFAULT_EXPLORATION_NODE_CAP = 150;

/** Default cumulative DDL-token budget for the active scope — overridden via `ai.explorationTokenBudget`. */
export const DEFAULT_EXPLORATION_TOKEN_BUDGET = 80_000;

/**
 * One phase's (nodeCap, tokenBudget) pair, clamped at construction.
 * Both phase guards read one of these; the rejection envelopes stay with their phase
 * because their shapes are distinct contracts (`over_discovery_budget` carries a hint
 * and byte counts, the active guard token counts).
 */
export interface PhaseScopeBudget {
  /** Maximum scope nodes the phase admits. */
  readonly nodeCap: number;
  /** Maximum estimated DDL tokens the phase admits. */
  readonly tokenBudget: number;
}

/**
 * Every token budget one turn runs under, fixed when the turn starts.
 *
 * @remarks
 * The value is immutable and carried by the turn's own objects — the request-scoped model port and
 * the lease-bound tool services — so two turns in flight at once, each on its own model, read
 * their own window and caps. Nothing here is process state.
 */
export interface TurnTokenBudget {
  /** Input window of the model the turn selected; `Infinity` when the provider reports none. */
  readonly modelWindowTokens: number;
  /** Pre-consent catalog-request caps. */
  readonly discovery: PhaseScopeBudget;
  /** Active hop-loop scope caps. */
  readonly exploration: PhaseScopeBudget;
}

/** Clamps one phase pair: at least one node, at least a thousand tokens. */
function phaseScopeBudget(nodeCap: number, tokenBudget: number): PhaseScopeBudget {
  return Object.freeze({
    nodeCap: Math.max(1, nodeCap | 0),
    tokenBudget: Math.max(1000, tokenBudget | 0),
  });
}

/** True when either axis of `budget` is exceeded. */
function exceedsPhaseBudget(budget: PhaseScopeBudget, nodes: number, tokens: number): boolean {
  return nodes > budget.nodeCap || tokens > budget.tokenBudget;
}

/**
 * Builds one turn's immutable budget from the selected model's window and the workspace settings.
 *
 * @param settings - Resolved per-turn values; each omitted field falls back to its shipped default,
 *   and a non-positive `modelWindowTokens` means the window is unknown so the ceilings apply.
 * @returns The frozen budget the turn's objects carry.
 */
export function createTurnTokenBudget(settings: {
  readonly modelWindowTokens?: number;
  readonly discoveryNodeCap?: number;
  readonly discoveryTokenBudget?: number;
  readonly explorationNodeCap?: number;
  readonly explorationTokenBudget?: number;
} = {}): TurnTokenBudget {
  const window = settings.modelWindowTokens ?? 0;
  return Object.freeze({
    modelWindowTokens: window > 0 ? window : Number.POSITIVE_INFINITY,
    discovery: phaseScopeBudget(
      settings.discoveryNodeCap ?? DEFAULT_DISCOVERY_NODE_CAP,
      settings.discoveryTokenBudget ?? DEFAULT_DISCOVERY_TOKEN_BUDGET,
    ),
    exploration: phaseScopeBudget(
      settings.explorationNodeCap ?? DEFAULT_EXPLORATION_NODE_CAP,
      settings.explorationTokenBudget ?? DEFAULT_EXPLORATION_TOKEN_BUDGET,
    ),
  });
}

/**
 * The budget in force where no turn selected one — the shipped defaults with no model window.
 *
 * @remarks
 * Read by the `vscode.lm` tool registration, which serves external callers outside any `@lineage`
 * turn and therefore has no model window or turn-scoped settings to calibrate against.
 */
export const DEFAULT_TURN_TOKEN_BUDGET: TurnTokenBudget = createTurnTokenBudget();

// ─── Discovery-phase budget guard ────────────────────────────────────────────

/**
 * Discovery scope budget check — fires per scope-expanding catalog request.
 *
 * @remarks
 * Run BEFORE executing the underlying catalog handler. On overflow, the caller
 * returns the structured rejection envelope carrying partial data plus this
 * `hint` — the report-and-offer referral: answer the user briefly from the
 * partial data the result carries, say the full question needs a detailed
 * analysis, and offer to continue with `lineage_start_exploration` once the
 * user confirms, never starting it. Naming `lineage_start_exploration` in a
 * tool hint is precedented (`RESULT_TOO_LARGE_HINT`); the rule that a
 * hint must not name hop-by-hop or a consent-gated path does not apply to this
 * hint — the consent gate itself stays untouched and the post-discovery
 * SM-offer pill remains the trigger. No
 * fallback, and nothing is ever truncated: the partial payload the caller
 * attaches is a different bounded payload, not a slice of the rejected request.
 *
 * @param budget - The calling turn's budget.
 * @param requestedNodes - Number of nodes the request would load (e.g. BFS result size).
 * @param requestedDdlBytes - Total DDL bytes that would be returned.
 * @returns `{ ok: true }` when the request fits both caps; otherwise `{ ok: false, ... }`
 *          with the counts, limits, and AI-facing hint.
 */
export function checkScopeBudget(
  budget: TurnTokenBudget,
  requestedNodes: number,
  requestedDdlBytes: number,
): { ok: true } | { ok: false; reason: 'over_discovery_budget'; counts: { nodes: number; ddl_bytes: number }; limits: { node_cap: number; token_budget: number }; hint: string } {
  const tokens = estimateTokens(requestedDdlBytes);
  if (!exceedsPhaseBudget(budget.discovery, requestedNodes, tokens)) return { ok: true };
  return {
    ok: false,
    reason: REJECTION_CODES.overDiscoveryBudget,
    counts: { nodes: requestedNodes, ddl_bytes: requestedDdlBytes },
    limits: { node_cap: budget.discovery.nodeCap, token_budget: budget.discovery.tokenBudget },
    hint: 'Scope exceeds the discovery budget, so only partial data could be loaded. Answer the user briefly from the partial data this result carries, say the full question needs a detailed analysis, and offer to continue with lineage_start_exploration once the user confirms — do not start it yourself.',
  };
}

// ─── Bounded prompt blocks ───────────────────────────────────────────────────

/**
 * Fraction of the selected model's input window one bounded prompt block may claim — the retry
 * context, the discovery evidence projection, the replayed discovery transcript.
 *
 * @remarks
 * The byte ceilings below were sized for a 128Ki-token window, where this share equals them; on a
 * smaller BYOK window the same share scales every block down together, so a retry block can never
 * exceed the window it is appended to. Each ceiling is the block's own home; this share is theirs.
 */
export const CONTEXT_BLOCK_WINDOW_SHARE = 0.125;

/** Ceiling for the rendered `<runtime_tool_context>` retry payload — three quarters of the 64 KiB discovery ceiling, leaving a quarter for the instruction and question the payload is appended to. */
export const MAX_ATTEMPT_CONTEXT_BYTES = 49_152;

/** Ceiling for the complete discovery-evidence message and for the replayed discovery transcript — one 64 KiB prompt budget, applied to each so the two cannot compound. */
export const MAX_DISCOVERY_BLOCK_BYTES = 65_536;

/** Headroom reserved inside a block for identity fields, so one bounded item never fills the whole block. */
export const CONTEXT_BLOCK_ITEM_HEADROOM_BYTES = 4_096;

/** Bytes one bounded prompt block may hold on the turn's model: its ceiling, or the window share when that is smaller. */
function contextBlockBytes(budget: TurnTokenBudget, ceiling: number): number {
  const share = Math.floor(budget.modelWindowTokens * CONTEXT_BLOCK_WINDOW_SHARE * CHARS_PER_TOKEN);
  return Number.isFinite(share) ? Math.max(CONTEXT_BLOCK_ITEM_HEADROOM_BYTES, Math.min(ceiling, share)) : ceiling;
}

/** Byte budget for the rendered retry context on the turn's model. */
export function attemptContextBytes(budget: TurnTokenBudget): number {
  return contextBlockBytes(budget, MAX_ATTEMPT_CONTEXT_BYTES);
}

/** Byte budget for one stored evidence kind (observations or rejections) on the turn's model. */
export function storedEvidenceKindBytes(budget: TurnTokenBudget): number {
  return attemptContextBytes(budget) - CONTEXT_BLOCK_ITEM_HEADROOM_BYTES;
}

/** Byte budget for the complete discovery-evidence message, and for the replayed discovery transcript, on the turn's model. */
export function discoveryBlockBytes(budget: TurnTokenBudget): number {
  return contextBlockBytes(budget, MAX_DISCOVERY_BLOCK_BYTES);
}

/** Byte budget for one canonical discovery result, held below {@link discoveryBlockBytes} so one result cannot fill the block. */
export function discoveryEvidenceItemBytes(budget: TurnTokenBudget): number {
  return discoveryBlockBytes(budget) - CONTEXT_BLOCK_ITEM_HEADROOM_BYTES;
}

// ─── Active-phase (exploration) admission guard ──────────────────────────────

/** Fraction of the selected model's input window the discovery budget may claim — the setting is a ceiling, the window share the floor for small BYOK models. */
export const DISCOVERY_WINDOW_SHARE = 0.125;

/** Fraction of the selected model's input window the exploration budget may claim. */
export const EXPLORATION_WINDOW_SHARE = 0.5;

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
 * @param budget - The calling turn's budget.
 * @param projectedNodes - Scope size if the staged additions were committed.
 * @param projectedDdlChars - Cumulative DDL characters of the projected scope.
 * @returns `{ ok: true }` when the projection fits both caps; otherwise the counts and limits.
 */
export function checkActiveScopeAdmission(
  budget: TurnTokenBudget,
  projectedNodes: number,
  projectedDdlChars: number,
): { ok: true; counts: { nodes: number; tokens: number }; limits: { node_cap: number; token_budget: number } }
  | { ok: false; reason: 'over_active_scope_budget'; counts: { nodes: number; tokens: number }; limits: { node_cap: number; token_budget: number } } {
  const tokens = estimateTokens(projectedDdlChars);
  // Both arms carry the same counts and limits. The rejection always recorded the budget it broke
  // and the admission recorded nothing, so a run that grew the scope comfortably and a run that
  // never grew it at all read identically in the log.
  const counts = { nodes: projectedNodes, tokens };
  const limits = { node_cap: budget.exploration.nodeCap, token_budget: budget.exploration.tokenBudget };
  if (!exceedsPhaseBudget(budget.exploration, projectedNodes, tokens)) return { ok: true, counts, limits };
  return { ok: false, reason: 'over_active_scope_budget', counts, limits };
}

/**
 * Maximum allowed length for a regular expression query.
 *
 * @remarks
 * Used during input validation to mitigate the risk of ReDoS (Regular Expression Denial of Service)
 * and ensure catastrophic backtracking does not occur during model searching.
 */
export const REGEX_MAX_LENGTH = 200;
