/**
 * Pins that the layout worker client never leaves a caller hanging: a factory that throws, or a
 * worker that raises `error` or `messageerror`, reports once, rejects pending calls, and is retried on the
 * next call instead of being reused broken.
 */
import { describe, expect, it, vi } from 'vitest';
import { createLayoutWorkerClient } from '../../../src/utils/layoutWorkerClient';
import type { LayoutInput } from '../../../src/engine/graphBuilder';
import { DEFAULT_CONFIG } from '../../../src/engine/types';

const INPUT: LayoutInput = { nodeIds: ['a'], edges: [], config: DEFAULT_CONFIG };

/** Minimal `Worker` stand-in: records listeners and lets a test raise failure events. */
class FakeWorker {
  public readonly terminate = vi.fn();
  private readonly listeners = new Map<string, Array<(event: { message?: string }) => void>>();
  addEventListener(type: string, listener: (event: { message?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(): void {}
  postMessage(): void {}
  fail(type: 'error' | 'messageerror', message?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ message });
  }
}

describe('createLayoutWorkerClient', () => {
  it('a factory that throws reports once, yields no promise, and is retried on the next call', () => {
    const spawn = vi.fn(() => { throw new Error('blocked by CSP'); });
    const unavailable = vi.fn();
    const client = createLayoutWorkerClient(spawn as unknown as () => Worker, unavailable);

    expect(client.runDagre(INPUT)).toBeUndefined();
    expect(client.runDagre(INPUT)).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(unavailable).toHaveBeenCalledTimes(2);
    expect(unavailable).toHaveBeenCalledWith('blocked by CSP');
  });

  it.each([
    { event: 'error' as const, message: 'script load failed', reason: 'script load failed' },
    { event: 'messageerror' as const, message: undefined, reason: 'layout worker message could not be deserialized' },
  ])('a worker that raises $event rejects pending calls, terminates, and is re-created', async ({ event, message, reason }) => {
    const workers: FakeWorker[] = [];
    const spawn = vi.fn(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
    const unavailable = vi.fn();
    const client = createLayoutWorkerClient(spawn as unknown as () => Worker, unavailable);

    const pending = client.runDagre(INPUT);
    const sibling = client.runDagre(INPUT);
    expect(pending).toBeInstanceOf(Promise);
    const assertions = Promise.all([
      expect(pending).rejects.toThrow(reason),
      expect(sibling).rejects.toThrow(reason),
    ]);
    workers[0].fail(event, message);
    await assertions;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledExactlyOnceWith(reason);

    expect(client.runDagre(INPUT)).toBeInstanceOf(Promise);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('a healthy worker is created once and reused', () => {
    const spawn = vi.fn(() => new FakeWorker());
    const client = createLayoutWorkerClient(spawn as unknown as () => Worker);
    expect(client.runDagre(INPUT)).toBeInstanceOf(Promise);
    expect(client.runDagre(INPUT)).toBeInstanceOf(Promise);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
