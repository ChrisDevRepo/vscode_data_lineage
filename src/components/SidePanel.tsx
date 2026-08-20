import type { ReactNode } from 'react';
import { CloseIcon } from './ui/CloseIcon';

interface SidePanelProps {
  /** The title text displayed in the header. */
  title: string;
  /** Optional icon displayed next to the title. */
  icon?: ReactNode;
  /** Callback function triggered when the close button is clicked. */
  onClose: () => void;
  /** Content to be rendered within the panel body. */
  children: ReactNode;
}

/**
 * Renders the shared titled, closable sidebar shell.
 */
export function SidePanel({ title, icon, onClose, children }: SidePanelProps) {
  return (
    <div className="ln-sidebar">
      <div className="flex items-center justify-between px-3 py-2"
           style={{ background: 'var(--ln-sidebar-header-bg)' }}>
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-xs font-semibold"
                style={{ color: 'var(--ln-sidebar-header-fg)' }}>{title}</span>
        </div>
        <button onClick={onClose}
                aria-label="Close panel"
                className="opacity-60 hover:opacity-100 cursor-pointer"
                style={{ color: 'var(--ln-fg)' }}>
          <CloseIcon className="w-3.5 h-3.5" />
        </button>
      </div>
      {children}
    </div>
  );
}
