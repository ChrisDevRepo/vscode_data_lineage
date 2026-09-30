import { memo } from 'react';
import type { FilterProfile } from '../engine/projectStore';
import { BOOKMARK_SOURCE_COLORS, BOOKMARK_SOURCE_LABELS } from '../engine/shared/bridgeContract';
import { ModeBanner } from './ModeBanner';
import { ColumnViewToggle } from './ColumnViewToggle';

interface BookmarkBannerProps {
  /** The saved view profile being displayed. */
  profile: FilterProfile;
  /** Number of nodes currently visible in the graph (after applying in-bookmark filters). */
  shownCount: number;
  /** Total number of nodes defined in the bookmark's allowlist. */
  totalCount: number;
  /** Callback triggered when the user chooses to exit the bookmarked view. */
  onExit: () => void;
  /** Whether the run recorded column-level findings, which is what the column view renders. */
  columnViewAvailable?: boolean;
  /** Whether the column view is the one currently rendered. */
  columnView?: boolean;
  /** Switches between the object view and the column view of the same scope. */
  onToggleColumnView?: (columnView: boolean) => void;
}

/** Local aliases; the contract owns the values. */
const SOURCE_LABELS = BOOKMARK_SOURCE_LABELS;
const SOURCE_COLORS = BOOKMARK_SOURCE_COLORS;

/** SVG path for the bookmark icon. */
const BOOKMARK_ICON = 'M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z';

/**
 * Configures {@link ModeBanner} for an active "Advanced Bookmark" (an allowlist-based view).
 */
export const BookmarkBanner = memo(function BookmarkBanner({
  profile,
  shownCount,
  totalCount,
  onExit,
  columnViewAvailable,
  columnView,
  onToggleColumnView,
}: BookmarkBannerProps) {
  const source = profile.source ?? 'user';
  const label = SOURCE_LABELS[source];
  const chipColor = SOURCE_COLORS[source];

  const viewToggle = columnViewAvailable && onToggleColumnView ? (
    <ColumnViewToggle active={columnView} onToggle={onToggleColumnView} />
  ) : null;

  return (
    <ModeBanner
      variant="bookmark"
      icon={BOOKMARK_ICON}
      title={profile.name}
      subtitle={
        <>
          <span
            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-sm"
            style={{ border: `1px solid ${chipColor}`, color: chipColor }}
          >
            {label}
          </span>
          {' '}
          {shownCount === totalCount ? `${totalCount} objects` : `${shownCount} of ${totalCount} objects`}
        </>
      }
      onClose={onExit}
      extraControls={viewToggle}
    />
  );
});
