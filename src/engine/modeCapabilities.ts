import type { TraceState } from './types';

/**
 * UI mode policy inputs derived by the app shell.
 */
export interface ModeCapabilityInput {
  /** Current trace state mode from the graph session. */
  traceMode: TraceState['mode'];
  /** Whether a graph analysis result currently owns the scoped surface. */
  hasAnalysisMode: boolean;
  /** Whether an AI-authored preview currently owns the scoped surface. */
  hasAiPreview: boolean;
  /** Whether a saved allowlist-backed view currently owns the scoped surface. */
  hasAdvancedView: boolean;
}

/**
 * Centralized UI permissions for graph interaction modes.
 */
export interface ModeCapabilities {
  /** Whether any scoped mode is active and should lock conflicting controls. */
  isModeLocked: boolean;
  /** Whether the highlighted node can be added to durable exclusion filters. */
  canExcludeHighlightedNode: boolean;
  /** Whether a node can be removed from the current allowlist-backed view. */
  canRemoveNodeFromScopedView: boolean;
  /** Whether direct-neighbor add/prune controls are enabled for the trace. */
  canEditTraceScope: boolean;
  /** Whether a new trace, analysis, or saved scoped mode may be started. */
  canStartNewScopedMode: boolean;
  /** Whether the user may switch between Object View and Schema View. */
  canSwitchGraphMode: boolean;
}

/**
 * Derives graph UI capabilities from the currently active scoped mode.
 *
 * Keep this as the single source of truth for mode-specific control gating.
 */
export function deriveModeCapabilities(input: ModeCapabilityInput): ModeCapabilities {
  const isTraceView = input.traceMode === 'applied' || input.traceMode === 'filtered';
  const isPathView = input.traceMode === 'path-applied';
  const hasTraceMode = isTraceView || isPathView || input.traceMode === 'configuring' || input.traceMode === 'pathfinding';
  const hasScopedView = hasTraceMode || input.hasAnalysisMode || input.hasAiPreview || input.hasAdvancedView;
  const isCuratedView = input.hasAiPreview || input.hasAdvancedView;

  return {
    isModeLocked: hasScopedView,
    canExcludeHighlightedNode: !hasScopedView,
    canRemoveNodeFromScopedView: isCuratedView && !input.hasAnalysisMode && !hasTraceMode,
    canEditTraceScope: isTraceView,
    canStartNewScopedMode: !hasScopedView,
    canSwitchGraphMode: !hasScopedView,
  };
}
