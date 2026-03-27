import { memo } from 'react';
import type { FilterProfile } from '../engine/projectStore';

interface BookmarkBannerProps {
  profile: FilterProfile;
  /** Number of nodes currently shown (after in-bookmark filters). */
  shownCount: number;
  /** Total nodes in the allowlist. */
  totalCount: number;
  onExit: () => void;
}

const SOURCE_LABELS: Record<NonNullable<FilterProfile['source']>, string> = {
  ai: 'AI',
  trace: 'Trace',
  analysis: 'Analysis',
  user: 'View',
};

const SOURCE_COLORS: Record<NonNullable<FilterProfile['source']>, string> = {
  ai: 'var(--ln-analysis-border)',
  trace: 'var(--ln-warning-border)',
  analysis: 'var(--ln-analysis-border)',
  user: 'var(--ln-border)',
};

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
        <span className="text-sm font-semibold ln-text truncate" title={profile.name}>
          {profile.name}
        </span>
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
