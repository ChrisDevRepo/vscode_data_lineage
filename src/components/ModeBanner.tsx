import { memo, useState, useRef, useEffect, type ReactNode, type ReactElement } from 'react';
import { Tooltip } from './ui/Tooltip';

/**
 * Supported visual variants for the {@link ModeBanner}.
 * Each variant applies specific styling and icon colors.
 */
export type BannerVariant = 'trace' | 'analysis' | 'ai';

/**
 * Props for the {@link ModeBanner} component.
 */
interface ModeBannerProps {
  /** The visual style of the banner. */
  variant: BannerVariant;
  /** SVG path data for the leading icon. */
  icon: string;
  /** Bold primary title text. */
  title: string;
  /** Secondary information or summary text. */
  subtitle: ReactNode;
  /** Callback fired when the user closes the banner. */
  onClose: () => void;
  /** Optional callback to save the current mode's result as a permanent bookmark. */
  onSaveAsBookmark?: (name: string, withPositions: boolean) => void;
  /** Extra controls rendered in the action area (before Save as Bookmark). */
  extraControls?: ReactElement | null;
}

/**
 * Maps banner variants to their corresponding CSS class names.
 */
const VARIANT_CLASS: Record<BannerVariant, string> = {
  trace: 'ln-mode-banner--trace',
  analysis: 'ln-mode-banner--analysis',
  ai: 'ln-mode-banner--ai',
};

/**
 * A shared UI component for displaying the active graph mode (Trace, Analysis, AI).
 * 
 * It appears at the top of the canvas and provides:
 * - A summary of the active operation.
 * - Mode-specific actions (via `extraControls`).
 * - A standardized workflow for saving the current view as a named bookmark.
 * 
 * @param props - The component props.
 * @returns A memoized React component.
 */
export const ModeBanner = memo(function ModeBanner({
  variant,
  icon,
  title,
  subtitle,
  onClose,
  onSaveAsBookmark,
  extraControls,
}: ModeBannerProps) {
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

  return (
    <div className={`ln-mode-banner ${VARIANT_CLASS[variant]} px-3 py-1.5 flex items-center gap-3`}>
      <svg
        className="ln-mode-banner__icon w-5 h-5 flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
      </svg>

      <span className="text-xs font-semibold ln-text whitespace-nowrap">{title}</span>
      <span className="text-xs ln-text-muted">·</span>
      <span className="text-xs ln-text-muted truncate">{subtitle}</span>

      <div className="flex items-center gap-2 ml-auto flex-shrink-0">
        {extraControls}
        {extraControls && onSaveAsBookmark && !saving && (
          <div className="w-px h-4 ln-divider" />
        )}
        {onSaveAsBookmark && !saving && (
          <Tooltip content="Save as a named bookmark">
            <button
              onClick={() => setSaving(true)}
              className="ln-mode-banner__link"
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
              onKeyDown={e => { if (e.key === 'Enter') handleConfirmSave(); if (e.key === 'Escape') { setSaving(false); setSaveName(''); } }}
              placeholder="Bookmark name..."
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
              className="ln-mode-banner__btn-sm ln-btn-primary"
            >
              Save
            </button>
            <button
              onClick={() => { setSaving(false); setSaveName(''); }}
              className="ln-mode-banner__btn-sm ln-btn-secondary"
            >
              Cancel
            </button>
          </div>
        )}
        <Tooltip content="Close">
          <button onClick={onClose} className="ln-mode-banner__close">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </Tooltip>
      </div>
    </div>
  );
});
