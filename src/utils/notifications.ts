import * as vscode from 'vscode';
import {
  LOG_TRUNC_JSON,
  Logger,
  safeStringifyForLog,
  sanitizeForLog,
  trunc,
} from './log';
import { redactSecrets } from './redact';

type NotifyContext = Record<string, unknown>;

const MAX_NOTIFICATION_CONTEXT = LOG_TRUNC_JSON * 4;

/**
 * One-line, bounded rendering of a context value. Text is redacted before it is cut, so truncation
 * cannot split a credential past the redaction patterns: list items and error messages here, a
 * string value by {@link formatContext} before the call. `formatContext` redacts each rendered part
 * again, which covers serialized objects.
 */
function renderContextValue(value: unknown): string {
  try {
    if (Array.isArray(value)) {
      return trunc(value.map((item) => (
        item && typeof item === 'object'
          ? safeStringifyForLog(item)
          : sanitizeForLog(redactSecrets(String(item)))
      )).join(', '), LOG_TRUNC_JSON);
    }
    if (value instanceof Error) return trunc(sanitizeForLog(redactSecrets(value.message)), LOG_TRUNC_JSON);
    if (value && typeof value === 'object') return safeStringifyForLog(value);
    return trunc(sanitizeForLog(String(value)), LOG_TRUNC_JSON);
  } catch {
    return '[Unserializable]';
  }
}

/**
 * Renders the context as one `key=value; …` line, with credential-shaped text removed from every
 * part.
 */
function formatContext(context?: NotifyContext): string {
  if (!context) return '';
  try {
    const parts = Object.entries(context)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        const rendered = renderContextValue(typeof value === 'string' ? redactSecrets(value) : value);
        return redactSecrets(`${sanitizeForLog(key)}=${rendered}`);
      });
    return parts.length > 0
      ? ` — ${trunc(parts.join('; '), MAX_NOTIFICATION_CONTEXT)}`
      : '';
  } catch {
    return ' — context=[Unserializable]';
  }
}

/**
 * Logs the toast text and call-site context at debug and returns the redacted toast text. Both can
 * carry a path, a name or a driver message, so neither reaches an info, warn or error line: the
 * caller logs the operation alone at the toast's level. The toast is redacted because a caller may
 * build it from a driver message.
 */
function noticeDetailAndToast(logger: Logger, operation: string, userMessage: string, context?: NotifyContext): string {
  logger.debug(`${operation} — notification="${userMessage}"${formatContext(context)}`);
  return redactSecrets(userMessage);
}

/** Logs detailed error diagnostics before showing a concise VS Code error toast. */
export function notifyError(
  logger: Logger,
  operation: string,
  userMessage: string,
  error?: unknown,
  context?: NotifyContext,
  showErrorMessage: (message: string) => unknown = vscode.window.showErrorMessage,
): void {
  logger.error(operation, error);
  showErrorMessage(noticeDetailAndToast(logger, operation, userMessage, context));
}

/** Logs detailed information diagnostics before showing a concise VS Code info toast. */
export function notifyInfo(
  logger: Logger,
  operation: string,
  userMessage: string,
  context?: NotifyContext,
  showInformationMessage: (message: string) => unknown = vscode.window.showInformationMessage,
): void {
  logger.info(operation);
  showInformationMessage(noticeDetailAndToast(logger, operation, userMessage, context));
}

/** Logs detailed warning diagnostics before showing a concise VS Code warning toast. */
export function notifyWarning(
  logger: Logger,
  operation: string,
  userMessage: string,
  context?: NotifyContext,
  showWarningMessage: (message: string) => unknown = vscode.window.showWarningMessage,
): void {
  logger.warn(operation);
  showWarningMessage(noticeDetailAndToast(logger, operation, userMessage, context));
}

/** Toasts already shown this session, keyed on operation and text; the logger still records every occurrence. */
const shownToasts = new Set<string>();

/** Forgets the shown toasts, so a setting change that fixes and then re-breaks a config shows again. */
export function clearOnceToasts(): void {
  shownToasts.clear();
}

/** True the first time this operation and toast text is seen this session. */
export function isFirstToast(operation: string, userMessage: string): boolean {
  const key = `${operation}\n${userMessage}`;
  if (shownToasts.has(key)) return false;
  shownToasts.add(key);
  return true;
}

/** {@link notifyError} that shows its toast once per session for the same operation and text. */
export function notifyErrorOnce(
  logger: Logger,
  operation: string,
  userMessage: string,
  error?: unknown,
  context?: NotifyContext,
  showErrorMessage: (message: string) => unknown = vscode.window.showErrorMessage,
): void {
  notifyError(logger, operation, userMessage, error, context, isFirstToast(operation, userMessage) ? showErrorMessage : () => {});
}

/** {@link notifyWarning} that shows its toast once per session for the same operation and text. */
export function notifyWarningOnce(
  logger: Logger,
  operation: string,
  userMessage: string,
  context?: NotifyContext,
  showWarningMessage: (message: string) => unknown = vscode.window.showWarningMessage,
): void {
  notifyWarning(logger, operation, userMessage, context, isFirstToast(operation, userMessage) ? showWarningMessage : () => {});
}
