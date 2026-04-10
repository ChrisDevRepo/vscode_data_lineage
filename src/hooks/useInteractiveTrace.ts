import { useState, useCallback, useMemo } from 'react';
import Graph from 'graphology';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { CustomNodeData } from '../components/CustomNode';
import { TraceState, ExtensionConfig, DEFAULT_CONFIG, AnalysisType, DatabaseModel } from '../engine/types';
import { traceNodeWithLevels, applyTraceToFlow, computeShortestPath, buildGraphologyGraph } from '../engine/graphBuilder';

interface UseInteractiveTraceReturn {
  trace: TraceState;
  tracedNodes: FlowNode<CustomNodeData>[];
  tracedEdges: FlowEdge[];
  startTraceConfig: (nodeId: string) => void;
  startTraceImmediate: (nodeId: string) => void;
  applyTrace: (upstreamLevels: number, downstreamLevels: number) => void;
  startPathFinding: (nodeId: string) => void;
  applyPath: (targetNodeId: string) => boolean;
  applyAnalysisSubset: (nodeIds: Set<string>, edgeIds: Set<string>, originId?: string, analysisType?: AnalysisType) => void;
  endTrace: (onComplete?: () => void) => void;
  clearTrace: (onComplete?: () => void) => void;
  toggleFullGraph: () => void;
}

/**
 * Run BFS on targetGraph; optionally compute full-graph count + per-node gap data.
 * Shared by applyTrace, startTraceImmediate, and toggleFullGraph.
 */
function computeTrace(
  targetGraph: Graph,
  fullGraph: Graph | null,
  nodeId: string,
  upstreamLevels: number,
  downstreamLevels: number,
): {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  fullTraceNodeCount?: number;
  filteredNeighborGaps?: Map<string, { hidden: number; total: number }>;
} {
  const { nodeIds, edgeIds } = traceNodeWithLevels(targetGraph, nodeId, upstreamLevels, downstreamLevels);

  if (!fullGraph || fullGraph === targetGraph) {
    return { nodeIds, edgeIds };
  }

  // Run BFS on full graph to find the complete trace
  const fullResult = traceNodeWithLevels(fullGraph, nodeId, upstreamLevels, downstreamLevels);
  const fullTraceNodeCount = fullResult.nodeIds.size;

  // Per-node gap: for each visible node, count how many of its full-trace neighbors are hidden
  const gaps = new Map<string, { hidden: number; total: number }>();
  for (const nid of nodeIds) {
    if (!fullGraph.hasNode(nid)) continue;
    const fullNeighbors = fullGraph.neighbors(nid).filter(n => fullResult.nodeIds.has(n));
    const hiddenCount = fullNeighbors.filter(n => !nodeIds.has(n)).length;
    if (hiddenCount > 0) {
      gaps.set(nid, { hidden: hiddenCount, total: fullNeighbors.length });
    }
  }

  return {
    nodeIds,
    edgeIds,
    fullTraceNodeCount,
    filteredNeighborGaps: gaps.size > 0 ? gaps : undefined,
  };
}

// Initial trace state factory
const createInitialTrace = (config: ExtensionConfig): TraceState => ({
  mode: 'none',
  selectedNodeId: null,
  targetNodeId: null,
  upstreamLevels: config.trace.defaultUpstreamLevels,
  downstreamLevels: config.trace.defaultDownstreamLevels,
  tracedNodeIds: new Set(),
  tracedEdgeIds: new Set(),
});

