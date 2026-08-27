import { memo } from 'react';
import { ModeBanner } from './ModeBanner';
import { Tooltip } from './ui/Tooltip';

interface AiViewBannerProps {
  /** The name or title of the AI-generated view. */
  name: string;
  /** Total number of objects currently visible in the AI preview. */
  nodeCount: number;
  /** Callback triggered when the user chooses to discard the AI preview. */
  onDiscard: () => void;
  /**
   * Callback triggered when the user chooses to save the current AI view as a permanent bookmark.
   * @param name - The name for the new bookmark.
   * @param withPositions - Whether to save the current visual positions of nodes.
   */
  onSaveAsBookmark?: (name: string, withPositions: boolean) => void;
  /**
   * Whether the run recorded column-level findings, which is what the column view renders.
   *
   * @remarks
   * The switch is offered only when it has something to show; a run without column findings
   * keeps the object view as its only view.
   */
  columnViewAvailable?: boolean;
  /** Whether the column view is the one currently rendered. */
  columnView?: boolean;
  /** Switches between the object view and the column view of the same scope. */
  onToggleColumnView?: (columnView: boolean) => void;
}

/** SVG path for the AI/Sparkle icon. */
const AI_ICON = 'M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z';

/**
 * Configures {@link ModeBanner} for an AI-curated graph preview.
 */
export const AiViewBanner = memo(function AiViewBanner({
  name,
  nodeCount,
  onDiscard,
  onSaveAsBookmark,
  columnViewAvailable,
  columnView,
  onToggleColumnView,
}: AiViewBannerProps) {
  const viewToggle = columnViewAvailable && onToggleColumnView ? (
    <Tooltip content={'Objects shows dependencies between objects.\nColumns shows the column-level findings of this analysis.'} placement="bottom" multiline>
      <div className="flex items-center gap-0.5" role="group" aria-label="Preview detail level">
        <button
          onClick={() => onToggleColumnView(false)}
          aria-pressed={!columnView}
          className={`ln-mode-banner__btn-sm ${columnView ? 'ln-btn-secondary' : 'ln-btn-primary'}`}
        >
          Objects
        </button>
        <button
          onClick={() => onToggleColumnView(true)}
          aria-pressed={!!columnView}
          className={`ln-mode-banner__btn-sm ${columnView ? 'ln-btn-primary' : 'ln-btn-secondary'}`}
        >
          Columns
        </button>
      </div>
    </Tooltip>
  ) : null;

  return (
    <ModeBanner
      variant="ai"
      icon={AI_ICON}
      title="AI Preview"
      subtitle={
        <>
          <span className="font-bold">{nodeCount} objects</span>
          {' — '}
          <span className="font-mono font-semibold">"{name}"</span>
        </>
      }
      onClose={onDiscard}
      onSaveAsBookmark={onSaveAsBookmark}
      extraControls={viewToggle}
    />
  );
});
