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
 * @returns The display mode the canvas should render.
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
}: GraphDisplayModeInput): GraphDisplayMode {
  if (scopedModeActive) return 'scoped';

  if (graphMode === 'overview') {
    if (expandedSchemaCount > 0) {
      const renderedCount = expandedSchemaViewRenderedCount ?? filteredCount;
      return renderedCount > config.renderLimit ? 'renderLimit' : 'schemaExpanded';
    }
    return schemaOverviewRenderedCount > config.renderLimit ? 'renderLimit' : 'schemaOverview';
  }

  const fullRenderedCount = renderLimitHit > 0 ? renderLimitHit : filteredCount;
  if (fullRenderedCount > config.renderLimit) return 'renderLimit';
  return 'full';
}
