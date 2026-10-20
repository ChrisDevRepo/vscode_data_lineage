/** Utility for constructing Content-Security-Policy (CSP) strings for VS Code webviews. */

export interface CspOptions {
  /** The unique nonce generated for script execution. */
  nonce: string;
  /** The allowed CSP source URI provided by the VS Code webview panel. */
  cspSource: string;
}

/** Builds a webview Content Security Policy from its nonce and allowed source URI. */
export function buildWebviewCsp({ nonce, cspSource }: CspOptions): string {
  return [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    "worker-src blob:",
    "form-action 'none'"
  ].join('; ') + ';';
}
