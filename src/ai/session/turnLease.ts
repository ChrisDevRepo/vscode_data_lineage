/** Immutable ownership token captured by one host turn before model or tool execution. */
export interface TurnLease {
  /** UI conversation that opened the turn. */
  readonly sessionId: string;
  /** {@link AiSession} epoch owned by the turn. */
  readonly epoch: number;
  /** Cancellation signal shared by the model loop and tool dispatcher. */
  readonly signal: AbortSignal;
}

/** Error used when a cancelled or superseded turn attempts further work. */
class InactiveTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Rejects work that no longer belongs to the active session epoch.
 * @param lease - Ownership captured by the executing host turn.
 * @param currentEpoch - Live singleton-session epoch at the dispatch boundary.
 */
export function assertActiveTurnLease(lease: TurnLease, currentEpoch: number): void {
  if (lease.signal.aborted) throw new InactiveTurnError('AI turn was cancelled.');
  if (lease.epoch !== currentEpoch) {
    throw new InactiveTurnError(`AI turn was superseded (captured=${lease.epoch}, current=${currentEpoch}).`);
  }
}
