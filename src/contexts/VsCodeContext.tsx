import { createContext, useContext, ReactNode } from 'react';

/**
 * Context providing access to the VS Code Webview API.
 *
 * @remarks
 * The `VsCodeAPI` type is globally declared in `src/types/global.d.ts`, so the API handed down here
 * is the same typed handle `acquireVsCodeApi()` returns: `postMessage` accepts only the bridge's
 * outbound message union. This context allows nested components to post messages to the extension
 * host and persist state across webview reloads without prop drilling.
 */
const VsCodeContext = createContext<VsCodeAPI | null>(null);

/**
 * Provider component for the VS Code Webview API context.
 *
 * @param props - Component properties.
 * @param props.children - The nested React component tree.
 * @param props.api - The acquired VS Code API instance (or null in external browsers/tests).
 */
export const VsCodeProvider = ({ children, api }: { children: ReactNode; api: VsCodeAPI | null }) => {
  return <VsCodeContext.Provider value={api}>{children}</VsCodeContext.Provider>;
};

/**
 * Hook to access the VS Code Webview API from within the React tree.
 *
 * @throws If called from a component not wrapped in a `VsCodeProvider`.
 * @returns The active `VsCodeAPI` instance, whose `postMessage` is typed to the outbound union.
 */
export const useVsCode = (): VsCodeAPI => {
  const context = useContext(VsCodeContext);
  if (!context) {
    throw new Error('useVsCode must be used within VsCodeProvider');
  }
  return context;
};
