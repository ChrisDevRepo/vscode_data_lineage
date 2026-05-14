/**
 * Transient-network-error detection for LM calls.
 *
 * @remarks
 * Pure module — vscode-free so unit tests can exercise it under tsx.
 * The full predicate `isTransientLmError` lives in `lineageParticipant.ts` and adds the
 * `vscode.LanguageModelError` gate (intentional model-side decisions: Cancelled / NotFound /
 * NoPermissions / Blocked — never retried).
 */

export const TRANSIENT_NET_PATTERN =
  /network|timeout|reset|ECONNRESET|ETIMEDOUT|ERR_NETWORK_CHANGED|fetch failed|EAI_AGAIN/i;

/**
 * Pure regex check against the network-error vocabulary surfaced by the Copilot LM wrapper.
 *
 * @remarks
 * The wrapper boxes Node `fetch` failures into plain `Error` objects with `code` populated
 * (not into `LanguageModelError`), so the regex covers both `name + message` and `code`.
 *
 * @param err - The thrown value to classify.
 * @returns `true` when the error text matches the transient-network pattern.
 */
export function matchesTransientNetPattern(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  const code = (err as { code?: string })?.code ?? '';
  return TRANSIENT_NET_PATTERN.test(msg) || TRANSIENT_NET_PATTERN.test(code);
}
