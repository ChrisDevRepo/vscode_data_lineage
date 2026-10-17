import type Graph from 'graphology';
import { OBJECT_TYPES, type ExtensionConfig, type FilterState, type GraphMode } from './types';
import { traceNodeIdsWithLevels } from './graphBuilder';

/** Which graph surface the canvas renders. */
export type GraphDisplayMode = 'full' | 'schemaOverview' | 'schemaExpanded' | 'scoped' | 'renderLimit';

interface GraphModeInput {
  filteredCount: number;
  config: ExtensionConfig;
}

/** Display surface decision plus the projected node count that produced it. */
export interface GraphDisplayState {
  /** The display surface the canvas should render. */
  mode: GraphDisplayMode;
  /** Projected React Flow node count of the surface that will render — the number the render-limit screen reports. For a scope on stage it is the scope's own node count. */
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
  scopedRenderedCount?: number;
}

/** Seeds the user-owned graph view mode when a model is first loaded or Refresh View runs. */
export function deriveInitialGraphMode({ filteredCount, config }: GraphModeInput): GraphMode {
  return config.overview.enabled && filteredCount > effectiveOverviewThreshold(config) ? 'overview' : 'full';
}

/** The object count above which Schema View applies: the configured `overview.threshold` capped at `renderLimit`, as the setting's description promises — one value for the initial mode, the toggle's soft-disabled state and the toolbar tooltip. */
export function effectiveOverviewThreshold(config: Pick<ExtensionConfig, 'overview' | 'renderLimit'>): number {
  return Math.min(config.overview.threshold, config.renderLimit);
}

/** Derives the full graph display surface, including scoped, render-limit, and expanded-schema-view states. */
export function deriveGraphDisplayMode({
  graphMode,
  filteredCount,
  config,
  renderLimitHit,
  expandedSchemaCount,
  schemaOverviewRenderedCount,
  expandedSchemaViewRenderedCount,
  scopedModeActive = false,
  scopedRenderedCount,
}: GraphDisplayModeInput): GraphDisplayState {
  const renderedCount =
    graphMode === 'overview'
      ? (expandedSchemaCount > 0
          ? (expandedSchemaViewRenderedCount ?? filteredCount)
          : schemaOverviewRenderedCount)
      : (renderLimitHit > 0 ? renderLimitHit : filteredCount);
  if (scopedModeActive) {
    if (scopedRenderedCount !== undefined && scopedRenderedCount > config.renderLimit) {
      return { mode: 'renderLimit', renderedCount: scopedRenderedCount };
    }
    return { mode: 'scoped', renderedCount: scopedRenderedCount ?? renderedCount };
  }

  if (renderedCount > config.renderLimit) return { mode: 'renderLimit', renderedCount };
  if (graphMode === 'overview') {
    return { mode: expandedSchemaCount > 0 ? 'schemaExpanded' : 'schemaOverview', renderedCount };
  }
  return { mode: 'full', renderedCount };
}

/** One restorable view — the filter, graph shape, and camera — captured on entry to a locked (trace/analysis/bookmark/AI/path-finder) mode and restored exactly on exit. */
export interface ViewSnapshot {
  /** The filter in force before the locked mode was entered. */
  filter: FilterState;
  /** Object View / Schema View before the locked mode was entered. */
  graphMode: GraphMode;
  /** Schemas expanded in Expanded Schema View before the locked mode was entered. */
  expandedSchemas: readonly string[];
  /** Object focused within Expanded Schema View before the locked mode was entered, if any. */
  focusNodeId: string | null;
  /** Camera position before the locked mode was entered, when known. */
  viewport?: { x: number; y: number; zoom: number };
}

/** Whether a view snapshot should be captured or restored on this render. */
export interface ViewSnapshotTransition {
  /** Capture a fresh snapshot: a locked mode was just entered and none is already saved. */
  shouldSnapshot: boolean;
  /** Restore and clear the saved snapshot: the last locked mode was just exited. */
  shouldRestore: boolean;
}

/** Decides whether to capture or restore the {@link ViewSnapshot} for this render, from the locked-mode transition alone. */
export function deriveViewSnapshotTransition(
  isModeLocked: boolean,
  wasModeLocked: boolean,
  hasSnapshot: boolean,
): ViewSnapshotTransition {
  const entering = isModeLocked && !wasModeLocked;
  const leaving = !isModeLocked && wasModeLocked;
  return {
    shouldSnapshot: entering && !hasSnapshot,
    shouldRestore: leaving && hasSnapshot,
  };
}

/** The filter the canvas is built from while an AI preview is shown. */
export function aiPreviewDisplayFilter(
  filter: FilterState,
  aiPreviewActive: boolean,
  modelSchemas: Iterable<string>,
): FilterState {
  if (!aiPreviewActive || !filter.allowlistNodeIds) return filter;
  return {
    ...filter,
    schemas: new Set(modelSchemas),
    types: new Set(OBJECT_TYPES),
    showExternalRefs: true,
    externalRefTypes: new Set(['file', 'db']),
    exclusionPatterns: [],
    hideIsolated: false,
  };
}

/** The user's selection once the AI preview is discarded: the preview allowlist is dropped and every other choice, including an edit made while the preview was shown, is kept. */
export function filterAfterAiPreviewDiscard(filter: FilterState): FilterState {
  const { allowlistNodeIds: _allowlist, ...selection } = filter;
  return selection;
}

/** The filter the extension host treats as the user's selection. */
export function userFilterForHost(filter: FilterState, aiPreviewActive: boolean, snapshot: ViewSnapshot | null): FilterState {
  return aiPreviewActive && snapshot ? snapshot.filter : filter;
}

/** Drops the most recently expanded schema, one Esc press at a time. */
export function collapseLastExpandedSchema(expandedSchemas: ReadonlySet<string>): Set<string> | null {
  const ordered = Array.from(expandedSchemas);
  ordered.pop();
  return ordered.length > 0 ? new Set(ordered) : null;
}

/** Drops expanded schemas no longer present in the model, keeping the rest, so a settings change or Refresh collapses only the schemas that disappeared. */
export function retainExistingSchemas(
  expandedSchemas: ReadonlySet<string>,
  existingSchemas: ReadonlySet<string>,
): Set<string> | null {
  const kept = Array.from(expandedSchemas).filter((schema) => existingSchemas.has(schema));
  return kept.length > 0 ? new Set(kept) : null;
}

/** Deterministic, sorted serialization of an expanded-schema set — the one function every persisted or posted record listing expanded schemas reuses. */
export function serializeExpandedSchemas(expandedSchemas: ReadonlySet<string> | undefined): string[] {
  return expandedSchemas ? Array.from(expandedSchemas).sort() : [];
}

/** What the render-limit screen tells the user. The notice has no actions. */
export interface RenderLimitFallback {
  /** The one instruction under "Render limit reached". */
  message: string;
}

/** Instruction on every render-limit screen. The notice offers no button. */
const RENDER_LIMIT_NOTICE = 'Reduce filter scope or adjust VS Code settings.';

/** The render-limit notice. The current view stays selected and nothing is drawn. */
export function deriveRenderLimitFallback(): RenderLimitFallback {
  return { message: RENDER_LIMIT_NOTICE };
}

/** Node count a trace from `nodeId` at the given depths would render — BFS only, never layout, so it is cheap enough to probe a candidate depth (a depth-choice count label) before committing to one. */
export function traceSizeByDepth(
  graph: Graph,
  nodeId: string,
  upstreamLevels: number,
  downstreamLevels: number,
): number {
  return traceNodeIdsWithLevels(graph, nodeId, upstreamLevels, downstreamLevels).size;
}
