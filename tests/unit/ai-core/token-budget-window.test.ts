import { describe, expect, it } from 'vitest';
import {
  CONTEXT_BLOCK_ITEM_HEADROOM_BYTES,
  CONTEXT_BLOCK_WINDOW_SHARE,
  MAX_ATTEMPT_CONTEXT_BYTES,
  MAX_DISCOVERY_BLOCK_BYTES,
  attemptContextBytes,
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
