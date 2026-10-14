/**
 * Pins that the layout worker client never leaves a caller hanging: a factory that throws, or a
 * worker that raises `error`, reports once, rejects the call in flight, and is retried on the
 * next call instead of being reused broken.
 */
import { describe, expect, it, vi } from 'vitest';
import { createLayoutWorkerClient } from '../../../src/utils/layoutWorkerClient';
import type { LayoutInput } from '../../../src/engine/graphBuilder';
import { DEFAULT_CONFIG } from '../../../src/engine/types';

const INPUT: LayoutInput = { nodeIds: ['a'], edges: [], config: DEFAULT_CONFIG };

/** Minimal `Worker` stand-in: records listeners and lets a test raise the `error` event. */
class FakeWorker {
  public readonly terminate = vi.fn();
  private readonly listeners = new Map<string, Array<(event: { message?: string }) => void>>();
  addEventListener(type: string, listener: (event: { message?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(): void {}
  postMessage(): void {}
  fail(message: string): void {
    for (const listener of this.listeners.get('error') ?? []) listener({ message });
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

  it('a worker that raises error rejects the call in flight, is terminated, and is re-created next time', async () => {
    const workers: FakeWorker[] = [];
    const spawn = vi.fn(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
    const unavailable = vi.fn();
    const client = createLayoutWorkerClient(spawn as unknown as () => Worker, unavailable);

    const pending = client.runDagre(INPUT);
    expect(pending).toBeInstanceOf(Promise);
    workers[0].fail('script load failed');
    await expect(pending).rejects.toThrow('script load failed');
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledWith('script load failed');

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
