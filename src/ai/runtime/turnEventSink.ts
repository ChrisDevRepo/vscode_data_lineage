import type { TurnEvent } from '../../engine/shared/chatContract';

export type { TurnEvent };

/** Non-terminal progress phases exposed to chat surfaces. */
export type TurnStatusPhase = Extract<TurnEvent, { type: 'status' }>['phase'];

/** Terminal status of a graph-owned turn. */
export type TurnResultStatus = Extract<TurnEvent, { type: 'terminal' }>['status'];

/** Provider-neutral payload for a native consent gate; `gateId` is what a user's decision carries. */
export type NativeGateEvent = Omit<Extract<TurnEvent, { type: 'gate' }>, 'type'>;

/** Callback that receives each accepted turn event. */
export type TurnEventConsumer = (event: TurnEvent) => void;

/** Observer callback that also receives the event's 1-based sequence number. */
export type TurnEventObserver = (event: TurnEvent, sequence: number) => void;

/**
 * Provider-neutral event sink for exactly one runtime turn. The terminal outcome is claimed before
 * the external callback runs, so synchronous re-entry cannot emit a second terminal or a late
 * event.
 */
export class TurnEventSink {
  private eventCount = 0;
  private terminal: TurnResultStatus | null = null;
  private readonly observers = new Set<TurnEventObserver>();

  public constructor(private readonly consumer: TurnEventConsumer) {}

  /** Claimed terminal status, or `null` while the turn remains open. */
  public get terminalStatus(): TurnResultStatus | null {
    return this.terminal;
  }

  /** Registers an event observer and returns an idempotent disposal handle. */
  public addObserver(observer: TurnEventObserver): { dispose(): void } {
    this.observers.add(observer);
    return { dispose: () => this.observers.delete(observer) };
  }

  /** Emits a progress status unless the turn is closed. */
  public status(phase: TurnStatusPhase, label: string): boolean {
    return this.emit({ type: 'status', phase, label });
  }

  /** Emits an incremental text fragment unless the turn is closed. */
  public stream(delta: string): boolean {
    return this.emit({ type: 'text', delta });
  }

  /** Emits a native consent gate unless the turn is closed. */
  public gate(gate: NativeGateEvent): boolean {
    return this.emit({ type: 'gate', ...gate });
  }

  /** Emits a recoverable or informational error unless the turn is closed. */
  public error(message: string, recoverable?: boolean): boolean {
    return this.emit({ type: 'error', message, recoverable });
  }

  /** Claims and emits the terminal result; returns `false` if already closed. */
  public result(status: TurnResultStatus, error?: string): boolean {
    if (!this.claimTerminal(status)) return false;
    this.send({ type: 'terminal', status, error });
    return true;
  }

  /** Emits an unrecoverable error followed by the terminal error result. */
  public fail(message: string): boolean {
    if (!this.claimTerminal('error')) return false;
    try {
      this.send({ type: 'error', message, recoverable: false });
    } finally {
      this.send({ type: 'terminal', status: 'error', error: message });
    }
    return true;
  }

  private emit(event: TurnEvent): boolean {
    if (this.terminal !== null) return false;
    this.send(event);
    return true;
  }

  private claimTerminal(status: TurnResultStatus): boolean {
    if (this.terminal !== null) return false;
    this.terminal = status;
    return true;
  }

  private send(event: TurnEvent): void {
    this.eventCount += 1;
    this.consumer(event);
    for (const observer of this.observers) {
      observer(event, this.eventCount);
    }
  }
}
