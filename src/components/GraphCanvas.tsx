import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Toolbar } from './Toolbar';
import { NodeInfoBar } from './NodeInfoBar';
import { DetailSearchSidebar } from './DetailSearchSidebar';
import type { FilterState, TraceState, ObjectType, ExtensionConfig, DatabaseModel, AnalysisMode, AnalysisType } from '../engine/types';
import type { FilterProfile } from '../engine/projectStore';
import { getSchemaColor, getVirtualExtColor } from '../utils/schemaColors';
import { NODE_WIDTH, NODE_HEIGHT } from '../engine/graphBuilder';

// IMPORTANT: nodeTypes must be defined at module level — not inside the component.
// If defined inside, React Flow remounts all nodes on every render.
const nodeTypes = { lineageNode: CustomNode, schemaNode: SchemaNode } satisfies NodeTypes;

const FIT_VIEW_PADDING = 0.15;
const FIT_VIEW_DURATION = 800;
const AUTO_FIT_DELAY_MS = 100;

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
  onSaveView?: (name: string) => void;
  onApplyView?: (profile: FilterProfile) => void;
  onDeleteView?: (profileId: string) => void;
  onAssignSlot?: (profileId: string, slot: number | null) => void;
  graphMode?: GraphMode;
  onSchemaNodeDoubleClick?: (schemaName: string) => void;
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
  onSaveView,
  onApplyView,
  onDeleteView,
  onAssignSlot,
  graphMode = 'full',
  onSchemaNodeDoubleClick,
}: GraphCanvasProps) {
  const { fitView, getNode, setCenter } = useReactFlow();
  const vscodeApi = useVsCode();

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      onNodeClick(node.id);
    },
    [onNodeClick]
  );

  const handleFitView = useCallback(() => {
    fitView({ padding: FIT_VIEW_PADDING, duration: FIT_VIEW_DURATION });
  }, [fitView]);

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
    setTimeout(() => {
      const targetNode = getNode(nodeId);
      if (targetNode?.position) {
        setCenter(
          targetNode.position.x + NODE_WIDTH / 2,
          targetNode.position.y + NODE_HEIGHT / 2,
          { zoom: 0.8, duration: 800 }
        );
      }
    }, 100);
  }, [getNode, setCenter]);

  // Execute search: find node and zoom to it
  const handleExecuteSearch = useCallback((name: string, schema?: string) => {
    const foundNode = schema
      ? flowNodes.find(n => n.data.label === name && n.data.schema === schema)
      : flowNodes.find(n => n.data.label === name);

    if (foundNode) {
      onNodeClick(foundNode.id);
      zoomToNode(foundNode.id);
    }
  }, [flowNodes, zoomToNode, onNodeClick]);

  // Export current graph to Draw.io format (disabled in overview mode)
  const handleExportDrawio = useCallback(() => {
    if (graphMode === 'overview') return;
    import('../export/drawioExporter').then(({ exportToDrawio }) => {
      const schemas = (availableSchemas || []).filter(s => filter.schemas.has(s));
      const xml = exportToDrawio(flowNodes as FlowNode<CustomNodeData>[], flowEdges, schemas);
      const base = sourceName?.replace(/\.dacpac$/i, '') || 'lineage';
      vscodeApi.postMessage({ type: 'export-file', data: xml, defaultName: `${base}_lineage.drawio` });
    }).catch((err) => {
      vscodeApi.postMessage({ type: 'error', error: `Draw.io export failed: ${err instanceof Error ? err.message : err}` });
    });
  }, [flowNodes, flowEdges, availableSchemas, filter.schemas, sourceName, vscodeApi, graphMode]);

  // Auto-fit view whenever the graph data changes (filter, trace, rebuild, etc.)
  // flowNodes reference only changes on rebuild — not on highlight
  useEffect(() => {
    const timer = setTimeout(() => {
      fitView({ padding: FIT_VIEW_PADDING, duration: FIT_VIEW_DURATION });
    }, AUTO_FIT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [flowNodes, fitView]);

  // Local state preserves drag positions across highlight changes
  const [localNodes, setLocalNodes] = useState<FlowNode[]>(flowNodes);
  const [localEdges, setLocalEdges] = useState<FlowEdge[]>(flowEdges);

  useEffect(() => {
    setLocalNodes(flowNodes);
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
        },
      };
    });
  }, [localNodes, highlightedNodeId, level1Neighbors]);

  const displayEdges = useMemo(() => {
    if (!highlightedNodeId) return localEdges;

    return localEdges.map(edge => {
      const isConnected = edge.source === highlightedNodeId || edge.target === highlightedNodeId;
      return {
        ...edge,
        style: {
          ...edge.style,
          stroke: isConnected ? 'var(--ln-focus-border)' : edge.style?.stroke,
          strokeWidth: isConnected ? 1.8 : edge.style?.strokeWidth || 0.8,
          opacity: isConnected ? 1 : 0.6,
        },
        animated: isConnected && (
          (trace.mode === 'applied' || trace.mode === 'filtered' || trace.mode === 'path-applied')
            ? config.layout.edgeAnimation
            : config.layout.highlightAnimation
        ),
      };
    });
  }, [localEdges, highlightedNodeId, config.layout.edgeAnimation, config.layout.highlightAnimation, trace.mode]);

  // Stable allNodes list for autocomplete/search — only lineageNode nodes (not schema overview nodes)
  const allNodes = useMemo(
    () => displayNodes
      .filter(n => n.type === 'lineageNode')
      .map(n => {
        const d = n.data as CustomNodeData;
        return { id: n.id, name: d.label, schema: d.schema, type: d.objectType };
      }),
    [displayNodes],
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
        onSaveView={onSaveView}
        onApplyView={onApplyView}
        onDeleteView={onDeleteView}
        onAssignSlot={onAssignSlot}
      />

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
                      allNodes={displayNodes
                        .filter(n => n.type === 'lineageNode')
                        .map(n => {
                          const d = n.data as CustomNodeData;
                          return {
                            id: n.id,
                            name: String(d.label),
                            schema: String(d.schema),
                            type: d.objectType as ObjectType,
                            bodyScript: modelNodeMap.get(n.id)?.bodyScript,
                            columns: modelNodeMap.get(n.id)?.columns,
                          };
                        })}
                      onResultClick={(nodeId, searchTerm) => {
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

        <Legend schemas={(availableSchemas || []).filter(s => filter.schemas.has(s))} isSidebarOpen={isDetailSearchOpen || !!analysisMode} />
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
