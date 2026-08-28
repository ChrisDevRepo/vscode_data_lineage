import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
  MarkerType,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type NodeTypes,
  type NodeMouseHandler,
  type OnNodesChange,
  type OnEdgesChange,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Graph from 'graphology';
import { useVsCode } from '../contexts/VsCodeContext';

import { CustomNode, type CustomNodeData, type TraceNeighborOption, type TraceNodeControls, type TraceSideControls } from './CustomNode';
import { Spinner } from './ui/Spinner';
import { SchemaNode } from './SchemaNode';
import type { SchemaNodeData, GraphMode, TraceAffordanceSnapshot, TraceAffordanceSideSnapshot } from '../engine/types';
import { Legend } from './Legend';
import { deriveLegendSchemas, deriveLegendColorMap } from './legendDerivation';
import { ErrorBoundary } from './ErrorBoundary';
import { InlineTraceControls } from './InlineTraceControls';
import { TracedFilterBanner } from './TracedFilterBanner';
import { PathFinderBar } from './PathFinderBar';
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
import { ColumnTraceNode, type ColumnTraceNodeData } from './ColumnTraceNode';
import {
  buildColumnTraceView,
  columnRowKey,
  resolveRowLineStates,
  type ColumnTraceViewObject,
  type ColumnLineState,
} from '../engine/columnTraceView';
import { canPruneTraceNode, isEditableTraceMode, isManualTraceScopeEdit, type TracePruneCheck } from '../engine/traceScope';
import { directNeighborIds, type NeighborSide } from '../engine/graphGuards';
import { notifyUser } from '../utils/notify';
import { SHORTCUT_KEYS } from '../ui/keyboardShortcuts';

/**
 * Mapping of custom node types for React Flow.
 *
 * IMPORTANT: nodeTypes must be defined at module level — not inside the component.
 * If defined inside, React Flow remounts all nodes on every render, causing
 * severe performance degradation and loss of state.
 */
const nodeTypes = { lineageNode: CustomNode, schemaNode: SchemaNode, columnTraceNode: ColumnTraceNode } satisfies NodeTypes;

const AiDescriptionOverlay = lazy(async () => {
  const module = await import('./AiDescriptionOverlay');
  return { default: module.AiDescriptionOverlay };
});

/** Padding factor applied when fitting the graph view. */
const FIT_VIEW_PADDING = 0.15;

/** Animation duration in ms for fitting the graph view. */
const FIT_VIEW_DURATION = 250;

/**
 * Max time (ms) to wait for a pending zoom target to appear in flowNodes before
 * giving up and showing a warning.
 */
