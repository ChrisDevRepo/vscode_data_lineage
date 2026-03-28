import { memo } from 'react';
import type { AnalysisMode } from '../engine/types';
import { ANALYSIS_TYPE_INFO, ANALYSIS_TYPE_LABELS } from '../utils/analysisInfo';
import { ModeBanner } from './ModeBanner';

interface AnalysisBannerProps {
  analysis: AnalysisMode;
  onClose: () => void;
  onSaveAsBookmark?: (name: string, withPositions: boolean) => void;
}

export const AnalysisBanner = memo(function AnalysisBanner({
  analysis,
  onClose,
  onSaveAsBookmark,
}: AnalysisBannerProps) {
  const { type, result, activeGroupId } = analysis;
  const activeGroup = activeGroupId
    ? result.groups.find(g => g.id === activeGroupId)
    : null;

  const subtitle = activeGroup ? (
    <>
      Viewing <span className="font-bold">{activeGroup.label}</span>
      {' '}({activeGroup.nodeIds.length} node{activeGroup.nodeIds.length !== 1 ? 's' : ''})
    </>
  ) : (
    result.summary
  );

  return (
    <ModeBanner
      variant="analysis"
      icon={ANALYSIS_TYPE_INFO[type].icon}
      title={ANALYSIS_TYPE_LABELS[type]}
      subtitle={subtitle}
      onClose={onClose}
      onSaveAsBookmark={onSaveAsBookmark}
    />
  );
});
