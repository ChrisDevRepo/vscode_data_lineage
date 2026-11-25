/**
 * The one token counter: the bundled `o200k_base` encoder times a safety margin. The scope bundle's
 * DDL estimate and the discovery token budget it is checked against count with it, so a definition
 * is never "small" to one and "large" to the other. Kept apart from `tokenBudget.ts`, which the
 * regex-search worker bundles, so the 2 MB rank table stays out of the worker.
 */
import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
import { checkScopeTokens, type DiscoveryBudgetRejection, type TurnTokenBudget } from './tokenBudget';

/**
 * Default factor on every token count. The counter is OpenAI's `o200k_base`; other models tokenize
 * SQL and identifiers into more tokens, and a 32k window has no room for the difference.
 */
export const TOKEN_COUNT_MARGIN = 1.2;

let encoder: Tiktoken | undefined;

/** Unscaled `o200k_base` token count of `text`. */
export function rawTokens(text: string): number {
  encoder ??= new Tiktoken(o200kBase);
  return encoder.encode(text).length;
}

/**
 * Tokens `text` takes: the `o200k_base` count times `margin` (defaults to
 * {@link TOKEN_COUNT_MARGIN}), rounded up.
 */
export function countTokens(text: string, margin = TOKEN_COUNT_MARGIN): number {
  return Math.ceil(rawTokens(text) * margin);
}

/**
 * The discovery budget check for a request whose payload is `text` (a serialized reply or a
 * definition): its tokens are counted with {@link countTokens}, the counter the model port trims
 * with.
 */
export function checkScopeText(
  budget: TurnTokenBudget,
  requestedNodes: number,
  text: string,
): DiscoveryBudgetRejection | null {
  return checkScopeTokens(budget, requestedNodes, countTokens(text), text.length);
}
