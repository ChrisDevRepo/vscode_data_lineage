import React, { type ReactNode } from 'react';
import { CloseIcon } from './ui/CloseIcon';

/**
 * Props for the {@link SidePanel} component.
 */
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
 * A generic sidebar panel component for displaying detailed information or interactive controls.
 *
 * @remarks
 * This component features a header with a title, an optional icon, and a close button.
 * It is styled using theme variables (e.g., `--ln-sidebar-header-bg`, `--ln-sidebar-header-fg`).
 *
 * @param props - The component properties.
 * @returns A {@link React.JSX.Element} representing the sidebar panel.
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
