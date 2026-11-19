import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  useNodesInitialized,
  applyNodeChanges,
  applyEdgeChanges,
  MarkerType,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type NodeTypes,
  type EdgeTypes,
  type NodeMouseHandler,
  type OnNodeDrag,
  type OnNodesChange,
  type OnEdgesChange,
  type FitViewOptions,
  Panel,
  getNodesBounds,
  getViewportForBounds,
  useStore,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Graph from 'graphology';
import { useVsCode } from '../contexts/VsCodeContext';

import { CustomNode } from './CustomNode';
import { Spinner } from './ui/Spinner';
import { SchemaNode } from './SchemaNode';
import type { AiBadge, ColumnTraceNodeData, CustomNodeData, SchemaNodeData, GraphMode, TraceAffordanceSnapshot, TraceAffordanceSideSnapshot, TraceNeighborOption, TraceNodeControls, TraceSideControls } from '../engine/types';
import { ColumnTraceEdge, type ColumnTraceEdgeData } from './ColumnTraceEdge';
import { Legend } from './Legend';
import { deriveLegendSchemas, deriveLegendColorMap } from './legendDerivation';
import { ErrorBoundary } from './ErrorBoundary';
import { InlineTraceControls } from './InlineTraceControls';
import { TracedFilterBanner, TRACE_ICON } from './TracedFilterBanner';
import { ModeBanner } from './ModeBanner';
import { PathFinderBar } from './PathFinderBar';
import { TRACE_NAVIGATOR_WIDTH, TraceTreePanel } from './TraceTreePanel';
import { buildTraceTree } from '../engine/traceTree';
import { AnalysisBanner } from './AnalysisBanner';
import { AnalysisSidebar } from './AnalysisSidebar';
import { AiViewBanner } from './AiViewBanner';
import { BookmarkBanner } from './BookmarkBanner';
import { BookmarkInfoCard } from './BookmarkInfoCard';
import { Toolbar } from './Toolbar';
import { NodeInfoBar } from './NodeInfoBar';
import { DetailSearchSidebar } from './DetailSearchSidebar';
import type { FilterState, TraceState, ObjectType, ExtensionConfig, DatabaseModel, AnalysisMode, AnalysisType } from '../engine/types';
import type { FilterProfile, AIViewMetadata } from '../engine/projectStore';
import { getSchemaColor, getExternalNodeColor, AI_COLOR_HEX, AI_COLOR_GLOW, resolveAiColor } from '../utils/schemaColors';
import { NODE_WIDTH, NODE_HEIGHT } from '../engine/graphBuilder';
import { effectiveOverviewThreshold } from '../engine/graphDisplayMode';
import { ColumnTraceNode } from './ColumnTraceNode';
import {
  buildColumnTraceView,
  buildColumnThreadIndex,
  columnRowKey,
  columnThread,
  resolveRowLineStates,
  type ColumnTraceViewObject,
  type ColumnLineState,
} from '../engine/columnTraceView';
import {
  createNodeDecorationCache,
  decorateFlowNodes,
  createColumnNodeCache,
  projectColumnNodes,
  computeNodeDecoration,
  shouldVirtualizeCanvas,
  shouldAnimateEdges,
  MIN_CANVAS_ZOOM,
} from '../engine/nodeDecoration';

import { createEdgeDecorationCache, decorateFlowEdges, edgeDensity } from '../engine/edgeDecoration';
import { ColumnHoverProvider, type ColumnHoverState } from '../contexts/ColumnHoverContext';
import { canPruneTraceNode, isEditableTraceMode, isManualTraceScopeEdit, traceRemovalSides, unionConnectingPaths, type TracePruneCheck } from '../engine/traceScope';
import { directNeighborIds, type NeighborSide, type RemovalSide } from '../engine/graphGuards';
import { notifyUser } from '../utils/notify';
import { normalizeColName, schemaKey } from '../utils/sql';
import { SHORTCUT_KEYS, ESC_PRIORITY } from '../ui/keyboardShortcuts';
import type { AiReportSection, AiDockPosition } from './AiDescriptionOverlay';
import { ExtensionToWebviewMsgSchema, validateBridgeFrame } from '../engine/shared/bridgeContract';
import { errorMessage } from '../utils/errorMessage';

/**
 * Custom node types for React Flow. Must stay at module level: defined inside the component, React
 * Flow remounts every node on each render, losing state and performance.
 */
const nodeTypes = { lineageNode: CustomNode, schemaNode: SchemaNode, columnTraceNode: ColumnTraceNode } satisfies NodeTypes;

/** Custom edge types for React Flow; module-level for the same reason as {@link nodeTypes}. */
const edgeTypes = { columnTraceEdge: ColumnTraceEdge } satisfies EdgeTypes;

const AiDescriptionOverlay = lazy(async () => {
  const module = await import('./AiDescriptionOverlay');
  return { default: module.AiDescriptionOverlay };
});

/** The panel's reserved extent before its own `ResizeObserver` has reported a measured size. */
const AI_PANEL_DEFAULT_WIDTH = 'min(440px, 55vw)';
const AI_PANEL_DEFAULT_HEIGHT = 'min(360px, 45vh)';

/** `window.vscode` state key the dock position is persisted under, beside other keys. */
const AI_DOCK_STATE_KEY = 'aiDockPosition';

/** Reverse of `aiSections`' per-section `nodeIds`: every section that badged `nodeId`, in order. */
export function sectionsForNode(sections: readonly AiReportSection[], nodeId: string): number[] {
  return sections.filter(s => s.nodeIds.includes(nodeId)).map(s => s.n);
}

/**
 * Cache key of the AI pane's open state and pinned section: origin id ('preview' if none) + view.
 */
export function aiLayoutCacheKey(originId: string | undefined, viewName: string): string {
  return `${originId ?? 'preview'}::${viewName}`;
}

/** Padding factor applied when fitting the graph view. */
const FIT_VIEW_PADDING = 0.15;

type FitViewPadding = NonNullable<FitViewOptions['padding']>;

/** React Flow's mount-time `fitViewOptions`; module-level so the prop keeps one identity. */
const INITIAL_FIT_VIEW_OPTIONS: FitViewOptions = { padding: FIT_VIEW_PADDING };

/** Fit padding while the trace navigator card covers the left edge: its width plus a gap. */
const TRACE_NAVIGATOR_FIT_PADDING: FitViewPadding = { x: FIT_VIEW_PADDING, y: FIT_VIEW_PADDING, left: `${TRACE_NAVIGATOR_WIDTH + 40}px` };

/** Animation duration in ms for fitting the graph view. */
const FIT_VIEW_DURATION = 250;

/**
 * Delay in ms before an AI panel dock/open change re-fits: one frame past the panel's CSS size
 * transition, so the fit reads the settled canvas box.
 */
const AI_PANEL_REFIT_DELAY = 80;

/**
 * Arms `fire` through `schedule` (`requestAnimationFrame`/`setTimeout`), claiming the next value of
 * `generationRef`; `fire` runs only if `generationRef` still holds it, since a later user gesture
 * or fit bumps it and this one becomes a no-op.
 *
 * @param ready - Whether the intended graph has arrived and is measured; false defers another
 *   frame.
 * @param maxDeferredFrames - Frame budget for `ready()`; once spent the fit stops without calling
 *   `fire`, so an unmeasured graph is not framed.
 * @returns A cancel that clears the latest scheduled callback (effect cleanup / unmount).
 */
export function scheduleFit(
  generationRef: { current: number },
  fire: () => void,
  schedule: (run: () => void) => number = (run) => requestAnimationFrame(run),
  clear: (id: number) => void = (id) => cancelAnimationFrame(id),
  ready: () => boolean = () => true,
  maxDeferredFrames = 60,
): () => void {
  const generation = ++generationRef.current;
  let cancelled = false;
  let deferred = 0;
  let id: number;
  const run = () => {
    if (cancelled || generationRef.current !== generation) return;
    if (!ready()) {
      if (deferred >= maxDeferredFrames) return;
      deferred++;
      id = schedule(run);
      return;
    }
    fire();
  };
  id = schedule(run);
  return () => { cancelled = true; clear(id); };
}

/**
 * Resumes a graph fit blocked by rebuilding, only while its generation still owns the camera. The
 * returned scheduler's cleanup also cancels a resumed fit.
 */
export function useRebuildResumableFit(
  isRebuilding: boolean,
  generationRef: { current: number },
  armFit: () => () => void,
): () => () => void {
  const rebuildingRef = useRef(isRebuilding);
  rebuildingRef.current = isRebuilding;
  const pendingRef = useRef<{ resume: () => void } | null>(null);

  useEffect(() => {
    if (isRebuilding) return;
    const pending = pendingRef.current;
    pendingRef.current = null;
    pending?.resume();
  }, [isRebuilding]);

  return useCallback(() => {
    let cancel = armFit();
    const generation = generationRef.current;
    const request = {
      resume: () => {
        if (generationRef.current !== generation) return;
        cancel();
        cancel = armFit();
      },
    };
    pendingRef.current = rebuildingRef.current ? request : null;
    return () => {
      if (pendingRef.current === request) pendingRef.current = null;
      cancel();
    };
  }, [armFit, generationRef]);
}

/** Reframes pane size changes unless a saved camera restore owns the view; user gestures win. */
export function useCanvasResizeFit(width: number, height: number, fitGraph: () => () => void, restoringViewport = false): void {
  const previousSize = useRef({ width, height });
  useEffect(() => {
    const previous = previousSize.current;
    previousSize.current = { width, height };
    if (restoringViewport || width <= 0 || height <= 0 || previous.width <= 0 || previous.height <= 0
      || (previous.width === width && previous.height === height)) return;
    return fitGraph();
  }, [width, height, fitGraph, restoringViewport]);
}

/** Whether React Flow has received and measured the graph a pending fit will frame. */
export function graphReadyForFit(
  expectedNodes: readonly FlowNode[], expectedEdges: readonly FlowEdge[],
  renderedNodes: readonly FlowNode[], renderedEdges: readonly FlowEdge[],
): boolean {
  const expectedVisible = expectedNodes.filter(node => !node.hidden);
  const renderedVisible = renderedNodes.filter(node => !node.hidden);
  if (expectedVisible.length !== renderedVisible.length || expectedEdges.length !== renderedEdges.length) return false;
  const renderedById = new Map(renderedVisible.map(node => [node.id, node]));
  if (!expectedVisible.every(node => {
    const rendered = renderedById.get(node.id);
    return rendered && rendered.position.x === node.position.x && rendered.position.y === node.position.y
      && (rendered.measured?.width ?? 0) > 0 && (rendered.measured?.height ?? 0) > 0;
  })) return false;
  const renderedEdgeById = new Map(renderedEdges.map(edge => [edge.id, edge]));
  return expectedEdges.every(edge => {
    const rendered = renderedEdgeById.get(edge.id);
    return rendered?.source === edge.source && rendered.target === edge.target;
  });
}

/** Skip fits until the graph-data update paired with a saved viewport arrives. */
export function skipFitForPendingViewport(
  preserveVersion: number, consumedVersion: { current: number }, nodeDataChanged: boolean,
): boolean {
  if (preserveVersion === consumedVersion.current) return false;
  if (nodeDataChanged) consumedVersion.current = preserveVersion;
  return true;
}

/** Largest zoom the canvas allows. */
const MAX_CANVAS_ZOOM = 2;

/**
 * The canvas `minZoom`: {@link MIN_CANVAS_ZOOM}, lowered to the zoom a fit of every visible node
 * needs in a `paneWidth` × `paneHeight` pane at `padding`, so a fit is never clamped short of the
 * graph. Bounds come from `getNodesBounds` (measured, else declared, else zero size), so an
 * unmeasured node still contributes its position.
 */
export function canvasMinZoom(
  nodes: readonly FlowNode[],
  paneWidth: number,
  paneHeight: number,
  padding: FitViewPadding,
): number {
  const visible = nodes.filter(n => !n.hidden);
  if (visible.length === 0 || paneWidth <= 0 || paneHeight <= 0) return MIN_CANVAS_ZOOM;
  const bounds = getNodesBounds(visible);
  const { zoom } = getViewportForBounds(bounds, paneWidth, paneHeight, 0, MAX_CANVAS_ZOOM, padding);
  return Math.min(MIN_CANVAS_ZOOM, zoom);
}

/**
 * Whether a `ReactFlow` `onMoveStart` event is a user gesture: a real `event` for user pan/zoom,
 * `null` for programmatic `fitView`/`setViewport`/`setCenter`.
 */
export function isUserMoveEvent(event: MouseEvent | TouchEvent | null): boolean {
  return event !== null;
}

/**
 * Applies a viewport armed at `armedGeneration` only if {@link fitGenerationRef} still holds it. A
 * user pan/zoom or newer fit in the gap before the graph data (deferred via `startTransition`)
 * catches up bumps the generation, so the stale viewport no-ops. Returns whether it was applied.
 */
