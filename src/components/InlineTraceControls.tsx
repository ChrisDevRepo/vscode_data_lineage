import { memo, useState } from 'react';

interface InlineTraceControlsProps {
  startNodeId: string;
  startNodeName: string;
  defaultUpstream?: number;
  defaultDownstream?: number;
  onApply: (config: {
    startNodeId: string;
    upstreamLevels: number;
    downstreamLevels: number;
  }) => void;
  onClose: () => void;
}

export const InlineTraceControls = memo(function InlineTraceControls({
  startNodeId,
  startNodeName,
  defaultUpstream = 3,
  defaultDownstream = 3,
  onApply,
  onClose,
}: InlineTraceControlsProps) {
  const [upstream, setUpstream] = useState(defaultUpstream);
  const [isUpstreamAll, setIsUpstreamAll] = useState(false);
  const [downstream, setDownstream] = useState(defaultDownstream);
  const [isDownstreamAll, setIsDownstreamAll] = useState(false);

  const handleApply = () => {
    onApply({
      startNodeId,
      upstreamLevels: isUpstreamAll ? Number.MAX_SAFE_INTEGER : upstream,
      downstreamLevels: isDownstreamAll ? Number.MAX_SAFE_INTEGER : downstream,
    });
  };

  return (
    <div className="ln-trace-config flex items-center justify-between gap-4 px-4 py-2.5">
      <div className="flex items-center gap-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium ln-text">From:</span>
          <span className="text-sm font-semibold ln-text-link">{startNodeName}</span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm font-medium ln-text">Upstream:</span>
          <input
            type="number"
            min="0"
            max="99"
            value={upstream}
            onChange={(e) => {
              setUpstream(parseInt(e.target.value) || 0);
              setIsUpstreamAll(false);
            }}
            disabled={isUpstreamAll}
            className="w-16 h-9 px-2 text-sm text-center rounded transition-colors focus:outline-none disabled:opacity-50 ln-input"
          />
          <button
            onClick={() => setIsUpstreamAll(!isUpstreamAll)}
            className={`h-9 px-3 rounded text-sm font-medium transition-colors ${isUpstreamAll ? 'ln-btn-primary' : 'ln-btn-secondary'}`}
          >
            All
          </button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm font-medium ln-text">Downstream:</span>
          <input
            type="number"
            min="0"
            max="99"
            value={downstream}
            onChange={(e) => {
              setDownstream(parseInt(e.target.value) || 0);
              setIsDownstreamAll(false);
            }}
            disabled={isDownstreamAll}
            className="w-16 h-9 px-2 text-sm text-center rounded transition-colors focus:outline-none disabled:opacity-50 ln-input"
          />
          <button
            onClick={() => setIsDownstreamAll(!isDownstreamAll)}
            className={`h-9 px-3 rounded text-sm font-medium transition-colors ${isDownstreamAll ? 'ln-btn-primary' : 'ln-btn-secondary'}`}
          >
            All
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={handleApply}
          className="h-9 px-4 rounded text-sm font-medium transition-colors ln-btn-primary"
        >
          Apply
        </button>
        <button
          onClick={onClose}
          className="h-8 w-8 flex items-center justify-center rounded transition-colors ln-btn-secondary"
          title="Close Trace Configuration"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
});
