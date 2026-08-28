import * as vscode from 'vscode';
import {
  LOG_TRUNC_JSON,
  Logger,
  safeStringifyForLog,
  sanitizeForLog,
  trunc,
} from './log';

type NotifyContext = Record<string, unknown>;

const MAX_NOTIFICATION_CONTEXT = LOG_TRUNC_JSON * 4;

/**
 * Ceiling for the toast text itself. Comfortably above every message this extension composes,
 * so only runaway interpolation — a raw provider error, webview-supplied text — is cut. The
 * untruncated message always reaches the log line above the toast.
 */
const MAX_NOTIFICATION_MESSAGE = 400;

function renderContextValue(value: unknown): string {
  try {
    if (Array.isArray(value)) {
      return trunc(value.map((item) => (
        item && typeof item === 'object'
          ? safeStringifyForLog(item)
          : sanitizeForLog(String(item))
      )).join(', '), LOG_TRUNC_JSON);
    }
    if (value instanceof Error) return trunc(sanitizeForLog(value.message), LOG_TRUNC_JSON);
    if (value && typeof value === 'object') return safeStringifyForLog(value);
    return trunc(sanitizeForLog(String(value)), LOG_TRUNC_JSON);
  } catch {
    return '[Unserializable]';
  }
}

function formatContext(context?: NotifyContext): string {
  if (!context) return '';
  try {
    const parts = Object.entries(context)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${sanitizeForLog(key)}=${renderContextValue(value)}`);
    return parts.length > 0
      ? ` — ${trunc(parts.join('; '), MAX_NOTIFICATION_CONTEXT)}`
      : '';
  } catch {
    return ' — context=[Unserializable]';
  }
}

/**
 * Logs detailed error diagnostics before showing a concise VS Code error toast.
 *
 * @param logger - The logger instance.
 * @param operation - The operation being performed.
 * @param userMessage - The message to show to the user.
 * @param error - The optional error object.
 * @param context - Additional context to log.
 * @param showErrorMessage - Function to display the error message.
 */
export function notifyError(
  logger: Logger,
  operation: string,
  userMessage: string,
  error?: unknown,
  context?: NotifyContext,
  showErrorMessage: (message: string) => unknown = vscode.window.showErrorMessage,
): void {
  const detail = `notification="${userMessage}"${formatContext(context)}`;
  logger.error(`${operation} — ${detail}`, error ?? new Error(userMessage));
  showErrorMessage(trunc(userMessage, MAX_NOTIFICATION_MESSAGE));
}

/**
 * Logs detailed information diagnostics before showing a concise VS Code info toast.
 *
 * @param logger - The logger instance.
 * @param operation - The operation being performed.
 * @param userMessage - The message to show to the user.
 * @param context - Additional context to log.
 * @param showInformationMessage - Function to display the info message.
 */
export function notifyInfo(
  logger: Logger,
  operation: string,
  userMessage: string,
  context?: NotifyContext,
  showInformationMessage: (message: string) => unknown = vscode.window.showInformationMessage,
): void {
  logger.info(`${operation} — notification="${userMessage}"${formatContext(context)}`);
  showInformationMessage(trunc(userMessage, MAX_NOTIFICATION_MESSAGE));
}

/**
 * Logs detailed warning diagnostics before showing a concise VS Code warning toast.
 *
 * @param logger - The logger instance.
 * @param operation - The operation being performed.
 * @param userMessage - The message to show to the user.
 * @param context - Additional context to log.
 * @param showWarningMessage - Function to display the warning message.
 */
export function notifyWarning(
  logger: Logger,
  operation: string,
  userMessage: string,
  context?: NotifyContext,
  showWarningMessage: (message: string) => unknown = vscode.window.showWarningMessage,
): void {
  logger.warn(`${operation} — notification="${userMessage}"${formatContext(context)}`);
  showWarningMessage(trunc(userMessage, MAX_NOTIFICATION_MESSAGE));
}
