/**
 * Token budget — single source of truth for AI delivery-mode decisions.
 *
 * Two discovery caps control SM escalation: `ai.discoveryNodeCap` (default 10, max projected
 * scope nodes) and `ai.discoveryTokenBudget` (default 10000, max projected DDL tokens). Either
 * cap exceeded rejects the request at the tool boundary with `over_discovery_budget`, pointing
 * the AI at `lineage_start_exploration`.
 *
 * No tool response is ever truncated, capped or sliced — an over-budget request is hard-rejected
 * with a hint instead, and the AI escalates to SM via the gate.
 *
 * The exploration admission limits — `ai.maxRounds` and `ai.maxTraceColumns` — live here too, in
 * {@link checkScopeAdmission}.
 *
 * Zero VS Code imports — pure functions for testability.
 */
import { DEFAULT_MAX_ROUNDS } from '../core/agentCore';
import { REJECTION_CODES } from './rejectionCodes';
import { makeRejection, type ToolRejection } from './toolErrorEnvelope';

/**
 * Provides a heuristic estimation of token count from a character count.
 *
 * @remarks
 * Uses a standard approximation of 1 token ≈ 4 characters for JSON/SQL payloads.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** The heuristic ratio behind {@link estimateTokens} and the byte ceilings derived from token counts. */
const CHARS_PER_TOKEN = 4;

export const OVER_DISCOVERY_BUDGET_HINT = 'Scope exceeds the discovery budget. A scope this large is analysed hop by hop through an approved exploration.';

/** Default node cap for discovery-phase catalog requests — overridden via VS Code `ai.discoveryNodeCap`. */
export const DEFAULT_DISCOVERY_NODE_CAP = 10;

/** Default for `ai.maxTraceColumns`: starting columns one column trace may select. */
export const DEFAULT_MAX_TRACE_COLUMNS = 10;

/** Default DDL-token budget for discovery-phase catalog requests — overridden via `ai.discoveryTokenBudget`. */
export const DEFAULT_DISCOVERY_TOKEN_BUDGET = 10_000;


/** The discovery phase's (nodeCap, tokenBudget) pair, clamped at construction. */
export interface PhaseScopeBudget {
  /** Maximum scope nodes the phase admits. */
  readonly nodeCap: number;
  /** Maximum estimated DDL tokens the phase admits. */
  readonly tokenBudget: number;
}

/** The limits an exploration proposal is admitted under: rounds and starting trace columns. */
export interface ExplorationLimits {
  /** Maximum rounds of one exploration (`ai.maxRounds`); procedures, views and functions each take one. */
  readonly maxRounds: number;
  /** Maximum starting columns one column trace may select (`ai.maxTraceColumns`). */
  readonly maxTraceColumns: number;
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
  /** Limits an exploration proposal is admitted under, read once per turn. */
  readonly exploration: ExplorationLimits;
}

/** Clamps the discovery pair: at least one node, at least a thousand tokens. */
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
 *   and a non-positive `modelWindowTokens` means the window is unknown so the fallback window applies.
 * @returns The frozen budget the turn's objects carry.
 */
