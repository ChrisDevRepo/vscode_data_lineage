import { Uri, Webview } from "vscode";

/**
 * Resolves a local file system path into a URI a Webview can load, which cannot read the local file
 * system directly: `webview.asWebviewUri` converts it to the `vscode-webview-resource` scheme for
 * scripts, styles and assets from the extension bundle.
 *
 * @param extensionUri - Base URI of the extension (usually `ExtensionContext.extensionUri`).
 * @param pathList - Path segments to join and resolve.
 *
 * @example
 * ```typescript
 * const scriptUri = getUri(panel.webview, context.extensionUri, ["dist", "bundle.js"]);
 * ```
 */
export function getUri(webview: Webview, extensionUri: Uri, pathList: string[]) {
  return webview.asWebviewUri(Uri.joinPath(extensionUri, ...pathList));
}
