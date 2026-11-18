/**
 * Routes notifications from the sandboxed Webview, which cannot use `vscode.window`, to the
 * extension host over the IPC layer so UI components can trigger native VS Code toasts.
 */

/**
 * Dispatches a warning notification to the host. The host adds the `Data Lineage:` prefix; callers
 * pass only the message body.
 */
export function notifyUser(text: string): void {
  window.vscode?.postMessage({ type: 'show-warning', text });
}
