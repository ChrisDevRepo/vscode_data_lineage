import { createContext, useContext, ReactNode } from 'react';

interface VsCodeAPI {
  postMessage: (message: any) => void;
  getState: () => any;
  setState: (state: any) => void;
}

const VsCodeContext = createContext<VsCodeAPI | null>(null);

export const VsCodeProvider = ({ children, api }: { children: ReactNode; api: VsCodeAPI | null }) => {
  return <VsCodeContext.Provider value={api}>{children}</VsCodeContext.Provider>;
};

export const useVsCode = () => {
  const context = useContext(VsCodeContext);
  if (!context) {
    throw new Error('useVsCode must be used within VsCodeProvider');
  }
  return context;
};
