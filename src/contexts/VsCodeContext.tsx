import { createContext, useContext, ReactNode } from 'react';

// VsCodeAPI type is declared globally in src/types/global.d.ts

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
