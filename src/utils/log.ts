/**
 * Structured logging infrastructure for the Data Lineage extension host.
 *
 * Output-channel logging uses these helpers to enforce consistent
 * `[Category] message` formatting. This ensures traceability across the
 * asynchronous boundaries of the extension, bridge, and engine.
 */
import type { LogOutputChannel } from 'vscode';

/**
 * Canonical categories used to tag extension log entries.
 */
export type LogCategory =
  | 'DB'
  | 'Dacpac'
  | 'Parse'
  | 'Config'
  | 'Project'
  | 'AI'
  | 'Stats'
  | 'Detail'
  | 'Bridge'
  | 'Filter'
  | 'Storage';

function normalizeLogMessage(msg: string): string {
  return sanitizeForLog(msg);
}

/** Removes stale manual category tags before the structured logger adds the canonical one. */
function normalizeCategorizedLogMessage(cat: LogCategory, msg: string): string {
  let norm = normalizeLogMessage(msg);
  const prefix = `[${cat}]`;
  while (norm === prefix || norm.startsWith(`${prefix} `)) {
    norm = norm.slice(prefix.length).trimStart();
  }
  return norm;
}

/**
 * Logs a milestone event that is meaningful to the end-user.
 *
 * Use for major state transitions, successful operations, or startup events.
 * Keep frequency low (≤ ~20 per session) to maintain high signal.
 *
 * @param ch - The VS Code `LogOutputChannel` to write to.
 * @param cat - The functional category of the log.
 * @param msg - The message to log. Format: `Operation — key result (timing)`
 */
export function logInfo(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  const norm = normalizeCategorizedLogMessage(cat, msg);
  ch.info(`[${cat}] ${norm}`);
}

/**
 * Logs a granular developer-centric event or state transition.
 *
 * Only visible when the user enables the 'Debug' log level.
 * Use for tracing internal logic flow, tool calls, and payload inspection.
 *
 * @param ch - The VS Code `LogOutputChannel` to write to.
 * @param cat - The functional category of the log.
 * @param msg - The message to log. Format: `Detail — context, parameters, timing`
 */
export function logDebug(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  const norm = normalizeCategorizedLogMessage(cat, msg);
  ch.debug(`[${cat}] ${norm}`);
}

/**
 * Logs a degraded state or non-critical failure.
 *
 * Use when a feature can continue to operate but with limitations or
 * after a successful fallback operation.
 *
 * @param ch - The VS Code `LogOutputChannel` to write to.
 * @param cat - The functional category of the log.
 * @param msg - The message to log. Format: `What happened — what system did → recovery hint`
 */
export function logWarn(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  const norm = normalizeCategorizedLogMessage(cat, msg);
  ch.warn(`[${cat}] ${norm}`);
}

/**
 * A domain-scoped logger that encapsulates a channel and category.
 *
 * Recommended for use within specific services or classes to reduce
 * repetitive parameter passing.
 */
export class Logger {
  /**
   * Creates a new Logger instance.
   * @param ch - The VS Code `LogOutputChannel`.
   * @param cat - The fixed category for this logger.
   */
  constructor(
    private readonly ch: LogOutputChannel,
    private readonly cat: LogCategory
  ) {}

  /**
   * Factory method to create a new Logger.
   *
   * @param ch - Output channel to write to.
   * @param cat - Functional category prefix (e.g. `'Config'`, `'Bridge'`) prepended to every log line.
   */
  static create(ch: LogOutputChannel, cat: LogCategory): Logger {
    return new Logger(ch, cat);
  }

  /**
   * Logs an info-level message.
   *
   * @param msg - Message body to emit under this logger's category.
   */
  info(msg: string): void { logInfo(this.ch, this.cat, msg); }
  /**
   * Logs a debug-level message.
   *
   * @param msg - Message body to emit under this logger's category.
   */
  debug(msg: string): void { logDebug(this.ch, this.cat, msg); }
  /**
   * Logs a warning-level message.
   *
   * @param msg - Message body to emit under this logger's category.
   */
  warn(msg: string): void { logWarn(this.ch, this.cat, msg); }
  /**
   * Logs an error-level message with full stack detail.
   *
   * @param op - Operation label prepended to the error message.
   * @param err - Caught error or unknown value; stack is extracted when available.
   */
  error(op: string, err: unknown): void { logError(this.ch, this.cat, op, err); }
}

