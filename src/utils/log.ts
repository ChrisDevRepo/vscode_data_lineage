/** Structured logging infrastructure for the Data Lineage extension host. */
import type { LogOutputChannel } from 'vscode';
import { redactSecrets } from './redact';
import { errorMessage } from './errorMessage';

/** Canonical categories used to tag extension log entries. */
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

/** Logs a milestone event that is meaningful to the end-user. */
function logInfo(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  const norm = normalizeCategorizedLogMessage(cat, msg);
  ch.info(`[${cat}] ${norm}`);
}

/** Logs a granular developer-centric event or state transition. */
function logDebug(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  const norm = normalizeCategorizedLogMessage(cat, msg);
  ch.debug(`[${cat}] ${norm}`);
}

/** Logs a degraded state or non-critical failure. */
function logWarn(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  const norm = normalizeCategorizedLogMessage(cat, msg);
  ch.warn(`[${cat}] ${norm}`);
}

/** A domain-scoped logger that encapsulates a channel and category. */
export class Logger {
  /** Creates a new Logger instance. */
  constructor(
    private readonly ch: LogOutputChannel,
    private readonly cat: LogCategory,
  ) {}

  /** Factory method to create a new Logger. */
  static create(ch: LogOutputChannel, cat: LogCategory): Logger {
    return new Logger(ch, cat);
  }

  /** Logs an info-level message. */
  info(msg: string): void {
    logInfo(this.ch, this.cat, msg);
  }
  /** Logs a debug-level message. */
  debug(msg: string): void {
    logDebug(this.ch, this.cat, msg);
  }
  /** Logs a warning-level message. */
  warn(msg: string): void {
    logWarn(this.ch, this.cat, msg);
  }
  /** Logs an error-level message with full stack detail. */
  error(op: string, err: unknown): void {
    logError(this.ch, this.cat, op, err);
  }
}

/** Truncation cap for content text (prompts, questions, reasoning, SQL previews) — logging.md truncation table. */
export const LOG_TRUNC_CONTENT = 200;

/** Truncation cap for JSON payloads (tool I/O, webview messages) — logging.md truncation table. */
export const LOG_TRUNC_JSON = 300;

/** Items shown when a log line previews a list. */
export const LOG_TRUNC_LIST = 10;

/** Truncation cap for tool-rejection diagnostics (reason and remediation hint). */
export const LOG_TRUNC_REJECTION = 1_000;

/** Serializes an arbitrary value into a bounded, single-line diagnostic preview. */
export function safeStringifyForLog(
  value: unknown,
  max = LOG_TRUNC_JSON,
): string {
  try {
    const seen = new WeakSet();
    const serialized = JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate === 'bigint') return `${candidate.toString()}n`;
      if (typeof candidate === 'string') {
        return trunc(
          redactSecrets(candidate),
          Math.max(32, Math.floor(max / 2)),
        );
      }
      if (candidate && typeof candidate === 'object') {
        if (seen.has(candidate)) return '[Circular]';
        seen.add(candidate);
      }
      return candidate;
    });
    if (serialized !== undefined)
      return trunc(normalizeLogMessage(serialized), max);
  } catch {}

  try {
    return trunc(normalizeLogMessage(String(value)), max);
  } catch {
    return '[Unserializable]';
  }
}

/** Truncates a string or an array of items for log previews. */
export function trunc(val: string | unknown[], max: number): string {
  if (Array.isArray(val)) {
    if (val.length <= max) return val.join(', ');
    return `${val.slice(0, max).join(', ')} \u2026 [+${val.length - max} more]`;
  }
  return val.length <= max
    ? val
    : `${val.slice(0, max)}\u2026 [+${val.length - max} chars]`;
}

/** Normalizes a string for single-line display in the Output Channel. */
export function sanitizeForLog(s: string): string {
  return s
    .replace(/\\[nrt]/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Logs a critical failure or unhandled exception. */
function logError(
  ch: LogOutputChannel,
  cat: LogCategory,
  op: string,
  err: unknown,
): void {
  const detail = normalizeLogMessage(errorMessage(err));
  const msg = `FAILED: ${normalizeCategorizedLogMessage(cat, op)} — ${detail}`;
  ch.error(`[${cat}] ${msg}`);
  if (err instanceof Error && err.stack) {
    const stackLine = `Stack: ${normalizeLogMessage(err.stack)}`;
    ch.error(`[${cat}] ${stackLine}`);
  }
}
