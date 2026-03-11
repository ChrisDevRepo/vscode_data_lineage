import { memo, useState, useEffect, useCallback, useRef } from 'react';
import type { SavedSession } from '../engine/types';
import { Button } from './ui/Button';
import { CloseIcon } from './ui/CloseIcon';

interface SessionDropdownProps {
  sessions: SavedSession[];
  onSave: (name: string) => void;
  onLoad: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}

export const SessionDropdown = memo(function SessionDropdown({
  sessions,
  onSave,
  onLoad,
  onDelete,
}: SessionDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 50);
    else setSaveName('');
  }, [isOpen]);

  const handleSave = useCallback(() => {
    const trimmed = saveName.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setSaveName('');
    setIsOpen(false);
  }, [saveName, onSave]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    }
  }, [handleSave]);

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  };

  return (
    <div className="relative">
      <Button
        onClick={() => setIsOpen(!isOpen)}
        variant="icon"
        title="Sessions"
        aria-expanded={isOpen}
        aria-haspopup="true"
        style={isOpen ? { background: 'var(--ln-toolbar-active-bg)' } : undefined}
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" />
        </svg>
      </Button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-20" onMouseDown={() => setIsOpen(false)} />
          <div className="absolute top-full right-0 mt-1 w-72 rounded-md shadow-lg z-30 ln-dropdown" style={{ boxShadow: 'var(--ln-dropdown-shadow)' }}>
            {/* Save row */}
            <div className="flex items-center gap-2 px-3 py-2 ln-border-bottom">
              <input
                ref={inputRef}
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Session name..."
                className="flex-1 text-xs px-2 py-1 rounded ln-input"
              />
              <button
                onClick={handleSave}
                disabled={!saveName.trim()}
                className="text-xs px-2 py-1 rounded font-semibold transition-colors ln-btn-primary disabled:opacity-40"
              >
                Save
              </button>
            </div>

            {/* Session list */}
            <div className="max-h-64 overflow-y-auto py-1">
              {sessions.length === 0 ? (
                <div className="text-center py-4 text-xs ln-text-muted">
                  No saved sessions
                </div>
              ) : (
                sessions.map((session) => (
                  <div
                    key={session.id}
                    className="flex items-center gap-2 px-3 py-1.5 group transition-colors ln-list-item cursor-pointer"
                    onClick={() => { onLoad(session.id); setIsOpen(false); }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate ln-text">{session.name}</div>
                      <div className="text-[10px] ln-text-muted flex items-center gap-1">
                        <span>{session.source.type === 'database' ? 'DB' : 'DACPAC'}</span>
                        <span className="opacity-50">|</span>
                        <span>{session.source.name}</span>
                        <span className="opacity-50">|</span>
                        <span>{formatDate(session.updatedAt)}</span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(session.id); }}
                      className="w-5 h-5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity ln-text-muted"
                      title="Delete session"
                    >
                      <CloseIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
});
