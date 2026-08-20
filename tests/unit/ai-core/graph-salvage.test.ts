/**
 * Regression tests for the active-hop salvage disposition in `src/ai/agent/graph.ts`.
 *
 * Pins the two rules that decide whether a stopped active hop presents partial coverage or fails
 * the turn: salvage requires at least one SUBMITTED hop (never a merely dequeued one), and a
 * truncation stop always keeps its error exit so `model_output_truncated` survives.
 */
import { describe, expect, it } from 'vitest';
import { shouldSalvageActiveStop } from '../../../src/ai/agent/graph';

describe('shouldSalvageActiveStop', () => {
  it.each([
    ['semantic_failures', 1, true],
    ['semantic_failures', 11, true],
    ['provider_calls', 1, true],
    ['provider_calls', 0, false],
    ['semantic_failures', 0, false],
    ['output_limit', 0, false],
    ['output_limit', 5, false],
  ] as const)('%s with %i submitted hop(s) → salvage=%s', (reason, submittedHops, expected) => {
    expect(shouldSalvageActiveStop(reason, submittedHops)).toBe(expected);
  });

  it('never salvages an exploration with zero submitted hops, whatever the stop reason', () => {
    for (const reason of ['semantic_failures', 'provider_calls', 'output_limit'] as const) {
      expect(shouldSalvageActiveStop(reason, 0)).toBe(false);
    }
  });
});
