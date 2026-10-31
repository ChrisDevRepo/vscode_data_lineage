import type { TraceState } from './types';

/** UI mode policy inputs derived by the app shell. */
export interface ModeCapabilityInput {
  traceMode: TraceState['mode'];
  /** Whether a graph analysis result currently owns the scoped surface. */
  hasAnalysisMode: boolean;
  /** Whether an AI-authored preview currently owns the scoped surface. */
  hasAiPreview: boolean;
  /** Whether a saved allowlist-backed view currently owns the scoped surface. */
  hasAdvancedView: boolean;
}

/** UI permissions per graph interaction mode, computed by deriveModeCapabilities. */
export interface ModeCapabilities {
  /** Whether any scoped mode is active and should lock conflicting controls. */
  isModeLocked: boolean;
  /** Whether the interactive-trace hook's traced subset (not the raw base graph) should render. */
  isTraceActive: boolean;
  /**
   * Whether the Delete key adds the highlighted node to the exclusion filters (plain graph only).
   */
  canExcludeHighlightedNode: boolean;
  canRemoveNodeFromScopedView: boolean;
  canEditTraceScope: boolean;
  canStartNewScopedMode: boolean;
  canSwitchGraphMode: boolean;
}

/** Derives graph UI capabilities from the currently active scoped mode. */
export function deriveModeCapabilities(
  input: ModeCapabilityInput,
): ModeCapabilities {
  const isTraceView =
    input.traceMode === 'applied' || input.traceMode === 'filtered';
  const isPathView = input.traceMode === 'path-applied';
  const hasTraceMode =
    isTraceView ||
    isPathView ||
    input.traceMode === 'configuring' ||
    input.traceMode === 'pathfinding';
  const isCuratedView = input.hasAiPreview || input.hasAdvancedView;
  const isTraceActive =
    isTraceView || isPathView || input.traceMode === 'analysis';

  const hasScopedView =
    hasTraceMode || input.hasAnalysisMode || input.hasAdvancedView;

  return {
    isModeLocked: hasScopedView,
    isTraceActive,
    canExcludeHighlightedNode: !hasScopedView && !input.hasAiPreview,
    canRemoveNodeFromScopedView:
      isCuratedView && !input.hasAnalysisMode && !hasTraceMode,
    canEditTraceScope: isTraceView,
    canStartNewScopedMode: !hasScopedView && !input.hasAiPreview,
    canSwitchGraphMode: !hasScopedView && !input.hasAiPreview,
  };
}

/** The action Delete performs, per {@link ModeCapabilities}. */
export type RemoveAction =
  | { kind: 'exclude' }
  | { kind: 'trace-prune' }
  | { kind: 'curated-remove' }
  | { kind: 'refuse'; reason: string };

/** Resolves what Delete does for the highlighted node in the current mode. */
export function resolveRemoveAction(
  capabilities: Pick<
    ModeCapabilities,
    'isModeLocked' | 'canEditTraceScope' | 'canRemoveNodeFromScopedView'
  >,
  context: { hasAnalysisMode: boolean; isTraceOrigin: boolean },
): RemoveAction {
  if (capabilities.canEditTraceScope) {
    if (context.isTraceOrigin)
      return {
        kind: 'refuse',
        reason: 'This is the trace source — it cannot be removed',
      };
    return { kind: 'trace-prune' };
  }
  if (capabilities.canRemoveNodeFromScopedView)
    return { kind: 'curated-remove' };
  if (!capabilities.isModeLocked) return { kind: 'exclude' };
  if (context.hasAnalysisMode)
    return {
      kind: 'refuse',
      reason: 'Exit analysis to remove nodes from the view',
    };
  return { kind: 'refuse', reason: 'Nothing can be removed from this view' };
}
