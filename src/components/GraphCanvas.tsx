import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
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

import { CustomNode, type CustomNodeData } from './CustomNode';
import { SchemaNode } from './SchemaNode';
import type { SchemaNodeData, GraphMode } from '../engine/types';
import { Legend } from './Legend';
import { InlineTraceControls } from './InlineTraceControls';
import { TracedFilterBanner } from './TracedFilterBanner';
import { PathFinderBar } from './PathFinderBar';
import { AnalysisBanner } from './AnalysisBanner';
import { AnalysisSidebar } from './AnalysisSidebar';
import { AiViewBanner } from './AiViewBanner';
import { BookmarkBanner } from './BookmarkBanner';
import { BookmarkInfoCard } from './BookmarkInfoCard';
import { AiDescriptionOverlay } from './AiDescriptionOverlay';
import { Toolbar } from './Toolbar';
import { NodeInfoBar } from './NodeInfoBar';
import { DetailSearchSidebar } from './DetailSearchSidebar';
import type { FilterState, TraceState, ObjectType, ExtensionConfig, DatabaseModel, AnalysisMode, AnalysisType } from '../engine/types';
import type { FilterProfile, AIViewMetadata } from '../engine/projectStore';
import { getSchemaColor, getExternalNodeColor, AI_COLOR_HEX, AI_COLOR_GLOW, resolveAiColor, type SchemaColorMap } from '../utils/schemaColors';
import { schemaKey } from '../utils/sql';
import { NODE_WIDTH, NODE_HEIGHT } from '../engine/graphBuilder';
import { notifyUser } from '../utils/notify';

/**
 * Mapping of custom node types for React Flow.
 *
 * IMPORTANT: nodeTypes must be defined at module level — not inside the component.
 * If defined inside, React Flow remounts all nodes on every render, causing
 * severe performance degradation and loss of state.
 */
const nodeTypes = { lineageNode: CustomNode, schemaNode: SchemaNode } satisfies NodeTypes;

/** Padding factor applied when fitting the graph view. */
const FIT_VIEW_PADDING = 0.15;

/** Animation duration in ms for fitting the graph view. */
const FIT_VIEW_DURATION = 250;

/**
 * Max time (ms) to wait for a pending zoom target to appear in flowNodes before
 * giving up and showing a warning.
 */
const PENDING_ZOOM_TIMEOUT_MS = 5000;

/**
 * Props for the {@link GraphCanvas} component.
 */
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
  /** Callback fired when a node is right-clicked. */
  onNodeContextMenu: (nodeId: string, x: number, y: number) => void;
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
  /** The current graph abstraction level (full object graph or overview schema graph). */
  graphMode?: GraphMode;
  /**
   * Object-level node IDs that passed all filters (from useGraphology flowNodes).
   * In overview mode, flowNodes are schema aggregates — this set preserves the object-level truth.
   */
  filteredObjectIds?: Set<string>;
  /** Callback for double-clicking a schema node (triggers drill-down). */
  onSchemaNodeDoubleClick?: (schemaName: string) => void;
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
  /** Called after pendingPositions have been applied so the parent can clear them. */
  onPendingPositionsApplied?: () => void;
  /** Whether trace BFS uses the full (unfiltered) model. */
  useFullModel?: boolean;
  /** Toggle between filtered and full-model trace. */
  onToggleFullModel?: () => void;
  /** Number of trace nodes hidden by the active filter. */
  filteredOutCount?: number;
}

