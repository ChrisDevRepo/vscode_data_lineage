interface VsCodeAPI {
  postMessage: (message: Record<string, unknown>) => void;
  getState: () => Record<string, unknown> | undefined;
  setState: (state: Record<string, unknown>) => void;
}

declare function acquireVsCodeApi(): VsCodeAPI;

interface Window {
  vscode?: VsCodeAPI;
  LOGO_URI?: string;
}

// Injected at build time by vite.config.ts define — matches package.json version
declare const __APP_VERSION__: string;
