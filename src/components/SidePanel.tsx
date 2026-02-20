import type { ReactNode } from 'react';
import { CloseIcon } from './ui/CloseIcon';

interface SidePanelProps {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

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
                className="opacity-60 hover:opacity-100 cursor-pointer"
                style={{ color: 'var(--ln-fg)' }}>
          <CloseIcon className="w-3.5 h-3.5" />
        </button>
      </div>
      {children}
    </div>
  );
}
