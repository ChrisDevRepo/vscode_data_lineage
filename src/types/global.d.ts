/** The outbound half of the bridge contract, as the webview bundles see it. */
type WebviewToExtensionMsg =
  import('../engine/shared/bridgeContract').WebviewToExtensionMsg;

/** The handle `acquireVsCodeApi()` returns, shared by the lineage panel and the detail panel. */
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
