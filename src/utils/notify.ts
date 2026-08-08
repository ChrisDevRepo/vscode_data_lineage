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
 * @param text - The message body to display.
 *
 * @remarks The extension host adds the `Data Lineage:` prefix; callers provide only the message
 * body.
 */
export function notifyUser(text: string): void {
  window.vscode?.postMessage({ type: 'show-warning', text });
}
