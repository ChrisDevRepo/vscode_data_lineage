/**
 * Structured logging for the extension host: the helpers enforce a consistent `[Category] message`
 * format so entries stay traceable across the extension, bridge and engine.
 */
import type { LogOutputChannel } from 'vscode';
import { redactSecrets } from './redact';

/** Name of the extension's output channel, as users see it in the Output view. */
export const OUTPUT_CHANNEL_NAME = 'Data Lineage Viz';

/** Categories that tag extension log entries. */
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

/**
 * The one redaction point for output-channel text: every {@link Logger} line, at every level and
 * for every caller, passes through here, so no call site has to remove a credential itself.
 */
function normalizeLogMessage(msg: string): string {
  return sanitizeForLog(redactSecrets(msg));
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
 * Logs a user-meaningful milestone: a major state transition, successful operation or startup
 * event. Keep frequency low (≤ ~20 per session) to keep the signal high.
 *
 * @param msg - Format: `Operation — key result (timing)`
 */
function logInfo(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  const norm = normalizeCategorizedLogMessage(cat, msg);
  ch.info(`[${cat}] ${norm}`);
}

/**
 * Logs a developer-centric event or state transition, visible only at the 'Debug' log level:
 * internal logic flow, tool calls, payload inspection.
 *
 * @param msg - Format: `Detail — context, parameters, timing`
 */
function logDebug(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  const norm = normalizeCategorizedLogMessage(cat, msg);
  ch.debug(`[${cat}] ${norm}`);
}

/**
 * Logs a degraded state or non-critical failure: the feature continues with limits, or after a
 * successful fallback.
 *
 * @param msg - Format: `What happened — what system did → recovery hint`
 */
function logWarn(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  const norm = normalizeCategorizedLogMessage(cat, msg);
  ch.warn(`[${cat}] ${norm}`);
}

/**
 * Logger scoped to a channel and category, so services and classes need not repeat the parameters.
 */
export class Logger {
  constructor(
    private readonly ch: LogOutputChannel,
    private readonly cat: LogCategory
  ) {}

  /** Creates a Logger; `cat` is the category prefix (e.g. `'Config'`, `'Bridge'`) of every line. */
  static create(ch: LogOutputChannel, cat: LogCategory): Logger {
    return new Logger(ch, cat);
  }

  info(msg: string): void { logInfo(this.ch, this.cat, msg); }
  debug(msg: string): void { logDebug(this.ch, this.cat, msg); }
  warn(msg: string): void { logWarn(this.ch, this.cat, msg); }
  /**
   * Logs an error-level message with full stack detail; the stack is extracted from `err` when
   * available.
   *
   * @param op - Operation label prepended to the error message.
   */
  error(op: string, err: unknown): void { logError(this.ch, this.cat, op, err); }
}

/** Truncation cap for content text (prompts, questions, reasoning, SQL previews). */
export const LOG_TRUNC_CONTENT = 200;

/** Truncation cap for JSON payloads (tool I/O, webview messages). */
export const LOG_TRUNC_JSON = 300;

/** Items shown when a log line previews a list. */
export const LOG_TRUNC_LIST = 10;

/**
 * Truncation cap for tool-rejection diagnostics (reason and remediation hint), deliberately above
 * the content/JSON caps. Both are already bounded at construction, and for a turn that *ends* on a
 * rejection this log line is the only complete record of which rule fired: the correction envelope
 * is replayed into the next provider request, and a terminal rejection has none. Truncating below
 * the value's own bound makes such a turn undiagnosable, so this is a safety stop on pathological
 * input, not a formatting budget.
 */
export const LOG_TRUNC_REJECTION = 1_000;

/**
 * Serializes any value into a bounded single-line diagnostic preview. Circular references and
 * bigint are shown explicitly; an object whose property access or serialization throws degrades to
 * a stable marker, so formatting never suppresses the operation it accompanies.
 */
export function safeStringifyForLog(value: unknown, max = LOG_TRUNC_JSON): string {
  try {
    const seen = new WeakSet();
    const serialized = JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate === 'bigint') return `${candidate.toString()}n`;
      if (typeof candidate === 'string') {
        return trunc(sanitizeForLog(candidate), Math.max(32, Math.floor(max / 2)));
      }
      if (candidate && typeof candidate === 'object') {
        if (seen.has(candidate)) return '[Circular]';
        seen.add(candidate);
      }
      return candidate;
    });
    if (serialized !== undefined) return trunc(sanitizeForLog(serialized), max);
  } catch {
  }

  try {
    return trunc(sanitizeForLog(String(value)), max);
  } catch {
    return '[Unserializable]';
  }
}

/**
 * Truncates a string or array for log previews, appending the overflow count; `max` is the length
 * (string) or item count (array).
 */
export function trunc(val: string | any[], max: number): string {
  if (Array.isArray(val)) {
    if (val.length <= max) return val.join(', ');
    return `${val.slice(0, max).join(', ')} \u2026 [+${val.length - max} more]`;
  }
  return val.length <= max ? val : `${val.slice(0, max)}\u2026 [+${val.length - max} chars]`;
}

/**
 * Normalizes a string to one line for the Output Channel: whitespace, newlines and control
 * characters collapse to single spaces. A backslash sequence like the `\new` in `C:\new\temp` is
 * text and stays as written.
 */
export function sanitizeForLog(s: string): string {
  return s
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Logs a critical failure or unhandled exception: the message is taken from `Error` objects, and
 * both the `FAILED:` line and the stack go out at **error** level. Format: `[CAT] FAILED: operation
 * — error detail`
 */
function logError(ch: LogOutputChannel, cat: LogCategory, op: string, err: unknown): void {
  const detail = normalizeLogMessage(err instanceof Error ? err.message : String(err));
  const msg = `FAILED: ${normalizeCategorizedLogMessage(cat, op)} — ${detail}`;
  ch.error(`[${cat}] ${msg}`);
  if (err instanceof Error && err.stack) {
    const stackLine = `Stack: ${normalizeLogMessage(err.stack)}`;
    ch.error(`[${cat}] ${stackLine}`);
  }
}
