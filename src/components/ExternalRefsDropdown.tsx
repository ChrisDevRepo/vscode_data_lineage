import { memo } from 'react';
import { FloatingPortal } from '@floating-ui/react';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { useDropdown } from '../hooks/useDropdown';

/**
 * Props for the {@link ExternalRefsDropdown} component.
 */
interface ExternalRefsDropdownProps {
  /** Whether any external references are shown at all (Master toggle). */
  showExternalRefs: boolean;
  /** Set of active external reference sub-types. */
  externalRefTypes: Set<'file' | 'db'>;
  /** Callback to toggle the master 'showExternalRefs' state. */
  onToggleMaster: () => void;
  /** Callback to toggle a specific external reference sub-type. */
  onToggleSubType: (subType: 'file' | 'db') => void;
  /** Optional visual flag indicating if the view is already narrowed by other filters. */
  isNarrowed?: boolean;
}

/**
 * A dropdown component for filtering external references in the lineage graph.
 * 
 * It provides a master toggle to show/hide all external references and 
 * granular checkboxes for specific types like file sources or cross-database links.
 * 
 * @param props - The component props.
 * @returns A memoized React component.
 */
export const ExternalRefsDropdown = memo(function ExternalRefsDropdown({
  showExternalRefs,
  externalRefTypes,
  onToggleMaster,
  onToggleSubType,
  isNarrowed = false,
}: ExternalRefsDropdownProps) {
  const { isOpen, toggle, refs, floatingStyles, getFloatingProps } = useDropdown();

  return (
    <>
      <div className={`relative inline-flex${isNarrowed ? ' ln-filter-dot' : ''}`}>
      <Tooltip content="External References">
        <Button
          ref={refs.setReference}
          onClick={toggle}
          variant="icon"
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
      </Tooltip>
      </div>

      <FloatingPortal>
        {isOpen && (
          <div
            ref={refs.setFloating}
            style={{ ...floatingStyles, boxShadow: 'var(--ln-dropdown-shadow)' }}
            className="w-56 rounded-md shadow-lg z-50 p-2 ln-dropdown"
            role="menu"
            aria-label="External reference filters"
            {...getFloatingProps()}
          >
            {/* Master toggle */}
            <div className="flex items-center gap-2 px-2 py-1.5 rounded transition-colors ln-list-item" role="menuitemcheckbox" aria-checked={showExternalRefs}>
              <input
                type="checkbox"
                checked={showExternalRefs}
                onChange={onToggleMaster}
                className="w-4 h-4 rounded border cursor-pointer ln-checkbox"
                aria-label="Toggle all external references"
              />
              <span className="text-sm ln-text">External Refs</span>
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
                <span className="text-sm ln-text">File Sources</span>
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
                <span className="text-sm ln-text">Cross-Database</span>
              </div>
            </div>
          </div>
        )}
      </FloatingPortal>
    </>
  );
});
