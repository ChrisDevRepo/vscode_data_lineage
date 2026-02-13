import { memo } from 'react';
import type { AnalysisMode, AnalysisType } from '../engine/types';

interface AnalysisBannerProps {
  analysis: AnalysisMode;
  onClose: () => void;
}

const TYPE_LABELS: Record<AnalysisType, string> = {
  islands: 'Islands Analysis',
  hubs: 'Hubs Analysis',
  orphans: 'Orphan Nodes Analysis',
};

const TYPE_ICONS: Record<AnalysisType, string> = {
  islands: 'M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5',
  hubs: 'M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z',
  orphans: 'M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636',
};

export const AnalysisBanner = memo(function AnalysisBanner({
  analysis,
  onClose,
}: AnalysisBannerProps) {
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
            d={TYPE_ICONS[type]}
          />
        </svg>

        <div className="flex flex-col">
          <div className="text-sm font-semibold ln-text">
            {TYPE_LABELS[type]}
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
