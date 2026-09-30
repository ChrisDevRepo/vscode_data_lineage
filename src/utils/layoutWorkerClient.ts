import { wrap, type Remote } from 'comlink';
import type { LayoutInput } from '../engine/graphBuilder';
import type { LayoutWorkerApi } from './layout.worker';

type LayoutPositions = Map<string, { x: number; y: number }>;

/** Lazily started layout worker that reports its own failure instead of hanging a caller. */
export interface LayoutWorkerClient {
  /**
   * Runs Dagre in the worker. `undefined` when no worker can be started, so the caller keeps its
   * main-thread path; a worker that dies mid-job rejects the pending call instead of never settling.
   */
  runDagre(input: LayoutInput): Promise<LayoutPositions> | undefined;
}

/**
 * Wraps a worker factory in a client that owns the worker's lifecycle.
 *
 * @remarks
 * A `Worker` that fails to load raises an `error` event and never a rejection, so a bare Comlink
 * proxy leaves every pending call unsettled and a module-level singleton broken for the rest of
 * the page. This client terminates and forgets the worker on that event, rejects the calls in
 * flight, and retries construction on the next call. A factory that throws synchronously is the
 * same failure reported once through `onUnavailable`.
 *
 * @param spawn - Constructs the raw worker; called only on first use and again after a failure.
 * @param onUnavailable - Receives one reason per failure, for the caller's own log channel.
 */
export function createLayoutWorkerClient(
  spawn: () => Worker,
  onUnavailable: (reason: string) => void = () => {},
): LayoutWorkerClient {
  let worker: Worker | undefined;
  let api: Remote<LayoutWorkerApi> | undefined;
  const inFlight = new Set<(error: Error) => void>();

  const drop = (reason: string): void => {
    worker?.terminate();
    worker = undefined;
    api = undefined;
    const error = new Error(reason);
    for (const reject of inFlight) reject(error);
    inFlight.clear();
    onUnavailable(reason);
  };

  const acquire = (): Remote<LayoutWorkerApi> | undefined => {
    if (api) return api;
    let spawned: Worker;
    try {
      spawned = spawn();
    } catch (error: unknown) {
      drop(error instanceof Error ? error.message : String(error));
      return undefined;
    }
    spawned.addEventListener('error', (event) => {
      if (worker === spawned) drop(event.message || 'layout worker failed');
    });
    worker = spawned;
    api = wrap<LayoutWorkerApi>(spawned);
    return api;
  };

  return {
    runDagre(input) {
      const remote = acquire();
      if (!remote) return undefined;
      return new Promise<LayoutPositions>((resolve, reject) => {
        inFlight.add(reject);
        remote.runDagre(input).then(resolve, reject).finally(() => inFlight.delete(reject));
      });
    },
  };
}
