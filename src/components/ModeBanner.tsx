import {
  memo,
  useState,
  useRef,
  useEffect,
  type ReactNode,
  type ReactElement,
} from 'react';
import { CloseIcon } from './ui/CloseIcon';
import { Tooltip } from './ui/Tooltip';

/** Visual variants of {@link ModeBanner}. */
type BannerVariant = 'trace' | 'analysis' | 'ai' | 'bookmark';

interface ModeBannerProps {
  variant: BannerVariant;
  /** SVG path data for the leading icon. */
  icon: string;
  title: string;
  subtitle: ReactNode;
  onClose: () => void;
  onSaveAsBookmark?: (name: string) => void;
  /** Extra controls rendered in the action area (before Save as Bookmark). */
  extraControls?: ReactElement | null;
}

const VARIANT_CLASS: Record<BannerVariant, string> = {
  trace: 'ln-mode-banner--trace',
  analysis: 'ln-mode-banner--analysis',
  ai: 'ln-mode-banner--ai',
  bookmark: 'ln-mode-banner--bookmark',
};

/** A shared UI component for displaying the active graph mode (Trace, Analysis, AI). */
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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (saving) inputRef.current?.focus();
  }, [saving]);

  function handleConfirmSave() {
    const name = saveName.trim();
    if (!name) return;
    onSaveAsBookmark?.(name);
    setSaving(false);
    setSaveName('');
  }

  return (
    <div
      className={`ln-mode-banner ${VARIANT_CLASS[variant]} px-3 py-1.5 flex items-center gap-3`}
    >
      <svg
        className="ln-mode-banner__icon w-5 h-5 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
      </svg>

      <span className="text-xs font-semibold ln-text whitespace-nowrap">
        {title}
      </span>
      <span className="text-xs ln-text-muted">·</span>
      <span className="text-xs ln-text-muted truncate">{subtitle}</span>

      <div className="flex items-center gap-2 ml-auto shrink-0">
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
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmSave();
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setSaving(false);
                  setSaveName('');
                }
              }}
              placeholder="Bookmark name..."
              className="h-7 px-2 text-xs rounded-sm ln-input w-[140px]"
            />
            <button
              onClick={handleConfirmSave}
              disabled={!saveName.trim()}
              className="ln-mode-banner__btn-sm ln-btn-primary"
            >
              Save
            </button>
            <button
              onClick={() => {
                setSaving(false);
                setSaveName('');
              }}
              className="ln-mode-banner__btn-sm ln-btn-secondary"
            >
              Cancel
            </button>
          </div>
        )}
        <Tooltip content="Close">
          <button
            onClick={() => onClose()}
            className="ln-mode-banner__close"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </Tooltip>
      </div>
    </div>
  );
});
