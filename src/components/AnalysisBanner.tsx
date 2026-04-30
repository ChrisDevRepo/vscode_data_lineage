import { memo } from 'react';
import type { AnalysisMode } from '../engine/types';
import { ANALYSIS_TYPE_INFO, ANALYSIS_TYPE_LABELS } from '../utils/analysisInfo';
import { ModeBanner } from './ModeBanner';

/**
 * Props for the `AnalysisBanner` component.
 */
interface AnalysisBannerProps {
  /** The current active analysis state, including the type and calculated result. */
  analysis: AnalysisMode;
  /** Callback triggered when the user chooses to exit the analysis mode. */
  onClose: () => void;
  /** 
   * Optional callback to save the current analysis result as a bookmark.
   * @param name - The name for the bookmark.
   * @param withPositions - Whether to save the current visual positions of nodes.
   */
  onSaveAsBookmark?: (name: string, withPositions: boolean) => void;
}

/**
 * A banner component displayed at the top of the viewport during an active structural analysis.
 * 
 * @remarks
 * This component dynamically renders metadata based on the `analysis.type` (e.g., 'Islands', 'Hubs', 'Cycles').
 * It provides context on what the user is currently seeing, such as the active group name
 * and the number of nodes affected.
 * 
 * @param props - The component props.
 */
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
