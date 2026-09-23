import { open, mkdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { TurnEvent } from '../runtime/turnEventSink';
import { safeTraceStringify, type WireRecord } from './wireLog';
import { markGitIgnored } from '../../utils/gitIgnoredDir';

/**
 * One lifecycle record in the session-scoped AI diagnostic trace.
 *
 * Lifecycle variants contain no prompt, model text, tool argument/result, or
 * error prose. The same trace also contains explicitly marked wire records, including sanitized
 * provider diagnostics, but only after the user enables the diagnostic command for this extension
 * host session.
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
       * Machine-readable stop reason behind a non-`ok` status (`semantic_failures`,
       * `provider_calls`, `output_limit`, `engine_error`, …).
       *
       * @remarks
       * A turn that ends on a tool rejection carries that rejection's prose nowhere in the trace:
       * rejection text reaches the wire only as the tool result replayed into the *next* request,
       * and a terminal rejection has no next request. This enumerated reason — plus `errorCode`
       * here and `issuePaths` on the `tool` record — is what makes such a turn diagnosable from the
       * NDJSON alone, without moving any prose into a lifecycle record.
       *
       * Typed as `string` deliberately: it mirrors the graph's existing stop-reason channel rather
       * than importing the agent layer's union into observability.
       */
      readonly reason?: string;
      /** Stable machine-readable graph failure code, when the graph set one. */
      readonly errorCode?: string;
      readonly modelCalls: number;
      readonly durationMs: number;
    }
  | {
      /**
       * First record in every trace file: what produced it.
       *
       * @remarks
       * The headless harness and the extension host write the same schema to the same filename
       * pattern, so without this record a file cannot say whether it came from a live VS Code
       * session or a test run — and only the former is valid production evidence.
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
      /**
       * Consent-card identifier this gate raised.
       *
       * @remarks
       * The join key to the matching {@link RuntimeLifecycleRecord} `gate-resolution` row. Without
       * it a raised gate and the action that answered it cannot be paired, and a gate the user
       * could not resolve is indistinguishable in the NDJSON from one they simply ignored.
       */
      readonly gateId?: string;
      readonly elapsedMs: number;
    }
  | {
      /**
       * Outcome of one native consent-card action.
       *
       * @remarks
       * Raised gates are recorded by the turn, but resolution happens in a VS Code command handler
       * outside the turn's event stream, so it reaches the trace from the participant instead.
       * Enumerated values only — the refusal *prose* stays in the debug log, matching the
       * lifecycle-records-carry-no-prose contract above. `runFingerprint` is absent by design:
       * lifecycle records are grouped by `requestId`, and the resolving command has no run scope.
       */
      readonly type: 'gate-resolution';
      readonly requestId: string;
      readonly gateId: string;
      readonly gate: string;
      readonly action: 'approve' | 'change' | 'cancel';
      readonly outcome: 'accepted' | 'refused' | 'no_owning_turn' | 'failed';
      /** Enumerated cause when `outcome` is `refused`; never free text. */
      readonly refusedBy?: 'gate_id_mismatch' | 'gate_kind_mismatch' | 'no_pending_gate';
      /**
       * When the action was received. The record's own `at` stamps an accepted approval only after
       * the released turn finishes, so the pair separates decision wait from released work.
       */
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
      /**
       * Dispatch outcome.
       *
       * @remarks
       * `gate` is not a failure: a consent gate returns through the same rejection envelope as a
       * real rejection but is never charged against the semantic budget, so folding it into
       * `rejected` overstates every rejection count derived from this trace.
       */
      readonly status: 'accepted' | 'rejected' | 'gate' | 'dispatch_error';
      readonly rejectionCode?: string;
      /**
       * Dotted field paths the rejection blamed, when it reported any.
       *
       * @remarks
       * `rejectionCode` alone cannot distinguish two different rules that share a code — several
       * `validation` rejections in one phase are otherwise indistinguishable in the NDJSON. These
       * are the same bounded identifier paths the correction envelope already carries
       * ({@link rejectionIssuePaths}), never prose, so the lifecycle-records-carry-no-prose
       * contract above still holds.
       */
      readonly issuePaths?: readonly string[];
      readonly durationMs: number;
    };

