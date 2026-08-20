/**
 * Cancellation bridge from VS Code to the provider adapter.
 *
 * @remarks
 * `LineageParticipant.handleChatRequest` receives the request's `vscode.CancellationToken` and
 * hands it here to obtain a standard `AbortSignal` for the model port. We do **not** invent a
 * separate cancellation channel — this is the one adapter between the two shapes.
 *
 * VS Code-free: it depends only on the structural shape of a `CancellationToken`
 * ({@link CancellationTokenLike}), so the bridge is unit-testable in the offline `ai` project.
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
 * Bridges a {@link CancellationTokenLike} to an `AbortSignal`.
 *
 * @remarks
 * If the token is already cancelled the returned signal is already aborted. Otherwise the
 * signal aborts the first time the token fires; the returned {@link BridgedAbort.dispose}
 * detaches the listener (idempotent), which the host calls when the turn settles.
 *
 * @param token - The platform cancellation token (from a `CancellationTokenSource`).
 * @returns The `AbortSignal` to pass to the adapter plus a `dispose` to unsubscribe.
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