export function applyPendingViewport(
  pending: { x: number; y: number; zoom: number },
  currentGeneration: number,
  armedGeneration: number,
  setViewport: (viewport: { x: number; y: number; zoom: number }, options: { duration: number }) => void,
): boolean {
  if (currentGeneration !== armedGeneration) return false;
  setViewport(pending, { duration: 0 });
  return true;
}

/** Zoom below which AI notes are hidden once they are showing. */
const NOTES_ZOOM_OUT = 0.18;

/** Zoom above which AI notes are shown once they are hidden. */
const NOTES_ZOOM_IN = 0.28;

/** Arrow-head width and height, in px, of a column-view edge. */
const COLUMN_EDGE_MARKER_SIZE = 14;


/** Max time (ms) to wait for a pending zoom target to appear in flowNodes before warning. */
const PENDING_ZOOM_TIMEOUT_MS = 5000;

/**
 * Class on the React Flow root while object view has an active node selection. With
 * `LIT_CLASS_NAME` (`src/engine/nodeDecoration.ts`, `src/engine/edgeDecoration.ts`), the CSS rule
 * in `src/index.css` dims every node/edge not marked lit, so a click gives most of the canvas no
 * new object identity. Column view keeps its own dim/hover styling and never gets this class.
 */
const SELECTION_ACTIVE_CLASS_NAME = 'ln-has-selection';

/** Canvas-root class applying the `--ln-edge-density` fade and thinning to object-view edges. */
const EDGE_DENSITY_CLASS_NAME = 'ln-edge-density';

/** Stable empty route-target list for the navigator outside a focus. */
const NO_FOCUS_TARGETS: readonly string[] = [];

/** Stable empty stale-name list for the AI preview info card. */
const NO_STALE_NAMES: string[] = [];

/**
 * Per-edge CSS custom property holding its base stroke width, set once when an edge enters
 * `localEdges`; the selection-dim/lit rules in `src/index.css` scale width off it.
 */
const EDGE_BASE_WIDTH_VAR = '--ln-edge-w';

/** Base stroke width, in px, an edge falls back to when its own style omits one. */
const DEFAULT_EDGE_STROKE_WIDTH = 1.2;

/** Inline style carrying a CSS custom property alongside the standard style properties. */
type StyleWithVars = CSSProperties & Record<`--${string}`, string | number>;

/** Stamps an edge's own base stroke width onto it as {@link EDGE_BASE_WIDTH_VAR}. */
function withEdgeBaseWidthVar(edge: FlowEdge): FlowEdge {
  const width = (edge.style?.strokeWidth as number | undefined) ?? DEFAULT_EDGE_STROKE_WIDTH;
  return { ...edge, style: { ...edge.style, [EDGE_BASE_WIDTH_VAR]: width } as StyleWithVars };
}

/**
 * Merges a rebuilt node list with the local nodes mid-drag: a node in `draggingIds` keeps its
 * position from `currentNodes`, and every other field of every node comes from `incomingNodes`.
 */
export function mergeIncomingNodesPreservingDrag(
  incomingNodes: FlowNode[],
  currentNodes: FlowNode[],
  draggingIds: ReadonlySet<string>,
): FlowNode[] {
  if (draggingIds.size === 0) return incomingNodes;
  const currentById = new Map(currentNodes.map((n) => [n.id, n]));
  return incomingNodes.map((n) => {
    if (!draggingIds.has(n.id)) return n;
    const current = currentById.get(n.id);
    return current ? { ...n, position: current.position } : n;
  });
}

type ModelNode = DatabaseModel['nodes'][number];

/** Separator that cannot appear in schema/object names, for composite lookup keys. */
const SEARCH_KEY_SEP = '\u0000';
const searchKey = (schema: string, name: string) => `${schema}${SEARCH_KEY_SEP}${name}`;

function traceNeighborSortKey(option: TraceNeighborOption): string {
  return `[${option.schema}].${option.label}`;
}

function resolveTraceNeighborOption(
  id: string,
  modelNodeMap: ReadonlyMap<string, ModelNode>,
  modelNodeMapLower: ReadonlyMap<string, ModelNode>,
): TraceNeighborOption | null {
  const node = modelNodeMap.get(id) ?? modelNodeMapLower.get(id.toLowerCase());
  if (!node) return null;
  return { id: node.id, label: node.name, schema: node.schema, objectType: node.type };
}

function buildTraceNeighborOptions(
  ids: string[],
  modelNodeMap: ReadonlyMap<string, ModelNode>,
  modelNodeMapLower: ReadonlyMap<string, ModelNode>,
): TraceNeighborOption[] {
  return ids
    .map(id => resolveTraceNeighborOption(id, modelNodeMap, modelNodeMapLower))
    .filter((option): option is TraceNeighborOption => !!option)
    .sort((a, b) => traceNeighborSortKey(a).localeCompare(traceNeighborSortKey(b)));
}

/**
 * Human-readable reason the prune control is unavailable. Every candidate is visible and a prune
 * cascade-removes its subtree, so {@link canPruneTraceNode} refuses only the trace origin; the
 * blocking cases are nothing to remove on this side, or only the origin.
 *
 * @param sideLabel - "upstream" or "downstream", for the empty-context message.
 * @returns Empty string when at least one neighbor is prunable, else the reason.
 */
function derivePruneDisabledReason(
  pruneChecks: ReadonlyArray<{ check: TracePruneCheck }>,
  sideLabel: string,
): string {
  if (pruneChecks.some(p => p.check.safe)) return '';
  if (pruneChecks.length === 0) return `No ${sideLabel} node in the trace to remove`;
  return 'This is the trace source — it cannot be removed';
}

function buildTraceSideControls(
  model: DatabaseModel,
  graph: Graph,
  nodeId: string,
  side: NeighborSide,
  visibleIds: ReadonlySet<string>,
  originNodeId: string,
  modelNodeMap: ReadonlyMap<string, ModelNode>,
  modelNodeMapLower: ReadonlyMap<string, ModelNode>,
  sides: ReadonlyArray<RemovalSide>,
): TraceNodeControls['in'] {
  const neighborOptions = buildTraceNeighborOptions(
    directNeighborIds(model, nodeId, side),
    modelNodeMap,
    modelNodeMapLower,
  );
  const add = neighborOptions.filter(option => !visibleIds.has(option.id));
  const visibleNeighbors = neighborOptions.filter(option => visibleIds.has(option.id));
  const pruneChecks = visibleNeighbors.map(option => ({
    option,
    check: canPruneTraceNode(graph, originNodeId, visibleIds, option.id, sides),
  }));
  const prune = pruneChecks
    .filter(p => p.check.safe)
    .map(p => ({ ...p.option, cutCount: p.check.cutNodeIds?.length }));
  const sideLabel = side === 'in' ? 'upstream' : 'downstream';

  return {
    add,
    prune,
    addDisabledReason: `All ${sideLabel} neighbors are already shown`,
    pruneDisabledReason: derivePruneDisabledReason(pruneChecks, sideLabel),
    neighborCount: neighborOptions.length,
    visibleNeighborCount: visibleNeighbors.length,
  };
}

function serializeSideAffordance(side: TraceSideControls): TraceAffordanceSideSnapshot {
  return {
    add: side.add.map(o => o.id),
    prune: side.prune.map(o => o.id),
    addDisabledReason: side.addDisabledReason,
    pruneDisabledReason: side.pruneDisabledReason,
    neighborCount: side.neighborCount,
    visibleNeighborCount: side.visibleNeighborCount,
  };
}

/**
 * Flattens the live {@link TraceNodeControls} (React callbacks) into a postMessage-safe object, so
 * the debug dump shows which add/prune buttons the user saw and why one was grayed.
 */
function serializeTraceAffordances(nodeId: string, controls: TraceNodeControls): TraceAffordanceSnapshot {
  return { nodeId, in: serializeSideAffordance(controls.in), out: serializeSideAffordance(controls.out) };
}

interface GraphCanvasProps {
  flowNodes: FlowNode[];
  flowEdges: FlowEdge[];
  trace: TraceState;
  filter: FilterState;
  metrics: { totalNodes: number; totalEdges: number; rootNodes: number; leafNodes: number } | null;
  highlightedNodeId?: string | null;
  /** The underlying graphology instance for structural analysis. */
  graph?: Graph | null;
  config: ExtensionConfig;
  onNodeClick: (nodeId: string, findQuery?: string) => void;
  /** Callback that drops the node selection — the canvas's click-away reset. */
  onClearSelection?: () => void;
  onSchemaNodeSelect?: (nodeId: string) => void;
  onNodeContextMenu: (node: FlowNode, x: number, y: number) => void;
  /**
   * Fired on object-node double-click; opens the detail view like the context menu's Show Details.
   */
  onShowDetails?: (nodeId: string) => void;
  onStartTraceImmediate: (nodeId: string) => void;
  /** Callback to apply a trace configuration (upstream/downstream levels). */
  onTraceApply: (config: { upstreamLevels: number; downstreamLevels: number }) => void;
  onTraceEnd: (onComplete?: () => void) => void;
  /** Callback to reset all filters and traces. */
  onResetAll: () => void;
  onToggleType: (type: ObjectType) => void;
  /** Callback to toggle 'Isolated Nodes' filter. */
  onToggleIsolated: () => void;
  onToggleFocusSchema: (schema: string) => void;
  onToggleSchema?: (schema: string) => void;
  onSelectAllSchemas?: (schemas: string[]) => void;
  onSelectNoneSchemas?: (schemas: string[]) => void;
  onToggleExternalRefs?: () => void;
  onToggleExternalRefType?: (subType: 'file' | 'db') => void;
  exclusionPatterns?: string[];
  onAddExclusionPattern?: (pattern: string) => void;
  onRemoveExclusionPattern?: (pattern: string) => void;
  availableSchemas?: string[];
  /** Schemas with at least one node after all filters — for legend display. */
  renderedSchemas?: string[];
  /** Diagnostic context forwarded to the canvas ErrorBoundary (current-screen snapshot). */
  graphErrorContext?: Record<string, unknown>;
  /** Reset key that clears the canvas ErrorBoundary when the rendered scope changes. */
  graphErrorResetKey?: string;
  /** Callback to refresh the current project data. */
  onRefresh: () => void;
  /** Callback to trigger a full graph rebuild (e.g. after filter change). */
  onRebuild?: () => void;
  onBack: () => void;
  onOpenDdlViewer?: () => void;
  isDetailSearchOpen?: boolean;
  onToggleDetailSearch?: () => void;
  /** Whether the trace navigator is collapsed to its reopen button. */
  isTraceTreeCollapsed?: boolean;
  onToggleTraceTreeCollapsed?: () => void;
  /** Traversal graph over the trace scope, shared by tree path lighting and focus paths. */
  traceScopeGraph?: Graph | null;
  /** Full-model traversal graph backing the tree and row path lighting. */
  modelGraph?: Graph | null;
  /** Shows only the routes to the given targets; an empty list restores the full trace. */
  setFocusTargets?: (targetIds: string[]) => boolean;
  /** Exits an active focus, restoring the full scope. */
  exitFocusPaths?: () => void;
  /** Whether a tree focus narrowing is on stage. */
  isFocusPaths?: boolean;
  /** Checked route targets while a focus is on stage. */
  focusTargetIds?: readonly string[];
  /** The pre-focus trace while routes are shown, else the trace; the navigator lists it. */
  navigatorTrace?: TraceState;
  /** Restores the trace's starting scope. */
  onResetTrace?: () => void;
  /** Loads one level from the given grow candidates. */
  onAddTraceNeighbors?: (candidateIds: string[]) => void;
  model?: DatabaseModel | null;
  infoBarNodeId?: string | null;
  onCloseInfoBar?: () => void;
  /** Current state of the graph analysis (SCC, Hubs, etc.). */
  analysisMode?: AnalysisMode | null;
  onOpenAnalysis?: (type: AnalysisType) => void;
  onCloseAnalysis?: () => void;
  onSelectAnalysisGroup?: (groupId: string) => void;
  onClearAnalysisGroup?: () => void;
  /** Callback to find and apply a path between two nodes. */
  onApplyPath?: (targetNodeId: string) => boolean;
  isRebuilding?: boolean;
  /** Node count a trace at the given upstream/downstream depth would render, before it runs. */
  estimateTraceSize?: (upstreamLevels: number, downstreamLevels: number) => number;
  /** Display name of the active source (e.g. dacpac filename). */
  sourceName?: string;
  /** List of saved filter profiles (bookmarks). */
  filterProfiles?: FilterProfile[];
  activeProjectId?: string | null;
  activeViewId?: string | null;
  /** Whether the current view has unsaved changes. */
  isViewModified?: boolean;
  onSaveView?: (name: string) => void;
  onApplyView?: (profile: FilterProfile) => void;
  onDeleteView?: (profileId: string) => void;
  onUpdateView?: (profileId: string) => void;
  /** Whether any filters have changed relative to the default or last saved state. */
  isFilterDirty?: boolean;
  /** Increments when the extension asks to go back; passed to the toolbar. */
  backRequest?: number;
  /** When true, analysis and trace-start are disabled (trace/analysis/bookmark mode active). */
  isModeLocked?: boolean;
  /** Whether the current scoped view supports removing individual nodes via the node X. */
  canRemoveNodeFromScopedView?: boolean;
  /** Whether the current trace scope supports manual add/prune controls. */
  canEditTraceScope?: boolean;
  /** Whether a fresh trace/path/analysis mode can be started from the current view. */
  canStartNewScopedMode?: boolean;
  /** Whether Object View / Schema View can be toggled from the current view. */
  canSwitchGraphMode?: boolean;
  /** The current graph abstraction level (full object graph or overview schema graph). */
  graphMode?: GraphMode;
  onGraphModeChange?: (mode: GraphMode) => void;
  /**
   * Set on initial load/reset: `true` when the model is below the overview threshold. Disables the
   * Schema View button; never re-derived from filter changes.
   */
  schemaViewSoftDisabled?: boolean;
  /**
   * Object-level node IDs that passed all filters (from useGraphology flowNodes). In overview mode
   * flowNodes are schema aggregates; this keeps the object-level truth.
   */
  filteredObjectIds?: Set<string>;
  /** Called when user saves a trace/path result as an advanced bookmark. */
  onSaveTraceBookmark?: (name: string, nodeIds: string[]) => void;
  /** Called when user saves an analysis result as an advanced bookmark. */
  onSaveAnalysisBookmark?: (
    name: string,
    nodeIds: string[],
  ) => void;
  /** Transient AI preview — shown before user decides to save. */
  aiPreview?: { name: string; nodeIds: Set<string>; aiMetadata: AIViewMetadata } | null;
  onSaveAiBookmark?: (name: string) => void;
  onDiscardAiPreview?: () => void;
  /** Called when user clicks the "×" remove-from-view button (advanced bookmark mode). */
  onRemoveFromView?: (nodeId: string) => void;
  /** The active advanced bookmark profile (when allowlist mode is on). */
  activeAdvancedProfile?: FilterProfile | null;
  /** Names of allowlist node IDs that no longer exist in the model. */
  bookmarkStaleNames?: string[];
  /** Called when user clicks "Exit View" in the bookmark banner. */
  onExitAdvancedBookmark?: () => void;
  /** Incremented when the next graph-data update should keep the current viewport. */
  viewportPreserveVersion?: number;
  /** Reports the live viewport on every change, for the parent to capture into a view snapshot. */
  onCameraChange?: (viewport: { x: number; y: number; zoom: number }) => void;
  /** A viewport to apply once after the next graph-data update, then cleared. */
  pendingViewport?: { x: number; y: number; zoom: number };
  /** Called after pendingViewport has been applied so the parent can clear it. */
  onPendingViewportApplied?: () => void;
  /** Whether trace BFS uses the full (unfiltered) model. */
  useFullModel?: boolean;
  /** Toggle between filtered and full-model trace. */
  onToggleFullModel?: () => void;
  /** Number of trace nodes hidden by the active filter. */
  filteredOutCount?: number;
  onTraceAddNeighbor?: (nodeId: string) => void;
  /** Prunes one safe node from the current trace scope. */
  onTracePruneNode?: (nodeId: string) => void;
  /** Opens expanded schema view for a node's schema without changing the schema filter. */
  onOpenExpandedSchemaViewForNode?: (nodeId: string) => void;
  /** Expands a collapsed schema cluster into objects without changing the schema filter. */
  onExpandExpandedSchemaViewSchema?: (schemaName: string) => void;
  /** Replaces the expanded-schema-view expansion set with this single schema. */
  onCenterExpandedSchemaViewSchema?: (schemaName: string) => void;
  /** True when overview renders both schema and object granularities. */
  isExpandedSchemaViewActive?: boolean;
  /** Schemas currently expanded into object nodes in Expanded Schema View. */
  expandedSchemas?: ReadonlySet<string>;
  /** Collapses all expanded schemas and returns to Schema View. */
  onResetExpandedSchemaView?: () => void;
  /** Whether collapsed schema clusters are currently rendered beside expanded object nodes. */
  showExpandedSchemaClusters?: boolean;
  /** Toggles the visual-only rendering of collapsed schema clusters in Expanded Schema View. */
  onToggleExpandedSchemaClusters?: () => void;
  /** Schemas currently expanded in expanded schema view; shown in compact control tooltips. */
  expandedSchemaCount?: number;
  /** Expands all schemas at once and enters Expanded Schema View. */
  onExpandAllSchemas?: () => void;
  /**
   * IDs of working-set nodes collapsed inside a schema cluster, passed to the toolbar search for
   * three-state partitioning.
   */
  collapsedSchemaNodeIds?: Set<string>;
  /** Render-limit notice, placed inside the canvas so it never covers the toolbar or banners. */
  renderLimitNotice?: ReactNode;
}

