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
  | 'Bridge';

/** info — user-facing summary: `[CAT] Operation — key result (timing)` */
export function logInfo(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  ch.info(`[${cat}] ${msg}`);
}

/** debug — developer/AI diagnostics: `[CAT] Detail — context, parameters` */
export function logDebug(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  ch.debug(`[${cat}] ${msg}`);
}

/** trace — raw data dumps: `[CAT] Raw — full payload` */
export function logTrace(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  ch.trace(`[${cat}] ${msg}`);
}

/** warn — degraded state: `[CAT] What happened — what system did → recovery hint` */
export function logWarn(ch: LogOutputChannel, cat: LogCategory, msg: string): void {
  ch.warn(`[${cat}] ${msg}`);
}

/** Truncate a string for log previews: first `max` chars + `… [+N chars]` suffix if longer. */
export function trunc(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\u2026 [+${s.length - max} chars]`;
}

/**
 * error — operation failed: `[CAT] FAILED: operation — error detail`
 *
 * Automatically logs the stack trace at debug level when available.
 */
export function logError(ch: LogOutputChannel, cat: LogCategory, op: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  ch.error(`[${cat}] FAILED: ${op} — ${detail}`);
  if (err instanceof Error && err.stack) {
    ch.debug(`[${cat}] Stack: ${err.stack}`);
  }
}
