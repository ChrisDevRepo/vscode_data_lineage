import { memo, useState, useCallback, useEffect, useRef } from 'react';
import { CloseIcon } from './ui/CloseIcon';

interface ObjectFilterModalProps {
  isOpen: boolean;
  onClose: () => void;
  patterns: string[];
  onAdd: (pattern: string) => void;
  onRemove: (index: number) => void;
  onClearAll: () => void;
}

function isRegexPattern(pattern: string): boolean {
  return /^\/.*\/[gimsuy]*$/.test(pattern.trim());
}

export const ObjectFilterModal = memo(function ObjectFilterModal({
  isOpen,
  onClose,
  patterns,
  onAdd,
  onRemove,
  onClearAll,
}: ObjectFilterModalProps) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      // Focus input when modal opens
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setInput('');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleAdd = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setInput('');
    inputRef.current?.focus();
  }, [input, onAdd]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  }, [handleAdd]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 ln-modal-overlay"
      onClick={onClose}
    >
      <div
        className="rounded-xl shadow-2xl w-full max-w-md max-h-[70vh] flex flex-col ln-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 ln-border-bottom flex-shrink-0">
          <div className="flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 ln-text">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z" />
            </svg>
            <h3 className="text-sm font-semibold ln-text">Object Filters</h3>
            {patterns.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full ln-badge">{patterns.length}</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg transition-colors ln-list-item ln-text"
            title="Close"
          >
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Add input */}
        <div className="flex items-center gap-2 px-4 py-3 ln-border-bottom flex-shrink-0">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="dbo.TableName or /regex/i"
            className="flex-1 text-sm px-2.5 py-1.5 rounded ln-input"
          />
          <button
            onClick={handleAdd}
            disabled={!input.trim()}
            className="px-3 py-1.5 text-xs font-semibold rounded transition-colors ln-btn-primary disabled:opacity-40"
          >
            Add
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-2 py-2 min-h-0">
          {patterns.length === 0 ? (
            <div className="text-center py-8 text-xs ln-text-muted">
              No filters active. Right-click a node to filter it out, or add a pattern above.
            </div>
          ) : (
            <div className="space-y-0.5">
              {patterns.map((pattern, i) => (
                <div
                  key={`${pattern}-${i}`}
                  className="flex items-center gap-2 px-2 py-1.5 rounded group transition-colors ln-list-item"
                >
                  <span className="flex-1 text-sm truncate ln-text font-mono" title={pattern}>
                    {pattern}
                  </span>
                  {isRegexPattern(pattern) && (
                    <span className="text-[9px] px-1 py-0.5 rounded ln-badge flex-shrink-0">regex</span>
                  )}
                  <button
                    onClick={() => onRemove(i)}
                    className="w-5 h-5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity ln-text-muted hover:ln-text"
                    title="Remove"
                  >
                    <CloseIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {patterns.length > 0 && (
          <div className="flex justify-end px-4 py-2.5 ln-border-top flex-shrink-0">
            <button
              onClick={onClearAll}
              className="text-xs px-3 py-1 rounded transition-colors ln-btn-ghost"
            >
              Delete All
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