export function createTurnTokenBudget(settings: {
  readonly modelWindowTokens?: number;
  readonly discoveryNodeCap?: number;
  readonly discoveryTokenBudget?: number;
  readonly maxRounds?: number;
  readonly maxTraceColumns?: number;
} = {}): TurnTokenBudget {
  const window = settings.modelWindowTokens ?? 0;
  return Object.freeze({
    modelWindowTokens: window > 0 ? window : Number.POSITIVE_INFINITY,
    discovery: phaseScopeBudget(
      settings.discoveryNodeCap ?? DEFAULT_DISCOVERY_NODE_CAP,
      settings.discoveryTokenBudget ?? DEFAULT_DISCOVERY_TOKEN_BUDGET,
    ),
    exploration: Object.freeze({
      maxRounds: Math.max(1, (settings.maxRounds ?? DEFAULT_MAX_ROUNDS) | 0),
      maxTraceColumns: Math.max(1, (settings.maxTraceColumns ?? DEFAULT_MAX_TRACE_COLUMNS) | 0),
    }),
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


/**
 * Discovery scope budget check — fires per scope-expanding catalog request.
 *
 * @remarks
 * Run BEFORE executing the underlying catalog handler; on overflow the caller returns the
 * structured rejection envelope instead of running it — no truncation, the whole request is
 * refused.
 *
 * In discovery an oversized `lineage_get_scope_bundle` never reaches the model:
 * `detectOverBudgetFromResult` makes that result a reroute terminal, so the turn leaves discovery
 * for SM entry and the consent gate opens there.
 *
 * @param requestedNodes - Number of nodes the request would load (e.g. BFS result size).
 * @param requestedDdlBytes - Total DDL bytes that would be returned.
 * @returns `null` when the request fits both caps; otherwise the rejection carrying the counts and
 *          limits in `detail` and the AI-facing hint.
 */
export function checkScopeBudget(
  budget: TurnTokenBudget,
  requestedNodes: number,
  requestedDdlBytes: number,
): DiscoveryBudgetRejection | null {
  const tokens = estimateTokens(requestedDdlBytes);
  if (!exceedsPhaseBudget(budget.discovery, requestedNodes, tokens)) return null;
  return {
    ...makeRejection({
      code: REJECTION_CODES.overDiscoveryBudget,
      hint: OVER_DISCOVERY_BUDGET_HINT,
    }),
    detail: {
      counts: { nodes: requestedNodes, ddl_bytes: requestedDdlBytes },
      limits: { node_cap: budget.discovery.nodeCap, token_budget: budget.discovery.tokenBudget },
    },
  };
}

/** A discovery-budget refusal: the rejection with the request's measured counts and the caps in `detail`. */
export type DiscoveryBudgetRejection = ToolRejection & {
  detail: {
    counts: { nodes: number; ddl_bytes: number };
    limits: { node_cap: number; token_budget: number };
  };
};


/**
 * Fraction of the selected model's input window one bounded prompt block may claim — the retry
 * context, the discovery evidence projection, the replayed discovery transcript.
 *
 * @remarks
 * The one size rule for prompt blocks: a block scales with the window it is appended to, so a
 * retry block can never exceed that window.
 */
export const CONTEXT_BLOCK_WINDOW_SHARE = 0.125;

/** Window, in tokens, assumed when the model reports none. */
const UNKNOWN_WINDOW_TOKENS = 131_072;

/** Headroom reserved inside a block for identity fields, so one bounded item never fills the whole block. */
export const CONTEXT_BLOCK_ITEM_HEADROOM_BYTES = 4_096;

/** Bytes one bounded prompt block may hold on the turn's model: the window share, or the same share of {@link UNKNOWN_WINDOW_TOKENS} when the model reports no window. */
export function contextBlockBytes(budget: TurnTokenBudget): number {
  const window = Number.isFinite(budget.modelWindowTokens) ? budget.modelWindowTokens : UNKNOWN_WINDOW_TOKENS;
  return Math.max(CONTEXT_BLOCK_ITEM_HEADROOM_BYTES, Math.floor(window * CONTEXT_BLOCK_WINDOW_SHARE * CHARS_PER_TOKEN));
}

/** Byte budget for one stored evidence kind (observations or rejections) on the turn's model. */
export function storedEvidenceKindBytes(budget: TurnTokenBudget): number {
  return contextBlockBytes(budget) - CONTEXT_BLOCK_ITEM_HEADROOM_BYTES;
}

/** Byte budget for one canonical discovery result, held below {@link contextBlockBytes} so one result cannot fill the block. */
export function discoveryEvidenceItemBytes(budget: TurnTokenBudget): number {
  return contextBlockBytes(budget) - CONTEXT_BLOCK_ITEM_HEADROOM_BYTES;
}


/** Fraction of the selected model's input window the discovery budget may claim — the effective budget is the smaller of the setting and this share of the window. */
export const DISCOVERY_WINDOW_SHARE = 0.125;

/** What the admission check measures of one proposed scope. */
export interface ProposedScope {
  /** Every node in the scope, tables included. */
  readonly nodes: number;
  /** Hops the run takes: those already taken plus one per procedure, view or function still to visit, queued table and supplement target. */
  readonly rounds: number;
  /** Distinct starting columns selected for the trace at the origin; 0 for a BB scope and for a supplement. */
  readonly columns: number;
}

/** Which admission limit refused a scope. */
export type ScopeRefusalLimit = 'rounds' | 'columns';

/** An over-limit scope: the axis that refused it and the plain-words texts the user reads. */
export interface ScopeRefusal {
  readonly limit: ScopeRefusalLimit;
  /** Shown when no proposal exists yet. */
  readonly text: string;
  /** Shown when a refinement broke the limit and the held proposal stays open. */
  readonly refineText: string;
  /** Shown when a supplement to a completed exploration broke the limit. */
  readonly supplementText: string;
}

/** Builds both user texts of one refusal from the limit reached and the way out. */
function scopeRefusal(limit: ScopeRefusalLimit, reached: string, wayOut: string): ScopeRefusal {
  return {
    limit,
    text: `Analysis cannot start: ${reached} — ${wayOut} and ask again.`,
    refineText: `The change was not applied: ${reached}. The previous plan is still open — approve it, or change it again after you ${wayOut}.`,
    supplementText: `The supplement was not applied: ${reached}. The completed analysis is unchanged — ${wayOut} and ask again.`,
  };
}

/**
 * The one exploration admission check, run on the dry-run proposal before the approval card, on a
 * scope change and on a supplement: the run's hops against `ai.maxRounds`, then the trace's starting columns against `ai.maxTraceColumns`. Columns tracked hop by
 * hop are never counted. A refusal is the user's to act on — the model never narrows a scope to fit.
 *
 * @returns `null` when the scope is admitted; otherwise the refusal.
 */
export function checkScopeAdmission(budget: TurnTokenBudget, scope: ProposedScope): ScopeRefusal | null {
  const { maxRounds, maxTraceColumns } = budget.exploration;
  if (scope.rounds > maxRounds) {
    return scopeRefusal(
      'rounds',
      `round limit reached (${scope.rounds}/${maxRounds}); each object the analysis reads takes one round`,
      'narrow the scope (exclude a schema, one direction, fewer levels) or raise `dataLineageViz.ai.maxRounds`',
    );
  }
  if (scope.columns > maxTraceColumns) {
    return scopeRefusal(
      'columns',
      `column limit reached (${scope.columns}/${maxTraceColumns}); a column trace follows at most that many starting columns`,
      'trace fewer columns or raise `dataLineageViz.ai.maxTraceColumns`',
    );
  }
  return null;
}

/**
 * Maximum allowed length for a regular expression query.
 *
 * @remarks
 * Used during input validation to mitigate the risk of ReDoS (Regular Expression Denial of Service)
 * and ensure catastrophic backtracking does not occur during model searching.
 */
export const REGEX_MAX_LENGTH = 200;
