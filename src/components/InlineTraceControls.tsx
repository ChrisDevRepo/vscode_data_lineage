import { memo, useState } from 'react';
import { CloseIcon } from './ui/CloseIcon';
import { Tooltip } from './ui/Tooltip';

/**
 * Props for the {@link InlineTraceControls} component.
 */
interface InlineTraceControlsProps {
  /** ID of the node starting the trace. */
  startNodeId: string;
  /** Display name of the start node. */
  startNodeName: string;
  /** Initial upstream depth to show in the input. */
  defaultUpstream?: number;
  /** Initial downstream depth to show in the input. */
  defaultDownstream?: number;
  /** Callback fired when the user applies the trace configuration. */
  onApply: (config: {
    startNodeId: string;
    upstreamLevels: number;
    downstreamLevels: number;
  }) => void;
  /** Callback fired to cancel the trace configuration. */
  onClose: () => void;
}

/** Numeric depth input paired with an exhaustive-depth toggle. */
function DepthInput({
  label,
  value,
  isAll,
  onChange,
  onToggleAll,
}: {
  label: string;
  value: number;
  isAll: boolean;
  onChange: (value: number) => void;
  onToggleAll: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium ln-text">{label}:</span>
      <input
        type="number"
        min="0"
        max="99"
        value={value}
        onChange={(event) => onChange(parseInt(event.target.value) || 0)}
        disabled={isAll}
        className="w-16 h-9 px-2 text-sm text-center rounded-sm transition-colors focus:outline-hidden disabled:opacity-50 ln-input"
      />
      <button
        onClick={onToggleAll}
        className={`h-9 px-3 rounded-sm text-sm font-medium transition-colors ${isAll ? 'ln-btn-primary' : 'ln-btn-secondary'}`}
      >
        All
      </button>
    </div>
  );
}

/**
 * A configuration bar for setting up a lineage trace.
 * 
 * It appears when a user initiates a trace but before the BFS is executed.
 * Users can specify numerical depths for upstream and downstream traversal
 * or select "All" for an exhaustive trace.
 * 
 * @param props - The component props.
 * @returns A memoized React component.
 */
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
      <div className="flex items-center gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium ln-text">From:</span>
          <span className="text-sm font-semibold ln-text-link">{startNodeName}</span>
        </div>

        <DepthInput
          label="Upstream"
          value={upstream}
          isAll={isUpstreamAll}
          onChange={(value) => { setUpstream(value); setIsUpstreamAll(false); }}
          onToggleAll={() => setIsUpstreamAll(!isUpstreamAll)}
        />

        <DepthInput
          label="Downstream"
          value={downstream}
          isAll={isDownstreamAll}
          onChange={(value) => { setDownstream(value); setIsDownstreamAll(false); }}
          onToggleAll={() => setIsDownstreamAll(!isDownstreamAll)}
        />
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={handleApply}
          className="h-9 px-4 rounded-sm text-sm font-medium transition-colors ln-btn-primary"
        >
          Apply
        </button>
        <Tooltip content="Close Trace Configuration">
          <button
            onClick={onClose}
            className="h-8 w-8 flex items-center justify-center rounded-sm transition-colors ln-btn-secondary"
          >
            <CloseIcon />
          </button>
        </Tooltip>
      </div>
    </div>
  );
});
