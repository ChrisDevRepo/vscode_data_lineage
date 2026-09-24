import type { CSSProperties, ReactNode } from 'react';
import { CloseIcon } from './ui/CloseIcon';

interface SidePanelProps {
  /** The header title; plain text or a control such as the trace starting point. */
  title: ReactNode;
  /** Optional icon displayed next to the title. */
  icon?: ReactNode;
  /** Callback function triggered when the close button is clicked. */
  onClose: () => void;
  /** Content to be rendered within the panel body. */
  children: ReactNode;
  /** Extra class on the shell, for panels that size their own body. */
  className?: string;
  /** Accessible name of the close button. Default: "Close panel". */
  closeLabel?: string;
  /** Title-bar actions, rendered before the close button. */
  actions?: ReactNode;
  /** Inline style on the shell, for panels that own their width. */
  style?: CSSProperties;
}

/**
 * Renders the shared titled, closable sidebar shell.
 */
export function SidePanel({ title, icon, onClose, children, className, closeLabel = 'Close panel', actions, style }: SidePanelProps) {
  return (
    <div className={className ? `ln-sidebar ${className}` : 'ln-sidebar'} style={style}>
      <div className="flex items-center justify-between gap-2 px-3 py-2"
           style={{ background: 'var(--ln-sidebar-header-bg)' }}>
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <span className="flex min-w-0 text-xs font-semibold"
                style={{ color: 'var(--ln-sidebar-header-fg)' }}>{title}</span>
        </div>
        <div className="flex items-center gap-1 flex-none">
          {actions}
          <button onClick={onClose}
                  aria-label={closeLabel}
                  className="opacity-60 hover:opacity-100 cursor-pointer"
                  style={{ color: 'var(--ln-fg)' }}>
            <CloseIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}
