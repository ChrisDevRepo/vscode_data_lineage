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
 * Centralized UI permissions for graph interaction modes. The app shell computes this once via
 * {@link deriveModeCapabilities} and threads the booleans to toolbar/context-menu/canvas controls
 * so each consumer enables or disables affordances from a single, consistent policy instead of
 * re-deriving ad-hoc conditions.
 */
export interface ModeCapabilities {
  /** Whether any scoped mode is active and should lock conflicting controls. */
  isModeLocked: boolean;
  /** Whether the interactive-trace hook's traced subset (not the raw base graph) should render. */
  isTraceActive: boolean;
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
  const isTraceActive = isTraceView || isPathView || input.traceMode === 'analysis';

  return {
    isModeLocked: hasScopedView,
    isTraceActive,
    canRemoveNodeFromScopedView: isCuratedView && !input.hasAnalysisMode && !hasTraceMode,
    canEditTraceScope: isTraceView,
    canStartNewScopedMode: !hasScopedView,
    canSwitchGraphMode: !hasScopedView,
  };
}

/** The concrete action Delete (or its menu/button equivalents) performs, per {@link ModeCapabilities}. */
export type RemoveAction =
  | { kind: 'exclude' }
  | { kind: 'trace-prune' }
  | { kind: 'curated-remove' }
  | { kind: 'refuse'; reason: string };

/**
 * Decides what "remove from what is on screen" does for the highlighted node, from the same
 * {@link ModeCapabilities} every other control reads — one dispatcher, one source of truth,
 * instead of each caller (keyboard shortcut, context menu item, node button) re-deriving its own
 * notion of what Delete means in the current mode.
 *
 * @param capabilities - The active mode's capability set.
 * @param context - Per-node facts {@link ModeCapabilities} does not carry.
 * @returns The action to perform, or a refusal with a user-facing reason.
 */
export function resolveRemoveAction(
  capabilities: Pick<ModeCapabilities, 'isModeLocked' | 'canEditTraceScope' | 'canRemoveNodeFromScopedView'>,
  context: { hasAnalysisMode: boolean; isTraceOrigin: boolean },
): RemoveAction {
  if (capabilities.canEditTraceScope) {
    if (context.isTraceOrigin) return { kind: 'refuse', reason: 'This is the trace source — it cannot be removed' };
    return { kind: 'trace-prune' };
  }
  if (capabilities.canRemoveNodeFromScopedView) return { kind: 'curated-remove' };
  if (!capabilities.isModeLocked) return { kind: 'exclude' };
  if (context.hasAnalysisMode) return { kind: 'refuse', reason: 'Exit analysis to remove nodes from the view' };
  return { kind: 'refuse', reason: 'Nothing can be removed from this view' };
}