/**
 * Record accepted by the session-scoped AI diagnostic trace.
 *
 * @remarks
 * The wire half is the whole {@link WireRecord} union, so the per-generation `generation` row and
 * the verbatim `provider-raw` bodies are accepted here by construction rather than by a second
 * hand-maintained list that could drift from the emitting ports.
 */
export type AiTraceRecord = RuntimeLifecycleRecord | WireRecord;

/**
 * What produced a trace file.
 *
 * @remarks
 * `extension-host` is a live VS Code session — real user, real Copilot/provider traffic, valid as
 * production evidence. `headless-harness` is the internal live-provider harness, which runs the
 * production runtime as a plain Node process against a substituted model port: useful for
 * regression, never evidence about the shipped extension's transport behaviour.
 */
export type TraceOrigin = 'extension-host' | 'headless-harness';

/** Opt-in switches applied when the session trace is enabled. */
export interface AiTraceOptions {
  /**
   * Producer stamped into the file's opening record. Defaults to `extension-host`.
   */
  readonly origin?: TraceOrigin;
  /**
   * Captures full system-prompt text and verbatim provider request/response bodies.
   *
   * @remarks
   * Off by default, and deliberately not a setting: verbose traces repeat the system prompt on
   * every generation and carry whole provider payloads, so a long exploration writes megabytes.
   * Callers turn it on for one diagnostic session when a hash is not enough to identify the input.
   */
  readonly verbose?: boolean;
}

/** Called for append failures after tracing has been enabled successfully. */
export type AiTraceWriteFailureHandler = (error: unknown, firstFailure: boolean) => void;

/**
 * Single NDJSON sink for AI diagnostics.
 *
 * The writer starts disabled. {@link enable} creates one session-specific path
 * under the supplied root's `lm-trace` directory; all later lifecycle and wire records are appended to
 * that file until the extension host is restarted. Writes are serialized and
 * the file is owner-readable only because wire records can contain database
 * identifiers, SQL, prompts, and model responses.
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
   * Enables tracing for the current extension-host session.
   *
   * Repeated calls return the existing path without reopening the file.
   *
   * @param logRoot - Root directory under which `lm-trace` is created.
   * @param options - Capture switches; see {@link AiTraceOptions.verbose}.
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

  /**
   * Whether the enabled trace captures system-prompt text and verbatim provider bodies.
   *
   * @remarks
   * False while the writer is disabled: emitters ask this to decide what to build, and building a
   * verbose payload for a sink that will discard it is the one cost the default path must not pay.
   */
  public isVerbose(): boolean {
    return this.verbose && this.isEnabled();
  }

  /**
   * Queues a lifecycle or wire record for append.
   *
   * @param record - Diagnostic record to serialize as one NDJSON line.
   * @returns A promise that settles after the queued append, or immediately when disabled.
   */
  public write(record: AiTraceRecord): Promise<void> {
    if (!this.filePath || this.closed) return Promise.resolve();
    return this.enqueue(record, true);
  }

  /**
   * Serializes one record onto the append chain.
   *
   * @param consumeOneShot - Whether a failure spends the once-per-session warn-level report. The
   *   trace-open stamp passes `false` so a transient failure at enable time cannot demote every
   *   later genuine append failure to debug level.
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

  /**
   * Writes the lifecycle projection of a native turn event.
   *
   * Status and gate events are retained; content-bearing events are discarded.
   *
   * @param requestId - Native chat request identifier shared by records from the same turn.
   * @param runFingerprint - Stable identifier for the active run.
   * @param seq - Monotonic event sequence within the run.
   * @param event - Native event to project.
   * @param elapsedMs - Milliseconds elapsed since the run started.
   * @returns A promise that settles after the projected record is written.
   */
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
