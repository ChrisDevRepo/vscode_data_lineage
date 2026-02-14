import { useCallback, useEffect, useMemo, useState } from 'react';
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

import { CustomNode, type CustomNodeData } from './CustomNode';
import { Legend } from './Legend';
import { InlineTraceControls } from './InlineTraceControls';
import { TracedFilterBanner } from './TracedFilterBanner';
import { PathFinderBar } from './PathFinderBar';
import { AnalysisBanner } from './AnalysisBanner';
import { AnalysisSidebar } from './AnalysisSidebar';
import { Toolbar } from './Toolbar';
import { NodeInfoBar } from './NodeInfoBar';
import { DetailSearchSidebar } from './DetailSearchSidebar';
import type { FilterState, TraceState, ObjectType, ExtensionConfig, DacpacModel, AnalysisMode, AnalysisType } from '../engine/types';
import { getSchemaColor } from '../utils/schemaColors';
import { NODE_WIDTH, NODE_HEIGHT } from '../engine/graphBuilder';

const nodeTypes = { lineageNode: CustomNode } satisfies NodeTypes;

interface GraphCanvasProps {
  flowNodes: FlowNode<CustomNodeData>[];
  flowEdges: FlowEdge[];
  trace: TraceState;
  filter: FilterState;
  metrics: { totalNodes: number; totalEdges: number; rootNodes: number; leafNodes: number } | null;
  highlightedNodeId?: string | null;
  graph?: Graph | null;
  config: ExtensionConfig;
  onNodeClick: (nodeId: string) => void;
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
  availableSchemas?: string[];
  onRefresh: () => void;
  onRebuild?: () => void;
  onBack: () => void;
  onOpenDdlViewer?: () => void;
  isDetailSearchOpen?: boolean;
  onToggleDetailSearch?: () => void;
  model?: DacpacModel | null;
  infoBarNodeId?: string | null;
  onCloseInfoBar?: () => void;
  analysisMode?: AnalysisMode | null;
  onOpenAnalysis?: (type: AnalysisType) => void;
  onCloseAnalysis?: () => void;
  onSelectAnalysisGroup?: (groupId: string) => void;
  onClearAnalysisGroup?: () => void;
  onApplyPath?: (targetNodeId: string) => boolean;
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
}: GraphCanvasProps) {
  const { fitView, getNode, setCenter } = useReactFlow();

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      onNodeClick(node.id);
    },
    [onNodeClick]
  );

  const handleFitView = useCallback(() => {
    fitView({ padding: 0.15, duration: 800 });
  }, [fitView]);

  const minimapNodeColor = useCallback(
    (node: FlowNode<CustomNodeData>) => getSchemaColor(String(node.data.schema)),
    []
  );

  // Execute search: find node and zoom to it
  const handleExecuteSearch = useCallback((name: string, schema?: string) => {
    const foundNode = schema
      ? flowNodes.find(n => n.data.label === name && n.data.schema === schema)
      : flowNodes.find(n => n.data.label === name);
    
    if (foundNode) {
      // Highlight the node (add yellow border)
      onNodeClick(foundNode.id);
      
      // Zoom and center on the node
      setTimeout(() => {
        const targetNode = getNode(foundNode.id);
        if (targetNode?.position) {
          setCenter(
            targetNode.position.x + NODE_WIDTH / 2,
            targetNode.position.y + NODE_HEIGHT / 2,
            { zoom: 0.8, duration: 800 }
          );
        }
      }, 100);
    }
  }, [flowNodes, getNode, setCenter, onNodeClick]);

  // Export current graph to Draw.io format
  const handleExportDrawio = useCallback(() => {
    import('../export/drawioExporter').then(({ exportToDrawio }) => {
      const schemas = (availableSchemas || []).filter(s => filter.schemas.has(s));
      const xml = exportToDrawio(flowNodes, flowEdges, schemas);
      const blob = new Blob([xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'lineage.drawio';
      a.click();
      URL.revokeObjectURL(url);
    }).catch((err) => {
      console.error('[Data Lineage] Draw.io export failed:', err);
    });
  }, [flowNodes, flowEdges, availableSchemas, filter.schemas]);

  // Auto-fit view whenever the graph data changes (filter, trace, rebuild, etc.)
  // flowNodes reference only changes on rebuild — not on highlight
  useEffect(() => {
    const timer = setTimeout(() => {
      fitView({ padding: 0.15, duration: 800 });
    }, 100);
    return () => clearTimeout(timer);
  }, [flowNodes, fitView]);

  // ── Local state: source of truth for positions (survives highlight changes) ──
  const [localNodes, setLocalNodes] = useState<FlowNode<CustomNodeData>[]>(flowNodes);
  const [localEdges, setLocalEdges] = useState<FlowEdge[]>(flowEdges);

  // Sync from upstream ONLY when the graph data itself changes (rebuild/filter/trace)
  // We use flowNodes reference identity — it only changes on rebuild, not on highlight
  useEffect(() => {
    setLocalNodes(flowNodes);
  }, [flowNodes]);

  useEffect(() => {
    setLocalEdges(flowEdges);
  }, [flowEdges]);

  const onNodesChange: OnNodesChange<FlowNode<CustomNodeData>> = useCallback(
    (changes) => setLocalNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setLocalEdges((eds) => applyEdgeChanges(changes, eds)),
    []
  );

  // ── Display layer: highlight/dim applied on top of local positions ──

  // Calculate level 1 neighbors for dimming effect
  const level1Neighbors = useMemo(() => {
    const neighbors = new Set<string>();
    if (highlightedNodeId && graph && graph.hasNode(highlightedNodeId)) {
      try {
        const nodeNeighbors = graph.neighbors(highlightedNodeId);
        nodeNeighbors.forEach(n => neighbors.add(n));
      } catch (e) {
        // Node may not exist in graph
      }
    }
    return neighbors;
  }, [highlightedNodeId, graph]);

  // Apply yellow highlight + dimming on top of localNodes (preserves drag positions)
  const displayNodes = useMemo(() => {
    return localNodes.map(node => {
      const isHighlighted = highlightedNodeId === node.id;
      const shouldBeDimmed = highlightedNodeId &&
        !isHighlighted &&
        !level1Neighbors.has(node.id);

      return {
        ...node,
        data: {
          ...node.data,
          highlighted: isHighlighted ? 'yellow' : node.data.highlighted,
          dimmed: !!shouldBeDimmed,
        }
      };
    });
  }, [localNodes, highlightedNodeId, level1Neighbors]);

  // Highlight edges connected to selected node
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

  return (
    <div className="flex flex-col h-screen overflow-hidden">
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
        onExecuteSearch={handleExecuteSearch}
        onStartTrace={onStartTraceImmediate}
        allNodes={displayNodes.map(n => ({
          id: n.id,
          name: n.data.label,
          schema: n.data.schema,
          type: n.data.objectType
        }))}
        metrics={metrics}
      />

      {/* Inline Trace Controls - shown during configuration phase */}
      {trace.mode === 'configuring' && trace.selectedNodeId && (
        <InlineTraceControls
          startNodeId={trace.selectedNodeId}
          startNodeName={displayNodes.find(n => n.id === trace.selectedNodeId)?.data.label || trace.selectedNodeId}
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
          startNodeName={displayNodes.find(n => n.id === trace.selectedNodeId)?.data.label || trace.selectedNodeId}
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
          sourceNodeName={displayNodes.find(n => n.id === trace.selectedNodeId)?.data.label || trace.selectedNodeId}
          allNodes={displayNodes.map(n => ({
            id: n.id,
            name: n.data.label,
            schema: n.data.schema,
            type: n.data.objectType,
          }))}
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

      <div className="flex-1 relative overflow-hidden">
        {flowNodes.length === 0 ? (
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
                    />
                  ) : onToggleDetailSearch ? (
                    <DetailSearchSidebar
                      onClose={onToggleDetailSearch}
                      allNodes={displayNodes.map(n => {
                        const modelNode = model?.nodes.find(mn => mn.id === n.id);
                        return {
                          id: n.id,
                          name: String(n.data.label),
                          schema: String(n.data.schema),
                          type: n.data.objectType as ObjectType,
                          bodyScript: modelNode?.bodyScript,
                        };
                      })}
                      onResultClick={(nodeId) => {
                        onNodeClick(nodeId);
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

      {infoBarNodeId && model && graph && (
        <NodeInfoBar
          nodeId={infoBarNodeId}
          model={model}
          graph={graph}
          onClose={onCloseInfoBar || (() => {})}
        />
      )}
    </div>
  );
}
