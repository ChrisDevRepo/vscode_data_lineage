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
import { TraceTreePanel } from './TraceTreePanel';
import { buildTraceTree, traceRemoveKind } from './traceTreeModel';
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
import { NODE_WIDTH, NODE_HEIGHT, buildGraphologyGraph } from '../engine/graphBuilder';
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

import { createEdgeDecorationCache, decorateFlowEdges } from '../engine/edgeDecoration';
import { ColumnHoverProvider, type ColumnHoverState } from '../contexts/ColumnHoverContext';
import { canPruneTraceNode, isEditableTraceMode, isManualTraceScopeEdit, unionConnectingPaths, type TracePruneCheck } from '../engine/traceScope';
import { directNeighborIds, type NeighborSide } from '../engine/graphGuards';
import { notifyUser } from '../utils/notify';
import { normalizeColName } from '../utils/sql';
import { SHORTCUT_KEYS, ESC_PRIORITY } from '../ui/keyboardShortcuts';

/**
 * Mapping of custom node types for React Flow.
 *
 * IMPORTANT: nodeTypes must be defined at module level — not inside the component.
 * If defined inside, React Flow remounts all nodes on every render, causing
 * severe performance degradation and loss of state.
 */
const nodeTypes = { lineageNode: CustomNode, schemaNode: SchemaNode, columnTraceNode: ColumnTraceNode } satisfies NodeTypes;

/** Mapping of custom edge types for React Flow; module-level for the same reason as {@link nodeTypes}. */
const edgeTypes = { columnTraceEdge: ColumnTraceEdge } satisfies EdgeTypes;

const AiDescriptionOverlay = lazy(async () => {
  const module = await import('./AiDescriptionOverlay');
  return { default: module.AiDescriptionOverlay };
});
import type { AiReportSection, AiDockPosition } from './AiDescriptionOverlay';

/** The panel's reserved extent before its own `ResizeObserver` has reported a measured size. */
const AI_PANEL_DEFAULT_WIDTH = 'min(440px, 55vw)';
const AI_PANEL_DEFAULT_HEIGHT = 'min(360px, 45vh)';

/** `window.vscode` state key the dock position is persisted under, merged in alongside other keys. */
const AI_DOCK_STATE_KEY = 'aiDockPosition';

/** Reverse of `aiSections`' per-section `nodeIds`: every section that badged `nodeId`, in order. */
export function sectionsForNode(sections: readonly AiReportSection[], nodeId: string): number[] {
  return sections.filter(s => s.nodeIds.includes(nodeId)).map(s => s.n);
}

/** Cache key for the AI pane's open state + pinned section — origin id ('preview' with none) + view name. */
export function aiLayoutCacheKey(originId: string | undefined, viewName: string): string {
  return `${originId ?? 'preview'}::${viewName}`;
}

/** Padding factor applied when fitting the graph view. */
const FIT_VIEW_PADDING = 0.15;

type FitViewPadding = NonNullable<FitViewOptions['padding']>;

/** Fit padding while the trace navigator card covers the canvas's left edge: its width plus a gap. */
const TRACE_NAVIGATOR_FIT_PADDING: FitViewPadding = { x: FIT_VIEW_PADDING, y: FIT_VIEW_PADDING, left: '360px' };

/** Animation duration in ms for fitting the graph view. */
const FIT_VIEW_DURATION = 250;

/**
 * Delay in ms before the AI panel's dock/open change triggers a re-fit — one frame budget past the
 * panel's CSS width/height transition, so the fit reads the settled canvas box, not the mid-animation
 * one.
 */
const AI_PANEL_REFIT_DELAY = 80;

/**
 * Arms `fire` through `schedule` (`requestAnimationFrame`/`setTimeout`), claiming the next value of
 * `generationRef` as this fit's generation; `fire` runs only if `generationRef` still holds that
 * generation when `schedule` fires — a later user gesture or fit bumps it past that point and this
 * one becomes a no-op instead of running.
 *
 * @returns A cancel that clears the scheduled callback directly (effect cleanup / unmount).
 */
export function scheduleFit(
  generationRef: { current: number },
  fire: () => void,
  schedule: (run: () => void) => number,
  clear: (id: number) => void,
): () => void {
  const generation = ++generationRef.current;
  const id = schedule(() => {
    if (generationRef.current === generation) fire();
  });
  return () => clear(id);
}

/**
 * Whether a `ReactFlow` `onMoveStart` event is a user gesture — React Flow fires it with a real
 * `event` for a user pan/zoom and `null` for a programmatic `fitView`/`setViewport`/`setCenter`.
 */
export function isUserMoveEvent(event: MouseEvent | TouchEvent | null): boolean {
  return event !== null;
}

/** Zoom below which AI notes are hidden once they are showing. */
const NOTES_ZOOM_OUT = 0.18;

/** Zoom above which AI notes are shown once they are hidden. */
const NOTES_ZOOM_IN = 0.28;

/** Arrow-head width and height, in px, of a column-view edge. */
const COLUMN_EDGE_MARKER_SIZE = 14;


/**
 * Max time (ms) to wait for a pending zoom target to appear in flowNodes before
 * giving up and showing a warning.
 */
const PENDING_ZOOM_TIMEOUT_MS = 5000;

/**
 * Class toggled on the React Flow root while object view has an active node selection.
 *
 * @remarks
 * Pairs with `LIT_CLASS_NAME` (`src/engine/nodeDecoration.ts`, `src/engine/edgeDecoration.ts`): the
 * CSS rule in `src/index.css` dims every node/edge that isn't marked lit while this class is
 * present, so the vast majority of the canvas never needs a new object identity just because some
 * other node was clicked. Column view keeps its own independent dim/hover styling and never
 * receives this class.
 */
