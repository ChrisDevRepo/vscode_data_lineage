import type { ExtensionConfig, GraphMode } from './types';

/**
 * Which graph surface the canvas renders.
 *
 * @remarks
 * `full` = individual objects with layout; `schemaOverview` = schema-cluster nodes only;
 * `schemaExpanded` = one or more schemas expanded to objects beside collapsed clusters (expanded schema view);
 * `scoped` = trace/path/analysis scope, which takes precedence over base graph size;
 * `renderLimit` = too many nodes to render, show the limit message instead.
 */
export type GraphDisplayMode = 'full' | 'schemaOverview' | 'schemaExpanded' | 'scoped' | 'renderLimit';

interface GraphModeInput {
  filteredCount: number;
  config: ExtensionConfig;
}

/**
 * Display surface decision plus the projected node count that produced it.
 */
export interface GraphDisplayState {
  /** The display surface the canvas should render. */
  mode: GraphDisplayMode;
  /**
   * Projected React Flow node count of the selected base surface — the number the
   * render-limit screen reports. For `scoped` mode it is the base-surface count
   * (the scope renders its own node set).
   */
  renderedCount: number;
}

interface GraphDisplayModeInput {
  graphMode: GraphMode;
  filteredCount: number;
  config: ExtensionConfig;
  renderLimitHit: number;
  expandedSchemaCount: number;
  schemaOverviewRenderedCount: number;
  expandedSchemaViewRenderedCount?: number;
  scopedModeActive?: boolean;
}

/**
 * Seeds the user-owned graph view mode when a model is first loaded or Reset All runs.
 *
 * @returns `'overview'` when Schema View is enabled and the count exceeds the initial threshold, else `'full'`.
 */
export function deriveInitialGraphMode({ filteredCount, config }: GraphModeInput): GraphMode {
  return config.overview.enabled && filteredCount > config.overview.threshold ? 'overview' : 'full';
}

/**
 * Derives the full graph display surface, including scoped, render-limit, and expanded-schema-view states.
 *
 * @remarks
 * The render limit is a React Flow node ceiling for the selected surface, not a hidden cap on the
 * underlying model or AI context. Trace/path/analysis scopes are already bounded by their own scope
 * and render before base graph limit checks. Expanded Schema View and Schema View compare their
 * projected rendered-node counts, not the raw object count.
 *
 * @returns The display mode the canvas should render and the rendered-node count behind the decision.
 */
export function deriveGraphDisplayMode({
  graphMode,
  filteredCount,
  config,
  renderLimitHit,
  expandedSchemaCount,
  schemaOverviewRenderedCount,
  expandedSchemaViewRenderedCount,
  scopedModeActive = false,
}: GraphDisplayModeInput): GraphDisplayState {
  const renderedCount =
    graphMode === 'overview'
      ? (expandedSchemaCount > 0
          ? (expandedSchemaViewRenderedCount ?? filteredCount)
          : schemaOverviewRenderedCount)
      : (renderLimitHit > 0 ? renderLimitHit : filteredCount);

  if (scopedModeActive) return { mode: 'scoped', renderedCount };
  if (renderedCount > config.renderLimit) return { mode: 'renderLimit', renderedCount };
  if (graphMode === 'overview') {
    return { mode: expandedSchemaCount > 0 ? 'schemaExpanded' : 'schemaOverview', renderedCount };
  }
  return { mode: 'full', renderedCount };
}
