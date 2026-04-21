import type { SmMode } from './smTypes';

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


/** Default inline token budget — overridden per-request from VS Code setting `ai.inlineTokenBudget`. */
const DEFAULT_INLINE_TOKEN_BUDGET = 10_000;

/** Runtime budget — set from VS Code setting at each request start. */
let inlineTokenBudget = DEFAULT_INLINE_TOKEN_BUDGET;

/**
 * Configures the runtime inline token budget from VS Code settings.
 * 
 * @remarks
 * This value is typically set at the start of each request in `extension.ts`
 * based on the `ai.inlineTokenBudget` configuration.
 * 
 * @param value - The maximum number of tokens allowed for inline (one-shot) delivery.
 */
export function setInlineTokenBudget(value: number): void {
  inlineTokenBudget = value;
}

/** 
 * Retrieves the currently active inline token budget. 
 * 
 * @returns The effective token budget used for delivery mode decisions.
 */
export function getEffectiveBudget(): number {
  return inlineTokenBudget;
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
 * Determines if a payload should be delivered inline (one-shot) or via on-demand tools.
 * 
 * @remarks
 * Inline delivery provides the AI with all DDL at once for immediate reasoning.
 * On-demand delivery triggers a hop-by-hop state machine for larger scopes.
 *
 * @param payloadChars - The character count of the payload.
 * @param precomputedTokens - Optional pre-calculated token count to skip estimation.
 * @returns `true` if the payload fits within the effective budget for inline delivery.
 */
export function shouldInline(payloadChars: number, precomputedTokens?: number): boolean {
  const tokens = precomputedTokens ?? estimateTokens(payloadChars);
  return tokens <= getEffectiveBudget();
}


/** Default node cap for inline SM delivery — overridden per-request from VS Code setting `ai.inlineNodeCap`. */
const DEFAULT_SM_INLINE_NODE_CAP = 10;

/** Runtime node cap — set from VS Code setting at each request start. */
let smInlineNodeCap = DEFAULT_SM_INLINE_NODE_CAP;

/** 
 * Configures the runtime inline node cap from VS Code settings. 
 * 
 * @param value - The maximum number of nodes allowed for inline State Machine (SM) delivery.
 */
export function setSmInlineNodeCap(value: number): void {
  smInlineNodeCap = value;
}

/** 
 * Retrieves the currently active inline node cap. 
 * 
 * @returns The maximum node count allowed for inline exploration.
 */
export function getSmInlineNodeCap(): number {
  return smInlineNodeCap;
}

/**
 * Determines if a State Machine (SM) exploration should use inline delivery.
 * 
 * @remarks
 * Evaluates both the node count of the scope and the estimated token budget.
 * Small, focused Blackboard (BB) scopes use inline delivery for faster analysis, 
 * while larger scopes or Column Trace (CT) investigations fallback to the 
 * sliding memory (hop-by-hop) architecture.
 *
 * @param mode - The exploration mode ('blackboard' or 'column_trace').
 * @param payloadChars - Character count of the DDL/Metadata payload.
 * @param scopeNodeCount - The total number of nodes in the exploration scope.
 * @returns `true` if it is a blackboard session and both node count and token budget constraints are satisfied.
 */
export function shouldSmInline(mode: SmMode, payloadChars: number, scopeNodeCount: number): boolean {
  if (mode === 'column_trace') return false; // CT is always sliding-memory for simplification.
  return scopeNodeCount <= smInlineNodeCap && shouldInline(payloadChars);
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