const SELECTION_ACTIVE_CLASS_NAME = 'ln-has-selection';

/** Stable empty route-target list for the navigator outside a focus. */
const NO_FOCUS_TARGETS: readonly string[] = [];

/**
 * Name of the per-edge CSS custom property carrying its own base stroke width, set once when an
 * edge enters `localEdges`.
 *
 * @remarks
 * The selection-dim/lit CSS rules (`src/index.css`) scale an edge's width off this property.
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
 * Merges a freshly rebuilt node list with the local nodes mid-drag: a node in `draggingIds` keeps
 * the position it currently holds in `currentNodes` — where the drag left it — while every field on
 * every node, dragging or not, otherwise comes from `incomingNodes`.
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
 * Derives an accurate, human-readable reason the prune control is unavailable.
 *
 * @remarks
 * Distinguishes the three blocking cases so the grayed button's tooltip is truthful:
 * the only candidate is the trace origin, pruning would disconnect the trace, or
 * there is simply nothing in the trace to remove on this side.
 *
 * @param pruneChecks - Per visible-neighbor prune-safety verdicts on this side.
 * @param sideLabel - "upstream" or "downstream", for the empty-context message.
 * @returns Empty string when at least one neighbor is prunable, else the reason copy.
 */
function derivePruneDisabledReason(
  pruneChecks: ReadonlyArray<{ check: TracePruneCheck }>,
  sideLabel: string,
): string {
  if (pruneChecks.some(p => p.check.safe)) return '';
  if (pruneChecks.length === 0) return `No ${sideLabel} node in the trace to remove`;
  const reasons = new Set(pruneChecks.map(p => p.check.reason));
  if (reasons.has('origin')) return 'This is the trace source — it cannot be removed';
  return 'These nodes cannot be removed without breaking the trace';
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
    check: canPruneTraceNode(graph, originNodeId, visibleIds, option.id),
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
 * Flattens the live {@link TraceNodeControls} (which carry React callbacks) into a
 * plain, postMessage-safe object so the debug dump can report exactly which add/prune
 * buttons the user saw, and why a control was grayed.
 */
function serializeTraceAffordances(nodeId: string, controls: TraceNodeControls): TraceAffordanceSnapshot {
  return { nodeId, in: serializeSideAffordance(controls.in), out: serializeSideAffordance(controls.out) };
}

interface GraphCanvasProps {
  /** Array of nodes formatted for React Flow. */
  flowNodes: FlowNode[];
  /** Array of edges formatted for React Flow. */
  flowEdges: FlowEdge[];
  /** Current state of the lineage trace or pathfinding operation. */
  trace: TraceState;
  /** Current filter settings (schemas, types, search term, etc.). */
  filter: FilterState;
  /** High-level metrics about the current graph subset. */
  metrics: { totalNodes: number; totalEdges: number; rootNodes: number; leafNodes: number } | null;
  /** ID of the node currently highlighted/selected by the user. */
  highlightedNodeId?: string | null;
  /** The underlying graphology instance for structural analysis. */
  graph?: Graph | null;
  /** Extension configuration settings. */
  config: ExtensionConfig;
  /** Callback fired when a node is clicked. */
  onNodeClick: (nodeId: string, findQuery?: string) => void;
  /** Callback that drops the node selection — the canvas's click-away reset. */
  onClearSelection?: () => void;
  /** Callback fired when a schema cluster is selected. */
  onSchemaNodeSelect?: (nodeId: string) => void;
  /** Callback fired when a node is right-clicked. */
  onNodeContextMenu: (node: FlowNode, x: number, y: number) => void;
  /** Callback fired when an object node is double-clicked — opens the same detail view as the context menu's Show Details. */
  onShowDetails?: (nodeId: string) => void;
  /** Callback to start a trace immediately from a node. */
  onStartTraceImmediate: (nodeId: string) => void;
  /** Callback to apply a trace configuration (upstream/downstream levels). */
  onTraceApply: (config: { upstreamLevels: number; downstreamLevels: number }) => void;
  /** Callback to end the current trace/path mode. */
  onTraceEnd: (onComplete?: () => void) => void;
  /** Callback to reset all filters and traces. */
  onResetAll: () => void;
  /** Callback to toggle visibility of a specific object type. */
  onToggleType: (type: ObjectType) => void;
  /** Callback to toggle 'Isolated Nodes' filter. */
  onToggleIsolated: () => void;
  /** Callback to toggle focus on a specific schema. */
  onToggleFocusSchema: (schema: string) => void;
  /** Callback to toggle visibility of a specific schema. */
  onToggleSchema?: (schema: string) => void;
  /** Callback to select all schemas in the filter. */
  onSelectAllSchemas?: (schemas: string[]) => void;
  /** Callback to deselect all schemas in the filter. */
  onSelectNoneSchemas?: (schemas: string[]) => void;
  /** Callback to toggle visibility of external references. */
  onToggleExternalRefs?: () => void;
  /** Callback to toggle a specific external reference sub-type. */
  onToggleExternalRefType?: (subType: 'file' | 'db') => void;
  /** Array of active exclusion patterns. */
  exclusionPatterns?: string[];
  /** Callback to add a new exclusion pattern. */
  onAddExclusionPattern?: (pattern: string) => void;
  /** Callback to remove an existing exclusion pattern. */
  onRemoveExclusionPattern?: (pattern: string) => void;
  /** List of all schemas available in the model. */
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
  /** Callback to navigate back to the previous screen. */
  onBack: () => void;
  /** Callback to open the DDL viewer for the selected object. */
  onOpenDdlViewer?: () => void;
  /** Whether the detailed search sidebar is currently open. */
  isDetailSearchOpen?: boolean;
  /** Callback to toggle the detailed search sidebar. */
  onToggleDetailSearch?: () => void;
  /** Whether the trace navigator is collapsed to its reopen button. */
  isTraceTreeCollapsed?: boolean;
  /** Callback to toggle the trace navigator. */
  onToggleTraceTreeCollapsed?: () => void;
  /** Traversal graph over the trace scope, shared by tree path lighting and focus paths. */
  traceScopeGraph?: Graph | null;
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
  /** The full database model (catalog and graph). */
  model?: DatabaseModel | null;
  /** ID of the node currently shown in the info bar. */
  infoBarNodeId?: string | null;
  /** Callback to close the info bar. */
  onCloseInfoBar?: () => void;
  /** Current state of the graph analysis (SCC, Hubs, etc.). */
  analysisMode?: AnalysisMode | null;
  /** Callback to start a specific analysis. */
  onOpenAnalysis?: (type: AnalysisType) => void;
  /** Callback to exit analysis mode. */
  onCloseAnalysis?: () => void;
  /** Callback to focus a specific group within the analysis results. */
  onSelectAnalysisGroup?: (groupId: string) => void;
  /** Callback to clear the active analysis group focus. */
  onClearAnalysisGroup?: () => void;
  /** Callback to find and apply a path between two nodes. */
  onApplyPath?: (targetNodeId: string) => boolean;
  /** Whether the graph is currently being rebuilt. */
  isRebuilding?: boolean;
  /** Estimates the node count a trace at the given upstream/downstream depth would render, before it runs. */
  estimateTraceSize?: (upstreamLevels: number, downstreamLevels: number) => number;
  /** Display name of the active source (e.g. dacpac filename). */
  sourceName?: string;
  /** List of saved filter profiles (bookmarks). */
  filterProfiles?: FilterProfile[];
  /** ID of the active project. */
  activeProjectId?: string | null;
  /** ID of the active saved view. */
  activeViewId?: string | null;
  /** Whether the current view has unsaved changes. */
  isViewModified?: boolean;
  /** Callback to save the current view. */
  onSaveView?: (name: string) => void;
  /** Callback to apply a saved filter profile. */
  onApplyView?: (profile: FilterProfile) => void;
  /** Callback to delete a saved view. */
  onDeleteView?: (profileId: string) => void;
  /** Callback to update an existing saved view. */
  onUpdateView?: (profileId: string) => void;
  /** Whether any filters have changed relative to the default or last saved state. */
  isFilterDirty?: boolean;
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
  /** Callback to switch between Object View and Schema View. */
  onGraphModeChange?: (mode: GraphMode) => void;
  /**
   * Set once on initial load/reset — `true` when the loaded model is below the overview threshold.
   * Disables the Schema View button; never re-derived from filter changes.
   */
  schemaViewSoftDisabled?: boolean;
  /**
   * Object-level node IDs that passed all filters (from useGraphology flowNodes).
   * In overview mode, flowNodes are schema aggregates — this set preserves the object-level truth.
   */
  filteredObjectIds?: Set<string>;
  /** Called when user saves a trace/path result as an advanced bookmark. */
  onSaveTraceBookmark?: (
    name: string,
    nodeIds: string[],
    source: 'trace' | 'path',
    positions?: Record<string, { x: number; y: number }>,
  ) => void;
  /** Called when user saves an analysis result as an advanced bookmark. */
  onSaveAnalysisBookmark?: (
    name: string,
    nodeIds: string[],
    positions?: Record<string, { x: number; y: number }>,
  ) => void;
  /** Transient AI preview — shown before user decides to save. */
  aiPreview?: { name: string; nodeIds: Set<string>; aiMetadata: AIViewMetadata } | null;
  /** Called when user saves an AI preview as a bookmark. */
  onSaveAiBookmark?: (
    name: string,
    withPositions: boolean,
    positions?: Record<string, { x: number; y: number }>,
  ) => void;
  /** Called when user discards the AI preview. */
  onDiscardAiPreview?: () => void;
  /** Called when user clicks the "×" remove-from-view button (advanced bookmark mode). */
  onRemoveFromView?: (nodeId: string) => void;
  /** The active advanced bookmark profile (when allowlist mode is on). */
  activeAdvancedProfile?: FilterProfile | null;
  /** Names of allowlist node IDs that no longer exist in the model. */
  bookmarkStaleNames?: string[];
  /** Called when user clicks "Exit View" in the bookmark banner. */
  onExitAdvancedBookmark?: () => void;
  /** Saved node positions from a bookmark — applied once after the next rebuild. */
  pendingPositions?: Record<string, { x: number; y: number }>;
  /** Incremented when the next graph-data update should keep the current viewport. */
  viewportPreserveVersion?: number;
  /** Called after pendingPositions have been applied so the parent can clear them. */
  onPendingPositionsApplied?: () => void;
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
  /** Adds a direct neighbor to the current trace scope. */
  onTraceAddNeighbor?: (nodeId: string) => void;
  /** Prunes one safe node from the current trace scope. */
  onTracePruneNode?: (nodeId: string) => void;
  /** Opens expanded schema view for a node's schema without changing the schema filter. */
  onOpenExpandedSchemaViewForNode?: (nodeId: string) => void;
  /** Expands a collapsed schema cluster into individual objects without changing the schema filter. */
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
  /** Number of schemas currently expanded in expanded schema view; shown in compact control tooltips. */
  expandedSchemaCount?: number;
  /** Expands all schemas at once and enters Expanded Schema View. */
  onExpandAllSchemas?: () => void;
  /**
   * IDs of nodes in the working set that are collapsed inside a schema cluster.
   * Passed to the toolbar search for three-state partitioning.
   */
  collapsedSchemaNodeIds?: Set<string>;
  /** Render-limit notice, positioned inside the canvas area so it never covers the toolbar or banners. */
  renderLimitNotice?: ReactNode;
}

/**
 * Renders the lineage graph and coordinates viewport, selection, filtering, and graph modes.
 */
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
  pendingPositions,
  viewportPreserveVersion = 0,
  onPendingPositionsApplied,
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
  const vscodeApi = useVsCode();

  const [localNodes, setLocalNodes] = useState<FlowNode[]>(flowNodes);
  const [localEdges, setLocalEdges] = useState<FlowEdge[]>(flowEdges);
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
   * Generation for every pending programmatic camera fit (AI-panel refit timer, section-focus fit,
   * column-view toggle fit, AI description fit, graph-change fit): each fit claims the next value on
   * scheduling, and a user pan/zoom (`onMoveStart` firing with a real event) bumps it so any fit still
   * in flight no-ops instead of running.
   */
  const fitGenerationRef = useRef(0);
  /** `ReactFlow`'s `onMoveStart` — bumps the fit generation only for a real user gesture. */
  const handleMoveStart = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (isUserMoveEvent(event)) fitGenerationRef.current++;
  }, []);

  /**
   * The report navigated to a section: it lights that section's labels and frames its objects.
   *
   * @remarks
   * Only this path frames — a node click also sets the active section, and moving the graph under
   * a click the user just made would take the node out from under the pointer.
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
      (run) => requestAnimationFrame(run),
      (id) => cancelAnimationFrame(id),
    );
  }, [fitView]);
  const [dockPosition, setDockPositionState] = useState<AiDockPosition>(() => {
    const saved = (vscodeApi.getState() as Record<string, unknown> | undefined)?.[AI_DOCK_STATE_KEY];
    return saved === 'left' || saved === 'bottom' ? saved : 'right';
  });
  const setDockPosition = useCallback((position: AiDockPosition) => {
    setDockPositionState(position);
    vscodeApi.setState({ ...(vscodeApi.getState() ?? {}), [AI_DOCK_STATE_KEY]: position });
  }, [vscodeApi]);
  const [panelSizePx, setPanelSizePx] = useState<{ width: number; height: number } | null>(null);
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
   *
   * @remarks
   * Derived above the `ErrorBoundary` that wraps the React Flow subtree, so a throw here would
   * escape to the root boundary and reload the whole webview; degrades to `null` instead.
   */
  const columnTraceView = useMemo(() => {
    const relations = activeAiMetadata?.columnAspect?.edges;
    if (!relations?.length) return null;
    try {
      const columnTypesByNode = new Map<string, ReadonlyMap<string, string>>();
      for (const node of model?.nodes ?? []) {
        if (node.columns?.length) {
          columnTypesByNode.set(node.id.toLowerCase(), new Map(node.columns.map(c => [normalizeColName(c.name), c.type])));
        }
      }
      const objects = new Map<string, ColumnTraceViewObject>();
      for (const node of flowNodes) {
        if (node.type === 'schemaNode') continue;
        const data = node.data as CustomNodeData;
        objects.set(node.id.toLowerCase(), {
          id: node.id,
          label: data.label,
          schema: data.schema,
          objectType: data.objectType,
          columnTypes: columnTypesByNode.get(node.id.toLowerCase()),
        });
      }
      const verdicts = activeAiMetadata?.nodeVerdicts?.length
        ? new Map(activeAiMetadata.nodeVerdicts.map(v => [v.nodeId.toLowerCase(), v.verdict]))
        : undefined;
      return buildColumnTraceView({
        relations,
        objects,
        verdicts,
        config,
        layoutDirection: activeAiMetadata?.layoutDirection,
      });
    } catch (err) {
      vscodeApi.postMessage({
        type: 'log',
        level: 'warn',
        text: `[Graph] Column view unavailable: ${err instanceof Error ? err.message : String(err)}`,
      });
      return null;
    }
  }, [activeAiMetadata, config, flowNodes, model, vscodeApi]);

  /** Whether the column view — not the object view — is the rendering currently on stage. */
  const columnViewActive = columnView && !!columnTraceView;

  /**
   * Node positions in object space, for the callbacks that persist or export them.
   *
   * @remarks
   * React Flow's `getNodes()` yields column-trace nodes while the column view is active — the same
   * ids in a different coordinate space. Bookmarks and exports are object-view artifacts, so they
   * read `localNodes` instead, which `onColumnNodesChange` deliberately leaves untouched.
   */
  const objectNodes = useCallback(() => (columnViewActive ? localNodes : getNodes()), [columnViewActive, localNodes, getNodes]);

  const pendingZoomRef = useRef<string | null>(null);
  const pendingClickRef = useRef<{ id: string; searchTerm?: string } | null>(null);
  /** Timestamp when pendingZoomRef was set — used to expire stale refs after PENDING_ZOOM_TIMEOUT_MS. */
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
   * Arms a zoom for a node the expanded schema view has yet to reveal.
   *
   * @param nodeId - The node to zoom and click once it lands in `flowNodes`.
   * @param searchTerm - Term the deferred click highlights in the detail panel.
   *
   * @remarks
   * The graph-change effect expires a pending zoom against {@link pendingZoomSetAt}; not stamping
   * it here would leave a stale timestamp and expire the zoom before the expanded graph arrives.
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

  const handleSaveTraceAsBookmark = useCallback((name: string, withPositions: boolean) => {
    if (!onSaveTraceBookmark) return;
    const nodeIds = Array.from(trace.tracedNodeIds);
    if (withPositions) {
      const nodeIdSet = new Set(nodeIds);
      const nodes = objectNodes();
      const pos: Record<string, { x: number; y: number }> = {};
      for (const n of nodes) {
        if (nodeIdSet.has(n.id)) pos[n.id] = n.position;
      }
      onSaveTraceBookmark(name, nodeIds, 'trace', pos);
    } else {
      onSaveTraceBookmark(name, nodeIds, 'trace');
    }
  }, [onSaveTraceBookmark, trace.tracedNodeIds, objectNodes]);

  const handleSaveAnalysisAsBookmark = useCallback((name: string, withPositions: boolean) => {
    if (!onSaveAnalysisBookmark || !analysisMode) return;
    const activeGroup = analysisMode.activeGroupId
      ? analysisMode.result.groups.find(g => g.id === analysisMode.activeGroupId)
      : null;
    const nodeIds = activeGroup
      ? activeGroup.nodeIds
      : analysisMode.result.groups.flatMap(g => g.nodeIds);
    if (withPositions) {
      const nodes = objectNodes();
      const pos: Record<string, { x: number; y: number }> = {};
      for (const n of nodes) pos[n.id] = n.position;
      onSaveAnalysisBookmark(name, nodeIds, pos);
    } else {
      onSaveAnalysisBookmark(name, nodeIds);
    }
  }, [onSaveAnalysisBookmark, analysisMode, objectNodes]);

  const handleSaveAiAsBookmark = useCallback((name: string, withPositions: boolean) => {
    if (!onSaveAiBookmark) return;
    if (withPositions) {
      const nodes = objectNodes();
      const pos: Record<string, { x: number; y: number }> = {};
      for (const n of nodes) pos[n.id] = n.position;
      onSaveAiBookmark(name, withPositions, pos);
    } else {
      onSaveAiBookmark(name, withPositions);
    }
  }, [onSaveAiBookmark, objectNodes]);

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
        const view = (node.data as ColumnTraceNodeData).view;
        return view.objectType === 'external' ? getExternalNodeColor() : getSchemaColor(view.schema);
      }
      const d = node.data as CustomNodeData;
      return d.objectType === 'external' ? getExternalNodeColor() : (d.schemaColor ?? getSchemaColor(String(d.schema)));
    },
    [isExpandedSchemaViewActive]
  );

  const minimapNodeStrokeColor = useCallback(
    (node: FlowNode) => (node.type === 'schemaNode'
      ? 'var(--ln-minimap-cluster-stroke)'
      : 'transparent'),
    []
  );

  /** Pending {@link zoomToNode} frame, cancelled by the next call or on unmount so a fast repeat search never queues competing `setCenter` calls. */
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

  /** Full-model traversal graph backing the tree and row path lighting. */
  const modelGraph = useMemo(() => (model ? buildGraphologyGraph(model) : null), [model]);

  /**
   * Tree-row activation: existing canvas selection, plus lighting of every
   * origin↔node connecting path with the camera autofit on the route. The origin needs no
   * override — the trace-origin rule already keeps it lit.
   */
  const handleTreeRowSelect = useCallback((nodeId: string) => {
    if (highlightedNodeId !== nodeId) onNodeClick(nodeId);
    const originId = trace.selectedNodeId;
    const path = originId && nodeId !== originId && traceScopeGraph
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
  }, [onNodeClick, highlightedNodeId, trace.selectedNodeId, traceScopeGraph, fitView]);

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
        ? exportSchemaOverviewToDrawio(clusterNodes, exportEdges, schemas)
        : exportToDrawio(exportObjectNodes, exportEdges, schemas, clusterNodes);
      if (!xml) return;
      const base = (sourceName?.replace(/\.dacpac$/i, '') || 'lineage').trim().replace(/[\\/:*?"<>|]/g, '_');
      vscodeApi.postMessage({ type: 'export-file', data: xml, defaultName: `${base}_lineage.drawio` });
    }).catch((err) => {
      vscodeApi.postMessage({ type: 'error', error: `Draw.io export failed: ${err instanceof Error ? err.message : err}` });
    });
  }, [objectNodes, columnViewActive, localEdges, getEdges, availableSchemas, filter.schemas, sourceName, vscodeApi]);

  /**
   * The one auto-fit: frames every node on the next frame, at the padding and duration every
   * caller shares; a later user pan/zoom bumps {@link fitGenerationRef} so it no-ops instead of
   * running.
   *
   * @remarks
   * Deferred a frame because each caller runs while the nodes it means to frame are still being
   * measured, and `fitView` on an unmeasured node frames the wrong box.
   *
   * @returns A cancel to return directly as an effect's cleanup.
   */
  const fitGraph = useCallback((): (() => void) => scheduleFit(
    fitGenerationRef,
    () => { void fitView({ padding: fitPaddingRef.current, duration: FIT_VIEW_DURATION }); },
    (run) => requestAnimationFrame(run),
    (id) => cancelAnimationFrame(id),
  ), [fitView]);

  /**
   * The sole owner of fit-on-graph-change: every `flowNodes` update — including a trace ending and
   * the graph reverting to its pre-trace shape — reframes here, once. A manual add/prune trace-scope
   * edit is the one graph change this owner does not reframe for, since the edited node is already
   * on screen and a fit there would move the view out from under the click that caused it.
   */
  useEffect(() => {
    const previousTrace = traceAtLastGraphChangeRef.current;
    const currentTrace = currentTraceRef.current;
    traceAtLastGraphChangeRef.current = currentTrace;

    if (pendingPositions && Object.keys(pendingPositions).length > 0) return;
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
    const preserveVersion = viewportPreserveVersionRef.current;
    if (preserveVersion !== consumedViewportPreserveVersionRef.current) {
      consumedViewportPreserveVersionRef.current = preserveVersion;
      return;
    }
    if (isManualTraceScopeEdit(previousTrace, currentTrace)) return;
    return fitGraph();
  }, [clearPendingZoomTimer, flowNodes, fitGraph, zoomToNode]); // pendingPositions, onNodeClickRef intentionally excluded — read at effect run time

  const [notesVisible, setNotesVisible] = useState(true);
  const [hoveredColumn, setHoveredColumn] = useState<{ nodeId: string; column: string } | null>(null);
  const [pinnedColumn, setPinnedColumn] = useState<{ nodeId: string; column: string } | null>(null);
  const [columnPositions, setColumnPositions] = useState<Record<string, { x: number; y: number }>>({});

  const nodeDecorationCache = useRef(createNodeDecorationCache());

  const edgeDecorationCache = useRef(createEdgeDecorationCache());

  const columnNodeCache = useRef(createColumnNodeCache());

  const fittedForColumnViewRef = useRef<boolean | null>(null);

  const pendingPositionsRef = useRef(pendingPositions);
  pendingPositionsRef.current = pendingPositions;
  const handleFitViewRef = useRef(handleFitView);
  handleFitViewRef.current = handleFitView;
  const onPendingPositionsAppliedRef = useRef(onPendingPositionsApplied);
  onPendingPositionsAppliedRef.current = onPendingPositionsApplied;

  /**
   * Node ids currently mid-drag, read by the sync effect below so a rebuild landing mid-drag never
   * resets the dragged node's position out from under the user's pointer.
   */
  const draggingNodeIdsRef = useRef<Set<string> | null>(null);
  /** The `flowNodes` the sync effect deferred while a drag was in progress; applied on drag stop. */
  const deferredFlowNodesRef = useRef<FlowNode[] | null>(null);

  useEffect(() => {
    if (draggingNodeIdsRef.current) {
      deferredFlowNodesRef.current = flowNodes;
      return;
    }
    const pending = pendingPositionsRef.current;
    if (pending && Object.keys(pending).length > 0) {
      setLocalNodes(flowNodes.map(n => {
        const saved = pending[n.id];
        return saved ? { ...n, position: { x: saved.x, y: saved.y } } : n;
      }));
      requestAnimationFrame(() => handleFitViewRef.current());
      onPendingPositionsAppliedRef.current?.();
    } else {
      setLocalNodes(flowNodes);
    }
  }, [flowNodes]);

  useEffect(() => {
    setLocalEdges(flowEdges.map(withEdgeBaseWidthVar));
  }, [flowEdges]);

  const pendingViewportRef = useRef(pendingViewport);
  pendingViewportRef.current = pendingViewport;
  const onPendingViewportAppliedRef = useRef(onPendingViewportApplied);
  onPendingViewportAppliedRef.current = onPendingViewportApplied;
  const setViewportRef = useRef(setViewport);
  setViewportRef.current = setViewport;

  /**
   * Applies a restored viewport once after the graph-data update it was captured for, then clears it.
   *
   * @remarks
   * Runs after the {@link fitGraph} owner above; the caller pairs a `pendingViewport` with
   * `preserveViewportOnNextGraphChange` so that owner skips its own fit for this same update.
   */
  useEffect(() => {
    const pending = pendingViewportRef.current;
    if (!pending) return;
    setViewportRef.current(pending, { duration: 0 });
    onPendingViewportAppliedRef.current?.();
  }, [flowNodes]);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setLocalNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );

  /**
   * Marks a drag live so the `localNodes` sync effect defers a rebuild that lands mid-drag, rather
   * than deriving drag state from `applyNodeChanges` position events (which arrive one frame late).
   */
  const handleNodeDragStart: OnNodeDrag = useCallback((_event, node, nodes) => {
    draggingNodeIdsRef.current = new Set((nodes.length ? nodes : [node]).map(n => n.id));
  }, []);

  /**
   * Releases the drag and, if a rebuild landed while it was live, applies the deferred nodes now —
   * the dragged node(s) keep the position the drag left them at; every other node takes the rebuilt
   * shape. See {@link mergeIncomingNodesPreservingDrag}.
   */
  const handleNodeDragStop: OnNodeDrag = useCallback((_event, node, nodes) => {
    const draggingIds = draggingNodeIdsRef.current ?? new Set((nodes.length ? nodes : [node]).map(n => n.id));
    draggingNodeIdsRef.current = null;
    const deferred = deferredFlowNodesRef.current;
    if (!deferred) return;
    deferredFlowNodesRef.current = null;
    setLocalNodes(current => mergeIncomingNodesPreservingDrag(deferred, current, draggingIds));
  }, []);

  /**
   * Node changes while the column view is on stage.
   *
   * @remarks
   * Column nodes carry the same ids as the object nodes they replace, so routing their changes
   * through `onNodesChange` would corrupt the positions a bookmark saves. Only the drag is kept.
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

  /**
   * Shows or hides AI notes as the canvas crosses the legibility zoom.
   *
   * @remarks
   * The band is deliberately wider than a single threshold, since `notesVisible` feeds every node's
   * decoration and a gesture resting on one exact zoom value would rebuild the whole node set on
   * each crossing. Off below {@link NOTES_ZOOM_OUT}, on above {@link NOTES_ZOOM_IN}.
   */
  const onCameraChangeRef = useRef(onCameraChange);
  onCameraChangeRef.current = onCameraChange;

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
    for (const n of modelNodeMap.values()) map.set(n.id.toLowerCase(), n);
    return map;
  }, [modelNodeMap]);


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
   * The active row's trace cone — its upstream sources and downstream consumers, never a sibling
   * input it merely shares an output with. See {@link columnThread}.
   */
  const hoveredColumnPath = useMemo((): Set<string> | null => {
    const active = pinnedColumn ?? hoveredColumn;
    if (!active || !columnThreadIndex) return null;
    return columnThread(columnThreadIndex, columnRowKey(active.nodeId, active.column));
  }, [pinnedColumn, hoveredColumn, columnThreadIndex]);

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

    const visibleIds = new Set(localNodes.filter(n => n.type === 'lineageNode').map(n => n.id));

    controls.set(targetNode.id, {
      in: buildTraceSideControls(model, modelGraph, targetNode.id, 'in', visibleIds, trace.selectedNodeId, modelNodeMap, modelNodeMapLower),
      out: buildTraceSideControls(model, modelGraph, targetNode.id, 'out', visibleIds, trace.selectedNodeId, modelNodeMap, modelNodeMapLower),
      onAdd: onTraceAddNeighbor,
      onPrune: onTracePruneNode,
    });
    return controls;
  }, [localNodes, model, modelGraph, modelNodeMap, modelNodeMapLower, onTraceAddNeighbor, onTracePruneNode, trace.mode, trace.selectedNodeId, highlightedNodeId, canEditTraceScope]);

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
    pinnedRow: pinnedColumn ? columnRowKey(pinnedColumn.nodeId, pinnedColumn.column) : null,
  }), [hoveredColumnPath, handleColumnHover, handleColumnSelect, pinnedColumn]);

  const handleToggleColumnView = useCallback((next: boolean) => {
    setColumnView(next);
    setHoveredColumn(null);
    setPinnedColumn(null);
  }, []);

  /**
   * Empty canvas clicked — every emphasis the user turned on goes back to normal.
   *
   * @remarks
   * Section focus, node selection and the pinned column thread are separate channels that each dim
   * something, so the reset clears all three rather than the last one used.
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
   * Per-node data for the column view, keyed by node id.
   *
   * @remarks
   * Deliberately excludes `columnPositions` and the hovered thread: React Flow re-measures any node
   * whose object identity changed, so deriving this from a drag or pointer move would re-measure
   * the whole canvas instead of one node. Position varies per node in {@link projectColumnNodes}.
   */
  const columnNodeData = useMemo((): Map<string, ColumnTraceNodeData> => {
    const byNode = new Map<string, ColumnTraceNodeData>();
    if (!columnTraceView) return byNode;
    const statesByRow = resolveRowLineStates(columnTraceView.edges);
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
        const state = statesByRow.get(columnRowKey(view.id, row.name));
        if (state) rowLineStates[row.name] = state;
      }
      const d = computeNodeDecoration(view.id, undefined, decorationInputs);
      byNode.set(view.id, {
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
      });
    }
    return byNode;
  }, [columnTraceView, notesVisible, highlightedNodeId, level1Neighbors, aiHighlightMap, aiBadgeMap, aiNoteMap, isBookmarkMode, canRemoveNodeFromScopedView, onRemoveFromView, traceControlsByNode, trace.selectedNodeId, trace.mode]);

  const displayNodes = useMemo((): FlowNode[] => {
    if (columnViewActive && columnTraceView) {
      return projectColumnNodes(columnTraceView.nodes, columnNodeData, columnPositions, columnNodeCache.current);
    }
    return decorateFlowNodes(localNodes, {
      graphMode,
      highlightedNodeId,
      level1Neighbors,
      litOverride: activeRoute?.nodeIds,
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
  }, [localNodes, graphMode, onExpandExpandedSchemaViewSchema, onCenterExpandedSchemaViewSchema, highlightedNodeId, level1Neighbors, activeRoute, isBookmarkMode, canRemoveNodeFromScopedView, onRemoveFromView, traceControlsByNode, aiHighlightMap, aiBadgeMap, aiNoteMap, notesVisible, trace.mode, trace.selectedNodeId, columnViewActive, columnTraceView, columnNodeData, columnPositions]);

  const displayEdges = useMemo(() => {
    if (columnViewActive && columnTraceView) {
      const litByHover = (edge: { source: string; sourceColumn: string; target: string; targetColumn: string }) =>
        !!hoveredColumnPath
        && hoveredColumnPath.has(columnRowKey(edge.source, edge.sourceColumn))
        && hoveredColumnPath.has(columnRowKey(edge.target, edge.targetColumn));
      const litBySelection = (edge: { source: string; target: string }) =>
        !highlightedNodeId || edge.source === highlightedNodeId || edge.target === highlightedNodeId;

      return columnTraceView.edges.map(edge => {
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
            sourceColumn: edge.sourceColumn,
            targetColumn: edge.targetColumn,
            ...(edge.transforms?.length ? { transforms: edge.transforms } : {}),
            ...(edge.note ? { note: edge.note } : {}),
          } satisfies ColumnTraceEdgeData,
        };
      });
    }
    if (!highlightedNodeId) return localEdges;

    const isTraceAnimationContext = trace.mode === 'applied' || trace.mode === 'filtered' || trace.mode === 'path-applied';
    const configAllowsAnimation = isTraceAnimationContext ? config.layout.edgeAnimation : config.layout.highlightAnimation;
    const litAnimated = shouldAnimateEdges(localEdges.length, configAllowsAnimation);
    return decorateFlowEdges(localEdges, highlightedNodeId, litAnimated, edgeDecorationCache.current, activeRoute?.edgeIds);
  }, [localEdges, highlightedNodeId, activeRoute, config.layout.edgeAnimation, config.layout.highlightAnimation, trace.mode, columnViewActive, columnTraceView, hoveredColumnPath]);

  const allNodes = useMemo(
    () => (model?.nodes ?? []).map(n => ({ id: n.id, name: n.name, schema: n.schema, type: n.type })),
    [model],
  );

  const detailSearchNodes = useMemo(
    () => allNodes.map(n => ({
      id: n.id,
      name: n.name,
      schema: n.schema,
      type: n.type,
      bodyScript: modelNodeMap.get(n.id)?.bodyScript,
      columns: modelNodeMap.get(n.id)?.columns,
    })),
    [allNodes, modelNodeMap],
  );

  const listedTrace = navigatorTrace ?? trace;
  const traceTree = useMemo(() => buildTraceTree(
    { originId: listedTrace.selectedNodeId, visibleNodeIds: listedTrace.tracedNodeIds, prunedNodeIds: listedTrace.manualPrunedNodeIds },
    modelGraph,
  ), [listedTrace.selectedNodeId, listedTrace.tracedNodeIds, listedTrace.manualPrunedNodeIds, modelGraph]);

  const showTraceNavigator = (trace.mode === 'applied' || trace.mode === 'filtered' || trace.mode === 'path-applied')
    && !!trace.selectedNodeId && !!traceTree && !!onToggleTraceTreeCollapsed;
  const isTraceNavigatorOpen = showTraceNavigator && !isDetailSearchOpen && !analysisMode && !isTraceTreeCollapsed;
  fitPaddingRef.current = isTraceNavigatorOpen ? TRACE_NAVIGATOR_FIT_PADDING : FIT_VIEW_PADDING;
  const traceEditCounts = useMemo(
    () => ({ added: listedTrace.manualAddedNodeIds.size, trimmed: listedTrace.manualPrunedNodeIds.size }),
    [listedTrace.manualAddedNodeIds, listedTrace.manualPrunedNodeIds],
  );

  const traceTreeLabels = useMemo(() => {
    const map = new Map<string, { name: string; detail?: string; type?: ObjectType }>();
    for (const n of allNodes) map.set(n.id, { name: n.name, detail: n.schema, type: n.type as ObjectType });
    return map;
  }, [allNodes]);

  const resolveTraceTreeNode = useCallback(
    (id: string) => traceTreeLabels.get(id),
    [traceTreeLabels],
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
    () => deriveLegendColorMap(localNodes),
    [localNodes],
  );

  useEffect(() => {
    if (!graphErrorContext) return;
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
    vscodeApi.postMessage({
      type: 'render-state',
      renderState: {
        ...graphErrorContext,
        highlightedNodeId: highlighted,
        affordances: highlighted && controls ? serializeTraceAffordances(highlighted, controls) : null,
        traceScope,
      },
    });
  }, [graphErrorResetKey, highlightedNodeId, traceControlsByNode, trace.tracedNodeIds.size]);

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
        overviewThreshold={config.overview.threshold}
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
          onApply={(traceConfig) => {
            onTraceApply(traceConfig);
          }}
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
          nodeCount={aiPreview.nodeIds.size}
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
                className={!columnViewActive && highlightedNodeId ? SELECTION_ACTIVE_CLASS_NAME : undefined}
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
                fitViewOptions={{ padding: 0.15 }}
                minZoom={MIN_CANVAS_ZOOM}
                maxZoom={2}
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
                    style={isTraceNavigatorOpen ? { bottom: 0 } : undefined}
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
                        focusTargetIds={focusTargetIds ?? NO_FOCUS_TARGETS}
                        onFocusTargets={setFocusTargets ?? (() => false)}
                        onStageIds={isFocusPaths ? trace.tracedNodeIds : null}
                        editCounts={traceEditCounts}
                        onResetTrace={onResetTrace ?? (() => {})}
                        onGrowLevel={onAddTraceNeighbors ?? (() => {})}
                        removeKind={traceRemoveKind(trace.mode)}
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
          isExpandedSchemaViewActive={!!isExpandedSchemaViewActive}
          expandedSchemas={expandedSchemas}
          isSidebarOpen={isDetailSearchOpen || !!analysisMode || isTraceNavigatorOpen}
        />

        {/* Bookmark info card — floating bottom-left, in advanced bookmark or AI preview mode */}
        {activeAdvancedProfile && isBookmarkMode && (
          <BookmarkInfoCard
            profile={activeAdvancedProfile}
            nodeCount={localNodes.length}
            schemaCount={legendSchemas.length}
            staleNodeNames={bookmarkStaleNames ?? []}
          />
        )}
        {aiPreview && !activeAdvancedProfile && (
          <BookmarkInfoCard
            profile={{
              id: '',
              name: aiPreview.name,
              createdAt: new Date().toISOString(),
              source: 'ai',
              filter: { schemas: [], types: [], searchTerm: '', hideIsolated: false, focusSchemas: [], showExternalRefs: true, externalRefTypes: [], exclusionPatterns: [] },
              aiMetadata: aiPreview.aiMetadata,
            }}
            nodeCount={localNodes.length}
            schemaCount={legendSchemas.length}
            staleNodeNames={[]}
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
