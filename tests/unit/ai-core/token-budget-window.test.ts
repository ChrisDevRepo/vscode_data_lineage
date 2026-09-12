import { describe, expect, it } from 'vitest';
import {
  CONTEXT_BLOCK_ITEM_HEADROOM_BYTES,
  CONTEXT_BLOCK_WINDOW_SHARE,
  DEFAULT_DISCOVERY_NODE_CAP,
  DEFAULT_DISCOVERY_TOKEN_BUDGET,
  DEFAULT_TURN_TOKEN_BUDGET,
  MAX_ATTEMPT_CONTEXT_BYTES,
  MAX_DISCOVERY_BLOCK_BYTES,
  attemptContextBytes,
  checkScopeBudget,
  createTurnTokenBudget,
  discoveryBlockBytes,
  discoveryEvidenceItemBytes,
  estimateTokens,
  storedEvidenceKindBytes,
} from '../../../src/ai/support/tokenBudget';

/**
 * Every bounded prompt block scales with the selected model's input window: the ceilings hold on a
 * large window, a small BYOK window shrinks every block together, and an unknown window means the
 * ceilings apply. Each case builds its own budget, so no case can leak its window into the next.
 */
describe('bounded prompt blocks follow the model window', () => {
  it('applies the ceilings when the window is unknown', () => {
    const budget = createTurnTokenBudget({ modelWindowTokens: 0 });
    expect(attemptContextBytes(budget)).toBe(MAX_ATTEMPT_CONTEXT_BYTES);
    expect(storedEvidenceKindBytes(budget)).toBe(MAX_ATTEMPT_CONTEXT_BYTES - CONTEXT_BLOCK_ITEM_HEADROOM_BYTES);
    expect(discoveryBlockBytes(budget)).toBe(MAX_DISCOVERY_BLOCK_BYTES);
    expect(discoveryEvidenceItemBytes(budget)).toBe(MAX_DISCOVERY_BLOCK_BYTES - CONTEXT_BLOCK_ITEM_HEADROOM_BYTES);
  });

  it('keeps the ceilings on a 128Ki-token window', () => {
    const budget = createTurnTokenBudget({ modelWindowTokens: 131_072 });
    expect(attemptContextBytes(budget)).toBe(MAX_ATTEMPT_CONTEXT_BYTES);
    expect(discoveryBlockBytes(budget)).toBe(MAX_DISCOVERY_BLOCK_BYTES);
  });

  it('scales every block down on an 8k window so one block fits its share', () => {
    const budget = createTurnTokenBudget({ modelWindowTokens: 8_192 });
    const shareBytes = Math.floor(8_192 * CONTEXT_BLOCK_WINDOW_SHARE * 4);
    expect(attemptContextBytes(budget)).toBe(shareBytes);
    expect(discoveryBlockBytes(budget)).toBe(shareBytes);
    expect(estimateTokens(attemptContextBytes(budget))).toBeLessThanOrEqual(8_192 * CONTEXT_BLOCK_WINDOW_SHARE);
    expect(storedEvidenceKindBytes(budget)).toBe(attemptContextBytes(budget) - CONTEXT_BLOCK_ITEM_HEADROOM_BYTES);
  });

  it('never drops a block below the item headroom', () => {
    const budget = createTurnTokenBudget({ modelWindowTokens: 1_024 });
    expect(attemptContextBytes(budget)).toBe(CONTEXT_BLOCK_ITEM_HEADROOM_BYTES);
    expect(storedEvidenceKindBytes(budget)).toBe(0);
  });

  it('keeps two concurrent turns on their own windows', () => {
    const wide = createTurnTokenBudget({ modelWindowTokens: 131_072 });
    const narrow = createTurnTokenBudget({ modelWindowTokens: 8_192 });
    expect(attemptContextBytes(wide)).toBe(MAX_ATTEMPT_CONTEXT_BYTES);
    expect(attemptContextBytes(narrow)).toBe(Math.floor(8_192 * CONTEXT_BLOCK_WINDOW_SHARE * 4));
    expect(attemptContextBytes(wide)).toBe(MAX_ATTEMPT_CONTEXT_BYTES);
  });
});

/**
 * `checkScopeBudget` is the one gate that rejects an oversized discovery catalog request with
 * `over_discovery_budget`. Discovery stays in chat; the existing SM-offer pill is the opt-in.
 * The boundary is documented (`DEFAULT_DISCOVERY_NODE_CAP` = 10, `DEFAULT_DISCOVERY_TOKEN_BUDGET`
 * = 10_000 tokens) but was asserted nowhere: pin it exactly at the cap, one over on each axis
 * independently, and confirm neither axis leaks into the other.
 */
describe('checkScopeBudget escalates at the documented discovery caps', () => {
  const CHARS_PER_TOKEN_FOR_TEST = 4;
  const ddlBytesFor = (tokens: number) => tokens * CHARS_PER_TOKEN_FOR_TEST;

  it('admits exactly at both caps', () => {
    const result = checkScopeBudget(
      DEFAULT_TURN_TOKEN_BUDGET,
      DEFAULT_DISCOVERY_NODE_CAP,
      ddlBytesFor(DEFAULT_DISCOVERY_TOKEN_BUDGET),
    );
    expect(result.ok, 'node cap and token budget hit exactly are still within budget').toBe(true);
  });

  it('rejects one node over the cap, tokens well under', () => {
    const result = checkScopeBudget(DEFAULT_TURN_TOKEN_BUDGET, DEFAULT_DISCOVERY_NODE_CAP + 1, ddlBytesFor(100));
    expect(result.ok, 'one node over the cap alone rejects').toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('over_discovery_budget');
      expect(result.limits).toEqual({ node_cap: DEFAULT_DISCOVERY_NODE_CAP, token_budget: DEFAULT_DISCOVERY_TOKEN_BUDGET });
      expect(result.hint).toMatch(/detailed analysis would be needed/i);
      expect(result.hint).not.toMatch(/hop-by-hop/i);
      expect(result.hint).not.toMatch(/consent-gated/i);
    }
  });

  it('rejects one token over the budget, nodes well under', () => {
    const result = checkScopeBudget(
      DEFAULT_TURN_TOKEN_BUDGET,
      1,
      ddlBytesFor(DEFAULT_DISCOVERY_TOKEN_BUDGET) + 1,
    );
    expect(result.ok, 'one token over the budget alone rejects').toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('over_discovery_budget');
      expect(result.counts.nodes).toBe(1);
    }
  });

  it('the two caps are independent — over on one axis rejects even with headroom on the other', () => {
    const nodesOverOnly = checkScopeBudget(DEFAULT_TURN_TOKEN_BUDGET, DEFAULT_DISCOVERY_NODE_CAP + 5, ddlBytesFor(1));
    const tokensOverOnly = checkScopeBudget(DEFAULT_TURN_TOKEN_BUDGET, 1, ddlBytesFor(DEFAULT_DISCOVERY_TOKEN_BUDGET * 2));
    expect(nodesOverOnly.ok, 'node overflow alone is sufficient to reject').toBe(false);
    expect(tokensOverOnly.ok, 'token overflow alone is sufficient to reject').toBe(false);
  });

  it('stays within budget one under each cap', () => {
    const result = checkScopeBudget(
      DEFAULT_TURN_TOKEN_BUDGET,
      DEFAULT_DISCOVERY_NODE_CAP - 1,
      ddlBytesFor(DEFAULT_DISCOVERY_TOKEN_BUDGET - 1),
    );
    expect(result.ok, 'one under both caps admits').toBe(true);
  });
});
