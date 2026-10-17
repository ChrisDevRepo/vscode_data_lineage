import { createContext, useContext, ReactNode } from 'react';

/** Context providing access to the VS Code Webview API. */
const VsCodeContext = createContext<VsCodeAPI | null>(null);

/** Provider component for the VS Code Webview API context. */
export const VsCodeProvider = ({ children, api }: { children: ReactNode; api: VsCodeAPI | null }) => {
  return <VsCodeContext.Provider value={api}>{children}</VsCodeContext.Provider>;
};

/** Hook to access the VS Code Webview API from within the React tree. */
export const useVsCode = (): VsCodeAPI => {
  const context = useContext(VsCodeContext);
  if (!context) {
    throw new Error('useVsCode must be used within VsCodeProvider');
  }
  return context;
};
