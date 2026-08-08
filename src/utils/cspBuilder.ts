/**
 * Utility for constructing Content-Security-Policy (CSP) strings for VS Code webviews.
 *
 * This ensures all necessary directives (such as 'unsafe-inline' for React styles
 * and webview URIs for chunk loading) are safely and consistently applied without
 * relying on brittle raw string concatenation.
 */

export interface CspOptions {
  /** The unique nonce generated for script execution. */
  nonce: string;
  /** The allowed CSP source URI provided by the VS Code webview panel. */
  cspSource: string;
}

/**
 * Builds a webview Content Security Policy from its nonce and allowed source URI.
 *
 * @returns A formatted CSP string ready for the `<meta>` tag.
 */
export function buildWebviewCsp({ nonce, cspSource }: CspOptions): string {
  return [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    // Vite chunk imports require the webview source in addition to the nonce.
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`
  ].join('; ') + ';';
}
