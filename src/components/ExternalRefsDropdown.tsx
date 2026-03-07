import { memo, useEffect, useState } from 'react';
import { Button } from './ui/Button';

interface ExternalRefsDropdownProps {
  showExternalRefs: boolean;
  externalRefTypes: Set<'file' | 'db'>;
  onToggleMaster: () => void;
  onToggleSubType: (subType: 'file' | 'db') => void;
}

export const ExternalRefsDropdown = memo(function ExternalRefsDropdown({
  showExternalRefs,
  externalRefTypes,
  onToggleMaster,
  onToggleSubType,
}: ExternalRefsDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  return (
    <div className="relative">
      <Button
        onClick={() => setIsOpen(!isOpen)}
        variant="icon"
        title="External References"
        aria-expanded={isOpen}
        aria-haspopup="true"
        style={isOpen ? { background: 'var(--ln-toolbar-active-bg)' } : undefined}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="w-5 h-5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"
          />
        </svg>
      </Button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-20" onMouseDown={() => setIsOpen(false)} />
          <div className="absolute top-full mt-2 w-56 rounded-md shadow-lg z-30 p-2 ln-dropdown" role="menu" aria-label="External reference filters">
            {/* Master toggle */}
            <div className="flex items-center gap-2 px-2 py-1.5 rounded transition-colors ln-list-item" role="menuitemcheckbox" aria-checked={showExternalRefs}>
              <input
                type="checkbox"
                checked={showExternalRefs}
                onChange={onToggleMaster}
                className="w-4 h-4 rounded border cursor-pointer ln-checkbox"
                aria-label="Toggle all external references"
              />
              <span className="text-sm font-medium">External Refs</span>
            </div>

            {/* Sub-filters (only interactive when master is ON) */}
            <div className={showExternalRefs ? '' : 'opacity-40'}>
              <div className="flex items-center gap-2 px-2 py-1.5 pl-6 rounded transition-colors ln-list-item" role="menuitemcheckbox" aria-checked={externalRefTypes.has('file')}>
                <input
                  type="checkbox"
                  checked={externalRefTypes.has('file')}
                  onChange={() => onToggleSubType('file')}
                  disabled={!showExternalRefs}
                  className="w-4 h-4 rounded border cursor-pointer ln-checkbox"
                  aria-label="Toggle file source references"
                />
                <span className="text-sm">File Sources</span>
                <span className="text-[10px] ml-auto" style={{ color: 'var(--ln-fg-dim)' }}>OPENROWSET</span>
              </div>
              <div className="flex items-center gap-2 px-2 py-1.5 pl-6 rounded transition-colors ln-list-item" role="menuitemcheckbox" aria-checked={externalRefTypes.has('db')}>
                <input
                  type="checkbox"
                  checked={externalRefTypes.has('db')}
                  onChange={() => onToggleSubType('db')}
                  disabled={!showExternalRefs}
                  className="w-4 h-4 rounded border cursor-pointer ln-checkbox"
                  aria-label="Toggle cross-database references"
                />
                <span className="text-sm">Cross-Database</span>
                <span className="text-[10px] ml-auto" style={{ color: 'var(--ln-fg-dim)' }}>3-part</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
});