/**
 * The primary canvas component for the lineage visualization.
 *
 * This component orchestrates the graph display (via React Flow), the various
 * floating control panels (Toolbar, Search, Legend), and the specialized
 * interaction modes (Trace, Path, Analysis).
 *
 * It manages:
 * - Graph layout and viewport control (fit view, zoom to node).
 * - Multi-layered filtering (types, schemas, exclusions).
 * - Selection and highlighting logic.
 * - Drill-down transitions between Overview (schema) and Full (object) modes.
 * - State management for advanced bookmarks and AI-generated views.
 *
 * @param props - The component props.
 * @returns A complex functional component.
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
  graphMode = 'full',
  filteredObjectIds,
  onSchemaNodeDoubleClick,
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
  onPendingPositionsApplied,
  useFullModel,
  onToggleFullModel,
  filteredOutCount,
}: GraphCanvasProps) {
  const { fitView, getNode, setCenter, getNodes, getViewport, setViewport } = useReactFlow();
  const vscodeApi = useVsCode();

  // Pending actions for post-rebuild drill-down (overview → full + zoom to node)
  const pendingZoomRef = useRef<string | null>(null);
  const pendingClickRef = useRef<{ id: string; searchTerm?: string } | null>(null);
  /** Timestamp when pendingZoomRef was set — used to expire stale refs after PENDING_ZOOM_TIMEOUT_MS. */
  const pendingZoomSetAt = useRef<number>(0);
  /** Active timer — guarantees the pendingZoom warning fires even if flowNodes stops changing. */
  const pendingZoomTimerRef = useRef<number | null>(null);
  // Cleanup: clear pending zoom timer on unmount to prevent post-destroy notifyUser calls
  useEffect(() => () => {
    if (pendingZoomTimerRef.current) clearTimeout(pendingZoomTimerRef.current);
  }, []);
  // Stable ref for onNodeClick — used inside auto-fit effect without adding to deps
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      onNodeClick(node.id);
    },
    [onNodeClick]
  );

  const handleFitView = useCallback(() => {
    fitView({ padding: FIT_VIEW_PADDING, duration: FIT_VIEW_DURATION });
  }, [fitView]);

  const handleSaveTraceAsBookmark = useCallback((name: string, withPositions: boolean) => {
    if (!onSaveTraceBookmark) return;
    const nodeIds = Array.from(trace.tracedNodeIds);
    if (withPositions) {
      const nodes = getNodes();
      const pos: Record<string, { x: number; y: number }> = {};
      for (const n of nodes) pos[n.id] = n.position;
      onSaveTraceBookmark(name, nodeIds, 'trace', pos, getViewport());
    } else {
      onSaveTraceBookmark(name, nodeIds, 'trace');
    }
  }, [onSaveTraceBookmark, trace.tracedNodeIds, getNodes, getViewport]);

  const handleSaveAnalysisAsBookmark = useCallback((name: string, withPositions: boolean) => {
    if (!onSaveAnalysisBookmark || !analysisMode) return;
    const activeGroup = analysisMode.activeGroupId
      ? analysisMode.result.groups.find(g => g.id === analysisMode.activeGroupId)
      : null;
    const nodeIds = activeGroup
      ? activeGroup.nodeIds
      : analysisMode.result.groups.flatMap(g => g.nodeIds);
    if (withPositions) {
      const nodes = getNodes();
      const pos: Record<string, { x: number; y: number }> = {};
      for (const n of nodes) pos[n.id] = n.position;
      onSaveAnalysisBookmark(name, nodeIds, pos, getViewport());
    } else {
      onSaveAnalysisBookmark(name, nodeIds);
    }
  }, [onSaveAnalysisBookmark, analysisMode, getNodes, getViewport]);

  const handleSaveAiAsBookmark = useCallback((name: string, withPositions: boolean) => {
    if (!onSaveAiBookmark) return;
    if (withPositions) {
      const nodes = getNodes();
      const pos: Record<string, { x: number; y: number }> = {};
      for (const n of nodes) pos[n.id] = n.position;
      onSaveAiBookmark(name, withPositions, pos, getViewport());
    } else {
      onSaveAiBookmark(name, withPositions);
    }
  }, [onSaveAiBookmark, getNodes, getViewport]);

  useKeyboardShortcut(['f', 'F'], handleFitView);

  const minimapNodeColor = useCallback(
    (node: FlowNode) => {
      // Schema nodes (overview mode) carry SchemaNodeData with a pre-computed color
      if (node.type === 'schemaNode') return (node.data as SchemaNodeData).color;
      const d = node.data as CustomNodeData;
      if (d.objectType === 'external') return getExternalNodeColor();
      return d.schemaColor ?? getSchemaColor(String(d.schema));
    },
    []
  );

  const handleNodeDoubleClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (graphMode === 'overview' && node.type === 'schemaNode') {
        const schemaName = (node.data as SchemaNodeData).schemaName;
        onSchemaNodeDoubleClick?.(schemaName);
      }
    },
    [graphMode, onSchemaNodeDoubleClick]
  );

  // Zoom and center on a specific node
  const log = useCallback((text: string, level: 'info' | 'debug' = 'debug') => window.vscode?.postMessage({ type: 'log', text, level }), []);
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
  }, [getNode, setCenter, log]);

  // Execute search: find node and zoom to it (drills down from overview if needed)
  const handleExecuteSearch = useCallback((name: string, schema?: string) => {
    const label = schema ? `[${schema}].[${name}]` : name;
    const foundNode = schema
      ? flowNodes.find(n => n.data.label === name && n.data.schema === schema)
      : flowNodes.find(n => n.data.label === name);

    if (foundNode) {
      onNodeClick(foundNode.id);
      zoomToNode(foundNode.id);
      return;
    }

    // Overview mode: node not in flowNodes — drill down to its schema.
    // enterFocusFromOverview now rebuilds synchronously with forceLayout=true,
    // so flowNodes will be ready on the next render when the useEffect fires.
    if (graphMode === 'overview' && model) {
      const modelNode = schema
        ? model.nodes.find(n => n.name === name && n.schema === schema)
        : model.nodes.find(n => n.name === name);
      if (modelNode) {
        pendingZoomRef.current = modelNode.id;
        pendingClickRef.current = { id: modelNode.id };
        pendingZoomSetAt.current = Date.now();
        // Active timeout — guarantees warning fires even if flowNodes stops changing
        if (pendingZoomTimerRef.current) clearTimeout(pendingZoomTimerRef.current);
        pendingZoomTimerRef.current = window.setTimeout(() => {
          if (pendingZoomRef.current) {
            notifyUser(`"${pendingZoomRef.current}" is not visible in the current view. Adjust your schema filter to include it.`);
            pendingZoomRef.current = null;
            pendingClickRef.current = null;
          }
        }, PENDING_ZOOM_TIMEOUT_MS);
        onSchemaNodeDoubleClick?.(modelNode.schema);
      } else {
        notifyUser(`"${label}" was not found in the loaded model.`);
      }
    } else {
      notifyUser(`"${label}" is not visible in the current view. Adjust your schema or type filters to include it.`);
    }
  }, [flowNodes, zoomToNode, onNodeClick, graphMode, model, onSchemaNodeDoubleClick, log]);

  // Export current graph to Draw.io format (disabled in overview mode)
  const handleExportDrawio = useCallback(() => {
    if (graphMode === 'overview') return;
    import('../export/drawioExporter').then(({ exportToDrawio }) => {
      const schemas = (availableSchemas || []).filter(s => filter.schemas.has(s));
      const xml = exportToDrawio(flowNodes as FlowNode<CustomNodeData>[], flowEdges, schemas);
      const base = (sourceName?.replace(/\.dacpac$/i, '') || 'lineage').trim().replace(/[\\/:*?"<>|]/g, '_');
      vscodeApi.postMessage({ type: 'export-file', data: xml, defaultName: `${base}_lineage.drawio` });
    }).catch((err) => {
      vscodeApi.postMessage({ type: 'error', error: `Draw.io export failed: ${err instanceof Error ? err.message : err}` });
    });
  }, [flowNodes, flowEdges, availableSchemas, filter.schemas, sourceName, vscodeApi, graphMode]);

  // Auto-fit view whenever the graph data changes — skipped when saved positions are being restored.
  // If a pending drill-down zoom target exists (overview → full), zoom to that node instead of fitView.
  // flowNodes reference only changes on rebuild — not on highlight.
  //
  // IMPORTANT: Only consume pendingZoomRef when the target node actually exists in the current
  // flowNodes. During overview→full transitions the graphMode change can trigger a render with
  // stale flowNodes before the rebuild's new nodes arrive. If we consumed the ref at that point
  // the zoom would silently fail and be lost. By checking existence first, we keep the ref set
  // until the correct flowNodes arrive on a subsequent render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pendingPositions && Object.keys(pendingPositions).length > 0) return;
    const zoomTarget = pendingZoomRef.current;
    const clickTarget = pendingClickRef.current;
    if (zoomTarget) {
      // Verify the target node exists in the current flowNodes before consuming.
      // During overview→full transitions the graphMode change may trigger a render
      // with stale flowNodes before the rebuild arrives. Keep the ref set until the
      // correct flowNodes land, or expire after PENDING_ZOOM_TIMEOUT_MS.
      const nodeExists = flowNodes.some(n => n.id === zoomTarget);
      const elapsed = Date.now() - pendingZoomSetAt.current;
      if (!nodeExists) {
        if (elapsed > PENDING_ZOOM_TIMEOUT_MS) {
          notifyUser(`"${zoomTarget}" is not visible in the current view. Adjust your schema filter to include it.`);
          pendingZoomRef.current = null;
          pendingClickRef.current = null;
          if (pendingZoomTimerRef.current) { clearTimeout(pendingZoomTimerRef.current); pendingZoomTimerRef.current = null; }
          // Fall through to fitView
        } else {
          return; // Don't consume — wait for the next flowNodes update (silent; fires every render)
        }
      } else {
        pendingZoomRef.current = null;
        pendingClickRef.current = null;
        if (pendingZoomTimerRef.current) { clearTimeout(pendingZoomTimerRef.current); pendingZoomTimerRef.current = null; }
        zoomToNode(zoomTarget);
        // Defer click to next frame so highlight survives the filter-changed rebuild
        // that may still be in-flight from the overview→full transition.
        if (clickTarget) {
          requestAnimationFrame(() => onNodeClickRef.current(clickTarget.id, clickTarget.searchTerm));
        }
        return;
      }
    }
    const raf = requestAnimationFrame(() => {
      fitView({ padding: FIT_VIEW_PADDING, duration: FIT_VIEW_DURATION });
    });
    return () => cancelAnimationFrame(raf);
  }, [flowNodes, fitView, zoomToNode]); // pendingPositions, onNodeClickRef intentionally excluded — read at effect run time

  // Local state preserves drag positions across highlight changes
  const [localNodes, setLocalNodes] = useState<FlowNode[]>(flowNodes);
  const [localEdges, setLocalEdges] = useState<FlowEdge[]>(flowEdges);
  const [notesVisible, setNotesVisible] = useState(true);

  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const ctEdgeMap = useMemo((): Map<string, Array<{ neighborNode: string; direction: 'in' | 'out'; fromCol: string; toCol: string }>> => {
    const m = new Map<string, Array<{ neighborNode: string; direction: 'in' | 'out'; fromCol: string; toCol: string }>>();
    const edges = activeAiMetadata?.columnAspect?.edges;
    if (!edges) return m;
    const add = (
      nodeId: string,
      pair: { neighborNode: string; direction: 'in' | 'out'; fromCol: string; toCol: string }
    ) => {
      const k = nodeId.toLowerCase();
      if (!m.has(k)) m.set(k, []);
      const arr = m.get(k)!;
      if (!arr.some(p =>
        p.neighborNode === pair.neighborNode &&
        p.direction === pair.direction &&
        p.fromCol === pair.fromCol &&
        p.toCol === pair.toCol
      )) {
        arr.push(pair);
      }
    };
    for (const e of edges) {
      add(e.toNode, {
        neighborNode: e.fromNode,
        direction: 'in',
        fromCol: e.fromCol,
        toCol: e.toCol,
      });
      add(e.fromNode, {
        neighborNode: e.toNode,
        direction: 'out',
        fromCol: e.fromCol,
        toCol: e.toCol,
      });
      if (e.hopNode.toLowerCase() !== e.toNode.toLowerCase()) {
        add(e.hopNode, {
          neighborNode: e.fromNode,
          direction: 'in',
          fromCol: e.fromCol,
          toCol: e.toCol,
        });
      }
    }
    return m;
  }, [activeAiMetadata]);

  const displayNodes = useMemo((): FlowNode[] => {
    return localNodes.map(node => {
      const isHighlighted = highlightedNodeId === node.id;
      const shouldBeDimmed = highlightedNodeId && !isHighlighted && !level1Neighbors.has(node.id);
      return {
        ...node,
        data: {
          ...node.data,
          highlighted: isHighlighted ? 'yellow' : (node.data as CustomNodeData).highlighted,
          dimmed: !!shouldBeDimmed,
          showRemoveButton: isBookmarkMode,
          onRemoveFromView: isBookmarkMode ? onRemoveFromView : undefined,
          aiHighlight: aiHighlightMap.get(node.id),
          aiBadge: aiBadgeMap.get(node.id),
          aiNote: notesVisible ? aiNoteMap.get(node.id) : undefined,
          ctColumnFlows: ctEdgeMap.get(node.id.toLowerCase()),
        },
      };
    });
  }, [localNodes, highlightedNodeId, level1Neighbors, isBookmarkMode, onRemoveFromView, aiHighlightMap, aiBadgeMap, aiNoteMap, notesVisible, ctEdgeMap]);

  const displayEdges = useMemo(() => {
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
  }, [localEdges, highlightedNodeId, config.layout.edgeAnimation, config.layout.highlightAnimation, trace.mode]);

  // Stable allNodes list for autocomplete/search — derived from full model catalog,
  // not displayNodes (which only contains schemaNode entries in overview mode).
  const allNodes = useMemo(
    () => (model?.nodes ?? []).map(n => ({ id: n.id, name: n.name, schema: n.schema, type: n.type })),
    [model],
  );

  // IDs of nodes currently rendered in the graph (after all filters: type, focus-schema,
  // search, maxNodes cap). Used by NodeInfoBar to show ⊘ on neighbors not in view,
  // and by quick search to split "in view" vs "not in current view" suggestions.
  // In overview mode localNodes are schema aggregates — use filteredObjectIds instead.
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
  const legendSchemas = useMemo(() => {
    // In overview mode localNodes are SchemaNodeData buckets; read schemaName directly.
    if (graphMode === 'overview') {
      return localNodes
        .filter(n => n.type === 'schemaNode')
        .map(n => (n.data as SchemaNodeData).schemaName)
        .filter(s => !!s && s.trim().length > 0)
        .sort();
    }

    const isTraceActive = trace.mode === 'applied' || trace.mode === 'path-applied'
      || trace.mode === 'filtered' || trace.mode === 'analysis';

    // We only show schemas in the legend if they contain at least one non-external object.
    const schemasWithRealObjects = new Set(
      localNodes
        .map(n => n.data as CustomNodeData)
        .filter(d => d.objectType !== 'external')
        .map(d => d.schema)
        .filter(s => !!s && s.trim().length > 0)
    );

    if (!isTraceActive) {
      return (renderedSchemas || []).filter(s => schemasWithRealObjects.has(s));
    }
    return Array.from(schemasWithRealObjects).filter(Boolean).sort();
  }, [graphMode, trace.mode, localNodes, renderedSchemas]);

  const legendColorMap = useMemo((): SchemaColorMap => {
    const colors: SchemaColorMap = new Map();
    for (const node of localNodes) {
      if (node.type === 'schemaNode') {
        const data = node.data as SchemaNodeData;
        colors.set(schemaKey(data.schemaName), data.color);
        continue;
      }
      const data = node.data as CustomNodeData;
      if (data.objectType !== 'external') {
        colors.set(schemaKey(data.schema), data.schemaColor ?? getSchemaColor(data.schema));
      }
    }
    return colors;
  }, [localNodes]);

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
        isOverview={graphMode === 'overview'}
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
        />
      )}

      <div className="flex-1 flex flex-row overflow-hidden min-h-0">
        <div className="flex-1 relative overflow-hidden min-w-0">
        {isRebuilding && (
          <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: 'var(--ln-bg)', opacity: 0.85 }}>
            <svg className="animate-spin h-8 w-8" style={{ color: 'var(--ln-fg-muted)' }} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
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
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              onNodeClick={handleNodeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
              onNodeContextMenu={(event, node) => {
                event.preventDefault();
                onNodeContextMenu(node.id, event.clientX, event.clientY);
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
                      onResultClick={(nodeId, searchTerm) => {
                        if (graphMode === 'overview') {
                          const node = model?.nodes.find(n => n.id === nodeId);
                          if (node) {
                            pendingZoomRef.current = nodeId;
                            pendingClickRef.current = { id: nodeId, searchTerm };
                            onSchemaNodeDoubleClick?.(node.schema);
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

        <Legend schemas={legendSchemas} schemaColorMap={legendColorMap} isSidebarOpen={isDetailSearchOpen || !!analysisMode} />

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
        )}
        </div>
      </div>

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
