/** Parses Retry-After seconds or an HTTP date; an absent or invalid header leaves backoff to the caller. */
export function retryAfterDelayMs(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header?.trim()) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
