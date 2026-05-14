/**
 * Idempotency counter — aborts the session when the AI repeatedly sends the
 * same tool call and gets rejected.
 */

/** Result of an {@link RepeatRejectGuard.observe} call. */
export interface RepeatRejectObservation {
  /** True when the guard has crossed the abort threshold. */
  abort: boolean;
  /** Current consecutive-identical-error count (1..N). */
  count: number;
  /** Stable hash of the last observed call (tool + input). */
  hash: string;
}

/**
 * Tracks consecutive identical tool calls that resulted in errors.
 *
 * Lifecycle (per session):
 * - On success, the counter and last-hash are reset.
 * - On error with the same hash as the previous call, the counter increments.
 * - On error with a different hash, the counter resets to 1 and the hash is updated.
 * - When the counter reaches {@link RepeatRejectGuard.ABORT_THRESHOLD}, `abort` is true.
 */
export class RepeatRejectGuard {
  /** Number of consecutive identical errors that trigger an abort. */
  static readonly ABORT_THRESHOLD = 3;

  private lastHash: string | null = null;
  private _count = 0;

  /** Current consecutive-identical-error count. Zero after a success. */
  get count(): number { return this._count; }

  /** Records one tool-call observation; returns whether the session should abort. */
  observe(toolName: string, input: unknown, isError: boolean): RepeatRejectObservation {
    const hash = stableHash({ toolName, input });
    if (!isError) {
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
