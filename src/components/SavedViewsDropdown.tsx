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
  onAssignSlot?: (profileId: string, slot: number | null) => void;
}

export const SavedViewsDropdown = memo(function SavedViewsDropdown({
  filterProfiles,
  isEnabled,
  onSaveView,
  onApplyView,
  onDeleteView,
  onAssignSlot,
}: SavedViewsDropdownProps) {
  const { isOpen, toggle, close, refs, floatingStyles, getFloatingProps } = useDropdown();
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [slotPickerOpen, setSlotPickerOpen] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset internal state when dropdown closes
  useEffect(() => {
    if (!isOpen) {
      setIsAdding(false);
      setNewName('');
      setConfirmDeleteId(null);
      setSlotPickerOpen(null);
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

  const assignedSlotCount = filterProfiles.filter(p => p.slot !== undefined).length;

  return (
    <>
      <span className="relative inline-flex">
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
        {assignedSlotCount > 0 && (
          <span
            className="absolute -top-1 -right-1 w-4 h-4 text-[9px] font-bold rounded-full flex items-center justify-center pointer-events-none"
            style={{ background: 'var(--ln-button-bg)', color: 'var(--ln-button-fg)' }}
          >
            {assignedSlotCount}
          </span>
        )}
      </span>

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
                        <span className="flex-1 truncate" style={{ color: 'var(--vscode-editorError-foreground, #f14c4c)' }}>
                          Delete &ldquo;{profile.name}&rdquo;?
                        </span>
                        <Button
                          variant="ghost"
                          className="h-6 px-1.5 text-xs"
                          style={{ color: 'var(--vscode-editorError-foreground, #f14c4c)' }}
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
                    <div key={profile.id}>
                      <div
                        className="flex items-center gap-1 px-2 py-1 rounded ln-list-item"
                        role="menuitem"
                      >
                        {/* Slot badge — shows assigned slot or '#' as hint; click to open picker */}
                        {onAssignSlot && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSlotPickerOpen(v => (v === profile.id ? null : profile.id));
                            }}
                            title={profile.slot
                              ? `Alt+${profile.slot} — click to change`
                              : 'Assign keyboard shortcut (Alt+1–9)'}
                            className="flex-shrink-0 w-5 h-5 flex items-center justify-center text-[10px] font-mono rounded ln-list-item"
                            style={profile.slot
                              ? { color: 'var(--ln-text-link)', fontWeight: 700 }
                              : { opacity: 0.35 }}
                          >
                            {profile.slot ?? '#'}
                          </button>
                        )}
                        <span className="flex-1 text-sm truncate flex items-center gap-1" title={profile.name}>
                          {profile.name}
                          {(profile.filter.allowlistNodeIds?.length ?? 0) > 0 && (
                            <span
                              className="text-[9px] px-1 rounded flex-shrink-0"
                              style={{
                                border: '1px solid var(--ln-analysis-border)',
                                color: 'var(--ln-analysis-fg)',
                                lineHeight: '14px',
                              }}
                            >
                              {profile.source === 'ai' ? 'AI' : profile.source === 'trace' ? 'trace' : profile.source === 'analysis' ? 'analysis' : 'adv'}
                            </span>
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

                      {/* Inline slot picker — expands below the row */}
                      {onAssignSlot && slotPickerOpen === profile.id && (
                        <div className="px-2 pb-1.5 pt-0.5 flex items-center gap-0.5">
                          {([1,2,3,4,5,6,7,8,9] as const).map(n => {
                            const takenBy = filterProfiles.find(fp => fp.slot === n && fp.id !== profile.id);
                            const isCurrent = profile.slot === n;
                            return (
                              <button
                                key={n}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onAssignSlot(profile.id, isCurrent ? null : n);
                                  setSlotPickerOpen(null);
                                }}
                                title={takenBy
                                  ? `Slot ${n} used by "${takenBy.name}"`
                                  : isCurrent
                                    ? `Remove Alt+${n}`
                                    : `Assign Alt+${n}`}
                                className="w-6 h-6 text-[10px] font-mono rounded flex items-center justify-center ln-list-item"
                                style={isCurrent
                                  ? { background: 'var(--ln-button-bg)', color: 'var(--ln-button-fg)', fontWeight: 700 }
                                  : takenBy
                                    ? { opacity: 0.35 }
                                    : undefined}
                              >
                                {n}
                              </button>
                            );
                          })}
                          <button
                            onClick={(e) => { e.stopPropagation(); setSlotPickerOpen(null); }}
                            className="w-6 h-6 text-[11px] rounded flex items-center justify-center ln-list-item ml-0.5"
                            title="Close"
                            style={{ opacity: 0.6 }}
                          >
                            ✕
                          </button>
                        </div>
                      )}
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
