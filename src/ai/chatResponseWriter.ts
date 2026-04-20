/**
 * Chat-response lifecycle wrapper for the `@lineage` participant.
 *
 * @remarks
 * VS Code closes a `ChatResponseStream` when the user cancels the turn (Stop
 * button, new prompt typed, panel closed). Any `stream.markdown / progress /
 * button` call after that point throws `Response stream has been closed`. This
 * module expresses "the stream is open / cancelled / closed" in the type
 * system so participant code can branch on a single field — same pattern as
 * the existing `SessionPhase` and `HopLoopExit` discriminated unions.
 *
 * Lives alongside `sessionPhase.ts` (phase FSM) and is consumed by
 * `lineageParticipant.ts` in place of raw `vscode.ChatResponseStream`.
 */

import type { ChatResponseStream, CancellationToken, Command } from 'vscode';
import type { Logger } from '../utils/log';

/**
 * Lifecycle state of a chat-response writer.
 *
 * @remarks
 * Discriminated so the write methods and external loops (LM stream consumption,
 * hop loop) branch on a single field — no boolean-flag pileup. Transitions are
 * one-way: `open` → `cancelled` or `open` → `closed`, never back.
 */
export type WriterStatus =
  /** Stream is alive; writes are delivered to VS Code. */
  | { kind: 'open' }
  /** User cancelled the turn (Stop button / new prompt / panel closed). */
  | { kind: 'cancelled' }
  /** VS Code tore the stream down without cancelling the token (rare). */
  | { kind: 'closed'; cause: string };

/**
 * Owns a `ChatResponseStream` + `CancellationToken` pair and exposes the
 * subset of write operations the participant uses.
 *
 * @remarks
 * - Transitions to a terminal state at most once; subsequent writes are silent
 *   no-ops. One structured log entry is emitted on the transition — never
 *   per-write, to preserve the two-level logging policy in `logging.md`.
 * - Cancellation is polled via `token.isCancellationRequested` inside
 *   `isOpen()` at each write. VS Code tokens are cheap to poll; no listener
 *   plumbing is required.
 * - If VS Code tears the stream down without cancelling the token (e.g. host
 *   window reload), the first throwing write flips status to `closed`.
 * - External loops (LM stream consumption, hop loop) use `isOpen()` to break
 *   early — pushing bytes into a closed pipe is pointless and throws.
 */
export class ChatResponseWriter {
  private _status: WriterStatus = { kind: 'open' };

  /**
   * Creates a new writer.
   *
   * @param stream - The underlying VS Code chat response stream.
   * @param token - The cancellation token for the current turn.
   * @param logger - Logger used for transition notifications (one `info` per cancel, one `warn` per observed close).
   * @param sessionId - Session id included in the log messages for forensic correlation.
   */
  constructor(
    private readonly stream: ChatResponseStream,
    private readonly token: CancellationToken,
    private readonly logger: Logger,
    private readonly sessionId: string,
  ) {}

  /** Current lifecycle state. Read-only; callers mutate only via writes. */
  public status(): WriterStatus { return this._status; }

  /**
   * Returns `true` while the stream is still accepting writes. Flips status to
   * `cancelled` as a side effect the first time the token reports cancellation.
   */
  public isOpen(): boolean {
    if (this._status.kind !== 'open') return false;
    if (this.token.isCancellationRequested) {
      this.transitionTo({ kind: 'cancelled' });
      return false;
    }
    return true;
  }

  /** Writes markdown to the chat if the stream is still open; no-op otherwise. */
  public markdown(text: string): void {
    if (!this.isOpen()) return;
    try { this.stream.markdown(text); } catch (e) { this.observeThrow(e); }
  }

  /** Writes a progress line to the chat if the stream is still open; no-op otherwise. */
  public progress(text: string): void {
    if (!this.isOpen()) return;
    try { this.stream.progress(text); } catch (e) { this.observeThrow(e); }
  }

  /** Renders an inline chat button if the stream is still open; no-op otherwise. */
  public button(cmd: Command): void {
    if (!this.isOpen()) return;
    try { this.stream.button(cmd); } catch (e) { this.observeThrow(e); }
  }

  private observeThrow(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Response stream has been closed/.test(msg)) {
      this.transitionTo({ kind: 'closed', cause: msg });
      return;
    }
    // Any other error is a real bug — surface it.
    throw e;
  }

  private transitionTo(next: WriterStatus): void {
    if (this._status.kind !== 'open') return;
    this._status = next;
    if (next.kind === 'cancelled') {
      this.logger.info(`[${this.sessionId}] Chat response cancelled by user`);
    } else if (next.kind === 'closed') {
      this.logger.warn(`[${this.sessionId}] Chat response closed unexpectedly — ${next.cause}`);
    }
  }
}
