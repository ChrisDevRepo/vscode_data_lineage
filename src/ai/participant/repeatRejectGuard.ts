/**
 * Idempotency counter — aborts the session when the AI repeatedly sends the
 * same tool call and gets rejected.
 */

/** Result of an {@link RepeatRejectGuard.observe} call. */
export interface RepeatRejectObservation {
  /** True when the guard has crossed the abort threshold. */
  abort: boolean;
  /** Current consecutive-same-code reject count (1..N). */
  count: number;
  /** Stable hash of the last observed reject (tool + reject code). */
  hash: string;
}

/**
 * Tracks consecutive rejects of the same tool with the same reject code.
 *
 * @remarks
 * Keyed on `{ toolName, rejectCode }` — NOT the payload — so reworded retries that
 * fail the same way cannot reset the counter. This is the fix for the present_result
 * incident where 8+ distinct full payloads were each rejected with the same validation
 * code but the payload-keyed guard reset every round.
 *
 * Lifecycle (per session):
 * - On success (`rejectCode === null`), the counter and last-hash are reset.
 * - On a reject with the same code as the previous call, the counter increments.
 * - On a reject with a different code (or tool), the counter resets to 1.
 * - When the counter reaches {@link RepeatRejectGuard.ABORT_THRESHOLD}, `abort` is true.
 */
export class RepeatRejectGuard {
  /** Number of consecutive same-code rejects that trigger an abort. */
  static readonly ABORT_THRESHOLD = 3;

  private lastHash: string | null = null;
  private _count = 0;

  /** Current consecutive-same-code reject count. Zero after a success. */
  get count(): number { return this._count; }

  /**
   * Records one tool-call outcome; returns whether the session should abort.
   *
   * @param toolName - The invoked tool.
   * @param rejectCode - The reject code from {@link extractToolErrorCode}, or `null` on success.
   */
  observe(toolName: string, rejectCode: string | null): RepeatRejectObservation {
    const hash = stableHash({ toolName, rejectCode });
    if (rejectCode === null) {
      this.reset();
      return { abort: false, count: 0, hash };
    }
    if (hash !== this.lastHash) {
      this.lastHash = hash;
      this._count = 1;
      return { abort: false, count: 1, hash };
    }
    this._count++;
    return { abort: this._count >= RepeatRejectGuard.ABORT_THRESHOLD, count: this._count, hash };
  }

  /** Clear state — called on any successful call or explicit session reset. */
  reset(): void {
    this.lastHash = null;
    this._count = 0;
  }
}

/**
 * Deterministic hash of an arbitrary object. Produces the same string for
 * equivalent inputs regardless of property declaration order.
 */
function stableHash(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).sort().reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (value as Record<string, unknown>)[k];
          return acc;
        }, {})
      : value
  );
}
