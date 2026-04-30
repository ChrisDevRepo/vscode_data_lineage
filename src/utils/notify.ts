/**
 * Infrastructure for routing notifications from the Webview to the VS Code Extension Host.
 *
 * Webviews operate in a sandboxed environment and cannot directly access the
 * `vscode.window` API. This bridge allows UI components to trigger native
 * VS Code notification toasts by passing messages through the IPC layer.
 */

/**
 * Dispatches a warning notification to the VS Code host.
 *
 * Use this function for user-facing errors that require immediate attention
 * but do not halt the entire application (e.g., "Failed to load table stats").
 *
 * @param text - The message body to display.
 *
 * @remarks
 * Architectural Remark:
 * The extension host automatically prefixes all notifications with "Data Lineage: ".
 * Do not include the extension name in the `text` parameter to avoid redundancy.
 *
 * @example
 * ```typescript
 * if (error) {
 *   notifyUser("Unable to connect to SQL Server.");
 * }
 * ```
 */
export function notifyUser(text: string): void {
  window.vscode?.postMessage({ type: 'show-warning', text });
}
