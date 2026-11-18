import type Graph from 'graphology';
import { OBJECT_TYPES, type ExtensionConfig, type FilterState, type GraphMode } from './types';
import { traceNodeIdsWithLevels } from './graphBuilder';

/**
 * Which graph surface the canvas renders: `full` (individual objects with layout), `schemaOverview`
 * (schema-cluster nodes only), `schemaExpanded` (some schemas expanded to objects beside collapsed
 * clusters), `scoped` (trace/path/analysis scope, which takes precedence over base graph size),
 * `renderLimit` (too many nodes: show the limit message).
 */
export type GraphDisplayMode = 'full' | 'schemaOverview' | 'schemaExpanded' | 'scoped' | 'renderLimit';

interface GraphModeInput {
  filteredCount: number;
  config: ExtensionConfig;
}

/** Display surface decision plus the projected node count that produced it. */
export interface GraphDisplayState {
  /** The display surface the canvas should render. */
  mode: GraphDisplayMode;
  /**
   * Projected React Flow node count of the surface that will render, the number the render-limit
   * screen reports; for a scope on stage, the scope's own node count.
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
  scopedRenderedCount?: number;
}

/**
 * Seeds the user-owned graph view mode when a model is first loaded or Refresh View runs. Compares
 * against the lesser of the configured threshold and the render limit, so Object View never seeds a
 * shape it cannot render.
 *
 * @returns `'overview'` when Schema View is enabled and the count exceeds the effective threshold,
 *   else `'full'`.
 */
export function deriveInitialGraphMode({ filteredCount, config }: GraphModeInput): GraphMode {
  return config.overview.enabled && filteredCount > effectiveOverviewThreshold(config) ? 'overview' : 'full';
}

/**
 * The object count above which Schema View applies: the configured `overview.threshold` capped at
 * `renderLimit`, as the setting's description promises; one value for the initial mode, the
 * toggle's soft-disabled state and the toolbar tooltip.
 */
export function effectiveOverviewThreshold(config: Pick<ExtensionConfig, 'overview' | 'renderLimit'>): number {
  return Math.min(config.overview.threshold, config.renderLimit);
}

/**
 * Derives the full graph display surface, including scoped, render-limit and expanded-schema-view
 * states. The render limit is a React Flow node ceiling for the selected surface, not a cap on the
 * model or AI context. Every surface is measured by what it will put on the canvas (projected node
 * counts, or a scope's own); a scope is not self-limiting (an all-levels trace over a connected
 * model reaches the whole model), so it is held to the same ceiling.
 *
 * @returns The display mode and the rendered-node count behind the decision.
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

/**
 * One restorable view (filter, graph shape, camera) captured on entry to a locked
 * (trace/analysis/bookmark/AI/path-finder) mode and restored exactly on exit.
 */
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

/**
 * Decides whether to capture or restore the {@link ViewSnapshot} from the locked-mode transition
 * alone. Captures only on the entering edge and only when none is saved: a second locked mode
 * entered while one is active (Refresh mid-trace, analysis from within a trace) must not overwrite
 * the snapshot that restores the pre-mode view. Restoring is edge-triggered too, so the snapshot is
 * consumed once.
 */
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

/**
 * The filter the canvas is built from while an AI preview is shown. The preview's allowlist names
 * exactly the nodes to render, so schemas, types, external references, exclusion patterns and
 * isolation are widened for display only: every allowlisted node renders whatever the toolbar
 * selection is, which stays the user's.
 *
 * @returns The widened filter, or `filter` itself when no preview is shown or it carries no
 *   allowlist.
 */
export function aiPreviewDisplayFilter(
  filter: FilterState,
  aiPreviewActive: boolean,
  modelSchemas: Iterable<string>,
): FilterState {
  if (!aiPreviewActive || !filter.allowlistNodeIds || filter.allowlistNodeIds.size === 0) return filter;
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

/**
 * The user's selection once the AI preview is discarded: the allowlist is dropped and every other
 * choice, including an edit made while the preview was shown, is kept.
 */
export function filterAfterAiPreviewDiscard(filter: FilterState): FilterState {
  const { allowlistNodeIds: _allowlist, ...selection } = filter;
  return selection;
}

/**
 * The filter the extension host treats as the user's selection. While the AI preview is shown it is
 * the selection saved in the view snapshot at run start, so prompt context and follow-ups keep the
 * schemas and types the run started with; an edit made meanwhile reaches the host once the preview
 * is discarded.
 *
 * @param snapshot - The view saved on entry to the locked mode, if any.
 */
export function userFilterForHost(filter: FilterState, aiPreviewActive: boolean, snapshot: ViewSnapshot | null): FilterState {
  return aiPreviewActive && snapshot ? snapshot.filter : filter;
}

/**
 * Drops the most recently expanded schema, one Esc press at a time (a JS `Set` keeps insertion
 * order, so no separate order state). Returns the remaining schemas, or `null` once none remain.
 */
export function collapseLastExpandedSchema(expandedSchemas: ReadonlySet<string>): Set<string> | null {
  const ordered = Array.from(expandedSchemas);
  ordered.pop();
  return ordered.length > 0 ? new Set(ordered) : null;
}

/**
 * Drops expanded schemas no longer in the model, so a settings change or Refresh collapses only
 * schemas that disappeared; `null` when none remain.
 */
export function retainExistingSchemas(
  expandedSchemas: ReadonlySet<string>,
  existingSchemas: ReadonlySet<string>,
): Set<string> | null {
  const kept = Array.from(expandedSchemas).filter((schema) => existingSchemas.has(schema));
  return kept.length > 0 ? new Set(kept) : null;
}

/**
 * Deterministic, sorted serialization of an expanded-schema set — the one function every persisted
 * or posted record listing expanded schemas reuses.
 */
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

/**
 * The render-limit notice: the current view stays selected and nothing is drawn. The same sentence
 * covers the base graph and a trace, path, analysis or AI scope; the user changes filters or
 * `dataLineageViz.renderLimit`, and the notice never switches views or shrinks a trace.
 */
export function deriveRenderLimitFallback(): RenderLimitFallback {
  return { message: RENDER_LIMIT_NOTICE };
}

/**
 * Node count a trace from `nodeId` at the given depths would render. BFS only, no layout, so it is
 * cheap enough to probe a candidate depth before committing.
 */
export function traceSizeByDepth(
  graph: Graph,
  nodeId: string,
  upstreamLevels: number,
  downstreamLevels: number,
): number {
  return traceNodeIdsWithLevels(graph, nodeId, upstreamLevels, downstreamLevels).size;
}
