/**
 * Cancellation classification for the host-graph tool attempt runner (`agent/toolAttempt.ts`).
 *
 * @remarks
 * Lives in `support/` (not `providers/`) so the agent layer never imports from the provider layer —
 * that direction would invert the intended layering. Provider-pure by construction: no `vscode` and
 * no model-SDK import.
 *
 * NOT the single cancellation classifier in the tree: `model/vscodeModelPort.ts` keeps a private
 * `isCancellation` with deliberately different coverage — it recognizes its own `ModelPortError`
 * (`code: 'cancelled'`) and VS Code's `Canceled`/`Cancelled` error names, which this one does not,
 * while this one recognizes the `ABORT_ERR`/`20` code forms, which that one does not. They are not
 * interchangeable; do not "consolidate" them without first reconciling both sets.
 */

/**
 * Classifies a thrown value as a genuine provider/transport cancellation, checked structurally —
 * never by matching on the error message text, since a provider error whose message merely
 * contains the word "abort" must still surface as a real error.
 *
 * @remarks
 * Covers the abort surfaces reachable from a tool attempt: a `DOMException` named `AbortError`
 * (the platform fetch abort), an `Error` named `AbortError`, and the `ABORT_ERR` code in both its
 * string and Node-numeric (`20`) forms.
 * @param error - The thrown value to classify.
 * @returns `true` only for a structurally recognized abort signal.
 */
function isProviderAbortError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') return true;
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return error.name === 'AbortError' || code === 'ABORT_ERR' || code === 20;
}

/**
 * Whether one dispatch attempt should be treated as cancelled: either the caller's own
 * {@link AbortSignal} already fired, or the thrown error structurally classifies as an abort via
 * {@link isProviderAbortError}.
 * @param error - The thrown value from the in-flight call.
 * @param signal - The signal the call was issued under, when the caller tracks one.
 * @returns `true` when the outcome should be reported as cancelled rather than failed.
 */
export function isCancellationOutcome(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return isProviderAbortError(error);
}
