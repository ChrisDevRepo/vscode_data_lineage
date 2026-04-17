import React, { memo } from 'react';
import { ModeBanner } from './ModeBanner';
import { Tooltip } from './ui/Tooltip';

/**
 * Props for the {@link TracedFilterBanner} component.
 */
interface TracedFilterBannerProps {
  /** The display name of the starting node for the lineage trace. */
  startNodeName: string;
  /** The number of levels to traverse upstream (parents). */
  upstreamLevels: number;
  /** The number of levels to traverse downstream (children). */
  downstreamLevels: number;
  /** Total number of nodes currently visible in the traced graph. */
  totalNodes: number;
  /** Total number of edges currently visible in the traced graph. */
  totalEdges: number;
  /** 
   * The current trace mode:
   * - 'applied': The trace is actively being calculated or shown as a temporary view.
   * - 'filtered': The trace is acting as a persistent filter on the global graph.
   */
  mode: 'applied' | 'filtered';
  /** Optional callback to end the tracing mode. */
  onEnd?: () => void;
  /** Callback to reset/clear the trace filter. */
  onReset: () => void;
  /** Optional callback to save the current traced view as a persistent bookmark. */
  onSaveAsBookmark?: (name: string, withPositions: boolean) => void;
  /** Whether the trace should ignore existing schema/type filters and use the full model. */
  useFullModel: boolean;
  /** Callback triggered when the "Include filtered" checkbox is toggled. */
  onToggleFullModel: () => void;
  /** The number of nodes that are hidden due to active schema/type filters. */
  filteredOutCount: number;
}

/** SVG path for the trace/lineage icon. */
const TRACE_ICON = 'M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917-3.286-.672Zm-7.518-.267A8.25 8.25 0 1 1 20.25 10.5M8.288 14.212A5.25 5.25 0 1 1 17.25 10.5';

/**
 * A specialized banner component that provides status and controls for an active lineage trace.
 *
 * @remarks
 * This component is memoized and wraps the generic {@link ModeBanner}.
 * it displays the trace starting point, traversal depth, and counts of visible vs. filtered nodes.
 * It also provides a toggle to include nodes that would otherwise be filtered out by global schema/type settings.
 *
 * @param props - The component properties.
 * @returns A {@link React.JSX.Element} representing the trace status banner.
 */
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
  /**
   * Formats the level depth for display.
   * 
   * @param levels - The depth number or MAX_SAFE_INTEGER for 'All'.
   * @returns A string representation of the depth.
   */
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
