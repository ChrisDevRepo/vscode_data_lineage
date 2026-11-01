import { memo } from 'react';
import type { FilterProfile } from '../engine/projectStore';
import {
  BOOKMARK_SOURCE_COLORS,
  BOOKMARK_SOURCE_LABELS,
} from '../engine/shared/bridgeContract';
import { ModeBanner } from './ModeBanner';
import { ColumnViewToggle } from './ColumnViewToggle';

interface BookmarkBannerProps {
  profile: FilterProfile;
  shownCount: number;
  totalCount: number;
  onExit: () => void;
  /** Whether the run recorded column-level findings, which is what the column view renders. */
  columnViewAvailable?: boolean;
  columnView?: boolean;
  onToggleColumnView?: (columnView: boolean) => void;
}

const BOOKMARK_ICON =
  'M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z';

/** Configures {@link ModeBanner} for an active "Advanced Bookmark" (an allowlist-based view). */
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
  const label = BOOKMARK_SOURCE_LABELS[source];
  const chipColor = BOOKMARK_SOURCE_COLORS[source];

  const viewToggle =
    columnViewAvailable && onToggleColumnView ? (
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
          </span>{' '}
          {shownCount === totalCount
            ? `${totalCount} objects`
            : `${shownCount} of ${totalCount} objects`}
        </>
      }
      onClose={onExit}
      extraControls={viewToggle}
    />
  );
});
