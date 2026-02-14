import { memo } from 'react';
import type { AnalysisMode } from '../engine/types';
import { ANALYSIS_TYPE_INFO, ANALYSIS_TYPE_LABELS } from '../utils/analysisInfo';

interface AnalysisBannerProps {
  analysis: AnalysisMode;
  onClose: () => void;
}

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
