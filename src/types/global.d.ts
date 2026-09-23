/**
 * The outbound half of the bridge contract, as the webview bundles see it.
 *
 * @remarks
 * Declared with an inline `import(...)` type rather than a top-level import so this file stays a
 * global script: a top-level import would turn it into a module and take `Window`, `VsCodeAPI` and
 * `__APP_VERSION__` out of global scope with it.
 */
type WebviewToExtensionMsg = import('../engine/shared/bridgeContract').WebviewToExtensionMsg;

/**
 * The handle `acquireVsCodeApi()` returns, shared by the lineage panel and the detail panel.
 *
 * @remarks
 * `postMessage` takes the bridge's own outbound union, so a send the host has no handler for is a
 * compile error in the webview rather than a frame the host's Zod seam drops at runtime. Both
 * panels share one handle type, so the union spans both dispatchers.
 */
interface VsCodeAPI {
  postMessage: (message: WebviewToExtensionMsg) => void;
  getState: () => Record<string, unknown> | undefined;
  setState: (state: Record<string, unknown>) => void;
}

declare function acquireVsCodeApi(): VsCodeAPI;

interface Window {
  vscode?: VsCodeAPI;
  LOGO_URI?: string;
}

declare const __APP_VERSION__: string;
