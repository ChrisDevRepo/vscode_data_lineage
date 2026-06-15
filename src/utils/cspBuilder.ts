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
 * Builds a strict but functional Content-Security-Policy for the React webview.
 *
 * @param options - Required parameters for VS Code webview CSP generation.
 * @returns A formatted CSP string ready for the `<meta>` tag.
 */
export function buildWebviewCsp({ nonce, cspSource }: CspOptions): string {
  return [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    // Note: cspSource is required in script-src so Vite can dynamically import chunks
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`
  ].join('; ') + ';';
}
