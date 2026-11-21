/**
 * Cancellation classification for the host-graph tool attempt runner (`agent/toolAttempt.ts`).
 * Lives in `support/`, not `providers/`, and stays provider-pure (no `vscode`, no model-SDK
 * import). Not the only cancellation classifier: `model/modelPort.ts`,
 * `model/vscodeLangChainBridge.ts` and `model/vscodeModelPort.ts` each classify with different
 * coverage; do not consolidate without reconciling all four.
 */

/**
 * Classifies a thrown value as a genuine provider/transport cancellation, structurally and never by
 * error message text, since a provider error whose message merely contains "abort" must still
 * surface as a real error.
 */
function isProviderAbortError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') return true;
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return error.name === 'AbortError' || code === 'ABORT_ERR' || code === 20;
}

/**
 * Whether one dispatch attempt should be treated as cancelled: the caller's `AbortSignal` already
 * fired, or the thrown error classifies as an abort via {@link isProviderAbortError}.
 */
export function isCancellationOutcome(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return isProviderAbortError(error);
}
