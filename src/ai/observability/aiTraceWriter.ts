import { open, mkdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { TurnEvent } from '../runtime/turnEventSink';
import { safeTraceStringify, type WireRecord } from './wireLog';
import { markGitIgnored } from '../../utils/gitIgnoredDir';

/**
 * One lifecycle record in the session-scoped AI diagnostic trace. Lifecycle variants carry no
 * prompt, model text, tool argument/result or error prose; wire records do, but only after the user
 * enables the diagnostic command for this extension host session.
 */
export type RuntimeLifecycleRecord =
  | {
      readonly type: 'turn-start';
      readonly requestId: string;
      readonly runFingerprint: string;
      readonly sessionFingerprint: string;
      readonly modelFingerprint: string;
    }
  | {
      readonly type: 'turn-terminal';
      readonly requestId: string;
      readonly runFingerprint: string;
      readonly status: 'ok' | 'error' | 'cancelled';
      /**
       * Machine-readable stop reason behind a non-`ok` status (`no_progress`, `engine_error`, ...),
       * typed `string` so observability does not import the agent layer's union.
       */
      readonly reason?: string;
      /** Stable machine-readable graph failure code, when the graph set one. */
      readonly errorCode?: string;
      readonly modelCalls: number;
      readonly durationMs: number;
    }
  | {
      /**
       * First record in every trace file: what produced it. The headless harness and the extension
       * host write the same schema to the same filename pattern, so only this record says whether a
       * file came from a live VS Code session (valid production evidence) or a test run.
       */
      readonly type: 'trace-open';
      readonly origin: TraceOrigin;
      readonly verbose: boolean;
    }
  | {
      readonly type: 'gate';
      readonly requestId: string;
      readonly runFingerprint: string;
      readonly seq: number;
      readonly phase: string;
      /** Consent-card identifier; the join key to the matching `gate-resolution` row. */
      readonly gateId?: string;
      readonly elapsedMs: number;
    }
  | {
      /**
       * Outcome of one native consent-card action, written by the participant because the command
       * handler runs outside the turn's event stream. Enumerated values only; no run scope, so no
       * `runFingerprint`.
       */
      readonly type: 'gate-resolution';
      readonly requestId: string;
      readonly gateId: string;
      readonly gate: string;
      readonly action: 'approve' | 'change' | 'cancel' | 'hold';
      readonly outcome: 'accepted' | 'refused' | 'no_owning_turn' | 'failed';
      /** Enumerated cause when `outcome` is `refused`; never free text. */
      readonly refusedBy?: 'gate_id_mismatch' | 'no_pending_gate';
      /** When the action was received; an accepted approval's `at` follows the released turn. */
      readonly decidedAt?: string;
    }
  | {
      readonly type: 'phase';
      readonly requestId: string;
      readonly runFingerprint: string;
      readonly seq: number;
      readonly phase: 'thinking' | 'scoping' | 'tool' | 'synthesizing';
      readonly elapsedMs: number;
    }
  | {
      readonly type: 'tool';
      readonly requestId: string;
      readonly runFingerprint: string;
      readonly seq: number;
      readonly phase: string;
      readonly toolName: string;
      /** Dispatch outcome; `gate` is a consent gate, not charged to the semantic budget. */
      readonly status: 'accepted' | 'rejected' | 'gate' | 'dispatch_error';
      readonly rejectionCode?: string;
      /** Dotted field paths the rejection blamed, when any; identifiers, never prose. */
      readonly issuePaths?: readonly string[];
      readonly durationMs: number;
    };

/** Record accepted by the trace: a lifecycle record or any {@link WireRecord}. */
export type AiTraceRecord = RuntimeLifecycleRecord | WireRecord;

/** What produced a trace file: a live `extension-host` session or the `headless-harness`. */
export type TraceOrigin = 'extension-host' | 'headless-harness';

/** Opt-in switches applied when the session trace is enabled. */
export interface AiTraceOptions {
  /** Producer stamped into the opening record. Defaults to `extension-host`. */
  readonly origin?: TraceOrigin;
  /** Captures full system-prompt text and verbatim provider request/response bodies. */
  readonly verbose?: boolean;
}

/** Called for append failures after tracing has been enabled successfully. */
export type AiTraceWriteFailureHandler = (error: unknown, firstFailure: boolean) => void;

/**
 * Single NDJSON sink for AI diagnostics. Starts disabled; {@link enable} opens one session file
 * under `<root>/lm-trace`. Writes are serialized and the file is owner-only (mode 0600) because
 * wire records carry identifiers, SQL, prompts and model responses.
 */
export class AiTraceWriter {
  private filePath: string | undefined;
  private handle: Promise<FileHandle> | undefined;
  private enabling: Promise<string> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private reportedWriteFailure = false;
  private verbose = false;
  private origin: TraceOrigin = 'extension-host';

  public constructor(private readonly onWriteFailure?: AiTraceWriteFailureHandler) {}

  /**
   * Enables tracing for this session; a repeat call returns the existing path.
   *
   * @returns Absolute path of the session trace file.
   * @throws When the writer has already been closed.
   */
  public async enable(logRoot: string, options: AiTraceOptions = {}): Promise<string> {
    if (this.closed) {
      throw new Error('AiTraceWriter: writer is closed.');
    }
    if (this.filePath) return this.filePath;
    if (this.enabling) return this.enabling;
    this.verbose = options.verbose === true;
    this.origin = options.origin ?? 'extension-host';

    const enabling = this.openTrace(logRoot);
    this.enabling = enabling;
    try {
      return await enabling;
    } finally {
      if (this.enabling === enabling) this.enabling = undefined;
    }
  }

  /** Whether tracing is enabled and the writer remains open. */
  public isEnabled(): boolean {
    return this.filePath !== undefined && !this.closed;
  }

  /** Whether the enabled trace captures system-prompt text and verbatim provider bodies. */
  public isVerbose(): boolean {
    return this.verbose && this.isEnabled();
  }

  /** Queues a record for append; settles after the append, or immediately when disabled. */
  public write(record: AiTraceRecord): Promise<void> {
    if (!this.filePath || this.closed) return Promise.resolve();
    return this.enqueue(record, true);
  }

  /**
   * Serializes one record onto the append chain. `consumeOneShot` is false for the trace-open stamp
   * so a failure at enable time does not spend the once-per-session warn-level report.
   */
  private enqueue(record: AiTraceRecord, consumeOneShot: boolean): Promise<void> {
    const line = `${serializeRecord(record)}\n`;
    const write = this.pending.then(async () => {
      const handle = await this.openHandle();
      await handle.appendFile(line, { encoding: 'utf8' });
      await handle.sync();
    });
    void write.catch((error) => this.reportWriteFailure(error, consumeOneShot));
    this.pending = write.catch(() => {});
    return write;
  }

  /** Writes the lifecycle projection of a turn event: status and gate events only. */
  public writeTurnEvent(
    requestId: string,
    runFingerprint: string,
    seq: number,
    event: TurnEvent,
    elapsedMs: number,
  ): Promise<void> {
    if (event.type === 'status') {
      return this.write({
        type: 'phase',
        requestId,
        runFingerprint,
        seq,
        phase: event.phase,
        elapsedMs,
      });
    }
    if (event.type === 'gate') {
      return this.write({
        type: 'gate',
        requestId,
        runFingerprint,
        seq,
        phase: event.gate,
        gateId: event.gateId,
        elapsedMs,
      });
    }
    return Promise.resolve();
  }

  /** Drains queued writes and closes the trace file. */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pending;
    const handle = await this.handle?.catch(() => undefined);
    if (handle) await handle.close();
  }

  private openHandle(): Promise<FileHandle> {
    if (!this.filePath) {
      return Promise.reject(new Error('AiTraceWriter: writer is disabled.'));
    }
    if (!this.handle) {
      const opening = open(this.filePath, 'a', 0o600).then(async (handle) => {
        await handle.chmod(0o600);
        return handle;
      });
      this.handle = opening;
      opening.catch(() => {
        if (this.handle === opening) this.handle = undefined;
      });
    }
    return this.handle;
  }

  private async openTrace(logRoot: string): Promise<string> {
    const directory = join(logRoot, 'lm-trace');
    await mkdir(directory, { recursive: true });
    await markGitIgnored(directory);
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = join(directory, `trace-${iso}.ndjson`);
    const opening = open(filePath, 'a', 0o600).then(async (handle) => {
      try {
        await handle.chmod(0o600);
        return handle;
      } catch (error) {
        await handle.close().catch(() => {});
        throw error;
      }
    });
    const handle = await opening;
    if (this.closed) {
      await handle.close().catch(() => {});
      throw new Error('AiTraceWriter: writer is closed.');
    }
    this.filePath = filePath;
    this.handle = Promise.resolve(handle);
    void this.enqueue({ type: 'trace-open', origin: this.origin, verbose: this.verbose }, false).catch(() => {});
    return filePath;
  }

  private reportWriteFailure(error: unknown, consumeOneShot: boolean): void {
    const firstFailure = !this.reportedWriteFailure;
    if (consumeOneShot) this.reportedWriteFailure = true;
    try {
      this.onWriteFailure?.(error, firstFailure);
    } catch {
    }
  }
}

function serializeRecord(record: AiTraceRecord): string {
  const at = new Date().toISOString();
  try {
    return safeTraceStringify({ at, ...record });
  } catch (error) {
    return JSON.stringify({
      at,
      type: 'trace-serialization-failure',
      error: error instanceof Error ? error.name : 'Error',
    });
  }
}
