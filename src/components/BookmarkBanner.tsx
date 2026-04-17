import { memo } from 'react';
import type { FilterProfile } from '../engine/projectStore';
import { Tooltip } from './ui/Tooltip';

/**
 * Props for the `BookmarkBanner` component.
 */
interface BookmarkBannerProps {
  /** The saved view profile being displayed. */
  profile: FilterProfile;
  /** Number of nodes currently visible in the graph (after applying in-bookmark filters). */
  shownCount: number;
  /** Total number of nodes defined in the bookmark's allowlist. */
  totalCount: number;
  /** Callback triggered when the user chooses to exit the bookmarked view. */
  onExit: () => void;
}

/** 
 * Human-readable labels for the different sources of bookmarked views.
 */
const SOURCE_LABELS: Record<NonNullable<FilterProfile['source']>, string> = {
  ai: 'AI',
  trace: 'Trace',
  analysis: 'Analysis',
  user: 'View',
};

/** 
 * Border and text colors corresponding to different bookmark sources.
 */
const SOURCE_COLORS: Record<NonNullable<FilterProfile['source']>, string> = {
  ai: 'var(--ln-analysis-border)',
  trace: 'var(--ln-warning-border)',
  analysis: 'var(--ln-analysis-border)',
  user: 'var(--ln-border)',
};

/**
 * A persistent banner displayed at the top of the graph canvas when an "Advanced Bookmark"
 * (an allowlist-based view) is active.
 * 
 * @remarks
 * This banner provides visual confirmation that the user is in a "locked" view mode
 * and provides a clear exit path to return to the global graph exploration.
 * 
 * @param props - The component props.
 */
export const BookmarkBanner = memo(function BookmarkBanner({
  profile,
  shownCount,
  totalCount,
  onExit,
}: BookmarkBannerProps) {
  const source = profile.source ?? 'user';
  const label = SOURCE_LABELS[source];
  const chipColor = SOURCE_COLORS[source];

  return (
    <div className="ln-bookmark-banner px-4 py-2 flex items-center justify-between">
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
          style={{
            border: `1px solid ${chipColor}`,
            color: chipColor,
          }}
        >
          {label}
        </span>
        <Tooltip content={profile.name}>
          <span className="text-sm font-semibold ln-text truncate">
            {profile.name}
          </span>
        </Tooltip>
        <span className="text-xs ln-text-muted flex-shrink-0">
          — {shownCount === totalCount ? `${totalCount} objects` : `${shownCount} of ${totalCount} objects`}
        </span>
      </div>

      <button
        onClick={onExit}
        className="h-7 px-3 text-xs rounded font-medium transition-colors ln-btn-secondary flex-shrink-0 ml-3"
      >
        ✕ Exit View
      </button>
    </div>
  );
});
