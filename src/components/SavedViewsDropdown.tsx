import { memo, useEffect, useRef, useState } from 'react';
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
  const { isOpen, toggle, close, containerRef } = useDropdown();
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
    <div className="relative" ref={containerRef}>
      <Button
        onClick={() => isEnabled && toggle()}
        variant="icon"
        title={isEnabled ? 'Saved Views' : 'Open a project to save views'}
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

      {isOpen && (
        <div
            className="absolute top-full mt-2 w-64 rounded-md shadow-lg z-30 p-2 ln-dropdown"
            style={{ boxShadow: 'var(--ln-dropdown-shadow)', right: 0 }}
            role="menu"
            aria-label="Saved views"
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
                  <Button variant="primary" style={{ fontSize: 11, height: 24, padding: '0 8px' }} onClick={handleSave} disabled={!newName.trim()}>
                    Save
                  </Button>
                  <Button variant="ghost" style={{ fontSize: 11, height: 24, padding: '0 8px' }} onClick={() => { setIsAdding(false); setNewName(''); }}>
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
                        <span className="flex-1 truncate" style={{ color: 'var(--vscode-editorError-foreground, #f14c4c)' }}>
                          Delete &ldquo;{profile.name}&rdquo;?
                        </span>
                        <button
                          className="px-1.5 py-0.5 rounded ln-list-item text-xs"
                          style={{ color: 'var(--vscode-editorError-foreground, #f14c4c)' }}
                          onClick={() => { onDeleteView(profile.id); setConfirmDeleteId(null); }}
                        >
                          Delete
                        </button>
                        <button
                          className="px-1.5 py-0.5 rounded ln-list-item text-xs"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={profile.id}
                      className="flex items-center gap-1 px-2 py-1 rounded ln-list-item"
                      role="menuitem"
                    >
                      <span className="flex-1 text-sm truncate" title={profile.name}>
                        {profile.name}
                      </span>
                      <button
                        className="text-xs px-1.5 py-0.5 rounded ln-list-item flex-shrink-0"
                        style={{ fontSize: 11 }}
                        onClick={() => { onApplyView(profile); close(); }}
                        title={`Apply "${profile.name}"`}
                      >
                        Apply
                      </button>
                      <button
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
    </div>
  );
});
