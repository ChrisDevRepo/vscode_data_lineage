/**
 * Pins the stats-connection negotiation contracts: connection reuse, one shared in-flight
 * negotiation for concurrent requests, and in-flight cleanup on cancel or error.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveStatsConnection, type StatsConnState } from '../../../src/bridge/messageHandlers';

function freshState(session: string | undefined = undefined): StatsConnState<string> {
  return { session, pending: null };
}

describe('resolveStatsConnection', () => {
  it('reuses the negotiated connection without renegotiating', async () => {
    const state = freshState('mssql://localhost/AdventureWorks');
    const negotiate = vi.fn(async (): Promise<string | undefined> => 'mssql://other/db');
    await expect(resolveStatsConnection(state, negotiate)).resolves.toBe(
      'mssql://localhost/AdventureWorks',
    );
    expect(negotiate).not.toHaveBeenCalled();
  });

  it('dedupes concurrent requests to one negotiation', async () => {
    const state = freshState();
    let release!: (uri: string | undefined) => void;
    const gate = new Promise<string | undefined>((resolve) => {
      release = resolve;
    });
    const negotiate = vi.fn(() => gate);
    const first = resolveStatsConnection(state, negotiate);
    const second = resolveStatsConnection(state, negotiate);
    release('mssql://localhost/AdventureWorks');
    await expect(first).resolves.toBe('mssql://localhost/AdventureWorks');
    await expect(second).resolves.toBe('mssql://localhost/AdventureWorks');
    expect(negotiate).toHaveBeenCalledTimes(1);
    expect(state.session).toBe('mssql://localhost/AdventureWorks');
    expect(state.pending).toBeNull();
  });

  it('clears the in-flight negotiation on cancel', async () => {
    const state = freshState();
    const negotiate = vi.fn(async (): Promise<string | undefined> => undefined);
    await expect(resolveStatsConnection(state, negotiate)).resolves.toBeUndefined();
    expect(state.pending).toBeNull();
    expect(state.session).toBeUndefined();
    const retry = vi.fn(
      async (): Promise<string | undefined> => 'mssql://localhost/AdventureWorks',
    );
    await expect(resolveStatsConnection(state, retry)).resolves.toBe(
      'mssql://localhost/AdventureWorks',
    );
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight negotiation and rejects joined callers on error', async () => {
    const state = freshState();
    const failure = new Error('connection prompt failed');
    let release!: (error: Error) => void;
    const gate = new Promise<string | undefined>((_, reject) => {
      release = reject;
    });
    const negotiate = vi.fn(() => gate);
    const first = expect(resolveStatsConnection(state, negotiate)).rejects.toBe(failure);
    const second = expect(resolveStatsConnection(state, negotiate)).rejects.toBe(failure);
    release(failure);
    await first;
    await second;
    expect(negotiate).toHaveBeenCalledTimes(1);
    expect(state.pending).toBeNull();
    expect(state.session).toBeUndefined();
    const retry = vi.fn(
      async (): Promise<string | undefined> => 'mssql://localhost/AdventureWorks',
    );
    await expect(resolveStatsConnection(state, retry)).resolves.toBe(
      'mssql://localhost/AdventureWorks',
    );
  });
});
