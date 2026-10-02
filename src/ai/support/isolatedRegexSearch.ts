import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { RegexSearchJob, RegexSearchReply } from './regexSearch.worker';

/** Failure of actual isolated execution, distinct from a syntax or result-admission refusal. */
export class RegexSearchExecutionError extends Error {
  constructor(public readonly reason: 'deadline' | 'cancelled' | 'worker', message: string) {
    super(message);
    this.name = reason === 'cancelled' ? 'AbortError' : 'RegexSearchExecutionError';
  }
}

/** Actual-execution watchdog; no synthetic samples or timing-based pattern classification. */
const SEARCH_EXECUTION_DEADLINE_MS = 1000;

/**
 * Executes one complete native-regexp search outside the extension host thread.
 *
 * @remarks
 * Cancellation, deadline and worker failure terminate the isolated job and reject without partial
 * results. The worker asset is adjacent both in extension bundles and in the compiled harness.
 * The watchdog starts when the worker is online, excluding worker startup from matching time.
 */
export function executeIsolatedRegexSearch(job: RegexSearchJob, signal?: AbortSignal): Promise<RegexSearchReply> {
  if (signal?.aborted) return Promise.reject(new RegexSearchExecutionError('cancelled', 'Search cancelled.'));
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(join(__dirname, 'regexSearch.worker.js'), { workerData: job });
    } catch (error: unknown) {
      reject(new RegexSearchExecutionError('worker', error instanceof Error ? error.message : 'Search worker could not start.'));
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: RegexSearchExecutionError, reply?: RegexSearchReply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(reply!);
    };
    const abort = (): void => finish(new RegexSearchExecutionError('cancelled', 'Search cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    worker.once('online', () => {
      timer = setTimeout(() => finish(new RegexSearchExecutionError('deadline', 'Regular expression search exceeded its execution deadline.')), SEARCH_EXECUTION_DEADLINE_MS);
    });
    worker.once('message', (reply: RegexSearchReply) => finish(undefined, reply));
    worker.once('error', error => finish(new RegexSearchExecutionError('worker', error.message)));
    worker.once('exit', code => finish(new RegexSearchExecutionError('worker', `Search worker exited before producing a result (code ${code}).`)));
  });
}
