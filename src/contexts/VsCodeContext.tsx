import { createContext, useContext, ReactNode } from 'react';

/**
 * Context providing access to the VS Code Webview API.
 * 
 * @remarks
 * The `VsCodeAPI` type is globally declared in `src/types/global.d.ts`.
 * This context allows nested components to post messages to the extension host
 * and persist state across webview reloads without prop drilling.
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
 * @throws {Error} If called from a component not wrapped in a `VsCodeProvider`.
 * @returns The active `VsCodeAPI` instance.
 */
export const useVsCode = () => {
  const context = useContext(VsCodeContext);
  if (!context) {
    throw new Error('useVsCode must be used within VsCodeProvider');
  }
  return context;
};
