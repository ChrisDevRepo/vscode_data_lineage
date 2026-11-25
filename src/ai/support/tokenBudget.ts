/**
 * Token budget: the single source of truth for AI delivery-mode decisions; pure functions, no VS
 * Code imports. Two discovery caps drive SM escalation: `ai.discoveryNodeCap` (default 10,
 * projected scope nodes) and `ai.discoveryTokenBudget` (default 10000, projected DDL tokens);
 * exceeding either rejects at the tool boundary with `over_discovery_budget`, pointing at
 * `lineage_start_exploration`. No tool response is ever truncated or sliced; an over-budget request
 * is hard-rejected with a hint. The exploration admission limits (`ai.maxRounds`,
 * `ai.maxTraceColumns`) live in {@link checkScopeAdmission}.
 */
import { DEFAULT_MAX_ROUNDS } from '../core/agentCore';
import { REJECTION_CODES } from './rejectionCodes';
import { makeRejection, type ToolRejection } from './toolErrorEnvelope';

/** Estimates tokens at 1 token ≈ 4 characters, the usual approximation for JSON/SQL payloads. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** The heuristic ratio behind {@link estimateTokens} and the byte ceilings derived from it. */
const CHARS_PER_TOKEN = 4;

/** What every `over_discovery_budget` rejection states went wrong. */
const OVER_DISCOVERY_BUDGET_REASON = 'Scope exceeds the discovery budget.';

/** Repair hint every `over_discovery_budget` rejection carries; the fallback when none arrives. */
export const OVER_DISCOVERY_BUDGET_HINT = 'A scope this large is analysed hop by hop through an approved exploration.';

/**
 * Default node cap for discovery-phase catalog requests — overridden via VS Code
 * `ai.discoveryNodeCap`.
 */
export const DEFAULT_DISCOVERY_NODE_CAP = 10;

/** Default for `ai.maxTraceColumns`: starting columns one column trace may select. */
export const DEFAULT_MAX_TRACE_COLUMNS = 10;

/**
 * Default DDL-token budget for discovery-phase catalog requests — overridden via
 * `ai.discoveryTokenBudget`.
 */
export const DEFAULT_DISCOVERY_TOKEN_BUDGET = 10_000;


/** The discovery phase's (nodeCap, tokenBudget) pair, clamped at construction. */
interface PhaseScopeBudget {
  /** Maximum scope nodes the phase admits. */
  readonly nodeCap: number;
  /** Maximum estimated DDL tokens the phase admits. */
  readonly tokenBudget: number;
}

/** The limits an exploration proposal is admitted under: rounds and starting trace columns. */
interface ExplorationLimits {
  /** Maximum rounds of one exploration (`ai.maxRounds`); each procedure/view/function takes one. */
  readonly maxRounds: number;
  /** Maximum starting columns one column trace may select (`ai.maxTraceColumns`). */
  readonly maxTraceColumns: number;
}

/**
 * Every token budget one turn runs under, fixed when the turn starts. Immutable and carried by the
 * turn's own objects (the request-scoped model port and the lease-bound tool services), so two
 * turns in flight on different models read their own window and caps. Nothing here is process
 * state.
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
 * Each omitted setting falls back to its shipped default; a non-positive `modelWindowTokens` means
 * the window is unknown and the fallback window applies.
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
 * The budget where no turn selected one: shipped defaults, no model window.
 */
export const DEFAULT_TURN_TOKEN_BUDGET: TurnTokenBudget = createTurnTokenBudget();


/**
 * Discovery scope budget check, fired per scope-expanding catalog request and run BEFORE the
 * catalog handler; on overflow the caller returns the structured rejection instead (no truncation,
 * the whole request is refused). An oversized `lineage_get_scope_bundle` never reaches the model:
 * `detectOverBudgetFromResult` makes it a reroute terminal, the turn leaves discovery for SM entry
 * and the consent gate opens there. The caller counts the request's DDL tokens (`countTokens` in
 * `tokenCount.ts`, which this module cannot import: the regex-search worker bundles it), so the
 * check and the request's own token figure share one counter.
 *
 * @param budget - The calling turn's budget.
 * @param requestedNodes - Nodes the request would load (e.g. BFS result size).
 * @param requestedDdlTokens - Tokens the request's DDL takes.
 * @param requestedDdlBytes - The same DDL's length, reported in the rejection's counts.
 * @returns `null` when the request fits both caps; otherwise the rejection carrying counts and
 *   limits in `detail` and the AI-facing hint.
 */
