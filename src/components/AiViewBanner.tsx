import { memo, useState, useRef, useEffect } from 'react';
import { Tooltip } from './ui/Tooltip';

interface AiViewBannerProps {
  name: string;
  nodeCount: number;
  onDiscard: () => void;
  /** When provided, shows the "Save as Bookmark" button. */
  onSaveAsBookmark?: (name: string, withPositions: boolean) => void;
}

export const AiViewBanner = memo(function AiViewBanner({
  name,
  nodeCount,
  onDiscard,
  onSaveAsBookmark,
}: AiViewBannerProps) {
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState(name);
  const [withPositions, setWithPositions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (saving) inputRef.current?.focus();
  }, [saving]);

  function handleConfirmSave() {
    const trimmed = saveName.trim();
    if (!trimmed) return;
    onSaveAsBookmark?.(trimmed, withPositions);
    setSaving(false);
    setSaveName('');
    setWithPositions(false);
  }

  return (
    <div className="ln-analysis-banner px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <svg
          className="w-5 h-5 flex-shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          style={{ color: 'var(--ln-analysis-icon)' }}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z"
          />
        </svg>

        <div className="flex flex-col">
          <div className="text-sm font-semibold ln-text">
            AI Preview
          </div>
          <div className="text-xs ln-text-muted">
            <span className="font-bold">{nodeCount} objects</span>
            {' — '}
            <span className="font-mono font-semibold">"{name}"</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {onSaveAsBookmark && !saving && (
          <Tooltip content="Save this AI view as a named bookmark">
            <button
              onClick={() => setSaving(true)}
              className="h-8 px-3 text-xs rounded font-medium transition-colors ln-btn-secondary"
            >
              Save as Bookmark
            </button>
          </Tooltip>
        )}
        {saving && (
          <div className="flex items-center gap-1">
            <input
              ref={inputRef}
              type="text"
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleConfirmSave(); if (e.key === 'Escape') { setSaving(false); setSaveName(name); } }}
              placeholder="Bookmark name…"
              className="h-7 px-2 text-xs rounded ln-input w-[140px]"
            />
            <label className="flex items-center gap-1 text-xs ln-text-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={withPositions}
                onChange={e => setWithPositions(e.target.checked)}
                className="ln-checkbox"
              />
              Positions
            </label>
            <button
              onClick={handleConfirmSave}
              disabled={!saveName.trim()}
              className="h-7 px-2 text-xs rounded font-medium transition-colors ln-btn-primary"
            >
              Save
            </button>
            <button
              onClick={() => { setSaving(false); setSaveName(name); }}
              className="h-7 px-2 text-xs rounded font-medium transition-colors ln-btn-secondary"
            >
              ✕
            </button>
          </div>
        )}
        <button
          onClick={onDiscard}
          className="h-8 px-3 text-xs rounded font-medium transition-colors ln-btn-secondary"
        >
          Discard
        </button>
      </div>
    </div>
  );
});
