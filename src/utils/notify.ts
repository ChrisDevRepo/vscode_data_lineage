/** Infrastructure for routing notifications from the Webview to the VS Code Extension Host. */

/** Dispatches a warning notification to the VS Code host. */
export function notifyUser(text: string): void {
  window.vscode?.postMessage({ type: 'show-warning', text });
}
