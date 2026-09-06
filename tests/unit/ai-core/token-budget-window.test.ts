import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTEXT_BLOCK_ITEM_HEADROOM_BYTES,
  CONTEXT_BLOCK_WINDOW_SHARE,
  MAX_ATTEMPT_CONTEXT_BYTES,
  MAX_DISCOVERY_BLOCK_BYTES,
  attemptContextBytes,
  discoveryBlockBytes,
  discoveryEvidenceItemBytes,
  estimateTokens,
  setModelWindowTokens,
  storedEvidenceKindBytes,
} from '../../../src/ai/support/tokenBudget';

/**
 * Every bounded prompt block scales with the selected model's input window: the ceilings hold on a
 * large window, a small BYOK window shrinks every block together, and an unknown window means the
 * ceilings apply.
 */
describe('bounded prompt blocks follow the model window', () => {
  afterEach(() => setModelWindowTokens(0));

  it('applies the ceilings when the window is unknown', () => {
    setModelWindowTokens(0);
    expect(attemptContextBytes()).toBe(MAX_ATTEMPT_CONTEXT_BYTES);
    expect(storedEvidenceKindBytes()).toBe(MAX_ATTEMPT_CONTEXT_BYTES - CONTEXT_BLOCK_ITEM_HEADROOM_BYTES);
    expect(discoveryBlockBytes()).toBe(MAX_DISCOVERY_BLOCK_BYTES);
    expect(discoveryEvidenceItemBytes()).toBe(MAX_DISCOVERY_BLOCK_BYTES - CONTEXT_BLOCK_ITEM_HEADROOM_BYTES);
  });

  it('keeps the ceilings on a 128Ki-token window', () => {
    setModelWindowTokens(131_072);
    expect(attemptContextBytes()).toBe(MAX_ATTEMPT_CONTEXT_BYTES);
    expect(discoveryBlockBytes()).toBe(MAX_DISCOVERY_BLOCK_BYTES);
  });

  it('scales every block down on an 8k window so one block fits its share', () => {
    setModelWindowTokens(8_192);
    const shareBytes = Math.floor(8_192 * CONTEXT_BLOCK_WINDOW_SHARE * 4);
    expect(attemptContextBytes()).toBe(shareBytes);
    expect(discoveryBlockBytes()).toBe(shareBytes);
    expect(estimateTokens(attemptContextBytes())).toBeLessThanOrEqual(8_192 * CONTEXT_BLOCK_WINDOW_SHARE);
    expect(storedEvidenceKindBytes()).toBe(attemptContextBytes() - CONTEXT_BLOCK_ITEM_HEADROOM_BYTES);
  });

  it('never drops a block below the item headroom', () => {
    setModelWindowTokens(1_024);
    expect(attemptContextBytes()).toBe(CONTEXT_BLOCK_ITEM_HEADROOM_BYTES);
    expect(storedEvidenceKindBytes()).toBe(0);
  });
});
