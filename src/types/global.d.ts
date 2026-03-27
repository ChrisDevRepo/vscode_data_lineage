// monaco-editor publishes types only for its main entry point.
// The ESM subpath import ('monaco-editor/esm/vs/editor/editor.api') used in
// MonacoSqlView.tsx avoids bundling all language workers (~9 MB), but TS
// cannot resolve its types. Re-export from the main declaration to fix that.
declare module 'monaco-editor/esm/vs/editor/editor.api' {
  export * from 'monaco-editor';
}

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
