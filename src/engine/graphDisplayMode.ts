import type Graph from 'graphology';
import type { ExtensionConfig, FilterState, GraphMode } from './types';
import { traceNodeWithLevels } from './graphBuilder';

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
   * Projected React Flow node count of the surface that will render — the number the
   * render-limit screen reports. For a scope on stage it is the scope's own node count.
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
 * Seeds the user-owned graph view mode when a model is first loaded or Reset All runs.
 *
 * @remarks
 * Compares against the lesser of the configured threshold and the render limit, so Object View
 * never seeds a shape it cannot render — the render limit always wins.
 *
 * @returns `'overview'` when Schema View is enabled and the count exceeds the effective initial threshold, else `'full'`.
 */
export function deriveInitialGraphMode({ filteredCount, config }: GraphModeInput): GraphMode {
  const effectiveThreshold = Math.min(config.overview.threshold, config.renderLimit);
  return config.overview.enabled && filteredCount > effectiveThreshold ? 'overview' : 'full';
}

/**
 * Derives the full graph display surface, including scoped, render-limit, and expanded-schema-view states.
 *
 * @remarks
 * The render limit is a React Flow node ceiling for the selected surface, not a hidden cap on the
 * underlying model or AI context. Every surface is measured by what it will actually put on the
 * canvas: Expanded Schema View and Schema View by their projected node counts, and a trace, path, or
 * analysis scope by its own. A scope is not self-limiting — an all-levels trace over a connected
 * model reaches the whole model — so it is held to the same ceiling rather than exempted from it.
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
 * One restorable view — the filter, graph shape, and camera — captured on entry to a locked
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
 * Decides whether to capture or restore the {@link ViewSnapshot} for this render, from the
 * locked-mode transition alone.
 *
 * @remarks
 * Takes a snapshot only on the entering edge, and only when none is already saved — a second
 * locked mode entered while one is already active (e.g. Refresh mid-trace, or analysis started
 * from within a trace) must never overwrite the one snapshot that restores the pre-mode view.
 * Restoring is likewise edge-triggered, so the saved snapshot is consumed exactly once.
 *
 * @param isModeLocked - Whether a locked mode is active this render.
 * @param wasModeLocked - Whether a locked mode was active last render.
 * @param hasSnapshot - Whether a snapshot is currently saved.
 * @returns The capture/restore decision for this render.
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
 * Drops the most recently expanded schema, one Esc press at a time.
 *
 * @remarks
 * A JS `Set` preserves insertion order, so the last element already *is* the expansion order —
 * no separate order-tracking state is kept for this.
 *
 * @returns The remaining expanded schemas, or `null` once none remain.
 */
export function collapseLastExpandedSchema(expandedSchemas: ReadonlySet<string>): Set<string> | null {
  const ordered = Array.from(expandedSchemas);
  ordered.pop();
  return ordered.length > 0 ? new Set(ordered) : null;
}

/**
 * Drops expanded schemas no longer present in the model, keeping the rest — the fix for a
 * settings change or Refresh collapsing every expanded schema when nothing about the schema set
 * actually changed.
 *
 * @returns The schemas that still exist, or `null` when none do.
 */
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

/** Where a render-limited surface falls back to so the screen never goes chrome-free and blank. */
export interface RenderLimitFallback {
  /** The surface to render instead of a blank screen; `null` when no fallback fits either. */
  fallbackMode: 'schemaOverview' | null;
  /** One-line explanation for the notice shown over or beside the fallback surface. */
  message: string;
}

interface RenderLimitFallbackInput {
  /** Whether the render-limited surface is a trace/path/analysis/AI scope rather than the base graph. */
  isScoped: boolean;
  /** The projected node count that exceeded the limit. */
  renderedCount: number;
  /** The configured render ceiling. */
  renderLimit: number;
  /** Whether Schema View has something to fall back to (schema clusters exist for this model). */
  hasSchemaOverview: boolean;
}

/**
 * Derives what a render-limited screen falls back to, so the toolbar, banners, and the rest of
 * the chrome stay mounted instead of the whole screen being replaced by a bare message.
 *
 * @remarks
 * A scope (trace/path/analysis/AI) has no coarser surface to fall back to — the scope itself is
 * over budget, so the caller keeps chrome mounted and shows actions to shrink it (reduce depth,
 * exit) rather than switching views. The base graph falls back to Schema View, which renders
 * one node per schema and is far cheaper than the object graph it replaces.
 */
export function deriveRenderLimitFallback(input: RenderLimitFallbackInput): RenderLimitFallback {
  const count = input.renderedCount.toLocaleString();
  const limit = input.renderLimit.toLocaleString();
  if (input.isScoped) {
    return {
      fallbackMode: null,
      message: `This view selects ${count} nodes (limit ${limit}). Reduce the trace depth, narrow the path, or adjust the render limit in settings.`,
    };
  }
  return {
    fallbackMode: input.hasSchemaOverview ? 'schemaOverview' : null,
    message: input.hasSchemaOverview
      ? `The current filter selects ${count} nodes (limit ${limit}) — showing Schema View instead. Narrow schema or type filters to see individual objects.`
      : `The current filter selects ${count} nodes (limit ${limit}). Select schema or type filters to reduce scope, or adjust the render limit in settings.`,
  };
}

/** One candidate trace depth and the node count it would produce. */
export interface TraceDepthCandidate {
  /** Upstream levels this candidate would apply. */
  upstream: number;
  /** Downstream levels this candidate would apply. */
  downstream: number;
  /** Node count the candidate would render. */
  count: number;
}

/**
 * Picks the largest trace depth, among candidates already probed, that renders within the
 * render limit.
 *
 * @remarks
 * Pure selection only — the caller probes each candidate depth and hands the counts here.
 *
 * @param candidates - Depths tried, in any order.
 * @param renderLimit - The configured render ceiling.
 * @returns The candidate with the largest total depth that fits, or `null` when none fit.
 */
export function largestFittingTraceDepth(
  candidates: readonly TraceDepthCandidate[],
  renderLimit: number,
): TraceDepthCandidate | null {
  let best: TraceDepthCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.count > renderLimit) continue;
    const bestDepth = best ? best.upstream + best.downstream : -1;
    if (candidate.upstream + candidate.downstream > bestDepth) best = candidate;
  }
  return best;
}

/**
 * Node count a trace from `nodeId` at the given depths would render — BFS only, never layout, so
 * it is cheap enough to probe several candidate depths (a render-limit "reduce depth" suggestion,
 * a depth-choice count label) before committing to one.
 */
export function traceSizeByDepth(
  graph: Graph,
  nodeId: string,
  upstreamLevels: number,
  downstreamLevels: number,
): number {
  return traceNodeWithLevels(graph, nodeId, upstreamLevels, downstreamLevels).nodeIds.size;
}
