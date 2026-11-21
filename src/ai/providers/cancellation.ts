/**
 * Cancellation bridge from VS Code to the provider adapter: `LineageParticipant.handleChatRequest`
 * hands the request's `vscode.CancellationToken` here to obtain a standard `AbortSignal` for the
 * model port. This is the one adapter between the two shapes; there is no separate cancellation
 * channel. VS Code-free (depends only on the structural {@link CancellationTokenLike}), so it is
 * unit-testable in the offline `ai` project.
 */

/** The structural subset of `vscode.CancellationToken` this bridge needs. */
export interface CancellationTokenLike {
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

/**
 * Bridges a {@link CancellationTokenLike} to an `AbortSignal`: already aborted when the token is
 * already cancelled, else aborting the first time the token fires. The returned
 * {@link BridgedAbort.dispose} detaches the listener (idempotent); the host calls it when the turn
 * settles.
 */
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
