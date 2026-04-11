/**
 * Webview → VS Code notification bridge.
 *
 * The webview cannot call `vscode.window.show*Message()` directly.
 * This helper sends a `postMessage` to the extension host, which
 * forwards it to the VS Code notification API.
 *
 * Extension handler: `extension.ts` → `showWarningMessage("Data Lineage: " + text)`
 *
 * See `.claude/rules/logging.md` → "VS Code Notification Protocol".
 */

/** Show a VS Code warning notification toast from the webview.
 *  Extension handler prefixes with "Data Lineage: " — pass bare text only.
 *  Use sparingly: only for user-initiated actions that failed silently. */
export function notifyUser(text: string): void {
  window.vscode?.postMessage({ type: 'show-warning', text });
}
