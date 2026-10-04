/** Protects exactly-once settlement when isolated worker error, exit and result events race. */
import { expect, it, vi } from 'vitest';

const workers = vi.hoisted(() => [] as import('node:events').EventEmitter[]);
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return { Worker: class extends EventEmitter {
    public terminate = vi.fn(async () => 0);
    constructor() { super(); workers.push(this); }
  } };
});
import { executeIsolatedRegexSearch } from '../../../src/ai/support/isolatedRegexSearch';

const job = { kind: 'catalog' as const, pattern: 'Order', nodes: [], limit: 20 };

it('rejects an error/exit race once and terminates once', async () => {
  const pending = executeIsolatedRegexSearch(job);
  const worker = workers.at(-1)!;
  worker.emit('online');
  worker.emit('error', new Error('Synthetic worker failure'));
  worker.emit('exit', 1);
  await expect(pending).rejects.toMatchObject({ reason: 'worker', message: 'Synthetic worker failure' });
  expect((worker as unknown as { terminate: unknown }).terminate).toHaveBeenCalledTimes(1);
});

it('rejects an exit without a complete result even when its code is zero', async () => {
  const pending = executeIsolatedRegexSearch(job);
  workers.at(-1)!.emit('exit', 0);
  await expect(pending).rejects.toMatchObject({ reason: 'worker', message: expect.stringContaining('before producing a result') });
});

it('keeps a complete result when termination subsequently raises an exit event', async () => {
  const pending = executeIsolatedRegexSearch(job);
  const worker = workers.at(-1)!;
  worker.emit('online');
  worker.emit('message', { ok: true, kind: 'catalog', ids: [] });
  worker.emit('exit', 1);
  await expect(pending).resolves.toEqual({ ok: true, kind: 'catalog', ids: [] });
  expect((worker as unknown as { terminate: unknown }).terminate).toHaveBeenCalledTimes(1);
});
