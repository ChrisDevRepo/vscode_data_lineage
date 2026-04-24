/**
 * Structured logging infrastructure for the Data Lineage extension host.
 *
 * All output channel logging MUST use these helpers to enforce consistent
 * `[Category] message` formatting. This ensures traceability across the
 * asynchronous boundaries of the extension, bridge, and engine.
 */
import type { LogOutputChannel } from 'vscode';

/**
 * Canonical log categories used to tag all log entries.
 * Never invent new categories without updating this type.
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
  | 'Filter';

/**
 * Internal log capture buffer for automated integration tests.
 *
 * @remarks
 * Architectural Remark: Stored on `globalThis` to survive bundler-induced
 * module duplication in test environments (where multiple instances of
 * this module might be loaded by different entry points).
 */
const GLOBAL_LOG_KEY = '__VSCODE_DL_TEST_LOGS__';
if (!(globalThis as any)[GLOBAL_LOG_KEY]) {
  (globalThis as any)[GLOBAL_LOG_KEY] = [];
}

/**
 * Shared array containing all logs captured during the current test session.
 */
export const testLogCapture: string[] = (globalThis as any)[GLOBAL_LOG_KEY];

/**
 * Internal helper to route logs to the test capture buffer when in test mode.
 */
function logToTest(cat: LogCategory, msg: string) {
  if (process.env.VSCODE_EX_TEST) {
    testLogCapture.push(`[${cat}] ${msg}`);
  }
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
  logToTest(cat, msg);
  ch.info(`[${cat}] ${msg}`);
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
  logToTest(cat, msg);
  ch.debug(`[${cat}] ${msg}`);
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
  logToTest(cat, msg);
  ch.warn(`[${cat}] ${msg}`);
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
   */
  static create(ch: LogOutputChannel, cat: LogCategory): Logger {
    return new Logger(ch, cat);
  }

  /** Logs an info-level message. */
  info(msg: string): void { logInfo(this.ch, this.cat, msg); }
  /** Logs a debug-level message. */
  debug(msg: string): void { logDebug(this.ch, this.cat, msg); }
  /** Logs a warning-level message. */
  warn(msg: string): void { logWarn(this.ch, this.cat, msg); }
  /** Logs an error-level message with error details. */
  error(op: string, err: unknown): void { logError(this.ch, this.cat, op, err); }

  /**
   * Specialized bridge log: suppress noisy types, log others concisely.
   * @param type - The incoming message type from the webview.
   */
  bridgeIncoming(type: string): void {
    if (type === 'filter-changed') return;
    this.debug(`Incoming: ${type}`);
  }
}

/**
 * Emits already-prefixed text verbatim at the given level.
 *
 * @remarks
 * For text that carries its own `[Category]` prefix (e.g. webview log messages
 * relayed through the bridge). Avoids double-tagging. All other callers should
 * use {@link logInfo} / {@link logDebug} / {@link logWarn} / {@link logError}.
 */
export function logRaw(
  ch: LogOutputChannel,
  level: 'info' | 'debug' | 'warn' | 'error',
  text: string,
): void {
  switch (level) {
    case 'info':  ch.info(text);  return;
    case 'warn':  ch.warn(text);  return;
    case 'error': ch.error(text); return;
    case 'debug': ch.debug(text); return;
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
    .replace(/\\[nrt]/g, ' ')   // JSON-escaped newline/return/tab → space
    .replace(/[\n\r\t]/g, ' ')  // real control chars → space
    .replace(/ {2,}/g, ' ');    // collapse runs of spaces
}

/**
 * Logs a critical failure or unhandled exception.
 *
 * Automatically extracts message from `Error` objects and logs stack
 * traces to the debug stream when available.
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
  const detail = err instanceof Error ? err.message : String(err);
  const msg = `FAILED: ${op} — ${detail}`;
  logToTest(cat, msg);
  ch.error(`[${cat}] ${msg}`);
  if (err instanceof Error && err.stack) {
    ch.debug(`[${cat}] Stack: ${err.stack}`);
  }
}