/** Truncation cap for content text (prompts, questions, reasoning, SQL previews) — logging.md truncation table. */
export const LOG_TRUNC_CONTENT = 200;

/** Truncation cap for JSON payloads (tool I/O, webview messages) — logging.md truncation table. */
export const LOG_TRUNC_JSON = 300;

/**
 * Truncation cap for tool-rejection diagnostics (reason and remediation hint).
 *
 * @remarks
 * Deliberately larger than the content/JSON caps. A rejection's reason and hint are already
 * bounded at construction, and for a turn that *ends* on a rejection this log line is the only
 * complete record of which rule fired: the model-facing correction envelope is replayed into the
 * next provider request, and a terminal rejection has no next request. Truncating below the
 * value's own bound is what makes such a turn undiagnosable, so this cap is a safety stop on
 * pathological input, not a formatting budget.
 */
export const LOG_TRUNC_REJECTION = 1_000;

/**
 * Serializes an arbitrary value into a bounded, single-line diagnostic preview.
 *
 * Circular references and bigint values are represented explicitly. Objects whose
 * property access or serialization throws degrade to a stable marker so diagnostic
 * formatting can never suppress the user-facing operation it accompanies.
 */
export function safeStringifyForLog(value: unknown, max = LOG_TRUNC_JSON): string {
  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate === 'bigint') return `${candidate.toString()}n`;
      if (typeof candidate === 'string') {
        return trunc(candidate, Math.max(32, Math.floor(max / 2)));
      }
      if (candidate && typeof candidate === 'object') {
        if (seen.has(candidate)) return '[Circular]';
        seen.add(candidate);
      }
      return candidate;
    });
    if (serialized !== undefined) return trunc(sanitizeForLog(serialized), max);
  } catch {
    // Fall through to a scalar representation. Proxies/getters can make JSON serialization throw.
  }

  try {
    return trunc(sanitizeForLog(String(value)), max);
  } catch {
    return '[Unserializable]';
  }
}

/**
 * Truncates a string or an array of items for log previews.
 *
 * @param val - The input string or array.
 * @param max - The maximum length (for string) or items (for array).
 * @returns The truncated value with overflow count.
 */
export function trunc(val: string | any[], max: number): string {
  if (Array.isArray(val)) {
    if (val.length <= max) return val.join(', ');
    return `${val.slice(0, max).join(', ')} \u2026 [+${val.length - max} more]`;
  }
  return val.length <= max ? val : `${val.slice(0, max)}\u2026 [+${val.length - max} chars]`;
}

/**
 * Normalizes a string for single-line display in the Output Channel.
 *
 * Collapses all whitespace, newlines, and escape sequences into single spaces.
 * This is crucial for keeping logs readable in the line-oriented Output view.
 *
 * @param s - The raw string to sanitize.
 * @returns A single-line sanitized string.
 */
export function sanitizeForLog(s: string): string {
  return s
    .replace(/\\[nrt]/g, ' ')      // JSON-escaped newline/return/tab → space
    .replace(/[\u0000-\u001F\u007F]/g, ' ') // ASCII control chars → space
    .replace(/\s+/g, ' ')          // collapse all whitespace runs
    .trim();
}

/**
 * Logs a critical failure or unhandled exception.
 *
 * Automatically extracts message from `Error` objects and logs both the
 * `FAILED:` line and the stack trace at **error** level.
 *
 * @param ch - The VS Code `LogOutputChannel` to write to.
 * @param cat - The functional category of the log.
 * @param op - The name of the operation that failed.
 * @param err - The error object or reason for failure.
 *
 * @remarks
 * Format: `[CAT] FAILED: operation — error detail`
 */
export function logError(ch: LogOutputChannel, cat: LogCategory, op: string, err: unknown): void {
  const detail = normalizeLogMessage(err instanceof Error ? err.message : String(err));
  const msg = `FAILED: ${normalizeCategorizedLogMessage(cat, op)} — ${detail}`;
  ch.error(`[${cat}] ${msg}`);
  if (err instanceof Error && err.stack) {
    const stackLine = `Stack: ${normalizeLogMessage(err.stack)}`;
    ch.error(`[${cat}] ${stackLine}`);
  }
}
