/**
 * Structured logging helpers for the extension host.
 *
 * All output channel logging MUST use these helpers to enforce consistent
 * `[Category] message` formatting. See `.claude/rules/logging.md` for
 * the full template reference and decision tree.
 */
import type { LogOutputChannel } from 'vscode';

/** Canonical log categories — never invent new ones. */
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

/** Internal log capture for automated tests. 
 *  Stored on globalThis to survive bundler-induced module duplication in test environments. */
const GLOBAL_LOG_KEY = '__VSCODE_DL_TEST_LOGS__';
if (!(globalThis as any)[GLOBAL_LOG_KEY]) {
  (globalThis as any)[GLOBAL_LOG_KEY] = [];
}
export const testLogCapture: string[] = (globalThis as any)[GLOBAL_LOG_KEY];

function logToTest(cat: LogCategory, msg: string) {
  if (process.env.VSCODE_EX_TEST) {
    testLogCapture.push(`[${cat}] ${msg}`);
  }
}

/** info — user-facing summary: `[CAT] Operation — key result (timing)` */
export function logInfo(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  logToTest(cat, msg);
  ch.info(`[${cat}] ${msg}`);
}

/** debug — developer/AI diagnostics: `[CAT] Detail — context, parameters` */
export function logDebug(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  logToTest(cat, msg);
  ch.debug(`[${cat}] ${msg}`);
}

/** trace — raw data dumps: `[CAT] Raw — full payload` */
export function logTrace(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  logToTest(cat, msg);
  ch.trace(`[${cat}] ${msg}`);
}

/** warn — degraded state: `[CAT] What happened — what system did → recovery hint` */
export function logWarn(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  logToTest(cat, msg);
  ch.warn(`[${cat}] ${msg}`);
}

/** Truncate a string for log previews: first `max` chars + `… [+N chars]` suffix if longer. */
export function trunc(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\u2026 [+${s.length - max} chars]`;
}

/** Normalize a string for single-line output-channel display: collapse all whitespace and JSON escape sequences to single spaces. */
export function sanitizeForLog(s: string): string {
  return s
    .replace(/\\[nrt]/g, ' ')   // JSON-escaped newline/return/tab → space
    .replace(/[\n\r\t]/g, ' ')  // real control chars → space
    .replace(/ {2,}/g, ' ');    // collapse runs of spaces
}

/**
 * error — operation failed: `[CAT] FAILED: operation — error detail`
 *
 * Automatically logs the stack trace at debug level when available.
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
