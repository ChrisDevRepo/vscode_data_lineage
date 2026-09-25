import { memo, useState } from 'react';
import { CloseIcon } from './ui/CloseIcon';
import { Tooltip } from './ui/Tooltip';
import { TRACE_ALL_LEVELS } from '../engine/shared/bridgeContract';

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
  /** BFS-only probe for the object count the current upstream/downstream choice would produce — "count before the click". Omitted when the caller cannot resolve a graph yet. */
  estimateCount?: (upstreamLevels: number, downstreamLevels: number) => number;
  /** Render limit the count is checked against for the "over limit" hint; the choice stays clickable regardless — the render-limit notice handles it once applied. */
  renderLimit?: number;
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
        aria-label={`${label} levels`}
        className="w-16 h-9 px-2 text-sm text-center rounded-sm transition-colors focus:outline-hidden disabled:opacity-50 ln-input"
      />
      <button
        onClick={onToggleAll}
        aria-label={`All ${label.toLowerCase()} levels`}
        aria-pressed={isAll}
        className={`h-9 px-3 rounded-sm text-sm font-medium transition-colors ${isAll ? 'ln-btn-primary' : 'ln-btn-secondary'}`}
      >
        All
      </button>
    </div>
  );
}

/** A configuration bar for setting up a lineage trace, shown before the BFS is executed. */
export const InlineTraceControls = memo(function InlineTraceControls({
  startNodeId,
  startNodeName,
  defaultUpstream = 3,
  defaultDownstream = 3,
  onApply,
  onClose,
  estimateCount,
  renderLimit,
}: InlineTraceControlsProps) {
  const [upstream, setUpstream] = useState(defaultUpstream);
  const [isUpstreamAll, setIsUpstreamAll] = useState(false);
  const [downstream, setDownstream] = useState(defaultDownstream);
  const [isDownstreamAll, setIsDownstreamAll] = useState(false);

  const effectiveUpstream = isUpstreamAll ? TRACE_ALL_LEVELS : upstream;
  const effectiveDownstream = isDownstreamAll ? TRACE_ALL_LEVELS : downstream;
  const previewCount = estimateCount?.(effectiveUpstream, effectiveDownstream);
  const overLimit = previewCount !== undefined && renderLimit !== undefined && previewCount > renderLimit;

  const handleApply = () => {
    onApply({ startNodeId, upstreamLevels: effectiveUpstream, downstreamLevels: effectiveDownstream });
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
        {previewCount !== undefined && (
          <span className={`text-xs whitespace-nowrap ${overLimit ? 'ln-text-warning' : 'ln-text-muted'}`}>
            {previewCount.toLocaleString()} objects{overLimit ? ' — over limit' : ''}
          </span>
        )}
        <button
          onClick={handleApply}
          className="h-9 px-4 rounded-sm text-sm font-medium transition-colors ln-btn-primary"
        >
          Apply
        </button>
        <Tooltip content="Close Trace Configuration">
          <button
            aria-label="Close Trace Configuration"
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