const PENDING_ZOOM_TIMEOUT_MS = 5000;

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
  if (reasons.has('disconnected')) return 'Removing this would disconnect the trace from its source';
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
  const prune = pruneChecks.filter(p => p.check.safe).map(p => p.option);
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
  /** Callback fired when a schema cluster is selected. */
  onSchemaNodeSelect?: (nodeId: string) => void;
  /** Callback fired when a node is right-clicked. */
  onNodeContextMenu: (node: FlowNode, x: number, y: number) => void;
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
    viewport?: { x: number; y: number; zoom: number },
  ) => void;
  /** Called when user saves an analysis result as an advanced bookmark. */
  onSaveAnalysisBookmark?: (
    name: string,
    nodeIds: string[],
    positions?: Record<string, { x: number; y: number }>,
    viewport?: { x: number; y: number; zoom: number },
  ) => void;
  /** Transient AI preview — shown before user decides to save. */
  aiPreview?: { name: string; nodeIds: Set<string>; aiMetadata: AIViewMetadata } | null;
  /** Called when user saves an AI preview as a bookmark. */
  onSaveAiBookmark?: (
    name: string,
    withPositions: boolean,
    positions?: Record<string, { x: number; y: number }>,
    viewport?: { x: number; y: number; zoom: number },
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
  /** Saved ReactFlow viewport — restored together with pendingPositions. */
  pendingViewport?: { x: number; y: number; zoom: number };
  /** Incremented when the next graph-data update should keep the current viewport. */
  viewportPreserveVersion?: number;
  /** Called after pendingPositions have been applied so the parent can clear them. */
  onPendingPositionsApplied?: () => void;
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
  onSchemaNodeSelect,
  onNodeContextMenu,
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
  pendingViewport,
  viewportPreserveVersion = 0,
  onPendingPositionsApplied,
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
}: GraphCanvasProps) {
  const { fitView, getNode, setCenter, getNodes, getEdges, getViewport, setViewport } = useReactFlow();
  const vscodeApi = useVsCode();

  /**
   * Object-view nodes to read while the column view is on stage; `null` in the object view.
   *
   * @remarks
   * Assigned during render once the column-view state exists, because the callbacks that read it are
   * declared above that state. See {@link objectNodes} for why the override is needed.
   */
  const columnViewObjectNodesRef = useRef<FlowNode[] | null>(null);

  /**
   * Node positions in object space, for the callbacks that persist or export them.
   *
   * @remarks
   * React Flow's `getNodes()` returns whatever is mounted, so it yields column-trace nodes while the
   * column view is active — the same ids in a different coordinate space, which a bookmark would
   * persist as object positions and a draw.io export would emit as objects. Bookmarks and exports
   * are object-view artifacts, so they fall back to `localNodes`, the positions that
   * `onColumnNodesChange` deliberately leaves untouched. The object view is unaffected.
   */
  const objectNodes = useCallback(() => columnViewObjectNodesRef.current ?? getNodes(), [getNodes]);

  // Pending actions after overview schema expansion (zoom to the revealed object)
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
  // Cleanup: clear pending zoom timer on unmount to prevent post-destroy notifyUser calls
  useEffect(() => clearPendingZoomTimer, [clearPendingZoomTimer]);
  // Stable ref for onNodeClick — used inside auto-fit effect without adding to deps
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;
  const currentTraceRef = useRef(trace);
  currentTraceRef.current = trace;
  const traceAtLastGraphChangeRef = useRef(trace);
  const viewportPreserveVersionRef = useRef(viewportPreserveVersion);
  viewportPreserveVersionRef.current = viewportPreserveVersion;
  const consumedViewportPreserveVersionRef = useRef(viewportPreserveVersion);

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
      onNodeClick(node.id);
    },
    [graphMode, onNodeClick, onSchemaNodeSelect]
  );

  const handleNodeDoubleClick: NodeMouseHandler = useCallback(
    (event, node) => {
      if (graphMode !== 'overview' || node.type !== 'schemaNode') return;
      event.preventDefault();
      setLocalNodes((nds) => nds.map((n) => n.selected ? { ...n, selected: false } : n));
      const schemaName = (node.data as SchemaNodeData).schemaName;
      if (config.overview.schemaDoubleClickBehavior === 'expand') {
        onExpandExpandedSchemaViewSchema?.(schemaName);
      } else {
        onCenterExpandedSchemaViewSchema?.(schemaName);
      }
    },
    [config.overview.schemaDoubleClickBehavior, graphMode, onCenterExpandedSchemaViewSchema, onExpandExpandedSchemaViewSchema]
  );

  const handleFitView = useCallback(() => {
    fitView({ padding: FIT_VIEW_PADDING, duration: FIT_VIEW_DURATION });
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
      onSaveTraceBookmark(name, nodeIds, 'trace', pos, getViewport());
    } else {
      onSaveTraceBookmark(name, nodeIds, 'trace');
    }
  }, [onSaveTraceBookmark, trace.tracedNodeIds, objectNodes, getViewport]);

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
      onSaveAnalysisBookmark(name, nodeIds, pos, getViewport());
    } else {
      onSaveAnalysisBookmark(name, nodeIds);
    }
  }, [onSaveAnalysisBookmark, analysisMode, objectNodes, getViewport]);

  const handleSaveAiAsBookmark = useCallback((name: string, withPositions: boolean) => {
    if (!onSaveAiBookmark) return;
    if (withPositions) {
      const nodes = objectNodes();
      const pos: Record<string, { x: number; y: number }> = {};
      for (const n of nodes) pos[n.id] = n.position;
      onSaveAiBookmark(name, withPositions, pos, getViewport());
    } else {
      onSaveAiBookmark(name, withPositions);
    }
  }, [onSaveAiBookmark, objectNodes, getViewport]);

  useKeyboardShortcut(SHORTCUT_KEYS.fitView, handleFitView);

  const minimapNodeColor = useCallback(
    (node: FlowNode) => {
      // Schema nodes (overview mode) carry SchemaNodeData with a pre-computed color
      if (node.type === 'schemaNode') {
        const color = (node.data as SchemaNodeData).color;
        return isExpandedSchemaViewActive
          ? `color-mix(in srgb, ${color} 28%, transparent)`
          : color;
      }
      const d = node.data as CustomNodeData;
      return d.objectType === 'external' ? getExternalNodeColor() : (d.schemaColor ?? getSchemaColor(String(d.schema)));
    },
    [isExpandedSchemaViewActive]
  );

  // Ring only the schema clusters on the minimap so their kind is readable without labels.
  const minimapNodeStrokeColor = useCallback(
    (node: FlowNode) => (node.type === 'schemaNode'
      ? 'var(--ln-minimap-cluster-stroke)'
      : 'transparent'),
    []
  );

  // Zoom and center on a specific node
  const zoomToNode = useCallback((nodeId: string) => {
    requestAnimationFrame(() => {
      const targetNode = getNode(nodeId);
      if (targetNode?.position) {
        setCenter(
          targetNode.position.x + NODE_WIDTH / 2,
          targetNode.position.y + NODE_HEIGHT / 2,
          { zoom: 0.8, duration: FIT_VIEW_DURATION }
        );
      } else {
        notifyUser(`Could not focus "${nodeId}". The node may have been filtered out during a view transition.`);
      }
    });
  }, [getNode, setCenter]);

  // O(1) lookups for search and pending-zoom checks. First-wins maps preserve `.find()` semantics.
  const flowNodeLookup = useMemo(() => {
    const ids = new Set<string>();
    const byLabel = new Map<string, FlowNode>();
    const bySchemaLabel = new Map<string, FlowNode>();
    for (const n of flowNodes) {
      ids.add(n.id);
      const label = String(n.data.label ?? '');
      if (!byLabel.has(label)) byLabel.set(label, n);
      const key = searchKey(String(n.data.schema ?? ''), label);
      if (!bySchemaLabel.has(key)) bySchemaLabel.set(key, n);
    }
    return { ids, byLabel, bySchemaLabel };
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

  // Execute search: find node and zoom to it, expanding its schema from overview when needed.
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

    // Overview mode: node not in flowNodes — expand its schema in expanded schema view (filter untouched).
    if (graphMode === 'overview' && model) {
      const modelNode = schema
        ? modelNodeNameLookup.bySchemaName.get(searchKey(schema, name))
        : modelNodeNameLookup.byName.get(name);
      if (modelNode) {
        pendingZoomRef.current = modelNode.id;
        pendingClickRef.current = { id: modelNode.id };
        pendingZoomSetAt.current = Date.now();
        // Active timeout — guarantees warning fires even if flowNodes stops changing
        clearPendingZoomTimer();
        pendingZoomTimerRef.current = window.setTimeout(() => {
          if (pendingZoomRef.current) {
            notifyUser(`"${pendingZoomRef.current}" is not visible in the current view. Adjust your schema filter to include it.`);
            pendingZoomRef.current = null;
            pendingClickRef.current = null;
          }
        }, PENDING_ZOOM_TIMEOUT_MS);
        onOpenExpandedSchemaViewForNode?.(modelNode.id);
      } else {
        notifyUser(`"${label}" was not found in the loaded model.`);
      }
    } else {
      notifyUser(`"${label}" is not visible in the current view. Adjust your schema or type filters to include it.`);
    }
  }, [clearPendingZoomTimer, flowNodeLookup, zoomToNode, onNodeClick, graphMode, model, modelNodeNameLookup, onOpenExpandedSchemaViewForNode]);

  // Export object nodes in detail views and cluster nodes in schema overview; empty exports no-op.
  const handleExportDrawio = useCallback(() => {
    const exportObjectNodes: FlowNode<CustomNodeData>[] = [];
    const clusterNodes: FlowNode<SchemaNodeData>[] = [];
    const exportNodes = objectNodes();
    const exportEdges = getEdges();
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
  }, [objectNodes, getEdges, availableSchemas, filter.schemas, sourceName, vscodeApi]);

  // Keep pending zoom targets until their node exists; otherwise fitView would consume and lose them.
  useEffect(() => {
    const previousTrace = traceAtLastGraphChangeRef.current;
    const currentTrace = currentTraceRef.current;
    traceAtLastGraphChangeRef.current = currentTrace;

    if (pendingPositions && Object.keys(pendingPositions).length > 0) return;
    const zoomTarget = pendingZoomRef.current;
    const clickTarget = pendingClickRef.current;
    if (zoomTarget) {
      // Verify the target node exists in the current flowNodes before consuming.
      // During overview expansion, React may render with stale flowNodes before the expanded schema graph
      // arrives. Keep the ref set until the correct flowNodes land, or expire after timeout.
      const nodeExists = flowNodeLookup.ids.has(zoomTarget);
      const elapsed = Date.now() - pendingZoomSetAt.current;
      if (!nodeExists) {
        if (elapsed > PENDING_ZOOM_TIMEOUT_MS) {
          notifyUser(`"${zoomTarget}" is not visible in the current view. Adjust your schema filter to include it.`);
          pendingZoomRef.current = null;
          pendingClickRef.current = null;
          clearPendingZoomTimer();
          // Fall through to fitView
        } else {
          return; // Don't consume — wait for the next flowNodes update (silent; fires every render)
        }
      } else {
        pendingZoomRef.current = null;
        pendingClickRef.current = null;
        clearPendingZoomTimer();
        zoomToNode(zoomTarget);
        // Defer click to next frame so highlight lands after the expanded schema nodes render.
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
    const raf = requestAnimationFrame(() => {
      fitView({ padding: FIT_VIEW_PADDING, duration: FIT_VIEW_DURATION });
    });
    return () => cancelAnimationFrame(raf);
  }, [clearPendingZoomTimer, flowNodes, fitView, zoomToNode]); // pendingPositions, onNodeClickRef intentionally excluded — read at effect run time

  // Local state preserves drag positions across highlight changes
  const [localNodes, setLocalNodes] = useState<FlowNode[]>(flowNodes);
  const [localEdges, setLocalEdges] = useState<FlowEdge[]>(flowEdges);
  const [notesVisible, setNotesVisible] = useState(true);
  const [columnView, setColumnView] = useState(false);
  const [hoveredColumn, setHoveredColumn] = useState<{ nodeId: string; column: string } | null>(null);
  const [columnPositions, setColumnPositions] = useState<Record<string, { x: number; y: number }>>({});

  useEffect(() => {
    if (pendingPositions && Object.keys(pendingPositions).length > 0) {
      setLocalNodes(flowNodes.map(n => {
        const saved = pendingPositions[n.id];
        return saved ? { ...n, position: { x: saved.x, y: saved.y } } : n;
      }));
      if (pendingViewport) {
        requestAnimationFrame(() => setViewport(pendingViewport));
      }
      onPendingPositionsApplied?.();
    } else {
      setLocalNodes(flowNodes);
    }
  }, [flowNodes]);

  useEffect(() => {
    setLocalEdges(flowEdges);
  }, [flowEdges]);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setLocalNodes((nds) => applyNodeChanges(changes, nds) as FlowNode[]),
    []
  );

  /**
   * Node changes while the column view is on stage.
   *
   * @remarks
   * Column nodes carry the same ids as the object nodes they replace, so routing their changes
   * through `onNodesChange` would apply a column-view drag to the object node of the same id and
   * corrupt the positions a bookmark saves. Only the drag is kept — selection and dimensions are
   * derived per render in the column branch of `displayNodes`.
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

  /** Hide AI notes when zoomed out below threshold for readability. */
  const handleViewportChange = useCallback((vp: { zoom: number }) => {
    setNotesVisible(prev => {
      const next = vp.zoom >= 0.5;
      return prev === next ? prev : next;
    });
  }, []);

  // ── O(1) model node lookup (avoids O(n²) .find() in DetailSearchSidebar) ──
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

  // ── Display layer: highlight/dim applied on top of local positions ──

  const level1Neighbors = useMemo(() => {
    const neighbors = new Set<string>();
    if (highlightedNodeId && graph && graph.hasNode(highlightedNodeId)) {
      const nodeNeighbors = graph.neighbors(highlightedNodeId);
      nodeNeighbors.forEach(n => neighbors.add(n));
    }
    return neighbors;
  }, [highlightedNodeId, graph]);

  const isBookmarkMode = (filter.allowlistNodeIds?.size ?? 0) > 0;

  // Build AI highlight + badge lookups from active AI profile OR transient AI preview
  const activeAiMetadata = activeAdvancedProfile?.aiMetadata ?? aiPreview?.aiMetadata;

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

  const aiBadgeMap = useMemo((): Map<string, { text: string }> => {
    const m = new Map<string, { text: string }>();
    const badges = activeAiMetadata?.badges;
    if (!badges) return m;
    for (const b of badges) m.set(b.nodeId, { text: b.text });
    return m;
  }, [activeAiMetadata]);

  const aiNoteMap = useMemo((): Map<string, { text: string }> => {
    const m = new Map<string, { text: string }>();
    const notes = activeAiMetadata?.notes;
    if (!notes) return m;
    for (const n of notes) m.set(n.nodeId, { text: n.text });
    return m;
  }, [activeAiMetadata]);

  /** Column-level rendering of the active trace; null when the run recorded no column findings. */
  const columnTraceView = useMemo(() => {
    const relations = activeAiMetadata?.columnAspect?.edges;
    if (!relations?.length) return null;
    const objects = new Map<string, ColumnTraceViewObject>();
    for (const node of flowNodes) {
      if (node.type === 'schemaNode') continue;
      const data = node.data as CustomNodeData;
      objects.set(node.id.toLowerCase(), {
        id: node.id,
        label: data.label,
        schema: data.schema,
        objectType: data.objectType,
      });
    }
    const verdicts = activeAiMetadata?.nodeVerdicts?.length
      ? new Map(activeAiMetadata.nodeVerdicts.map(v => [v.nodeId.toLowerCase(), v.verdict]))
      : undefined;
    return buildColumnTraceView({
      relations,
      objects,
      verdicts,
      layoutDirection: activeAiMetadata?.layoutDirection,
    });
  }, [activeAiMetadata, flowNodes]);

  const columnViewActive = columnView && !!columnTraceView;
  columnViewObjectNodesRef.current = columnViewActive ? localNodes : null;

  /**
   * Node-and-column keys reachable from the hovered row in either direction.
   *
   * @remarks
   * Traversal walks the column edges as an undirected graph so the whole thread lights up, not just
   * its upstream or downstream half.
   */
  const hoveredColumnPath = useMemo((): Set<string> | null => {
    if (!hoveredColumn || !columnTraceView) return null;
    const seen = new Set<string>([columnRowKey(hoveredColumn.nodeId, hoveredColumn.column)]);
    const queue = [...seen];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const edge of columnTraceView.edges) {
        const from = columnRowKey(edge.source, edge.sourceColumn);
        const to = columnRowKey(edge.target, edge.targetColumn);
        if (current === from && !seen.has(to)) { seen.add(to); queue.push(to); }
        else if (current === to && !seen.has(from)) { seen.add(from); queue.push(from); }
      }
    }
    return seen;
  }, [hoveredColumn, columnTraceView]);

  // Full-model graph backing the shared prune-safety guard; scope is bounded per call.
  const modelGraph = useMemo(() => (model ? buildGraphologyGraph(model) : null), [model]);

  const traceControlsByNode = useMemo((): Map<string, TraceNodeControls> => {
    const controls = new Map<string, TraceNodeControls>();
    const isEditableTrace = canEditTraceScope && isEditableTraceMode(trace.mode);
    if (!model || !modelGraph || !trace.selectedNodeId || !isEditableTrace || !onTraceAddNeighbor || !onTracePruneNode) {
      return controls;
    }
    // Only the highlighted (clicked) node shows edit controls — keeps the four +/- buttons off every
    // other node (no clutter) and bounds the per-node prune-safety BFS to a single node.
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

  // Leaving column mode drops the hovered thread; otherwise returning to it opens with an arbitrary
  // thread lit and every other row dimmed.
  const handleToggleColumnView = useCallback((next: boolean) => {
    setColumnView(next);
    setHoveredColumn(null);
  }, []);

  // Hand-placed column nodes belong to the relation set that produced the layout, so only a new
  // relation set invalidates them. Keying this on `columnTraceView` would also fire on every
  // re-derivation of the rendered node array — a filter toggle would silently discard the drags
  // `onColumnNodesChange` exists to keep.
  const columnRelations = activeAiMetadata?.columnAspect;
  useEffect(() => {
    setColumnPositions({});
  }, [columnRelations]);

  // A view with no column findings has no column mode to be in; drop back rather than render empty.
  useEffect(() => {
    if (!columnTraceView) {
      setColumnView(false);
      setHoveredColumn(null);
    }
  }, [columnTraceView]);

  /**
   * Per-node data for the column view, keyed by node id.
   *
   * @remarks
   * Deliberately excludes `columnPositions`: React Flow emits a position change per drag frame, so
   * deriving this inside `displayNodes` would rebuild every node's data object on every frame and
   * defeat the `React.memo` on `ColumnTraceNode`. Only `position` may vary with a drag.
   */
  const columnNodeData = useMemo((): Map<string, ColumnTraceNodeData> => {
    const byNode = new Map<string, ColumnTraceNodeData>();
    if (!columnTraceView) return byNode;
    const statesByRow = resolveRowLineStates(columnTraceView.edges);
    for (const view of columnTraceView.nodes) {
      const rowLineStates: Record<string, ColumnLineState> = {};
      for (const row of view.rows) {
        const state = statesByRow.get(columnRowKey(view.id, row.name));
        if (state) rowLineStates[row.name] = state;
      }
      const onPath = hoveredColumnPath
        ? view.rows.find(r => hoveredColumnPath.has(columnRowKey(view.id, r.name)))?.name
        : undefined;
      byNode.set(view.id, {
        view,
        rowsVisible: notesVisible,
        rowLineStates,
        onColumnHover: handleColumnHover,
        ...(onPath ? { hoveredColumn: onPath } : {}),
      });
    }
    return byNode;
  }, [columnTraceView, hoveredColumnPath, notesVisible, handleColumnHover]);

  const displayNodes = useMemo((): FlowNode[] => {
    if (columnViewActive && columnTraceView) {
      return columnTraceView.nodes.map(view => {
        const data = columnNodeData.get(view.id)!;
        return {
          id: view.id,
          type: 'columnTraceNode',
          position: columnPositions[view.id] ?? view.position,
          data: data as unknown as FlowNode['data'],
        } as FlowNode;
      });
    }
    return localNodes.map(node => {
      if (node.type === 'schemaNode') {
        return {
          ...node,
          data: {
            ...node.data,
            onExpandSchema: graphMode === 'overview' ? onExpandExpandedSchemaViewSchema : undefined,
            onMakeSchemaCenter: graphMode === 'overview' ? onCenterExpandedSchemaViewSchema : undefined,
          },
        };
      }

      const isHighlighted = highlightedNodeId === node.id;
      const isTraceOrigin = node.id === trace.selectedNodeId && (
        trace.mode === 'applied' || trace.mode === 'filtered' || trace.mode === 'path-applied'
      );
      const shouldBeDimmed = highlightedNodeId && !isHighlighted && !isTraceOrigin && !level1Neighbors.has(node.id);
      return {
        ...node,
        data: {
          ...node.data,
          highlighted: isTraceOrigin ? true : isHighlighted ? 'yellow' : (node.data as CustomNodeData).highlighted,
          dimmed: !!shouldBeDimmed,
          showRemoveButton: isBookmarkMode && canRemoveNodeFromScopedView,
          onRemoveFromView: isBookmarkMode && canRemoveNodeFromScopedView ? onRemoveFromView : undefined,
          traceControls: traceControlsByNode.get(node.id),
          aiHighlight: aiHighlightMap.get(node.id),
          aiBadge: aiBadgeMap.get(node.id),
          aiNote: notesVisible ? aiNoteMap.get(node.id) : undefined,
        },
      };
    });
  }, [localNodes, graphMode, onExpandExpandedSchemaViewSchema, onCenterExpandedSchemaViewSchema, highlightedNodeId, level1Neighbors, isBookmarkMode, canRemoveNodeFromScopedView, onRemoveFromView, traceControlsByNode, aiHighlightMap, aiBadgeMap, aiNoteMap, notesVisible, trace.mode, trace.selectedNodeId, columnViewActive, columnTraceView, columnNodeData, columnPositions]);

  const displayEdges = useMemo(() => {
    if (columnViewActive && columnTraceView) {
      const onPath = (edge: { source: string; sourceColumn: string; target: string; targetColumn: string }) => {
        if (!hoveredColumnPath) return true;
        return hoveredColumnPath.has(columnRowKey(edge.source, edge.sourceColumn))
          && hoveredColumnPath.has(columnRowKey(edge.target, edge.targetColumn));
      };
      return columnTraceView.edges.map(edge => {
        const lit = onPath(edge);
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          ...(edge.state === 'transformation' ? { label: '◆' } : {}),
          labelShowBg: false,
          labelStyle: { fill: 'var(--ln-fg-muted)', fontSize: 9 },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          style: {
            strokeWidth: lit ? 1.6 : 1,
            opacity: lit ? 1 : 0.25,
          },
        } as FlowEdge;
      });
    }
    if (!highlightedNodeId) return localEdges;

    return localEdges.map(edge => {
      const isConnected = edge.source === highlightedNodeId || edge.target === highlightedNodeId;
      const baseWidth = (edge.style?.strokeWidth as number | undefined) ?? 1.2;
      return {
        ...edge,
        style: {
          ...edge.style,
          stroke: isConnected ? 'var(--ln-focus-border)' : edge.style?.stroke,
          strokeWidth: isConnected ? Math.max(baseWidth + 0.6, 2.0) : baseWidth * 0.6,
          opacity: isConnected ? 1 : 0.35,
        },
        animated: isConnected && (
          (trace.mode === 'applied' || trace.mode === 'filtered' || trace.mode === 'path-applied')
            ? config.layout.edgeAnimation
            : config.layout.highlightAnimation
        ),
      };
    });
  }, [localEdges, highlightedNodeId, config.layout.edgeAnimation, config.layout.highlightAnimation, trace.mode, columnViewActive, columnTraceView, hoveredColumnPath]);

  // Stable allNodes list for autocomplete/search — derived from full model catalog,
  // not displayNodes (which only contains Schema Cluster entries in Schema View).
  const allNodes = useMemo(
    () => (model?.nodes ?? []).map(n => ({ id: n.id, name: n.name, schema: n.schema, type: n.type })),
    [model],
  );

  // IDs of objects in the current filter scope. Used by NodeInfoBar to show ⊘ on neighbors
  // outside the filter scope, and by quick search to split visible/clustered/out-of-filter results.
  // In Schema View, localNodes are Schema Clusters — use filteredObjectIds instead.
  const visibleNodeIds = useMemo(
    () => (graphMode === 'overview' && filteredObjectIds) ? filteredObjectIds : new Set(localNodes.map(n => n.id)),
    [localNodes, graphMode, filteredObjectIds],
  );

  const selectedNodeLabel = useMemo(() => {
    if (!trace.selectedNodeId) return null;
    return (displayNodes.find(n => n.id === trace.selectedNodeId)?.data as CustomNodeData | undefined)?.label || trace.selectedNodeId;
  }, [trace.selectedNodeId, displayNodes]);

  // Derive visible schemas for the Legend — externals are excluded from the colorful legend
  // list but remain in the underlying model/filters so they don't disappear from the graph.
  const legendSchemas = useMemo(
    () => deriveLegendSchemas(localNodes, graphMode, trace.mode, renderedSchemas),
    [graphMode, trace.mode, localNodes, renderedSchemas],
  );

  const legendColorMap = useMemo(
    () => deriveLegendColorMap(localNodes),
    [localNodes],
  );

  // Mirror the current-screen snapshot to the host so the debug dump can reproduce what
  // the user sees: rendered counts, the highlighted node, its add/prune affordances (with the
  // reason each is grayed), and the live trace scope. Resync on view, selection, or scope change.
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
    window.vscode?.postMessage({
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
        />
      )}

      {/* Inline Trace Controls - shown during configuration phase */}
      {trace.mode === 'configuring' && trace.selectedNodeId && (
        <InlineTraceControls
          startNodeId={trace.selectedNodeId}
          startNodeName={selectedNodeLabel ?? trace.selectedNodeId!}
          defaultUpstream={config.trace.defaultUpstreamLevels}
          defaultDownstream={config.trace.defaultDownstreamLevels}
          onApply={(traceConfig) => {
            onTraceApply(traceConfig);
          }}
          onClose={onTraceEnd}
        />
      )}

      {/* Traced Filter Banner - shown during applied or filtered (immediate) mode */}
      {(trace.mode === 'applied' || trace.mode === 'filtered') && trace.selectedNodeId && (
        <TracedFilterBanner
          startNodeName={selectedNodeLabel ?? trace.selectedNodeId!}
          upstreamLevels={trace.upstreamLevels}
          downstreamLevels={trace.downstreamLevels}
          totalNodes={trace.tracedNodeIds.size}
          totalEdges={trace.tracedEdgeIds.size}
          mode={trace.mode}
          onEnd={() => onTraceEnd(() => fitView({ padding: 0.2, duration: 800 }))}
          onReset={() => onResetAll()}
          onSaveAsBookmark={onSaveTraceBookmark ? handleSaveTraceAsBookmark : undefined}
          useFullModel={useFullModel ?? false}
          onToggleFullModel={onToggleFullModel ?? (() => {})}
          filteredOutCount={filteredOutCount ?? 0}
        />
      )}

      {/* Path Finder Bar — shown during pathfinding modes */}
      {(trace.mode === 'pathfinding' || trace.mode === 'path-applied') && trace.selectedNodeId && onApplyPath && (
        <PathFinderBar
          sourceNodeName={selectedNodeLabel ?? trace.selectedNodeId!}
          allNodes={allNodes}
          pathResult={trace.mode === 'path-applied' ? {
            found: true,
            nodeCount: trace.tracedNodeIds.size,
            edgeCount: trace.tracedEdgeIds.size,
          } : null}
          onFindPath={onApplyPath}
          onClose={() => onTraceEnd(() => fitView({ padding: 0.2, duration: 800 }))}
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
        resetKey={graphErrorResetKey}
        context={graphErrorContext}
        onError={() => {
          // Detail + the VS Code error toast are already emitted by ErrorBoundary.componentDidCatch
          // → bridge 'error' handler (error-level Output log). Here we only auto-reload so the user
          // never stares at a dead canvas; the navbar stays mounted above this boundary.
          setTimeout(() => window.vscode?.postMessage({ type: 'reload' }), 800);
        }}
        fallback={
          <div className="flex-1 flex items-center justify-center text-xs" style={{ color: 'var(--ln-fg-muted)' }}>
            The graph view hit an error and is reloading…
          </div>
        }
      >
      <div className="flex-1 flex flex-row overflow-hidden min-h-0">
        <div className="flex-1 relative overflow-hidden min-w-0">
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
          <div style={{ width: '100%', height: '100%', position: 'absolute' }}>
            <ReactFlow
              nodes={displayNodes}
              edges={displayEdges}
              onNodesChange={columnViewActive ? onColumnNodesChange : onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              onNodeClick={handleNodeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
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
              minZoom={0.1}
              maxZoom={2}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
              nodesDraggable={true}
              nodesConnectable={false}
              nodesFocusable={true}
              edgesFocusable={true}
              elementsSelectable={true}
              onViewportChange={handleViewportChange}
              selectNodesOnDrag={false}
              deleteKeyCode={null}
              panOnDrag={true}
              panOnScroll={false}
              zoomOnScroll={true}
              zoomOnPinch={true}
              zoomOnDoubleClick={true}
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
              {(isDetailSearchOpen || analysisMode) && (
                <Panel position="top-left">
                  {analysisMode && onCloseAnalysis && onSelectAnalysisGroup && onClearAnalysisGroup ? (
                    <AnalysisSidebar
                      analysis={analysisMode}
                      graph={graph}
                      onSelectGroup={onSelectAnalysisGroup}
                      onClearGroup={onClearAnalysisGroup}
                      onClose={onCloseAnalysis}
                      onSwitchAnalysis={onOpenAnalysis}
                    />
                  ) : onToggleDetailSearch ? (
                      <DetailSearchSidebar
                        onClose={onToggleDetailSearch}
                        allNodes={allNodes.map(n => ({
                          id: n.id,
                          name: n.name,
                          schema: n.schema,
                          type: n.type,
                          bodyScript: modelNodeMap.get(n.id)?.bodyScript,
                          columns: modelNodeMap.get(n.id)?.columns,
                        }))}
                        visibleNodeIds={visibleNodeIds}
                        collapsedSchemaNodeIds={collapsedSchemaNodeIds}
                        onResultClick={(nodeId, searchTerm) => {
                          if (graphMode === 'overview') {
                            if (modelNodeMap.has(nodeId)) {
                            pendingZoomRef.current = nodeId;
                            pendingClickRef.current = { id: nodeId, searchTerm };
                            onOpenExpandedSchemaViewForNode?.(nodeId);
                            return;
                          }
                        }
                        onNodeClick(nodeId, searchTerm);
                        zoomToNode(nodeId);
                      }}
                    />
                  ) : null}
                </Panel>
              )}
            </ReactFlow>
          </div>
        )}

        <Legend
          schemas={legendSchemas}
          schemaColorMap={legendColorMap}
          isExpandedSchemaViewActive={!!isExpandedSchemaViewActive}
          expandedSchemas={expandedSchemas}
          isSidebarOpen={isDetailSearchOpen || !!analysisMode}
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
        {/* AI description overlay — collapsible markdown panel at top-center */}
        {activeAiMetadata?.description && (
          <Suspense fallback={null}>
            <AiDescriptionOverlay
              viewName={activeAdvancedProfile?.name ?? aiPreview?.name ?? ''}
              description={activeAiMetadata.description}
              defaultExpanded={
                (aiPreview && aiPreview.nodeIds.size === 0) ||
                (activeAdvancedProfile && (activeAdvancedProfile.filter.allowlistNodeIds?.length ?? 0) === 0)
                ? true : false
              }
              onFocusNode={(nodeId) => { zoomToNode(nodeId); onNodeClick(nodeId); }}
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
