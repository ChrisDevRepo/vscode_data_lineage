import { memo } from 'react';
import { ModeBanner } from './ModeBanner';

interface TracedFilterBannerProps {
  startNodeName: string;
  upstreamLevels: number;
  downstreamLevels: number;
  totalNodes: number;
  totalEdges: number;
  mode: 'applied' | 'filtered';
  onEnd?: () => void;
  onReset: () => void;
  onSaveAsBookmark?: (name: string, withPositions: boolean) => void;
}

const TRACE_ICON = 'M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917-3.286-.672Zm-7.518-.267A8.25 8.25 0 1 1 20.25 10.5M8.288 14.212A5.25 5.25 0 1 1 17.25 10.5';

export const TracedFilterBanner = memo(function TracedFilterBanner({
  startNodeName,
  upstreamLevels,
  downstreamLevels,
  totalNodes,
  totalEdges,
  mode,
  onEnd,
  onReset,
  onSaveAsBookmark,
}: TracedFilterBannerProps) {
  const formatLevels = (levels: number) =>
    levels === Number.MAX_SAFE_INTEGER ? 'All' : levels.toString();

  const subtitle = mode === 'applied' ? (
    <>
      <span className="font-bold">{totalNodes} nodes · {totalEdges} edges</span> from{' '}
      <span className="font-mono font-semibold">"{startNodeName}"</span>
    </>
  ) : (
    <>
      Showing <span className="font-bold">{totalNodes} nodes</span> from{' '}
      <span className="font-mono font-semibold">"{startNodeName}"</span>
      {' '}({formatLevels(upstreamLevels)} levels up / {formatLevels(downstreamLevels)} levels down)
    </>
  );

  return (
    <ModeBanner
      variant="trace"
      icon={TRACE_ICON}
      title={mode === 'applied' ? 'Tracing' : 'Trace Filter Active'}
      subtitle={subtitle}
      onClose={mode === 'applied' && onEnd ? onEnd : onReset}
      onSaveAsBookmark={onSaveAsBookmark}
    />
  );
});
