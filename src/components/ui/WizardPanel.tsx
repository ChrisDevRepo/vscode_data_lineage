import { type ReactNode } from 'react';

interface WizardPanelProps {
  children: ReactNode;
  footer?: ReactNode;
}

/** Shared shell for all wizard screens: dark panel, centered, logo header. */
export function WizardPanel({ children, footer }: WizardPanelProps) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 ln-start-screen">
      <div className="w-full max-w-md ln-panel flex flex-col" style={{ borderRadius: 6, minHeight: 360 }}>
        <div className="flex items-center justify-center px-4 py-4 ln-border-bottom flex-shrink-0">
          <img
            src={window.LOGO_URI}
            alt="Data Lineage Viz"
            className="h-10 w-auto"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
        <div className="px-4 py-4 space-y-4 flex-1 overflow-y-auto">
          {children}
        </div>
        {footer && (
          <div className="px-4 pb-4 pt-2 ln-border-top flex-shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
