import { memo, useState, useRef, useEffect } from 'react';
import type { AnalysisMode } from '../engine/types';
import { ANALYSIS_TYPE_INFO, ANALYSIS_TYPE_LABELS } from '../utils/analysisInfo';

interface AnalysisBannerProps {
  analysis: AnalysisMode;
  onClose: () => void;
  /** When provided, shows the "Save as Bookmark" button. */
  onSaveAsBookmark?: (name: string, withPositions: boolean) => void;
}

export const AnalysisBanner = memo(function AnalysisBanner({
  analysis,
  onClose,
  onSaveAsBookmark,
}: AnalysisBannerProps) {
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [withPositions, setWithPositions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (saving) inputRef.current?.focus();
  }, [saving]);

  function handleConfirmSave() {
    const name = saveName.trim();
    if (!name) return;
    onSaveAsBookmark?.(name, withPositions);
    setSaving(false);
    setSaveName('');
    setWithPositions(false);
  }
  const { type, result, activeGroupId } = analysis;
  const activeGroup = activeGroupId
    ? result.groups.find(g => g.id === activeGroupId)
    : null;

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
            d={ANALYSIS_TYPE_INFO[type].icon}
          />
        </svg>

        <div className="flex flex-col">
          <div className="text-sm font-semibold ln-text">
            {ANALYSIS_TYPE_LABELS[type]}
          </div>
          <div className="text-xs ln-text-muted">
            {activeGroup ? (
              <>
                Viewing <span className="font-bold">{activeGroup.label}</span>
                {' '}({activeGroup.nodeIds.length} node{activeGroup.nodeIds.length !== 1 ? 's' : ''})
              </>
            ) : (
              result.summary
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {onSaveAsBookmark && !saving && (
          <button
            onClick={() => setSaving(true)}
            className="h-8 px-3 text-xs rounded font-medium transition-colors ln-btn-secondary"
            title="Save this analysis result as a named bookmark"
          >
            Save as Bookmark
          </button>
        )}
        {saving && (
          <div className="flex items-center gap-1">
            <input
              ref={inputRef}
              type="text"
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleConfirmSave(); if (e.key === 'Escape') { setSaving(false); setSaveName(''); } }}
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
              onClick={() => { setSaving(false); setSaveName(''); }}
              className="h-7 px-2 text-xs rounded font-medium transition-colors ln-btn-secondary"
            >
              ✕
            </button>
          </div>
        )}
        <button
          onClick={onClose}
          className="h-8 px-3 text-xs rounded font-medium transition-colors ln-btn-secondary"
        >
          Close Analysis
        </button>
      </div>
    </div>
  );
});