export function checkScopeTokens(
  budget: TurnTokenBudget,
  requestedNodes: number,
  requestedDdlTokens: number,
  requestedDdlBytes: number,
): DiscoveryBudgetRejection | null {
  if (!exceedsPhaseBudget(budget.discovery, requestedNodes, requestedDdlTokens)) return null;
  return {
    ...makeRejection({
      code: REJECTION_CODES.overDiscoveryBudget,
      reason: OVER_DISCOVERY_BUDGET_REASON,
      hint: OVER_DISCOVERY_BUDGET_HINT,
    }),
    detail: {
      counts: { nodes: requestedNodes, ddl_bytes: requestedDdlBytes },
      limits: { node_cap: budget.discovery.nodeCap, token_budget: budget.discovery.tokenBudget },
    },
  };
}

/**
 * A discovery-budget refusal: the rejection with the request's measured counts and the caps in
 * `detail`.
 */
export type DiscoveryBudgetRejection = ToolRejection & {
  detail: {
    counts: { nodes: number; ddl_bytes: number };
    limits: { node_cap: number; token_budget: number };
  };
};


/**
 * Fraction of the selected model's input window one bounded prompt block (retry context, discovery
 * evidence projection, replayed discovery transcript) may claim. The one size rule for prompt
 * blocks: a block scales with the window it is appended to, so a retry block can never exceed that
 * window.
 */
const CONTEXT_BLOCK_WINDOW_SHARE = 0.125;

/** Window, in tokens, assumed when the model reports none. */
const UNKNOWN_WINDOW_TOKENS = 131_072;

/** Headroom reserved inside a block for identity fields, so one item never fills the block. */
const CONTEXT_BLOCK_ITEM_HEADROOM_BYTES = 4_096;

/**
 * Bytes one bounded prompt block may hold on the turn's model: the window share, or the same share
 * of {@link UNKNOWN_WINDOW_TOKENS} when the model reports no window.
 */
export function contextBlockBytes(budget: TurnTokenBudget): number {
  const window = Number.isFinite(budget.modelWindowTokens) ? budget.modelWindowTokens : UNKNOWN_WINDOW_TOKENS;
  return Math.max(CONTEXT_BLOCK_ITEM_HEADROOM_BYTES, Math.floor(window * CONTEXT_BLOCK_WINDOW_SHARE * CHARS_PER_TOKEN));
}

/**
 * Byte budget for one stored evidence kind (observations or rejections) or one canonical discovery
 * result, held below {@link contextBlockBytes} so one entry cannot fill the block.
 */
export function storedEvidenceKindBytes(budget: TurnTokenBudget): number {
  return contextBlockBytes(budget) - CONTEXT_BLOCK_ITEM_HEADROOM_BYTES;
}


/**
 * Fraction of the selected model's input window the discovery budget may claim — the effective
 * budget is the smaller of the setting and this share of the window.
 */
const DISCOVERY_WINDOW_SHARE = 0.125;

/**
 * One turn's budget for a model of `windowTokens`: the window rides the budget and the discovery
 * token budget is the smaller of the setting and {@link DISCOVERY_WINDOW_SHARE} of the window.
 * A non-positive window means unknown: no window cap.
 */
export function calibrateTurnBudget(
  windowTokens: number,
  settings: Omit<NonNullable<Parameters<typeof createTurnTokenBudget>[0]>, 'modelWindowTokens'> = {},
): TurnTokenBudget {
  const window = windowTokens > 0 ? windowTokens : Number.POSITIVE_INFINITY;
  return createTurnTokenBudget({
    ...settings,
    modelWindowTokens: window,
    discoveryTokenBudget: Math.min(
      settings.discoveryTokenBudget ?? DEFAULT_DISCOVERY_TOKEN_BUDGET,
      Math.floor(window * DISCOVERY_WINDOW_SHARE),
    ),
  });
}

/** What the admission check measures of one proposed scope. */
export interface ProposedScope {
  /** Every node in the scope, tables included. */
  readonly nodes: number;
  /**
   * Hops the run takes: hops taken plus one per procedure, view or function, queued table and
   * supplement target.
   */
  readonly rounds: number;
  /** Distinct starting columns selected at the origin; 0 for a BB scope and for a supplement. */
  readonly columns: number;
}

/** Which admission limit refused a scope. */
type ScopeRefusalLimit = 'rounds' | 'columns';

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

/** Builds the three user texts of one refusal from the limit reached and the way out. */
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
 * scope change and on a supplement: the run's hops against `ai.maxRounds`, then the trace's
 * starting columns against `ai.maxTraceColumns` (columns tracked hop by hop are never counted). A
 * refusal is the user's to act on; the model never narrows a scope to fit.
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

/** Maximum regex query length; input validation against ReDoS (catastrophic backtracking). */
export const REGEX_MAX_LENGTH = 200;
