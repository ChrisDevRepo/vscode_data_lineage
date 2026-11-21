import { createContext, useContext, ReactNode } from 'react';

/**
 * Context giving nested components the VS Code Webview API, to post messages to the extension host
 * and persist state across reloads without prop drilling. `VsCodeAPI` is declared globally in
 * `src/types/global.d.ts`, so this is the handle `acquireVsCodeApi()` returns: `postMessage`
 * accepts only the bridge's outbound message union.
 */
const VsCodeContext = createContext<VsCodeAPI | null>(null);

/** Provides the VS Code Webview API; `api` is null in external browsers and tests. */
export const VsCodeProvider = ({ children, api }: { children: ReactNode; api: VsCodeAPI | null }) => {
  return <VsCodeContext.Provider value={api}>{children}</VsCodeContext.Provider>;
};

/**
 * Reads the VS Code Webview API, whose `postMessage` is typed to the outbound union.
 *
 * @throws If called outside a `VsCodeProvider`.
 */
export const useVsCode = (): VsCodeAPI => {
  const context = useContext(VsCodeContext);
  if (!context) {
    throw new Error('useVsCode must be used within VsCodeProvider');
  }
  return context;
};
