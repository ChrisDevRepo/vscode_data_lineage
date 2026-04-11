import { memo } from 'react';
import { ModeBanner } from './ModeBanner';
import { Tooltip } from './ui/Tooltip';

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
  useFullModel: boolean;
  onToggleFullModel: () => void;
  filteredOutCount: number;
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
  useFullModel,
  onToggleFullModel,
  filteredOutCount,
}: TracedFilterBannerProps) {
  const formatLevels = (levels: number) =>
    levels === Number.MAX_SAFE_INTEGER ? 'All' : levels.toString();

  const filteredHint = !useFullModel && filteredOutCount > 0
    ? <span className="ln-text-muted"> (+{filteredOutCount} filtered)</span>
    : null;

  const subtitle = mode === 'applied' ? (
    <>
      <span className="font-bold">{totalNodes} nodes · {totalEdges} edges</span>
      {filteredHint}
      {' '}from <span className="font-mono font-semibold">"{startNodeName}"</span>
    </>
  ) : (
    <>
      Showing <span className="font-bold">{totalNodes} nodes</span>
      {filteredHint}
      {' '}from <span className="font-mono font-semibold">"{startNodeName}"</span>
      {' '}({formatLevels(upstreamLevels)} levels up / {formatLevels(downstreamLevels)} levels down)
    </>
  );

  const filterToggle = (
    <Tooltip content="When enabled, trace ignores schema/type filters and shows all dependencies">
      <label className="flex items-center gap-1 text-xs ln-text-muted cursor-pointer select-none whitespace-nowrap">
        <input
          type="checkbox"
          checked={useFullModel}
          onChange={onToggleFullModel}
          className="ln-checkbox"
        />
        Include filtered
      </label>
    </Tooltip>
  );

  return (
    <ModeBanner
      variant="trace"
      icon={TRACE_ICON}
      title={mode === 'applied' ? 'Tracing' : 'Trace Filter Active'}
      subtitle={subtitle}
      onClose={mode === 'applied' && onEnd ? onEnd : onReset}
      onSaveAsBookmark={onSaveAsBookmark}
      extraControls={filterToggle}
    />
  );
});