export function useInteractiveTrace(
  graph: Graph | null,
  flowNodes: FlowNode<CustomNodeData>[],
  flowEdges: FlowEdge[],
  config: ExtensionConfig = DEFAULT_CONFIG,
  model: DatabaseModel | null = null
): UseInteractiveTraceReturn {
  const [trace, setTrace] = useState<TraceState>(() => createInitialTrace(config));

  // Full (unfiltered) graph for path-finding — paths should traverse all model nodes,
  // not just the filtered subset. Regular trace still uses the filtered graph.
  const fullGraph = useMemo(() => model ? buildGraphologyGraph(model) : null, [model]);

  // Phase 1: Start configuring trace (show InlineTraceControls)
  const startTraceConfig = useCallback((nodeId: string) => {
    setTrace({
      mode: 'configuring',
      selectedNodeId: nodeId,
      targetNodeId: null,
      upstreamLevels: config.trace.defaultUpstreamLevels,
      downstreamLevels: config.trace.defaultDownstreamLevels,
      tracedNodeIds: new Set(),
      tracedEdgeIds: new Set(),
    });
  }, [config.trace.defaultUpstreamLevels, config.trace.defaultDownstreamLevels]);

  // Immediate trace: apply with defaults without showing config UI
  const startTraceImmediate = useCallback((nodeId: string) => {
    if (!graph) {
      window.vscode?.postMessage({ type: 'log', text: `[Trace] Immediate skipped — graph not ready` });
      return;
    }

    const t0 = performance.now();
    const { nodeIds, edgeIds, fullTraceNodeCount, filteredNeighborGaps } = computeTrace(
      graph, fullGraph, nodeId,
      config.trace.defaultUpstreamLevels,
      config.trace.defaultDownstreamLevels
    );
    const ms = (performance.now() - t0).toFixed(1);
    window.vscode?.postMessage({ type: 'log', text:
      `[Trace] Immediate: "${nodeId}" up=${config.trace.defaultUpstreamLevels} down=${config.trace.defaultDownstreamLevels} → ${nodeIds.size} nodes, ${edgeIds.size} edges (${ms}ms)`
    });

    setTrace({
      mode: 'filtered',
      selectedNodeId: nodeId,
      targetNodeId: null,
      upstreamLevels: config.trace.defaultUpstreamLevels,
      downstreamLevels: config.trace.defaultDownstreamLevels,
      tracedNodeIds: nodeIds,
      tracedEdgeIds: edgeIds,
      fullTraceNodeCount,
      filteredNeighborGaps,
    });
  }, [graph, fullGraph, config.trace.defaultUpstreamLevels, config.trace.defaultDownstreamLevels]);

  // Phase 2: Apply trace with levels (filter graph, keep controls visible briefly)
  const applyTrace = useCallback(
    (upstreamLevels: number, downstreamLevels: number) => {
      if (!graph || !trace.selectedNodeId) {
        window.vscode?.postMessage({ type: 'log', text: `[Trace] Apply skipped — graph=${!!graph} selectedNode=${trace.selectedNodeId}` });
        return;
      }

      const t0 = performance.now();
      const { nodeIds, edgeIds, fullTraceNodeCount, filteredNeighborGaps } = computeTrace(
        graph, fullGraph, trace.selectedNodeId, upstreamLevels, downstreamLevels
      );
      const ms = (performance.now() - t0).toFixed(1);
      window.vscode?.postMessage({ type: 'log', text:
        `[Trace] Apply: "${trace.selectedNodeId}" up=${upstreamLevels} down=${downstreamLevels} → ${nodeIds.size} nodes, ${edgeIds.size} edges (${ms}ms)`
      });

      setTrace({
        mode: 'applied',
        selectedNodeId: trace.selectedNodeId,
        targetNodeId: null,
        upstreamLevels,
        downstreamLevels,
        tracedNodeIds: nodeIds,
        tracedEdgeIds: edgeIds,
        fullTraceNodeCount,
        filteredNeighborGaps,
      });
    },
    [graph, fullGraph, trace.selectedNodeId]
  );

  // Start path finding mode (from right-click "Find Path")
  const startPathFinding = useCallback((nodeId: string) => {
    setTrace({
      mode: 'pathfinding',
      selectedNodeId: nodeId,
      targetNodeId: null,
      upstreamLevels: 0,
      downstreamLevels: 0,
      tracedNodeIds: new Set(),
      tracedEdgeIds: new Set(),
    });
  }, []);

  // Compute and apply shortest path — returns true if path found
  // Uses fullGraph (unfiltered model) so paths can traverse nodes hidden by filters.
  const applyPath = useCallback((targetNodeId: string): boolean => {
    const pathGraph = fullGraph ?? graph;
    if (!pathGraph || !trace.selectedNodeId) {
      window.vscode?.postMessage({ type: 'log', text: `[Trace] Path skipped — graph=${!!pathGraph} selectedNode=${trace.selectedNodeId}` });
      return false;
    }

    const t0 = performance.now();
    const result = computeShortestPath(pathGraph, trace.selectedNodeId, targetNodeId);
    const ms = (performance.now() - t0).toFixed(1);
    if (!result) {
      window.vscode?.postMessage({ type: 'log', text:
        `[Trace] Path: "${trace.selectedNodeId}" → "${targetNodeId}" not found (${ms}ms)`
      });
      return false;
    }
    window.vscode?.postMessage({ type: 'log', text:
      `[Trace] Path: "${trace.selectedNodeId}" → "${targetNodeId}" found, ${result.nodeIds.size} nodes (${ms}ms)`
    });

    setTrace({
      mode: 'path-applied',
      selectedNodeId: trace.selectedNodeId,
      targetNodeId,
      upstreamLevels: 0,
      downstreamLevels: 0,
      tracedNodeIds: result.nodeIds,
      tracedEdgeIds: result.edgeIds,
    });
    return true;
  }, [fullGraph, graph, trace.selectedNodeId]);

  // Apply analysis subset — reuses same rendering as trace/path
  const applyAnalysisSubset = useCallback((
    nodeIds: Set<string>,
    edgeIds: Set<string>,
    originId?: string,
    analysisType?: AnalysisType
  ) => {
    window.vscode?.postMessage({ type: 'log', text:
      `[Trace] Analysis subset: ${analysisType ?? 'unknown'} — ${nodeIds.size} nodes, ${edgeIds.size} edges (flowNodes: ${flowNodes.length})`
    });
    setTrace({
      mode: 'analysis',
      analysisType,
      selectedNodeId: originId || null,
      targetNodeId: null,
      upstreamLevels: 0,
      downstreamLevels: 0,
      tracedNodeIds: nodeIds,
      tracedEdgeIds: edgeIds,
    });
  }, [flowNodes.length]);

  const endTrace = useCallback((onComplete?: () => void) => {
    setTrace(createInitialTrace(config));
    if (onComplete) {
      setTimeout(onComplete, 0);
    }
  }, [config]);

  const clearTrace = endTrace;

  // Toggle between filtered and full-model BFS in trace mode
  const toggleFullGraph = useCallback(() => {
    setTrace(prev => {
      if (!prev.selectedNodeId || (prev.mode !== 'applied' && prev.mode !== 'filtered')) return prev;
      const newUseFullGraph = !prev.useFullGraph;
      const targetGraph = newUseFullGraph ? fullGraph : graph;
      if (!targetGraph) return prev;

      // When showing all (fullGraph), no gaps to compute. When filtered, compute gaps.
      const countGraph = newUseFullGraph ? null : fullGraph;
      const { nodeIds, edgeIds, fullTraceNodeCount, filteredNeighborGaps } = computeTrace(
        targetGraph, countGraph, prev.selectedNodeId, prev.upstreamLevels, prev.downstreamLevels
      );

      window.vscode?.postMessage({ type: 'log', text:
        `[Trace] Toggle fullGraph=${newUseFullGraph}: ${nodeIds.size} nodes, ${edgeIds.size} edges`
      });

      return {
        ...prev,
        tracedNodeIds: nodeIds,
        tracedEdgeIds: edgeIds,
        useFullGraph: newUseFullGraph,
        fullTraceNodeCount: newUseFullGraph ? nodeIds.size : fullTraceNodeCount,
        filteredNeighborGaps: newUseFullGraph ? undefined : filteredNeighborGaps,
      };
    });
  }, [fullGraph, graph]);

  // Memoize trace application to avoid re-rendering all nodes
  const { tracedNodes, tracedEdges } = useMemo(
    (): { tracedNodes: FlowNode<CustomNodeData>[]; tracedEdges: FlowEdge[] } => {
      if (trace.mode === 'none' || trace.mode === 'configuring' || trace.mode === 'pathfinding') {
        return { tracedNodes: flowNodes, tracedEdges: flowEdges };
      }

      const { nodes, edges } = applyTraceToFlow(flowNodes, flowEdges, trace, config, model);
      return { tracedNodes: nodes as FlowNode<CustomNodeData>[], tracedEdges: edges };
    },
    [flowNodes, flowEdges, trace, config, model]
  );

  return { trace, tracedNodes, tracedEdges, startTraceConfig, startTraceImmediate, applyTrace, startPathFinding, applyPath, applyAnalysisSubset, endTrace, clearTrace, toggleFullGraph };
}