/** Renders the lineage graph and coordinates viewport, selection, filtering and graph modes. */
export function GraphCanvas({
  flowNodes,
  flowEdges,
  trace,
  filter,
  metrics,
  highlightedNodeId,
  graph,
  config,
  onNodeClick,
  onClearSelection,
  onSchemaNodeSelect,
  onNodeContextMenu,
  onShowDetails,
  onStartTraceImmediate,
  onTraceApply,
  onTraceEnd,
  onResetAll,
  onToggleType,
  onToggleIsolated,
  onToggleFocusSchema,
  onToggleSchema,
  onSelectAllSchemas,
  onSelectNoneSchemas,
  onToggleExternalRefs,
  onToggleExternalRefType,
  exclusionPatterns,
  onAddExclusionPattern,
  onRemoveExclusionPattern,
  availableSchemas,
  renderedSchemas,
  graphErrorContext,
  graphErrorResetKey,
  onRefresh,
  onRebuild,
  onBack,
  onOpenDdlViewer,
  isDetailSearchOpen,
  onToggleDetailSearch,
  isTraceTreeCollapsed,
  onToggleTraceTreeCollapsed,
  traceScopeGraph,
  modelGraph = null,
  setFocusTargets,
  exitFocusPaths,
  isFocusPaths,
  focusTargetIds,
  navigatorTrace,
  onResetTrace,
  onAddTraceNeighbors,
  model,
  infoBarNodeId,
  onCloseInfoBar,
  analysisMode,
  onOpenAnalysis,
  onCloseAnalysis,
  onSelectAnalysisGroup,
  onClearAnalysisGroup,
  onApplyPath,
  isRebuilding = false,
  estimateTraceSize,
  sourceName,
  filterProfiles,
  activeProjectId,
  activeViewId,
  isViewModified,
  onSaveView,
  onApplyView,
  onDeleteView,
  onUpdateView,
  isFilterDirty,
  backRequest,
  isModeLocked = false,
  canRemoveNodeFromScopedView = false,
  canEditTraceScope = false,
  canStartNewScopedMode = false,
  canSwitchGraphMode = false,
  graphMode = 'full',
  onGraphModeChange,
  schemaViewSoftDisabled = false,
  filteredObjectIds,
  onSaveTraceBookmark,
  onSaveAnalysisBookmark,
  aiPreview,
  onSaveAiBookmark,
  onDiscardAiPreview,
  onRemoveFromView,
  activeAdvancedProfile,
  bookmarkStaleNames,
  onExitAdvancedBookmark,
  viewportPreserveVersion = 0,
  onCameraChange,
  pendingViewport,
  onPendingViewportApplied,
  useFullModel,
  onToggleFullModel,
  filteredOutCount,
  onTraceAddNeighbor,
  onTracePruneNode,
  onOpenExpandedSchemaViewForNode,
  onExpandExpandedSchemaViewSchema,
  onCenterExpandedSchemaViewSchema,
  isExpandedSchemaViewActive,
  expandedSchemas,
  onResetExpandedSchemaView,
  showExpandedSchemaClusters = true,
  onToggleExpandedSchemaClusters,
  expandedSchemaCount = 0,
  onExpandAllSchemas,
  collapsedSchemaNodeIds,
  renderLimitNotice,
}: GraphCanvasProps) {
  const { fitView, getNode, setCenter, getNodes, getEdges, setViewport } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const graphRebuildingRef = useRef(isRebuilding);
  graphRebuildingRef.current = isRebuilding;
  const nodesInitializedRef = useRef(nodesInitialized);
  nodesInitializedRef.current = nodesInitialized;
  const displayedGraphRef = useRef({ nodes: flowNodes, edges: flowEdges, sourceNodes: flowNodes, sourceEdges: flowEdges });
  const vscodeApi = useVsCode();

  /** Schema colours of the current graph, collision-resolved across its schemas. */
  const graphSchemaColors = useMemo(
    () => deriveLegendColorMap(flowNodes, model?.identifierCaseSensitive),
    [flowNodes, model?.identifierCaseSensitive],
  );
  /**
   * A node's canvas colour: the external colour, else its schema's colour in the current graph; a
   * schema outside the graph (a filtered trace node) falls back to the per-schema hash.
   */
  const resolveNodeColor = useCallback((schema: string, objectType?: string): string => {
    if (objectType === 'external') return getExternalNodeColor();
    return graphSchemaColors.get(schemaKey(schema, model?.identifierCaseSensitive))
      ?? getSchemaColor(schema, undefined, model?.identifierCaseSensitive);
  }, [graphSchemaColors, model?.identifierCaseSensitive]);

  const [localNodes, setLocalNodes] = useState<FlowNode[]>(flowNodes);
  const [localEdges, setLocalEdges] = useState<FlowEdge[]>(flowEdges);
  const [syncedGraph, setSyncedGraph] = useState({ nodes: flowNodes, edges: flowEdges });
  const [columnView, setColumnView] = useState(false);

  const activeAiMetadata = activeAdvancedProfile?.aiMetadata ?? aiPreview?.aiMetadata;
  const aiDescription = activeAiMetadata?.description;

  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<number | null>(null);
  const aiPanelDefaultOpen = !!(
    (aiPreview && aiPreview.nodeIds.size === 0) ||
    (activeAdvancedProfile && (activeAdvancedProfile.filter.allowlistNodeIds?.length ?? 0) === 0)
  );
  const aiViewName = activeAdvancedProfile?.name ?? aiPreview?.name ?? '';
  const aiLayoutCache = useRef(new Map<string, { open: boolean; section: number | null }>());
  useEffect(() => {
    if (!aiDescription) return;
    const cached = aiLayoutCache.current.get(aiLayoutCacheKey(activeAdvancedProfile?.id, aiViewName));
    setAiPanelOpen(cached?.open ?? aiPanelDefaultOpen);
    setActiveSection(cached?.section ?? null);
  }, [aiDescription, aiPanelDefaultOpen, activeAdvancedProfile?.id, aiViewName]);
  useEffect(() => {
    if (!aiDescription) return;
    aiLayoutCache.current.set(aiLayoutCacheKey(activeAdvancedProfile?.id, aiViewName), { open: aiPanelOpen, section: activeSection });
  }, [aiDescription, activeAdvancedProfile?.id, aiViewName, aiPanelOpen, activeSection]);
  const aiSectionsRef = useRef<AiReportSection[]>([]);

  /**
   * Generation of every pending programmatic camera fit (AI-panel refit, section-focus, column-view
   * toggle, AI description and graph-change fits). Each fit claims the next value on scheduling; a
   * user pan/zoom (`onMoveStart` with a real event) bumps it so fits in flight no-op.
   */
  const fitGenerationRef = useRef(0);
  /** `ReactFlow`'s `onMoveStart` — bumps the fit generation only for a real user gesture. */
  const handleMoveStart = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (isUserMoveEvent(event)) fitGenerationRef.current++;
  }, []);

  /**
   * The report navigated to a section: lights its labels and frames its objects. Only this path
   * frames, because a node click also sets the active section and moving the graph under that click
   * would take the node from under the pointer.
   */
  const handleFocusSection = useCallback((n: number | null) => {
    setActiveSection(n);
    if (n == null) return;
    const nodeIds = aiSectionsRef.current.find(section => section.n === n)?.nodeIds;
    if (!nodeIds?.length) return;
    const nodes = nodeIds.map(id => ({ id }));
    scheduleFit(
      fitGenerationRef,
      () => { void fitView({ nodes, padding: FIT_VIEW_PADDING, duration: FIT_VIEW_DURATION }); },
    );
  }, [fitView]);
  const [dockPosition, setDockPositionState] = useState<AiDockPosition>(() => {
    const saved = (vscodeApi.getState() as Record<string, unknown> | undefined)?.[AI_DOCK_STATE_KEY];
    return saved === 'left' || saved === 'bottom' ? saved : 'right';
  });
  /** The report panel's measured size on the current dock edge; null until it reports there. */
  const [panelSizePx, setPanelSizePx] = useState<{ width: number; height: number } | null>(null);
  /** Moves the report to another edge, dropping the size measured on the old one. */
  const setDockPosition = useCallback((position: AiDockPosition) => {
    if (position === dockPosition) return;
    setDockPositionState(position);
    setPanelSizePx(null);
    vscodeApi.setState({ ...(vscodeApi.getState() ?? {}), [AI_DOCK_STATE_KEY]: position });
  }, [vscodeApi, dockPosition]);
  const handleAiPanelResize = useCallback((width: number, height: number) => {
    setPanelSizePx(prev => (prev && prev.width === width && prev.height === height) ? prev : { width, height });
  }, []);
  const aiCanvasReserve: CSSProperties = !(aiDescription && aiPanelOpen)
    ? { inset: 0 }
    : dockPosition === 'bottom'
      ? { top: 0, left: 0, right: 0, bottom: panelSizePx ? panelSizePx.height : AI_PANEL_DEFAULT_HEIGHT }
      : dockPosition === 'left'
        ? { top: 0, bottom: 0, right: 0, left: panelSizePx ? panelSizePx.width : AI_PANEL_DEFAULT_WIDTH }
        : { top: 0, bottom: 0, left: 0, right: panelSizePx ? panelSizePx.width : AI_PANEL_DEFAULT_WIDTH };
  useEffect(() => {
    if (!aiDescription) return;
    return scheduleFit(
      fitGenerationRef,
      () => { void fitView({ padding: FIT_VIEW_PADDING, duration: FIT_VIEW_DURATION }); },
      (run) => window.setTimeout(run, AI_PANEL_REFIT_DELAY),
      (id) => window.clearTimeout(id),
    );
  }, [aiPanelOpen, dockPosition, aiDescription, fitView]);

  /**
   * Column-level rendering of the active trace; null when the run recorded no column findings.
   * Derived above the `ErrorBoundary` around the React Flow subtree, so a throw would reload the
   * whole webview; it degrades to `null` instead.
   */
  const columnTraceView = useMemo(() => {
    const relations = activeAiMetadata?.columnAspect?.edges;
    if (!relations?.length) return null;
    try {
      const identifierKey = (id: string): string => schemaKey(id, model?.identifierCaseSensitive);
      const columnTypesByNode = new Map<string, ReadonlyMap<string, string>>();
      const columnNamesByNode = new Map<string, ReadonlyMap<string, string>>();
      for (const node of model?.nodes ?? []) {
        if (node.columns?.length) {
          columnTypesByNode.set(identifierKey(node.id), new Map(node.columns.map(c => [normalizeColName(c.name, model?.identifierCaseSensitive), c.type])));
          columnNamesByNode.set(identifierKey(node.id), new Map(node.columns.map(c => [normalizeColName(c.name, model?.identifierCaseSensitive), c.name])));
        }
      }
      const objects = new Map<string, ColumnTraceViewObject>();
      for (const node of flowNodes) {
        if (node.type === 'schemaNode') continue;
        const data = node.data as CustomNodeData;
        objects.set(identifierKey(node.id), {
          id: node.id,
          label: data.label,
          schema: data.schema,
          objectType: data.objectType,
          columnTypes: columnTypesByNode.get(identifierKey(node.id)),
          columnNames: columnNamesByNode.get(identifierKey(node.id)),
        });
      }
      const verdicts = activeAiMetadata?.nodeVerdicts?.length
        ? new Map(activeAiMetadata.nodeVerdicts.map(v => [identifierKey(v.nodeId), v.verdict]))
        : undefined;
      return buildColumnTraceView({
        identifierCaseSensitive: model?.identifierCaseSensitive,
        relations,
        objects,
        objectEdges: flowEdges,
        verdicts,
        config,
        layoutDirection: activeAiMetadata?.layoutDirection,
      });
    } catch (err) {
      vscodeApi.postMessage({
        type: 'log',
        level: 'warn',
        text: `[Graph] Column view unavailable: ${errorMessage(err)}`,
      });
      return null;
    }
  }, [activeAiMetadata, config, flowNodes, flowEdges, model, vscodeApi]);

  /** Whether the column view — not the object view — is the rendering currently on stage. */
  const columnViewActive = columnView && !!columnTraceView;

  /**
   * Node positions in object space, for the draw.io export. `getNodes()` yields column-trace nodes
   * (same ids, other coordinate space) while the column view is active, so this reads `localNodes`,
   * which `onColumnNodesChange` leaves untouched.
   */
  const objectNodes = useCallback(() => (columnViewActive ? localNodes : getNodes()), [columnViewActive, localNodes, getNodes]);

  const pendingZoomRef = useRef<string | null>(null);
  const pendingClickRef = useRef<{ id: string; searchTerm?: string } | null>(null);
  /** When pendingZoomRef was set; stale refs expire after PENDING_ZOOM_TIMEOUT_MS. */
  const pendingZoomSetAt = useRef<number>(0);
  /** Active timer — guarantees the pendingZoom warning fires even if flowNodes stops changing. */
  const pendingZoomTimerRef = useRef<number | null>(null);
  const clearPendingZoomTimer = useCallback(() => {
    if (!pendingZoomTimerRef.current) return;
    clearTimeout(pendingZoomTimerRef.current);
    pendingZoomTimerRef.current = null;
  }, []);
  useEffect(() => clearPendingZoomTimer, [clearPendingZoomTimer]);

  /**
   * Arms a zoom for a node the expanded schema view has yet to reveal; `searchTerm` is highlighted
   * in the detail panel by the deferred click.
   *
   * The graph-change effect expires a pending zoom against {@link pendingZoomSetAt}; not stamping
   * it here would expire the zoom before the expanded graph arrives.
   */
  const armPendingZoom = useCallback((nodeId: string, searchTerm?: string) => {
    pendingZoomRef.current = nodeId;
    pendingClickRef.current = { id: nodeId, searchTerm };
    pendingZoomSetAt.current = Date.now();
    clearPendingZoomTimer();
    pendingZoomTimerRef.current = window.setTimeout(() => {
      if (!pendingZoomRef.current) return;
      notifyUser(`"${pendingZoomRef.current}" is not visible in the current view. Adjust your schema filter to include it.`);
      pendingZoomRef.current = null;
      pendingClickRef.current = null;
    }, PENDING_ZOOM_TIMEOUT_MS);
  }, [clearPendingZoomTimer]);
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;
  const currentTraceRef = useRef(trace);
  currentTraceRef.current = trace;
  const traceAtLastGraphChangeRef = useRef(trace);
  const fitPaddingRef = useRef<FitViewPadding>(FIT_VIEW_PADDING);
  const viewportPreserveVersionRef = useRef(viewportPreserveVersion);
  viewportPreserveVersionRef.current = viewportPreserveVersion;
  const consumedViewportPreserveVersionRef = useRef(viewportPreserveVersion);

  const aiSections = useMemo((): AiReportSection[] => {
    const badges = activeAiMetadata?.badges;
    if (!badges?.length) return [];
    const byNumber = new Map<number, AiReportSection>();
    for (const badge of badges) {
      const match = /^(\d+)\s+(.+)$/.exec(badge.text);
      if (!match) continue;
      const n = Number(match[1]);
      const existing = byNumber.get(n);
      if (existing) existing.nodeIds.push(badge.nodeId);
      else byNumber.set(n, { n, label: match[2], nodeIds: [badge.nodeId] });
    }
    return [...byNumber.values()].sort((a, b) => a.n - b.n);
  }, [activeAiMetadata]);
  useEffect(() => {
    aiSectionsRef.current = aiSections;
  }, [aiSections]);

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (graphMode === 'overview' && node.type === 'schemaNode') {
        onSchemaNodeSelect?.(node.id);
        setLocalNodes((nds) => nds.map((n) =>
          n.type === 'schemaNode' && (n.data as SchemaNodeData).toolbarActive
            ? { ...n, data: { ...n.data, toolbarActive: false } }
            : n
        ));
        return;
      }
      const matches = sectionsForNode(aiSections, node.id);
      setActiveSection(matches[0] ?? null);
      setPinnedColumn(null);
      setTreeRoute(null);
      onNodeClick(node.id);
    },
    [graphMode, onNodeClick, onSchemaNodeSelect, aiSections]
  );

  const handleNodeDoubleClick: NodeMouseHandler = useCallback(
    (event, node) => {
      if (node.type !== 'schemaNode') {
        onShowDetails?.(node.id);
        return;
      }
      if (graphMode !== 'overview') return;
      event.preventDefault();
      setLocalNodes((nds) => nds.map((n) => n.selected ? { ...n, selected: false } : n));
      const schemaName = (node.data as SchemaNodeData).schemaName;
      if (config.overview.schemaDoubleClickBehavior === 'expand') {
        onExpandExpandedSchemaViewSchema?.(schemaName);
      } else {
        onCenterExpandedSchemaViewSchema?.(schemaName);
      }
    },
    [config.overview.schemaDoubleClickBehavior, graphMode, onCenterExpandedSchemaViewSchema, onExpandExpandedSchemaViewSchema, onShowDetails]
  );

  const handleFitView = useCallback(() => {
    void fitView({ padding: fitPaddingRef.current, duration: FIT_VIEW_DURATION });
  }, [fitView]);

  const handleSaveTraceAsBookmark = useCallback((name: string) => {
    if (!onSaveTraceBookmark) return;
    onSaveTraceBookmark(name, Array.from(trace.tracedNodeIds));
  }, [onSaveTraceBookmark, trace.tracedNodeIds]);

  const handleSaveAnalysisAsBookmark = useCallback((name: string) => {
    if (!onSaveAnalysisBookmark || !analysisMode) return;
    const activeGroup = analysisMode.activeGroupId
      ? analysisMode.result.groups.find(g => g.id === analysisMode.activeGroupId)
      : null;
    const nodeIds = activeGroup
      ? activeGroup.nodeIds
      : analysisMode.result.groups.flatMap(g => g.nodeIds);
    onSaveAnalysisBookmark(name, nodeIds);
  }, [onSaveAnalysisBookmark, analysisMode]);

  const handleSaveAiAsBookmark = useCallback((name: string) => {
    onSaveAiBookmark?.(name);
  }, [onSaveAiBookmark]);

  useKeyboardShortcut(SHORTCUT_KEYS.fitView, handleFitView);

  const minimapNodeColor = useCallback(
    (node: FlowNode) => {
      if (node.type === 'schemaNode') {
        const color = (node.data as SchemaNodeData).color;
        return isExpandedSchemaViewActive
          ? `color-mix(in srgb, ${color} 28%, transparent)`
          : color;
      }
      if (node.type === 'columnTraceNode') {
        const data = node.data as ColumnTraceNodeData;
        return data.schemaColor ?? resolveNodeColor(data.view.schema, data.view.objectType);
      }
      const d = node.data as CustomNodeData;
      return d.objectType === 'external' ? getExternalNodeColor() : (d.schemaColor ?? resolveNodeColor(String(d.schema)));
    },
    [isExpandedSchemaViewActive, resolveNodeColor]
  );

  const minimapNodeStrokeColor = useCallback(
    (node: FlowNode) => (node.type === 'schemaNode'
      ? 'var(--ln-minimap-cluster-stroke)'
      : 'transparent'),
    []
  );

  /**
   * Pending {@link zoomToNode} frame, cancelled by the next call or unmount so repeat searches
   * never queue competing `setCenter` calls.
   */
  const zoomToNodeFrameRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (zoomToNodeFrameRef.current !== null) cancelAnimationFrame(zoomToNodeFrameRef.current);
  }, []);

  const zoomToNode = useCallback((nodeId: string) => {
    if (zoomToNodeFrameRef.current !== null) cancelAnimationFrame(zoomToNodeFrameRef.current);
    zoomToNodeFrameRef.current = requestAnimationFrame(() => {
      zoomToNodeFrameRef.current = null;
      const targetNode = getNode(nodeId);
      if (targetNode?.position) {
        const width = targetNode.width ?? NODE_WIDTH;
        const height = targetNode.height ?? NODE_HEIGHT;
        void setCenter(
          targetNode.position.x + width / 2,
          targetNode.position.y + height / 2,
          { zoom: 0.8, duration: FIT_VIEW_DURATION }
        );
      } else {
        notifyUser(`Could not focus "${nodeId}". The node may have been filtered out during a view transition.`);
      }
    });
  }, [getNode, setCenter]);

  const handleAiFocusNode = useCallback((nodeId: string) => {
    zoomToNode(nodeId);
    onNodeClick(nodeId);
  }, [zoomToNode, onNodeClick]);

  /** Origin→node route lit by a trace tree row; null when no row route is active. */
  const [treeRoute, setTreeRoute] = useState<{ targetId: string; nodeIds: ReadonlySet<string>; edgeIds: ReadonlySet<string> } | null>(null);
  /** The row route while its row is still the selection; a canvas click elsewhere drops it. */
  const activeRoute = treeRoute && treeRoute.targetId === highlightedNodeId ? treeRoute : null;

  /**
   * Selects a tree row's node on the canvas once. A row click focuses (react-arborist `onFocus`)
   * then activates in the same event, so this ref, not the render's `highlightedNodeId`, stops the
   * second call selecting again.
   */
  const treeSelectionRef = useRef(highlightedNodeId);
  treeSelectionRef.current = highlightedNodeId;
  const selectTreeNode = useCallback((nodeId: string) => {
    if (treeSelectionRef.current === nodeId) return;
    treeSelectionRef.current = nodeId;
    onNodeClick(nodeId);
  }, [onNodeClick]);

  /**
   * Tree-row activation: canvas selection, plus lighting of every origin↔node connecting path with
   * the camera fitted to the route. The origin needs no override (the trace-origin rule keeps it
   * lit). While routes are shown a click only selects: every route stays lit and the camera keeps
   * framing their union.
   */
  const handleTreeRowSelect = useCallback((nodeId: string) => {
    selectTreeNode(nodeId);
    const originId = trace.selectedNodeId;
    const path = originId && nodeId !== originId && traceScopeGraph && !isFocusPaths
      ? unionConnectingPaths(traceScopeGraph, originId, [nodeId])
      : null;
    if (!path) {
      setTreeRoute(null);
      return;
    }
    setTreeRoute({ targetId: nodeId, nodeIds: path.nodeIds, edgeIds: path.edgeIds });
    void fitView({
      nodes: [...path.nodeIds].map(id => ({ id })),
      padding: fitPaddingRef.current,
      duration: FIT_VIEW_DURATION,
    });
  }, [selectTreeNode, trace.selectedNodeId, traceScopeGraph, isFocusPaths, fitView]);

  /** Starting-point activation: no selection, so nothing dims, and every node on stage framed. */
  const handleTraceShowWhole = useCallback(() => {
    onClearSelection?.();
    setTreeRoute(null);
    void fitView({ padding: fitPaddingRef.current, duration: FIT_VIEW_DURATION });
  }, [onClearSelection, fitView]);

  useEffect(() => {
    setTreeRoute(null);
  }, [trace.mode, trace.selectedNodeId, trace.tracedNodeIds]);

  const flowNodeLookup = useMemo(() => {
    const ids = new Set<string>();
    const byId = new Map<string, FlowNode>();
    const byLabel = new Map<string, FlowNode>();
    const bySchemaLabel = new Map<string, FlowNode>();
    for (const n of flowNodes) {
      ids.add(n.id);
      if (!byId.has(n.id)) byId.set(n.id, n);
      const label = String(n.data.label ?? '');
      if (!byLabel.has(label)) byLabel.set(label, n);
      const key = searchKey(String(n.data.schema ?? ''), label);
      if (!bySchemaLabel.has(key)) bySchemaLabel.set(key, n);
    }
    return { ids, byId, byLabel, bySchemaLabel };
  }, [flowNodes]);

  const modelNodeNameLookup = useMemo(() => {
    const byName = new Map<string, ModelNode>();
    const bySchemaName = new Map<string, ModelNode>();
    for (const n of model?.nodes ?? []) {
      if (!byName.has(n.name)) byName.set(n.name, n);
      const key = searchKey(n.schema, n.name);
      if (!bySchemaName.has(key)) bySchemaName.set(key, n);
    }
    return { byName, bySchemaName };
  }, [model]);

  const handleExecuteSearch = useCallback((name: string, schema?: string) => {
    const label = schema ? `[${schema}].[${name}]` : name;
    const foundNode = schema
      ? flowNodeLookup.bySchemaLabel.get(searchKey(schema, name))
      : flowNodeLookup.byLabel.get(name);

    if (foundNode) {
      onNodeClick(foundNode.id);
      zoomToNode(foundNode.id);
      return;
    }

    if (graphMode === 'overview' && model) {
      const modelNode = schema
        ? modelNodeNameLookup.bySchemaName.get(searchKey(schema, name))
        : modelNodeNameLookup.byName.get(name);
      if (modelNode) {
        armPendingZoom(modelNode.id);
        onOpenExpandedSchemaViewForNode?.(modelNode.id);
      } else {
        notifyUser(`"${label}" was not found in the loaded model.`);
      }
    } else {
      notifyUser(`"${label}" is not visible in the current view. Adjust your schema or type filters to include it.`);
    }
  }, [armPendingZoom, flowNodeLookup, zoomToNode, onNodeClick, graphMode, model, modelNodeNameLookup, onOpenExpandedSchemaViewForNode]);

  /** Host `focus-object` requests (the Search Objects quick pick) take the Quick Jump path. */
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if ((e.data as { type?: unknown } | null)?.type !== 'focus-object') return;
      const frame = validateBridgeFrame(ExtensionToWebviewMsgSchema, e.data);
      if (frame.ok && frame.data.type === 'focus-object') handleExecuteSearch(frame.data.name, frame.data.schema);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [handleExecuteSearch]);

  const handleExportDrawio = useCallback(() => {
    const exportObjectNodes: FlowNode<CustomNodeData>[] = [];
    const clusterNodes: FlowNode<SchemaNodeData>[] = [];
    const exportNodes = objectNodes();
    const exportEdges = columnViewActive ? localEdges : getEdges();
    for (const n of exportNodes) {
      if (n.type === 'schemaNode') clusterNodes.push(n as FlowNode<SchemaNodeData>);
      else exportObjectNodes.push(n as FlowNode<CustomNodeData>);
    }
    import('../export/drawioExporter').then(({ exportToDrawio, exportSchemaOverviewToDrawio }) => {
      const schemas = (availableSchemas || []).filter(s => filter.schemas.has(s));
      const xml = (exportObjectNodes.length === 0 && clusterNodes.length > 0)
        ? exportSchemaOverviewToDrawio(clusterNodes, exportEdges, schemas, model?.identifierCaseSensitive)
        : exportToDrawio(exportObjectNodes, exportEdges, schemas, clusterNodes, model?.identifierCaseSensitive);
      if (!xml) return;
      const base = (sourceName?.replace(/\.dacpac$/i, '') || 'lineage').trim().replace(/[\\/:*?"<>|]/g, '_');
      vscodeApi.postMessage({ type: 'export-file', data: xml, defaultName: `${base}_lineage.drawio` });
    }).catch((err) => {
      vscodeApi.postMessage({ type: 'error', error: `Draw.io export failed: ${err instanceof Error ? err.message : err}` });
    });
  }, [objectNodes, columnViewActive, localEdges, getEdges, availableSchemas, filter.schemas, sourceName, vscodeApi, model?.identifierCaseSensitive]);

  /**
   * The one auto-fit: frames every node once the displayed graph is ready, with the shared padding
   * and duration; a later user pan/zoom bumps {@link fitGenerationRef} so it no-ops.
   *
   * Waits until React Flow has the requested node positions, measured bounds and edges, so a view
   * arriving before measurement never frames the previous graph's bounds.
   *
   * @returns A cancel to return directly as an effect's cleanup.
   */
  const armGraphFit = useCallback((): (() => void) => scheduleFit(
    fitGenerationRef,
    () => { void fitView({ padding: fitPaddingRef.current, duration: FIT_VIEW_DURATION }); },
    undefined, undefined,
    () => {
      const displayed = displayedGraphRef.current;
      return displayed.sourceNodes === flowNodes && displayed.sourceEdges === flowEdges
        && !graphRebuildingRef.current && (nodesInitializedRef.current || displayed.nodes.every(node => node.hidden))
        && graphReadyForFit(displayed.nodes, displayed.edges, getNodes(), getEdges());
    },
  ), [fitView, flowNodes, flowEdges, getNodes, getEdges, columnViewActive]);
  const fitGraph = useRebuildResumableFit(isRebuilding, fitGenerationRef, armGraphFit);

  const nodesAtLastFitEffectRef = useRef(flowNodes);
  const shownTraceMode = ['applied', 'filtered', 'path-applied', 'analysis'].includes(trace.mode) ? trace.mode : null;

  /**
   * Fits graph changes and newly shown AI, trace and analytics views, including repeated shows with
   * unchanged node membership; a stored viewport restoration takes precedence. A manual add/prune
   * trace-scope edit is not reframed, since the edited node is on screen and a fit would move the
   * view from under the click.
   */
  useEffect(() => {
    const nodeDataChanged = nodesAtLastFitEffectRef.current !== flowNodes;
    nodesAtLastFitEffectRef.current = flowNodes;
    const previousTrace = traceAtLastGraphChangeRef.current;
    const currentTrace = currentTraceRef.current;
    traceAtLastGraphChangeRef.current = currentTrace;

    const zoomTarget = pendingZoomRef.current;
    const clickTarget = pendingClickRef.current;
    if (zoomTarget) {
      const nodeExists = flowNodeLookup.ids.has(zoomTarget);
      const elapsed = Date.now() - pendingZoomSetAt.current;
      if (!nodeExists) {
        if (elapsed > PENDING_ZOOM_TIMEOUT_MS) {
          notifyUser(`"${zoomTarget}" is not visible in the current view. Adjust your schema filter to include it.`);
          pendingZoomRef.current = null;
          pendingClickRef.current = null;
          clearPendingZoomTimer();
        } else {
          return; // Don't consume — wait for the next flowNodes update (silent; fires every render)
        }
      } else {
        pendingZoomRef.current = null;
        pendingClickRef.current = null;
        clearPendingZoomTimer();
        zoomToNode(zoomTarget);
        if (clickTarget) {
          requestAnimationFrame(() => onNodeClickRef.current(clickTarget.id, clickTarget.searchTerm));
        }
        return;
      }
    }
    if (skipFitForPendingViewport(viewportPreserveVersionRef.current, consumedViewportPreserveVersionRef, nodeDataChanged)) return;
    if (isManualTraceScopeEdit(previousTrace, currentTrace)) return;
    return fitGraph();
  }, [clearPendingZoomTimer, flowNodes, fitGraph, zoomToNode, aiPreview, analysisMode,
    shownTraceMode, trace.tracedNodeIds]);
  // onNodeClickRef is intentionally excluded from the deps: the effect reads it at run time.

  const [notesVisible, setNotesVisible] = useState(true);
  const [hoveredColumn, setHoveredColumn] = useState<{ nodeId: string; column: string } | null>(null);
  const [pinnedColumn, setPinnedColumn] = useState<{ nodeId: string; column: string } | null>(null);
  const [columnPositions, setColumnPositions] = useState<Record<string, { x: number; y: number }>>({});

  const nodeDecorationCache = useRef(createNodeDecorationCache());

  const edgeDecorationCache = useRef(createEdgeDecorationCache());

  const columnNodeCache = useRef(createColumnNodeCache());

  const fittedForColumnViewRef = useRef<boolean | null>(null);

  /**
   * Node ids mid-drag, read by the sync effect so a rebuild landing mid-drag never resets the
   * dragged node's position under the pointer.
   */
  const draggingNodeIdsRef = useRef<Set<string> | null>(null);
  /** The `flowNodes` the sync effect deferred during a drag; applied on drag stop. */
  const deferredFlowNodesRef = useRef<FlowNode[] | null>(null);

  useEffect(() => {
    if (draggingNodeIdsRef.current) {
      deferredFlowNodesRef.current = flowNodes;
      return;
    }
    setLocalNodes(flowNodes);
    setSyncedGraph(current => ({ ...current, nodes: flowNodes }));
  }, [flowNodes]);

  useEffect(() => {
    setLocalEdges(flowEdges.map(withEdgeBaseWidthVar));
    setSyncedGraph(current => ({ ...current, edges: flowEdges }));
  }, [flowEdges]);

  const pendingViewportRef = useRef(pendingViewport);
  /**
   * {@link fitGenerationRef} when `pendingViewport` first became this truthy value: its arming
   * generation.
   */
  const pendingViewportGenerationRef = useRef(fitGenerationRef.current);
  if (pendingViewport && pendingViewport !== pendingViewportRef.current) {
    pendingViewportGenerationRef.current = fitGenerationRef.current;
  }
  pendingViewportRef.current = pendingViewport;
  const onPendingViewportAppliedRef = useRef(onPendingViewportApplied);
  onPendingViewportAppliedRef.current = onPendingViewportApplied;
  const setViewportRef = useRef(setViewport);
  setViewportRef.current = setViewport;

  /**
   * Applies a restored viewport once after the graph-data update it was captured for, then clears
   * it. Runs after the {@link fitGraph} owner; the caller pairs a `pendingViewport` with
   * `preserveViewportOnNextGraphChange` so that owner skips its fit for this update. The update is
   * often deferred via `startTransition`, so {@link applyPendingViewport} gates it: a user pan/zoom
   * in that gap must win over the stale camera.
   */
  useEffect(() => {
    const pending = pendingViewportRef.current;
    if (!pending) return;
    applyPendingViewport(pending, fitGenerationRef.current, pendingViewportGenerationRef.current, setViewportRef.current);
    onPendingViewportAppliedRef.current?.();
  }, [flowNodes]);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setLocalNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );

  /**
   * Marks a drag live so the `localNodes` sync effect defers a rebuild landing mid-drag, rather
   * than deriving drag state from `applyNodeChanges` position events (one frame late).
   */
  const handleNodeDragStart: OnNodeDrag = useCallback((_event, node, nodes) => {
    fitGenerationRef.current++;
    draggingNodeIdsRef.current = new Set((nodes.length ? nodes : [node]).map(n => n.id));
  }, []);

  /**
   * Releases the drag and applies any rebuild deferred during it: dragged nodes keep their dropped
   * position, all others take the rebuilt shape. See {@link mergeIncomingNodesPreservingDrag}.
   */
  const handleNodeDragStop: OnNodeDrag = useCallback((_event, node, nodes) => {
    fitGenerationRef.current++;
    const draggingIds = draggingNodeIdsRef.current ?? new Set((nodes.length ? nodes : [node]).map(n => n.id));
    draggingNodeIdsRef.current = null;
    const deferred = deferredFlowNodesRef.current;
    if (!deferred) return;
    deferredFlowNodesRef.current = null;
    setLocalNodes(current => mergeIncomingNodesPreservingDrag(deferred, current, draggingIds));
    setSyncedGraph(current => ({ ...current, nodes: deferred }));
  }, []);

  /**
   * Node changes while the column view is on stage. Column nodes share ids with the object nodes
   * they replace, so routing their changes through `onNodesChange` would corrupt the positions the
   * Draw.io export reads; only the drag is kept.
   */
  const onColumnNodesChange: OnNodesChange = useCallback((changes) => {
    setColumnPositions((prev) => {
      let next = prev;
      for (const change of changes) {
        if (change.type !== 'position' || !change.position) continue;
        if (next === prev) next = { ...prev };
        next[change.id] = { x: change.position.x, y: change.position.y };
      }
      return next;
    });
  }, []);

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setLocalEdges((eds) => applyEdgeChanges(changes, eds)),
    []
  );

  const onCameraChangeRef = useRef(onCameraChange);
  onCameraChangeRef.current = onCameraChange;

  /**
   * Shows or hides AI notes as the canvas crosses the legibility zoom. The band is wider than one
   * threshold, since `notesVisible` feeds every node's decoration and a gesture resting on one zoom
   * value would rebuild the node set on each crossing. Off below {@link NOTES_ZOOM_OUT}, on above
   * {@link NOTES_ZOOM_IN}.
   */
  const handleViewportChange = useCallback((vp: { x: number; y: number; zoom: number }) => {
    setNotesVisible(prev => {
      if (prev && vp.zoom < NOTES_ZOOM_OUT) return false;
      if (!prev && vp.zoom > NOTES_ZOOM_IN) return true;
      return prev;
    });
    onCameraChangeRef.current?.(vp);
  }, []);

  const modelNodeMap = useMemo(() => {
    if (!model) return new Map<string, DatabaseModel['nodes'][number]>();
    const map = new Map<string, DatabaseModel['nodes'][number]>();
    for (const n of model.nodes) map.set(n.id, n);
    return map;
  }, [model]);

  const modelNodeMapLower = useMemo(() => {
    const map = new Map<string, DatabaseModel['nodes'][number]>();
    if (!model?.identifierCaseSensitive) for (const n of modelNodeMap.values()) map.set(n.id.toLowerCase(), n);
    return map;
  }, [modelNodeMap, model?.identifierCaseSensitive]);


  const level1Neighbors = useMemo(() => {
    const neighbors = new Set<string>();
    if (highlightedNodeId && graph && graph.hasNode(highlightedNodeId)) {
      const nodeNeighbors = graph.neighbors(highlightedNodeId);
      nodeNeighbors.forEach(n => neighbors.add(n));
    }
    return neighbors;
  }, [highlightedNodeId, graph]);

  const isBookmarkMode = (filter.allowlistNodeIds?.size ?? 0) > 0;

  const aiHighlightMap = useMemo((): Map<string, { color: string; glow: string; shadow: string }> => {
    const m = new Map<string, { color: string; glow: string; shadow: string }>();
    const groups = activeAiMetadata?.highlightGroups;
    if (!groups) return m;
    for (const g of groups) {
      const code = resolveAiColor(g.color || 'bu');
      const glowEntry = AI_COLOR_GLOW[code] ?? AI_COLOR_GLOW.gy;
      const entry = { color: AI_COLOR_HEX[code] ?? AI_COLOR_HEX.gy, glow: glowEntry.glow, shadow: glowEntry.shadow };
      for (const id of g.nodeIds) m.set(id, entry);
    }
    return m;
  }, [activeAiMetadata]);

  const activeSectionNodeIds = useMemo((): Set<string> | null => {
    if (activeSection == null) return null;
    const section = aiSections.find(s => s.n === activeSection);
    return section?.nodeIds.length ? new Set(section.nodeIds) : null;
  }, [aiSections, activeSection]);

  const aiBadgeMap = useMemo((): Map<string, AiBadge> => {
    const m = new Map<string, AiBadge>();
    const badges = activeAiMetadata?.badges;
    if (!badges) return m;
    for (const b of badges) {
      if (m.has(b.nodeId)) continue;
      const emphasis = activeSectionNodeIds ? (activeSectionNodeIds.has(b.nodeId) ? 'lit' : 'dim') : undefined;
      m.set(b.nodeId, emphasis ? { text: b.text, emphasis } : { text: b.text });
    }
    return m;
  }, [activeAiMetadata, activeSectionNodeIds]);

  const aiNoteMap = useMemo((): Map<string, { text: string }> => {
    const m = new Map<string, { text: string }>();
    const notes = activeAiMetadata?.notes;
    if (!notes) return m;
    for (const n of notes) m.set(n.nodeId, { text: n.text });
    return m;
  }, [activeAiMetadata]);

  const columnThreadIndex = useMemo(
    () => (columnTraceView ? buildColumnThreadIndex(columnTraceView) : null),
    [columnTraceView],
  );

  /**
   * The active row's trace cone: upstream sources and downstream consumers, never a sibling input
   * sharing an output. See {@link columnThread}.
   */
  const hoveredColumnPath = useMemo((): Set<string> | null => {
    const active = pinnedColumn ?? hoveredColumn;
    if (!active || !columnThreadIndex) return null;
    return columnThread(columnThreadIndex, columnRowKey(active.nodeId, active.column, model?.identifierCaseSensitive));
  }, [pinnedColumn, hoveredColumn, columnThreadIndex, model?.identifierCaseSensitive]);

  const traceControlsByNode = useMemo((): Map<string, TraceNodeControls> => {
    const controls = new Map<string, TraceNodeControls>();
    const isEditableTrace = canEditTraceScope && isEditableTraceMode(trace.mode);
    if (!model || !modelGraph || !trace.selectedNodeId || !isEditableTrace || !onTraceAddNeighbor || !onTracePruneNode) {
      return controls;
    }
    const targetNode = highlightedNodeId
      ? localNodes.find(n => n.id === highlightedNodeId && n.type === 'lineageNode')
      : undefined;
    if (!targetNode) return controls;

    const visibleIds = trace.tracedNodeIds;
    const sides = traceRemovalSides(trace.upstreamLevels, trace.downstreamLevels);

    controls.set(targetNode.id, {
      in: buildTraceSideControls(model, modelGraph, targetNode.id, 'in', visibleIds, trace.selectedNodeId, modelNodeMap, modelNodeMapLower, sides),
      out: buildTraceSideControls(model, modelGraph, targetNode.id, 'out', visibleIds, trace.selectedNodeId, modelNodeMap, modelNodeMapLower, sides),
      onAdd: onTraceAddNeighbor,
      onPrune: onTracePruneNode,
    });
    return controls;
  }, [localNodes, model, modelGraph, modelNodeMap, modelNodeMapLower, onTraceAddNeighbor, onTracePruneNode, trace.mode, trace.selectedNodeId, trace.upstreamLevels, trace.downstreamLevels, trace.tracedNodeIds, highlightedNodeId, canEditTraceScope]);

  const handleColumnHover = useCallback((nodeId: string, column: string | null) => {
    setHoveredColumn(column === null ? null : { nodeId, column });
  }, []);

  const handleColumnSelect = useCallback((nodeId: string, column: string) => {
    setActiveSection(null);
    onClearSelection?.();
    setPinnedColumn(current => (current?.nodeId === nodeId && current.column === column ? null : { nodeId, column }));
  }, [onClearSelection]);

  useKeyboardShortcut(SHORTCUT_KEYS.exitMode, () => setPinnedColumn(null), false, {
    priority: ESC_PRIORITY.overlay,
    active: !!pinnedColumn,
  });

  const columnHover = useMemo((): ColumnHoverState => ({
    hoveredPath: hoveredColumnPath,
    onColumnHover: handleColumnHover,
    onColumnSelect: handleColumnSelect,
    pinnedRow: pinnedColumn ? columnRowKey(pinnedColumn.nodeId, pinnedColumn.column, model?.identifierCaseSensitive) : null,
  }), [hoveredColumnPath, handleColumnHover, handleColumnSelect, pinnedColumn, model?.identifierCaseSensitive]);

  const handleToggleColumnView = useCallback((next: boolean) => {
    setColumnView(next);
    setHoveredColumn(null);
    setPinnedColumn(null);
  }, []);

  /**
   * Empty canvas clicked: clears every emphasis. Section focus, node selection and the pinned
   * column thread each dim something, so all three are cleared, not the last used.
   */
  const handlePaneReset = useCallback(() => {
    setActiveSection(null);
    setPinnedColumn(null);
    setHoveredColumn(null);
    setTreeRoute(null);
    onClearSelection?.();
  }, [onClearSelection]);

  useEffect(() => {
    if (!nodesInitialized || fittedForColumnViewRef.current === columnViewActive) return;
    const first = fittedForColumnViewRef.current === null;
    fittedForColumnViewRef.current = columnViewActive;
    if (first) return;
    return fitGraph();
  }, [columnViewActive, nodesInitialized, fitGraph]);

  const fittedAiViewRef = useRef<string | null>(null);
  useEffect(() => {
    if (!aiDescription) { fittedAiViewRef.current = null; return; }
    if (!nodesInitialized || fittedAiViewRef.current === aiDescription) return;
    fittedAiViewRef.current = aiDescription;
    return fitGraph();
  }, [aiDescription, nodesInitialized, fitGraph]);

  const columnRelations = activeAiMetadata?.columnAspect;
  useEffect(() => {
    setColumnPositions({});
    setHoveredColumn(null);
    setPinnedColumn(null);
  }, [columnRelations]);

  useEffect(() => {
    if (!columnTraceView) {
      setColumnView(false);
      setHoveredColumn(null);
      setPinnedColumn(null);
    }
  }, [columnTraceView]);

  /**
   * Per-node data for the column view, keyed by node id. Excludes `columnPositions` and the hovered
   * thread: React Flow re-measures any node whose object identity changed, so deriving from a drag
   * or pointer move would re-measure the whole canvas. Position varies per node in
   * {@link projectColumnNodes}.
   */
  const columnNodeData = useMemo((): Map<string, ColumnTraceNodeData> => {
    const byNode = new Map<string, ColumnTraceNodeData>();
    if (!columnTraceView) return byNode;
    const statesByRow = resolveRowLineStates(columnTraceView.edges, columnTraceView.identifierCaseSensitive);
    const decorationInputs = {
      highlightedNodeId,
      level1Neighbors,
      traceMode: trace.mode,
      traceSelectedNodeId: trace.selectedNodeId,
      isBookmarkMode,
      canRemoveNodeFromScopedView,
      notesVisible,
      onRemoveFromView,
      traceControlsByNode,
      aiHighlightMap,
      aiBadgeMap,
      aiNoteMap,
    };
    for (const view of columnTraceView.nodes) {
      const rowLineStates: Record<string, ColumnLineState> = {};
      for (const row of view.rows) {
        const state = statesByRow.get(columnRowKey(view.id, row.name, model?.identifierCaseSensitive));
        if (state) rowLineStates[row.name] = state;
      }
      const d = computeNodeDecoration(view.id, undefined, decorationInputs);
      byNode.set(view.id, {
        identifierCaseSensitive: model?.identifierCaseSensitive,
        view,
        rowLineStates,
        highlighted: d.highlighted,
        dimmed: d.dimmed,
        aiHighlight: d.aiHighlight,
        aiBadge: d.aiBadge,
        aiNote: d.aiNote,
        showRemoveButton: d.removable,
        onRemoveFromView: d.onRemoveFromView,
        traceControls: d.traceControls,
        schemaColor: resolveNodeColor(view.schema, view.objectType),
      });
    }
    return byNode;
  }, [columnTraceView, notesVisible, highlightedNodeId, level1Neighbors, aiHighlightMap, aiBadgeMap, aiNoteMap, isBookmarkMode, canRemoveNodeFromScopedView, onRemoveFromView, traceControlsByNode, trace.selectedNodeId, trace.mode, model?.identifierCaseSensitive, resolveNodeColor]);

  const displayNodes = useMemo((): FlowNode[] => {
    if (columnViewActive && columnTraceView) {
      return projectColumnNodes(columnTraceView.nodes, columnNodeData, columnPositions, columnNodeCache.current);
    }
    return decorateFlowNodes(localNodes, {
      graphMode,
      highlightedNodeId,
      level1Neighbors,
      litOverride: activeRoute?.nodeIds ?? (isFocusPaths ? trace.tracedNodeIds : undefined),
      traceMode: trace.mode,
      traceSelectedNodeId: trace.selectedNodeId,
      isBookmarkMode,
      canRemoveNodeFromScopedView,
      notesVisible,
      onRemoveFromView,
      traceControlsByNode,
      aiHighlightMap,
      aiBadgeMap,
      aiNoteMap,
      onExpandSchema: onExpandExpandedSchemaViewSchema,
      onMakeSchemaCenter: onCenterExpandedSchemaViewSchema,
    }, nodeDecorationCache.current);
  }, [localNodes, graphMode, onExpandExpandedSchemaViewSchema, onCenterExpandedSchemaViewSchema, highlightedNodeId, level1Neighbors, activeRoute, isFocusPaths, trace.tracedNodeIds, isBookmarkMode, canRemoveNodeFromScopedView, onRemoveFromView, traceControlsByNode, aiHighlightMap, aiBadgeMap, aiNoteMap, notesVisible, trace.mode, trace.selectedNodeId, columnViewActive, columnTraceView, columnNodeData, columnPositions]);

  const displayEdges = useMemo(() => {
    if (columnViewActive && columnTraceView) {
      const litByHover = (edge: { source: string; sourceColumn: string; target: string; targetColumn: string }) =>
        !!hoveredColumnPath
        && hoveredColumnPath.has(columnRowKey(edge.source, edge.sourceColumn, model?.identifierCaseSensitive))
        && hoveredColumnPath.has(columnRowKey(edge.target, edge.targetColumn, model?.identifierCaseSensitive));
      const litBySelection = (edge: { source: string; target: string }) =>
        !highlightedNodeId || edge.source === highlightedNodeId || edge.target === highlightedNodeId;

      const objectEdges = columnTraceView.objectEdges.map(edge => {
        const lit = !hoveredColumnPath && litBySelection(edge);
        return {
          id: edge.id,
          type: 'columnTraceEdge',
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: COLUMN_EDGE_MARKER_SIZE,
            height: COLUMN_EDGE_MARKER_SIZE,
            color: lit ? 'var(--ln-focus-border)' : 'var(--ln-edge-color)',
          },
          data: {
            state: 'unknown',
            lit,
            focused: lit && !!highlightedNodeId,
            sourceColumn: '',
            targetColumn: '',
            objectLevel: true,
          } satisfies ColumnTraceEdgeData,
        };
      });
      return [...objectEdges, ...columnTraceView.edges.map(edge => {
        const lit = hoveredColumnPath ? litByHover(edge) : litBySelection(edge);
        return {
          id: edge.id,
          type: 'columnTraceEdge',
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: COLUMN_EDGE_MARKER_SIZE,
            height: COLUMN_EDGE_MARKER_SIZE,
            color: lit ? 'var(--ln-focus-border)' : 'var(--ln-edge-color)',
          },
          data: {
            state: edge.state,
            lit,
            focused: lit && (!!hoveredColumnPath || !!highlightedNodeId),
            sourceColumn: edge.sourceColumn,
            targetColumn: edge.targetColumn,
            ...(edge.transforms?.length ? { transforms: edge.transforms } : {}),
            ...(edge.note ? { note: edge.note } : {}),
          } satisfies ColumnTraceEdgeData,
        };
      })];
    }
    if (!highlightedNodeId && !isFocusPaths) return localEdges;

    const isTraceAnimationContext = trace.mode === 'applied' || trace.mode === 'filtered' || trace.mode === 'path-applied';
    const configAllowsAnimation = isTraceAnimationContext ? config.layout.edgeAnimation : config.layout.highlightAnimation;
    const litAnimated = shouldAnimateEdges(localEdges.length, configAllowsAnimation);
    const routeEdgeIds = activeRoute?.edgeIds ?? (isFocusPaths ? trace.tracedEdgeIds : undefined);
    return decorateFlowEdges(localEdges, highlightedNodeId, litAnimated, edgeDecorationCache.current, routeEdgeIds);
  }, [localEdges, highlightedNodeId, activeRoute, isFocusPaths, trace.tracedEdgeIds, config.layout.edgeAnimation, config.layout.highlightAnimation, trace.mode, columnViewActive, columnTraceView, hoveredColumnPath, model?.identifierCaseSensitive]);
  displayedGraphRef.current = { nodes: displayNodes, edges: displayEdges, sourceNodes: syncedGraph.nodes, sourceEdges: syncedGraph.edges };

  const allNodes = useMemo(
    () => (model?.nodes ?? []).map(n => ({ id: n.id, name: n.name, schema: n.schema, type: n.type })),
    [model],
  );

  const detailSearchNodes = useMemo(
    () => (model?.nodes ?? []).map(n => ({
      id: n.id,
      name: n.name,
      schema: n.schema,
      type: n.type,
      bodyScript: n.bodyScript,
      columns: n.columns,
    })),
    [model],
  );

  const listedTrace = navigatorTrace ?? trace;
  const traceTree = useMemo(() => buildTraceTree(
    { originId: listedTrace.selectedNodeId, visibleNodeIds: listedTrace.tracedNodeIds, prunedNodeIds: listedTrace.manualPrunedNodeIds },
    modelGraph,
  ), [listedTrace.selectedNodeId, listedTrace.tracedNodeIds, listedTrace.manualPrunedNodeIds, modelGraph]);

  const showTraceNavigator = (trace.mode === 'applied' || trace.mode === 'filtered' || trace.mode === 'path-applied')
    && !!trace.selectedNodeId && !!traceTree && !!onToggleTraceTreeCollapsed;
  const isTraceNavigatorOpen = showTraceNavigator && !isDetailSearchOpen && !analysisMode && !isTraceTreeCollapsed;
  const fitPadding = isTraceNavigatorOpen ? TRACE_NAVIGATOR_FIT_PADDING : FIT_VIEW_PADDING;
  fitPaddingRef.current = fitPadding;
  const paneWidth = useStore((s) => s.width);
  const paneHeight = useStore((s) => s.height);
  useCanvasResizeFit(paneWidth, paneHeight, fitGraph, !!pendingViewport);
  const minZoom = useMemo(
    () => canvasMinZoom(displayNodes, paneWidth, paneHeight, fitPadding),
    [displayNodes, paneWidth, paneHeight, fitPadding],
  );
  /**
   * Hiding or showing the navigator card changes the free canvas width, so the trace is reframed.
   */
  const traceTreeCollapsedRef = useRef(isTraceTreeCollapsed);
  useEffect(() => {
    if (traceTreeCollapsedRef.current === isTraceTreeCollapsed) return;
    traceTreeCollapsedRef.current = isTraceTreeCollapsed;
    if (showTraceNavigator) return fitGraph();
  }, [isTraceTreeCollapsed, showTraceNavigator, fitGraph]);
  const traceEditCounts = useMemo(
    () => ({ added: listedTrace.manualAddedNodeIds.size, trimmed: listedTrace.manualPrunedNodeIds.size }),
    [listedTrace.manualAddedNodeIds, listedTrace.manualPrunedNodeIds],
  );

  const resolveTraceTreeNode = useCallback(
    (id: string) => {
      const n = modelNodeMap.get(id);
      return n ? { name: n.name, detail: n.schema, type: n.type as ObjectType, color: resolveNodeColor(n.schema, n.type) } : undefined;
    },
    [modelNodeMap, resolveNodeColor],
  );

  const visibleNodeIds = useMemo(
    () => (graphMode === 'overview' && filteredObjectIds) ? filteredObjectIds : new Set(localNodes.map(n => n.id)),
    [localNodes, graphMode, filteredObjectIds],
  );

  const selectedNodeLabel = useMemo(() => {
    if (!trace.selectedNodeId) return null;
    return (flowNodeLookup.byId.get(trace.selectedNodeId)?.data as CustomNodeData | undefined)?.label || trace.selectedNodeId;
  }, [trace.selectedNodeId, flowNodeLookup]);

  const legendSchemas = useMemo(
    () => deriveLegendSchemas(localNodes, graphMode, trace.mode, renderedSchemas),
    [graphMode, trace.mode, localNodes, renderedSchemas],
  );

  const legendColorMap = useMemo(
    () => deriveLegendColorMap(localNodes, model?.identifierCaseSensitive),
    [localNodes, model?.identifierCaseSensitive],
  );

  /**
   * Objects in the current view; unlike `localNodes`, still the real count while the render-limit
   * notice withholds nodes.
   */
  const viewObjectCount = filteredObjectIds?.size ?? 0;
  /**
   * Info-card scope count: rendered nodes (a trace narrows them), or the view's objects while the
   * render-limit notice withholds them.
   */
  const infoCardObjectCount = renderLimitNotice ? viewObjectCount : localNodes.length;

  /**
   * Info-card profile for an unsaved AI preview; memoized so the card skips unrelated canvas
   * renders.
   */
  const aiPreviewProfile = useMemo((): FilterProfile | null => (aiPreview ? {
    id: '',
    name: aiPreview.name,
    createdAt: new Date().toISOString(),
    source: 'ai',
    filter: { schemas: [], types: [], searchTerm: '', hideIsolated: false, focusSchemas: [], showExternalRefs: true, externalRefTypes: [], exclusionPatterns: [] },
    aiMetadata: aiPreview.aiMetadata,
  } : null), [aiPreview]);

  /** The `render-state` message for the current inputs; its identity changes only when one does. */
  const renderStateMessage = useMemo(() => {
    if (!graphErrorContext) return null;
    const highlighted = highlightedNodeId ?? null;
    const controls = highlighted ? traceControlsByNode.get(highlighted) : undefined;
    const traceScope = trace.mode !== 'none'
      ? {
          mode: trace.mode,
          origin: trace.selectedNodeId,
          baseNodeIds: Array.from(trace.baseNodeIds),
          manualAddedNodeIds: Array.from(trace.manualAddedNodeIds),
          manualPrunedNodeIds: Array.from(trace.manualPrunedNodeIds),
          tracedNodeIds: Array.from(trace.tracedNodeIds),
        }
      : null;
    return {
      type: 'render-state' as const,
      renderState: {
        ...graphErrorContext,
        highlightedNodeId: highlighted,
        affordances: highlighted && controls ? serializeTraceAffordances(highlighted, controls) : null,
        traceScope,
      },
    };
  }, [graphErrorContext, highlightedNodeId, traceControlsByNode, trace]);

  useEffect(() => {
    if (renderStateMessage) vscodeApi.postMessage(renderStateMessage);
  }, [renderStateMessage, vscodeApi]);

  return (
    <div className="flex flex-col h-screen">
      <Toolbar
        types={filter.types}
        onToggleType={onToggleType}
        hideIsolated={filter.hideIsolated}
        onToggleIsolated={onToggleIsolated}
        focusSchemas={filter.focusSchemas}
        onToggleFocusSchema={onToggleFocusSchema}
        selectedSchemas={filter.schemas}
        onToggleSchema={onToggleSchema}
        onSelectAllSchemas={onSelectAllSchemas}
        onSelectNoneSchemas={onSelectNoneSchemas}
        availableSchemas={availableSchemas}
        onRefresh={onRefresh}
        onRebuild={onRebuild}
        isRebuilding={isRebuilding}
        onBack={onBack}
        onOpenDdlViewer={onOpenDdlViewer}
        onExportDrawio={handleExportDrawio}
        hasHighlightedNode={!!highlightedNodeId}
        onToggleDetailSearch={onToggleDetailSearch}
        isDetailSearchOpen={isDetailSearchOpen}
        isAnalysisActive={!!analysisMode}
        analysisType={analysisMode?.type ?? null}
        onOpenAnalysis={onOpenAnalysis}
        showExternalRefs={filter.showExternalRefs}
        externalRefTypes={filter.externalRefTypes}
        onToggleExternalRefs={onToggleExternalRefs}
        onToggleExternalRefType={onToggleExternalRefType}
        exclusionPatterns={exclusionPatterns}
        onAddExclusionPattern={onAddExclusionPattern}
        onRemoveExclusionPattern={onRemoveExclusionPattern}
        onExecuteSearch={handleExecuteSearch}
        onStartTrace={onStartTraceImmediate}
        allNodes={allNodes}
        visibleNodeIds={visibleNodeIds}
        metrics={metrics}
        renderedNodeCount={flowNodes.length}
        overviewThreshold={effectiveOverviewThreshold(config)}
        renderLimit={config.renderLimit}
        filterProfiles={filterProfiles}
        activeProjectId={activeProjectId}
        activeViewId={activeViewId}
        isViewModified={isViewModified}
        onSaveView={onSaveView}
        onApplyView={onApplyView}
        onDeleteView={onDeleteView}
        onUpdateView={onUpdateView}
        isFilterDirty={isFilterDirty}
        backRequest={backRequest}
        isModeLocked={isModeLocked}
        canStartNewScopedMode={canStartNewScopedMode}
        canSwitchGraphMode={canSwitchGraphMode}
        isOverview={graphMode === 'overview'}
        graphMode={graphMode}
        onGraphModeChange={onGraphModeChange}
        schemaViewSoftDisabled={schemaViewSoftDisabled}
        isExpandedSchemaViewActive={!!isExpandedSchemaViewActive}
        onResetExpandedSchemaView={onResetExpandedSchemaView}
        showExpandedSchemaClusters={showExpandedSchemaClusters}
        onToggleExpandedSchemaClusters={onToggleExpandedSchemaClusters}
        expandedSchemaCount={expandedSchemaCount}
        onExpandAllSchemas={onExpandAllSchemas}
        collapsedSchemaNodeIds={collapsedSchemaNodeIds}
      />

      {/* Advanced bookmark banner — shown whenever an allowlist view is active */}
      {activeAdvancedProfile && isBookmarkMode && onExitAdvancedBookmark && (
        <BookmarkBanner
          profile={activeAdvancedProfile}
          shownCount={localNodes.filter(n => n.type === 'lineageNode').length}
          totalCount={activeAdvancedProfile.filter.allowlistNodeIds?.length ?? 0}
          onExit={onExitAdvancedBookmark}
          columnViewAvailable={!!columnTraceView}
          columnView={columnViewActive}
          onToggleColumnView={handleToggleColumnView}
        />
      )}

      {/* Inline Trace Controls - shown during configuration phase */}
      {trace.mode === 'configuring' && trace.selectedNodeId && (
        <InlineTraceControls
          startNodeId={trace.selectedNodeId}
          startNodeName={selectedNodeLabel ?? trace.selectedNodeId}
          defaultUpstream={config.trace.defaultUpstreamLevels}
          defaultDownstream={config.trace.defaultDownstreamLevels}
          onApply={onTraceApply}
          onClose={onTraceEnd}
          estimateCount={estimateTraceSize}
          renderLimit={config.renderLimit}
        />
      )}

      {/* Traced Filter Banner - shown during applied or filtered (immediate) mode */}
      {(trace.mode === 'applied' || trace.mode === 'filtered') && trace.selectedNodeId && (
        <TracedFilterBanner
          startNodeName={selectedNodeLabel ?? trace.selectedNodeId}
          upstreamLevels={trace.upstreamLevels}
          downstreamLevels={trace.downstreamLevels}
          totalNodes={trace.tracedNodeIds.size}
          totalEdges={trace.tracedEdgeIds.size}
          mode={trace.mode}
          onEnd={onTraceEnd}
          onReset={() => onResetAll()}
          onSaveAsBookmark={onSaveTraceBookmark ? handleSaveTraceAsBookmark : undefined}
          useFullModel={useFullModel ?? false}
          onToggleFullModel={onToggleFullModel ?? (() => {})}
          filteredOutCount={filteredOutCount ?? 0}
        />
      )}

      {/* Focus Banner — exit affordance for a tree focus narrowing */}
      {isFocusPaths && trace.selectedNodeId && exitFocusPaths && (
        <ModeBanner
          variant="trace"
          icon={TRACE_ICON}
          title="Routes"
          subtitle={
            <>
              Showing <span className="font-bold">{trace.tracedNodeIds.size} nodes</span>
              {' '}on routes from <span className="font-mono font-semibold">"{selectedNodeLabel ?? trace.selectedNodeId}"</span>
            </>
          }
          onClose={exitFocusPaths}
        />
      )}

      {/* Path Finder Bar — shown during pathfinding modes, never over a tree focus */}
      {(trace.mode === 'pathfinding' || (trace.mode === 'path-applied' && !isFocusPaths)) && trace.selectedNodeId && onApplyPath && (
        <PathFinderBar
          sourceNodeName={selectedNodeLabel ?? trace.selectedNodeId}
          allNodes={allNodes}
          pathResult={trace.mode === 'path-applied' ? {
            found: true,
            nodeCount: trace.tracedNodeIds.size,
            edgeCount: trace.tracedEdgeIds.size,
          } : null}
          onFindPath={onApplyPath}
          onClose={onTraceEnd}
        />
      )}

      {/* Analysis Banner - shown when analysis mode is active */}
      {analysisMode && onCloseAnalysis && (
        <AnalysisBanner
          analysis={analysisMode}
          onClose={onCloseAnalysis}
          onSaveAsBookmark={onSaveAnalysisBookmark ? handleSaveAnalysisAsBookmark : undefined}
        />
      )}

      {/* AI Preview Banner - shown when a transient AI view is active */}
      {aiPreview && onDiscardAiPreview && (
        <AiViewBanner
          name={aiPreview.name}
          nodeCount={viewObjectCount}
          onDiscard={onDiscardAiPreview}
          onSaveAsBookmark={onSaveAiBookmark ? handleSaveAiAsBookmark : undefined}
          columnViewAvailable={!!columnTraceView}
          columnView={columnViewActive}
          onToggleColumnView={handleToggleColumnView}
        />
      )}

      <ErrorBoundary
        resetKey={`${graphErrorResetKey ?? ''}|col:${columnViewActive}`}
        context={graphErrorContext}
        onError={() => {
          setTimeout(() => vscodeApi.postMessage({ type: 'reload' }), 800);
        }}
        fallback={
          <div className="flex-1 flex items-center justify-center text-xs" style={{ color: 'var(--ln-fg-muted)' }}>
            The graph view hit an error and is reloading…
          </div>
        }
      >
      <div className="flex-1 flex flex-row overflow-hidden min-h-0">
        <div className="flex-1 relative overflow-hidden min-w-0">
        {renderLimitNotice}
        {isRebuilding && (
          <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: 'var(--ln-bg)', opacity: 0.85 }}>
            <Spinner className="h-8 w-8" style={{ color: 'var(--ln-fg-muted)' }} />
          </div>
        )}
        {flowNodes.length === 0 && !isRebuilding ? (
          <div className="flex items-center justify-center h-full text-sm" style={{ color: 'var(--ln-fg-muted)' }}>
            No objects match current filters. Adjust type toggles or search term.
          </div>
        ) : (
          <div
            style={{
              ...aiCanvasReserve,
              position: 'absolute',
            }}
          >
            <ColumnHoverProvider value={columnHover}>
              <ReactFlow
                className={columnViewActive ? undefined : [EDGE_DENSITY_CLASS_NAME, (highlightedNodeId || isFocusPaths) && SELECTION_ACTIVE_CLASS_NAME].filter(Boolean).join(' ')}
                style={columnViewActive ? undefined : ({ '--ln-edge-density': edgeDensity(displayEdges.length) } as StyleWithVars)}
                nodes={displayNodes}
                edges={displayEdges}
                onlyRenderVisibleElements={shouldVirtualizeCanvas(displayNodes.length)}
                onNodesChange={columnViewActive ? onColumnNodesChange : onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeDragStart={handleNodeDragStart}
                onNodeDragStop={handleNodeDragStop}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodeClick={handleNodeClick}
                onNodeDoubleClick={handleNodeDoubleClick}
                onPaneClick={handlePaneReset}
                onNodeContextMenu={(event, node) => {
                  event.preventDefault();
                  if (node.type === 'schemaNode') {
                    onSchemaNodeSelect?.(node.id);
                    setLocalNodes((nds) => nds.map((n) => ({
                      ...n,
                      selected: n.id === node.id,
                      data: n.type === 'schemaNode'
                        ? { ...n.data, toolbarActive: n.id === node.id }
                        : n.data,
                    })));
                  }
                  onNodeContextMenu(node, event.clientX, event.clientY);
                }}
                fitView
                fitViewOptions={INITIAL_FIT_VIEW_OPTIONS}
                minZoom={minZoom}
                maxZoom={MAX_CANVAS_ZOOM}
                defaultViewport={{ x: 0, y: 0, zoom: 1 }}
                nodesDraggable={true}
                nodesConnectable={false}
                nodesFocusable={true}
                edgesFocusable={true}
                elementsSelectable={true}
                onViewportChange={handleViewportChange}
                onMoveStart={handleMoveStart}
                selectNodesOnDrag={false}
                deleteKeyCode={null}
                panOnDrag={true}
                panOnScroll={false}
                zoomOnScroll={true}
                zoomOnPinch={true}
                zoomOnDoubleClick={false}
                preventScrolling={true}
                nodeOrigin={[0, 0] as [number, number]}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={16} />
                <Controls showInteractive={true} position="bottom-left" />
                {config.layout.minimapEnabled && (
                  <MiniMap
                    pannable
                    zoomable
                    position="bottom-right"
                    nodeColor={minimapNodeColor}
                    nodeStrokeColor={minimapNodeStrokeColor}
                    nodeStrokeWidth={2}
                    nodeBorderRadius={4}
                    ariaLabel="Graph minimap"
                  />
                )}
                {(isDetailSearchOpen || analysisMode || showTraceNavigator) && (
                  <Panel
                    position="top-left"
                    style={isTraceNavigatorOpen ? { bottom: 0, pointerEvents: 'none' } : undefined}
                  >
                    {analysisMode && onCloseAnalysis && onSelectAnalysisGroup && onClearAnalysisGroup ? (
                      <AnalysisSidebar
                        analysis={analysisMode}
                        graph={graph}
                        onSelectGroup={onSelectAnalysisGroup}
                        onClearGroup={onClearAnalysisGroup}
                        onClose={onCloseAnalysis}
                        onSwitchAnalysis={onOpenAnalysis}
                      />
                    ) : isDetailSearchOpen && onToggleDetailSearch ? (
                        <DetailSearchSidebar
                          onClose={onToggleDetailSearch}
                          allNodes={detailSearchNodes}
                          visibleNodeIds={visibleNodeIds}
                          collapsedSchemaNodeIds={collapsedSchemaNodeIds}
                          onResultClick={(nodeId, searchTerm) => {
                            if (graphMode === 'overview' && modelNodeMap.has(nodeId)) {
                              armPendingZoom(nodeId, searchTerm);
                              onOpenExpandedSchemaViewForNode?.(nodeId);
                              return;
                            }
                            onNodeClick(nodeId, searchTerm);
                            zoomToNode(nodeId);
                          }}
                      />
                    ) : showTraceNavigator && traceTree && trace.selectedNodeId && onToggleTraceTreeCollapsed ? (
                      <TraceTreePanel
                        tree={traceTree}
                        originName={selectedNodeLabel ?? trace.selectedNodeId}
                        collapsed={isTraceTreeCollapsed ?? false}
                        onToggleCollapse={onToggleTraceTreeCollapsed}
                        resolveNode={resolveTraceTreeNode}
                        selectedNodeId={highlightedNodeId ?? null}
                        onSelectNode={handleTreeRowSelect}
                        onFocusNode={selectTreeNode}
                        onShowWhole={handleTraceShowWhole}
                        focusTargetIds={focusTargetIds ?? NO_FOCUS_TARGETS}
                        onFocusTargets={setFocusTargets ?? (() => false)}
                        onStageIds={isFocusPaths ? trace.tracedNodeIds : null}
                        editCounts={traceEditCounts}
                        onResetTrace={onResetTrace ?? (() => {})}
                        onGrowLevel={onAddTraceNeighbors ?? (() => {})}
                        canGrow={isEditableTraceMode(trace.mode)}
                      />
                    ) : null}
                  </Panel>
                )}
              </ReactFlow>
            </ColumnHoverProvider>
          </div>
        )}

        <Legend
          schemas={legendSchemas}
          schemaColorMap={legendColorMap}
          identifierCaseSensitive={model?.identifierCaseSensitive}
          isExpandedSchemaViewActive={!!isExpandedSchemaViewActive}
          expandedSchemas={expandedSchemas}
          inset={isDetailSearchOpen || analysisMode ? 'sidebar' : isTraceNavigatorOpen ? 'navigator' : showTraceNavigator && isTraceTreeCollapsed ? 'rail' : undefined}
        />

        {/* Bookmark info card — floating bottom-left, in advanced bookmark or AI preview mode */}
        {activeAdvancedProfile && isBookmarkMode && (
          <BookmarkInfoCard
            profile={activeAdvancedProfile}
            nodeCount={infoCardObjectCount}
            schemaCount={legendSchemas.length}
            staleNodeNames={bookmarkStaleNames ?? []}
          />
        )}
        {aiPreviewProfile && !activeAdvancedProfile && (
          <BookmarkInfoCard
            profile={aiPreviewProfile}
            nodeCount={infoCardObjectCount}
            schemaCount={legendSchemas.length}
            staleNodeNames={NO_STALE_NAMES}
          />
        )}
        {/* AI report column — docked to the chosen edge, collapsible to a slim rail; section chips scroll and highlight that section's nodes */}
        {activeAiMetadata?.description && (
          <Suspense fallback={null}>
            <AiDescriptionOverlay
              viewName={aiViewName}
              description={activeAiMetadata.description}
              expanded={aiPanelOpen}
              onExpandedChange={setAiPanelOpen}
              sections={aiSections}
              activeSection={activeSection}
              onFocusSection={handleFocusSection}
              onFocusNode={handleAiFocusNode}
              dockPosition={dockPosition}
              onDockPositionChange={setDockPosition}
              onPanelResize={handleAiPanelResize}
            />
          </Suspense>
        )}
        </div>
      </div>
      </ErrorBoundary>

      {infoBarNodeId && model && (
        <NodeInfoBar
          identifierCaseSensitive={model?.identifierCaseSensitive}
          nodeId={infoBarNodeId}
          catalog={model.catalog}
          neighborIndex={model.neighborIndex}
          visibleNodeIds={visibleNodeIds}
          parseStats={model.parseStats}
          onClose={onCloseInfoBar || (() => {})}
        />
      )}
    </div>
  );
}
