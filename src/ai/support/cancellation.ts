/** Cancellation classification for the host-graph tool attempt runner (`agent/toolAttempt.ts`). */

/** Classifies a thrown value as a genuine provider/transport cancellation, checked structurally — never by matching on the error message text, since a provider error whose message merely contains the word "abort" must still surface as a real error. */
function isProviderAbortError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') return true;
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return error.name === 'AbortError' || code === 'ABORT_ERR' || code === 20;
}

/** Whether one dispatch attempt should be treated as cancelled: either the caller's own `AbortSignal` already fired, or the thrown error structurally classifies as an abort via {@link isProviderAbortError}. */
export function isCancellationOutcome(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return isProviderAbortError(error);
}
