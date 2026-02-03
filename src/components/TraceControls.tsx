import { memo } from 'react';
import type { TraceState } from '../engine/types';

interface TraceControlsProps {
  trace: TraceState;
  onEnd: () => void;
}

export const TraceControls = memo(function TraceControls({
  trace,
  onEnd,
}: TraceControlsProps) {
  // Only show during 'applied' mode (after Apply button clicked, before End Trace)
  if (trace.mode !== 'applied') return null;

  return (
    <div
      className="absolute top-4 left-1/2 -translate-x-1/2 backdrop-blur-sm rounded-lg px-4 py-2 shadow-md z-10 flex items-center gap-3"
      style={{ background: 'color-mix(in srgb, var(--ln-bg) 95%, transparent)', border: '1px solid var(--ln-focus-border)' }}
    >
      <span className="text-sm" style={{ color: 'var(--ln-fg-muted)' }}>
        Tracing <span className="font-semibold" style={{ color: 'var(--ln-focus-border)' }}>{trace.selectedNodeId?.replace(/\[|\]/g, '')}</span>
      </span>

      <span className="text-xs" style={{ color: 'var(--ln-fg-dim)' }}>
        {trace.tracedNodeIds.size} nodes · {trace.tracedEdgeIds.size} edges
      </span>

      <button
        onClick={onEnd}
        className="px-3 py-1 text-xs rounded-md transition-colors"
        style={{
          background: 'var(--vscode-button-secondaryBackground)',
          color: 'var(--vscode-button-secondaryForeground)',
        }}
        title="End trace and return to full graph"
      >
        End Trace
      </button>
    </div>
  );
});
