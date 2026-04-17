import { Uri, Webview } from "vscode";

/**
 * Resolves a local file system path into a URI compatible with VS Code Webviews.
 *
 * Webviews are restricted from accessing the local file system directly. This
 * function uses `webview.asWebviewUri` to convert standard URIs into the
 * `vscode-webview-resource` scheme, enabling the UI to load scripts, styles,
 * and assets from the extension bundle.
 *
 * @param webview - The target `vscode.Webview` instance where the resource will be used.
 * @param extensionUri - The base URI of the extension (usually from `ExtensionContext.extensionUri`).
 * @param pathList - An array of path segments to be joined and resolved.
 *
 * @returns A `vscode.Uri` that can be safely embedded in webview HTML.
 *
 * @example
 * ```typescript
 * const scriptUri = getUri(panel.webview, context.extensionUri, ["dist", "bundle.js"]);
 * ```
 */
export function getUri(webview: Webview, extensionUri: Uri, pathList: string[]) {
  return webview.asWebviewUri(Uri.joinPath(extensionUri, ...pathList));
}
