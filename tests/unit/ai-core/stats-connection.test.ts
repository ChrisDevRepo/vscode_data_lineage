/**
 * Single-flight connection negotiation for table profiling.
 *
 * Two column cards in the detail panel can ask for statistics in the same tick. Without the
 * single flight each request opens its own negotiation, which for a stored connection means two
 * connects and — when the stored connection does not resolve — two connection prompts stacked in
 * front of the user for the same panel.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveStatsConnectionUri, type StatsConnState } from '../../../src/bridge/messageHandlers';

function emptyState(): StatsConnState {
  return { uri: undefined, pending: null };
}

/** A negotiation the test settles by hand, so both callers are provably in flight together. */
function deferredNegotiation() {
  let settle: (uri: string | undefined) => void = () => {};
  let fail: (err: unknown) => void = () => {};
  const negotiate = vi.fn(() => new Promise<string | undefined>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  }));
  return { negotiate, resolve: (uri: string | undefined) => settle(uri), reject: (err: unknown) => fail(err) };
}

describe('resolveStatsConnectionUri', () => {
  it('negotiates once for two concurrent requests and gives both the same uri', async () => {
    const state = emptyState();
    const { negotiate, resolve } = deferredNegotiation();

    const first = resolveStatsConnectionUri(state, negotiate);
    const second = resolveStatsConnectionUri(state, negotiate);
    resolve('conn-1');

    expect(await first).toBe('conn-1');
    expect(await second).toBe('conn-1');
    expect(negotiate, 'one prompt, not one per request').toHaveBeenCalledTimes(1);
    expect(state.uri).toBe('conn-1');
  });

  it('reuses the stored uri without negotiating again', async () => {
    const state: StatsConnState = { uri: 'conn-1', pending: null };
    const negotiate = vi.fn(async () => 'conn-2');

    expect(await resolveStatsConnectionUri(state, negotiate)).toBe('conn-1');
    expect(negotiate).not.toHaveBeenCalled();
  });

  it('clears the in-flight negotiation when the user cancels, so the next request can retry', async () => {
    const state = emptyState();
    const cancelled = vi.fn(async () => undefined);

    expect(await resolveStatsConnectionUri(state, cancelled)).toBeUndefined();
    expect(state.pending, 'nothing is left latched onto the cancelled negotiation').toBeNull();
    expect(state.uri).toBeUndefined();

    const succeeds = vi.fn(async () => 'conn-2');
    expect(await resolveStatsConnectionUri(state, succeeds)).toBe('conn-2');
  });

  it('clears the in-flight negotiation when it rejects, and rejects every joined caller', async () => {
    const state = emptyState();
    const { negotiate, reject } = deferredNegotiation();

    const first = resolveStatsConnectionUri(state, negotiate);
    const second = resolveStatsConnectionUri(state, negotiate);
    reject(new Error('login failed'));

    await expect(first).rejects.toThrow('login failed');
    await expect(second).rejects.toThrow('login failed');
    expect(state.pending).toBeNull();
    expect(state.uri).toBeUndefined();

    const succeeds = vi.fn(async () => 'conn-3');
    expect(await resolveStatsConnectionUri(state, succeeds)).toBe('conn-3');
  });
});
