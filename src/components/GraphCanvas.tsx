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
import { getSchemaColor, getVirtualExtColor, AI_COLOR_HEX, AI_COLOR_GLOW, resolveAiColor } from '../utils/schemaColors';
import { NODE_WIDTH, NODE_HEIGHT } from '../engine/graphBuilder';

// IMPORTANT: nodeTypes must be defined at module level — not inside the component.
// If defined inside, React Flow remounts all nodes on every render.
const nodeTypes = { lineageNode: CustomNode, schemaNode: SchemaNode } satisfies NodeTypes;

const FIT_VIEW_PADDING = 0.15;
const FIT_VIEW_DURATION = 250;

interface GraphCanvasProps {
  flowNodes: FlowNode[];
  flowEdges: FlowEdge[];
  trace: TraceState;
  filter: FilterState;
  metrics: { totalNodes: number; totalEdges: number; rootNodes: number; leafNodes: number } | null;
  highlightedNodeId?: string | null;
  graph?: Graph | null;
  config: ExtensionConfig;
  onNodeClick: (nodeId: string, findQuery?: string) => void;
  onNodeContextMenu: (nodeId: string, x: number, y: number) => void;
  onStartTraceImmediate: (nodeId: string) => void;
  onTraceApply: (config: { upstreamLevels: number; downstreamLevels: number }) => void;
  onTraceEnd: (onComplete?: () => void) => void;
  onResetAll: () => void;
  onToggleType: (type: ObjectType) => void;
  onSearchChange: (term: string) => void;
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
  onRefresh: () => void;
  onRebuild?: () => void;
  onBack: () => void;
  onOpenDdlViewer?: () => void;
  isDetailSearchOpen?: boolean;
  onToggleDetailSearch?: () => void;
  model?: DatabaseModel | null;
  infoBarNodeId?: string | null;
  onCloseInfoBar?: () => void;
  analysisMode?: AnalysisMode | null;
  onOpenAnalysis?: (type: AnalysisType) => void;
  onCloseAnalysis?: () => void;
  onSelectAnalysisGroup?: (groupId: string) => void;
  onClearAnalysisGroup?: () => void;
  onApplyPath?: (targetNodeId: string) => boolean;
  isRebuilding?: boolean;
  sourceName?: string;
  filterProfiles?: FilterProfile[];
  activeProjectId?: string | null;
  activeViewId?: string | null;
  isViewModified?: boolean;
  onSaveView?: (name: string) => void;
  onApplyView?: (profile: FilterProfile) => void;
  onDeleteView?: (profileId: string) => void;
  onUpdateView?: (profileId: string) => void;
  isFilterDirty?: boolean;
  /** When true, analysis and trace-start are disabled (trace/analysis/bookmark mode active). */
  isModeLocked?: boolean;
  graphMode?: GraphMode;
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
  /** Toggle between filtered and full-model BFS in trace mode. */
  onToggleFullGraph?: () => void;
}

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
  onSearchChange,
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
  onToggleFullGraph,
}: GraphCanvasProps) {
  const { fitView, getNode, setCenter, getNodes, getViewport, setViewport } = useReactFlow();
  const vscodeApi = useVsCode();

  // Pending actions for post-rebuild drill-down (overview → full + zoom to node)
  const pendingZoomRef = useRef<string | null>(null);
  const pendingClickRef = useRef<{ id: string; searchTerm?: string } | null>(null);
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
      const ext = d.externalType;
      if (ext === 'file' || ext === 'db') return getVirtualExtColor();
      return getSchemaColor(String(d.schema));
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
  const zoomToNode = useCallback((nodeId: string) => {
    requestAnimationFrame(() => {
      const targetNode = getNode(nodeId);
      if (targetNode?.position) {
        setCenter(
          targetNode.position.x + NODE_WIDTH / 2,
          targetNode.position.y + NODE_HEIGHT / 2,
          { zoom: 0.8, duration: FIT_VIEW_DURATION }
        );
      }
    });
  }, [getNode, setCenter]);

  // Execute search: find node and zoom to it (drills down from overview if needed)
  const handleExecuteSearch = useCallback((name: string, schema?: string) => {
    const foundNode = schema
      ? flowNodes.find(n => n.data.label === name && n.data.schema === schema)
      : flowNodes.find(n => n.data.label === name);

    if (foundNode) {
      onNodeClick(foundNode.id);
      zoomToNode(foundNode.id);
      return;
    }

    // Overview mode: node not in flowNodes — drill down to its schema
    if (graphMode === 'overview' && model) {
      const modelNode = schema
        ? model.nodes.find(n => n.name === name && n.schema === schema)
        : model.nodes.find(n => n.name === name);
      if (modelNode) {
        pendingZoomRef.current = modelNode.id;
        pendingClickRef.current = { id: modelNode.id };
        onSchemaNodeDoubleClick?.(modelNode.schema);
      }
    }
  }, [flowNodes, zoomToNode, onNodeClick, graphMode, model, onSchemaNodeDoubleClick]);

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
  // flowNodes reference only changes on rebuild — not on highlight
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pendingPositions && Object.keys(pendingPositions).length > 0) return;
    const zoomTarget = pendingZoomRef.current;
    const clickTarget = pendingClickRef.current;
    if (zoomTarget) {
      pendingZoomRef.current = null;
      pendingClickRef.current = null;
      zoomToNode(zoomTarget);
      if (clickTarget) onNodeClickRef.current(clickTarget.id, clickTarget.searchTerm);
      return;
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
        },
      };
    });
  }, [localNodes, highlightedNodeId, level1Neighbors, isBookmarkMode, onRemoveFromView, aiHighlightMap, aiBadgeMap, aiNoteMap, notesVisible]);

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
  // search, maxNodes cap). Used by NodeInfoBar to show ⊘ on neighbors not in view.
  const visibleNodeIds = useMemo(
    () => new Set(localNodes.map(n => n.id)),
    [localNodes],
  );

  const selectedNodeLabel = useMemo(() => {
    if (!trace.selectedNodeId) return null;
    return (displayNodes.find(n => n.id === trace.selectedNodeId)?.data as CustomNodeData | undefined)?.label || trace.selectedNodeId;
  }, [trace.selectedNodeId, displayNodes]);

  return (
    <div className="flex flex-col h-screen">
      <Toolbar
        types={filter.types}
        onToggleType={onToggleType}
        searchTerm={filter.searchTerm}
        onSearchChange={onSearchChange}
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
          fullTraceNodeCount={trace.fullTraceNodeCount}
          useFullGraph={trace.useFullGraph}
          onToggleFullGraph={onToggleFullGraph}
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

        <Legend schemas={renderedSchemas || []} isSidebarOpen={isDetailSearchOpen || !!analysisMode} />

        {/* Bookmark info card — floating bottom-left, in advanced bookmark or AI preview mode */}
        {activeAdvancedProfile && isBookmarkMode && (
          <BookmarkInfoCard
            profile={activeAdvancedProfile}
            nodeCount={localNodes.length}
            schemaCount={(renderedSchemas || []).length}
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
            schemaCount={(renderedSchemas || []).length}
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
