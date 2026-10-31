/** Cancellation bridge from VS Code to the provider adapter. */

/** The structural subset of `vscode.CancellationToken` this bridge needs. */
interface CancellationTokenLike {
  /** Whether cancellation was requested before the bridge was created. */
  readonly isCancellationRequested: boolean;
  /** Registers a callback fired once when cancellation is requested. */
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/** An `AbortSignal` paired with the listener disposable so the host can unsubscribe. */
interface BridgedAbort {
  readonly signal: AbortSignal;
  /** Detaches the token listener (call when the turn ends, to avoid a leak). */
  dispose(): void;
}

/** Bridges a {@link CancellationTokenLike} to an `AbortSignal`. */
export function tokenToAbortSignal(token: CancellationTokenLike): BridgedAbort {
  const controller = new AbortController();

  if (token.isCancellationRequested) {
    controller.abort();
    return { signal: controller.signal, dispose: () => {} };
  }

  const sub = token.onCancellationRequested(() => controller.abort());
  let disposed = false;
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      sub.dispose();
    },
  };
}
