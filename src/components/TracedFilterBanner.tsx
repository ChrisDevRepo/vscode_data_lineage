import { memo } from 'react';

interface TracedFilterBannerProps {
  startNodeName: string;
  upstreamLevels: number;
  downstreamLevels: number;
  totalNodes: number;
  totalEdges: number;
  mode: 'applied' | 'filtered';
  onEnd?: () => void;
  onReset: () => void;
}

export const TracedFilterBanner = memo(function TracedFilterBanner({
  startNodeName,
  upstreamLevels,
  downstreamLevels,
  totalNodes,
  totalEdges,
  mode,
  onEnd,
  onReset,
}: TracedFilterBannerProps) {
  const formatLevels = (levels: number) => {
    return levels === Number.MAX_SAFE_INTEGER ? 'All' : levels.toString();
  };

  return (
    <div className="ln-trace-banner px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <svg
          className="w-5 h-5 flex-shrink-0 ln-text-warning"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917-3.286-.672Zm-7.518-.267A8.25 8.25 0 1 1 20.25 10.5M8.288 14.212A5.25 5.25 0 1 1 17.25 10.5"
          />
        </svg>

        <div className="flex flex-col">
          <div className="text-sm font-semibold ln-text">
            {mode === 'applied' ? 'Tracing' : 'Trace Filter Active'}
          </div>
          <div className="text-xs ln-text-muted">
            {mode === 'applied' ? (
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
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={mode === 'applied' && onEnd ? onEnd : onReset}
          className="h-8 px-3 text-xs rounded font-medium transition-colors ln-btn-secondary"
        >
          {mode === 'applied' ? 'End Trace' : 'Clear Trace'}
        </button>
      </div>
    </div>
  );
});
