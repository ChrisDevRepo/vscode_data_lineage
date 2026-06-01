import type { TraceState } from './types';

/**
 * UI mode policy inputs derived by the app shell.
 */
export interface ModeCapabilityInput {
  traceMode: TraceState['mode'];
  hasAnalysisMode: boolean;
  hasAiPreview: boolean;
  hasAdvancedView: boolean;
}

/**
 * Centralized UI permissions for graph interaction modes.
 */
export interface ModeCapabilities {
  isModeLocked: boolean;
  canExcludeHighlightedNode: boolean;
  canRemoveNodeFromScopedView: boolean;
  canEditTraceScope: boolean;
  canStartNewScopedMode: boolean;
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
