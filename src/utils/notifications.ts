import * as vscode from 'vscode';
import { Logger, sanitizeForLog } from './log';

type NotifyContext = Record<string, unknown>;

function formatContext(context?: NotifyContext): string {
  if (!context || Object.keys(context).length === 0) return '';
  const parts = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const rendered = Array.isArray(value)
        ? value.join(', ')
        : value instanceof Error
          ? value.message
          : value && typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
      return `${key}=${sanitizeForLog(rendered)}`;
    });
  return parts.length > 0 ? ` — ${parts.join('; ')}` : '';
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
  showErrorMessage(userMessage);
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
  showInformationMessage(userMessage);
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
  showWarningMessage(userMessage);
}
