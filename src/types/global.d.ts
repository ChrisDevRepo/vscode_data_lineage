/**
 * The outbound half of the bridge contract as the webview bundles see it. Declared with an inline
 * `import(...)` type, not a top-level import, so this file stays a global script: an import would
 * make it a module and take `Window`, `VsCodeAPI` and `__APP_VERSION__` out of global scope.
 */
type WebviewToExtensionMsg = import('../engine/shared/bridgeContract').WebviewToExtensionMsg;

/**
 * The handle `acquireVsCodeApi()` returns, shared by the lineage and detail panels. `postMessage`
 * takes the bridge's outbound union, so a send the host has no handler for is a compile error in
 * the webview rather than a frame the Zod seam drops at runtime; the union spans both dispatchers.
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
