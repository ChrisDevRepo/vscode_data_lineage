import { memo, useEffect, useRef, useState } from 'react';
import { FloatingPortal } from '@floating-ui/react';
import { Button } from './ui/Button';
import type { FilterProfile } from '../engine/projectStore';
import { useDropdown } from '../hooks/useDropdown';

interface SavedViewsDropdownProps {
  filterProfiles: FilterProfile[];
  isEnabled: boolean;
  onSaveView: (name: string) => void;
  onApplyView: (profile: FilterProfile) => void;
  onDeleteView: (profileId: string) => void;
}

export const SavedViewsDropdown = memo(function SavedViewsDropdown({
  filterProfiles,
  isEnabled,
  onSaveView,
  onApplyView,
  onDeleteView,
}: SavedViewsDropdownProps) {
  const { isOpen, toggle, close, refs, floatingStyles, getFloatingProps } = useDropdown();
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset internal state when dropdown closes
  useEffect(() => {
    if (!isOpen) {
      setIsAdding(false);
      setNewName('');
      setConfirmDeleteId(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isAdding) inputRef.current?.focus();
  }, [isAdding]);

  const handleSave = () => {
    const name = newName.trim();
    if (!name) return;
    onSaveView(name);
    setNewName('');
    setIsAdding(false);
  };

  return (
    <>
      <Button
        ref={refs.setReference}
        onClick={() => isEnabled && toggle()}
        variant="icon"
        title={isEnabled ? 'Bookmarks' : 'Open a project to use bookmarks'}
        disabled={!isEnabled}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        style={isOpen ? { background: 'var(--ln-toolbar-active-bg)' } : undefined}
      >
        {/* Heroicons bookmark */}
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" />
        </svg>
      </Button>

      <FloatingPortal>
        {isOpen && (
          <div
            ref={refs.setFloating}
            style={{ ...floatingStyles, boxShadow: 'var(--ln-dropdown-shadow)' }}
            className="w-64 rounded-md shadow-lg z-[200] p-2 ln-dropdown"
            role="menu"
            aria-label="Bookmarks"
            {...getFloatingProps()}
          >
            {/* Save new view */}
            {!isAdding ? (
              <button
                className="w-full text-left px-2 py-1.5 text-sm rounded transition-colors ln-list-item flex items-center gap-2"
                onClick={() => setIsAdding(true)}
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 flex-shrink-0">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Save current view
              </button>
            ) : (
              <div className="space-y-1 px-1 pb-1">
                <input
                  ref={inputRef}
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSave();
                    if (e.key === 'Escape') { setIsAdding(false); setNewName(''); }
                  }}
                  placeholder="View name…"
                  className="w-full h-7 px-2 text-xs rounded ln-input"
                />
                <div className="flex gap-1">
                  <Button variant="primary" className="h-6 px-2 text-xs" onClick={handleSave} disabled={!newName.trim()}>
                    Save
                  </Button>
                  <Button variant="ghost" className="h-6 px-2 text-xs" onClick={() => { setIsAdding(false); setNewName(''); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {/* Saved profiles list */}
            {filterProfiles.length > 0 && (
              <>
                <div className="w-full h-px my-1.5" style={{ background: 'var(--ln-border)' }} />
                {filterProfiles.map((profile) => {
                  if (confirmDeleteId === profile.id) {
                    return (
                      <div key={profile.id} className="flex items-center gap-1 px-2 py-1 text-xs">
                        <span className="flex-1 truncate ln-text-error">
                          Delete &ldquo;{profile.name}&rdquo;?
                        </span>
                        <Button
                          variant="ghost"
                          className="h-6 px-1.5 text-xs ln-text-error"
                          onClick={() => { onDeleteView(profile.id); setConfirmDeleteId(null); }}
                        >
                          Delete
                        </Button>
                        <Button
                          variant="ghost"
                          className="h-6 px-1.5 text-xs"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={profile.id}
                      className="flex items-center gap-1 px-2 py-1 rounded ln-list-item"
                      role="menuitem"
                    >
                      <span className="flex-1 text-sm truncate flex items-center gap-1" title={profile.name}>
                        {profile.name}
                        {(profile.filter.allowlistNodeIds?.length ?? 0) > 0 && (
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            className="w-3 h-3 flex-shrink-0"
                            style={{ color: 'var(--ln-analysis-fg)', opacity: 0.8 }}
                            aria-label="Advanced bookmark"
                          >
                            <path fillRule="evenodd" d="M6.32 2.577a49.255 49.255 0 0 1 11.36 0c1.497.174 2.57 1.46 2.57 2.93V21a.75.75 0 0 1-1.085.67L12 18.089l-7.165 3.583A.75.75 0 0 1 3.75 21V5.507c0-1.47 1.073-2.756 2.57-2.93Z" clipRule="evenodd" />
                          </svg>
                        )}
                      </span>
                      <Button
                        variant="primary"
                        className="h-6 px-2 text-xs flex-shrink-0"
                        onClick={() => { onApplyView(profile); close(); }}
                        title={`Apply "${profile.name}"`}
                      >
                        Apply
                      </Button>
                      <button
                        type="button"
                        className="flex-shrink-0 p-0.5 rounded ln-list-item"
                        onClick={() => setConfirmDeleteId(profile.id)}
                        title={`Delete "${profile.name}"`}
                        aria-label={`Delete ${profile.name}`}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </FloatingPortal>
    </>
  );
});
