import { useState, useCallback, useMemo } from 'react';
import Graph from 'graphology';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { CustomNodeData } from '../components/CustomNode';
import { TraceState, ExtensionConfig, DEFAULT_CONFIG } from '../engine/types';
import { traceNodeWithLevels, applyTraceToFlow, computeShortestPath } from '../engine/graphBuilder';

interface UseInteractiveTraceReturn {
  trace: TraceState;
  tracedNodes: FlowNode<CustomNodeData>[];
  tracedEdges: FlowEdge[];
  startTraceConfig: (nodeId: string) => void;
  startTraceImmediate: (nodeId: string) => void;
  applyTrace: (upstreamLevels: number, downstreamLevels: number) => void;
  startPathFinding: (nodeId: string) => void;
  applyPath: (targetNodeId: string) => boolean;
  endTrace: (onComplete?: () => void) => void;
  clearTrace: (onComplete?: () => void) => void;
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
  config: ExtensionConfig = DEFAULT_CONFIG
): UseInteractiveTraceReturn {
  const [trace, setTrace] = useState<TraceState>(() => createInitialTrace(config));

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
    if (!graph) return;

    const { nodeIds, edgeIds } = traceNodeWithLevels(
      graph,
      nodeId,
      config.trace.defaultUpstreamLevels,
      config.trace.defaultDownstreamLevels
    );

    setTrace({
      mode: 'filtered',
      selectedNodeId: nodeId,
      targetNodeId: null,
      upstreamLevels: config.trace.defaultUpstreamLevels,
      downstreamLevels: config.trace.defaultDownstreamLevels,
      tracedNodeIds: nodeIds,
      tracedEdgeIds: edgeIds,
    });
  }, [graph, config.trace.defaultUpstreamLevels, config.trace.defaultDownstreamLevels]);

  // Phase 2: Apply trace with levels (filter graph, keep controls visible briefly)
  const applyTrace = useCallback(
    (upstreamLevels: number, downstreamLevels: number) => {
      if (!graph || !trace.selectedNodeId) return;

      const { nodeIds, edgeIds } = traceNodeWithLevels(
        graph,
        trace.selectedNodeId,
        upstreamLevels,
        downstreamLevels
      );

      setTrace({
        mode: 'applied',
        selectedNodeId: trace.selectedNodeId,
        targetNodeId: null,
        upstreamLevels,
        downstreamLevels,
        tracedNodeIds: nodeIds,
        tracedEdgeIds: edgeIds,
      });
    },
    [graph, trace.selectedNodeId]
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
  const applyPath = useCallback((targetNodeId: string): boolean => {
    if (!graph || !trace.selectedNodeId) return false;

    const result = computeShortestPath(graph, trace.selectedNodeId, targetNodeId);
    if (!result) return false;

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
  }, [graph, trace.selectedNodeId]);

  // Phase 3: End trace (clear immediately)
  const endTrace = useCallback((onComplete?: () => void) => {
    setTrace(createInitialTrace(config));
    if (onComplete) {
      setTimeout(onComplete, 0);
    }
  }, [config]);

  // Clear everything
  const clearTrace = useCallback((onComplete?: () => void) => {
    setTrace(createInitialTrace(config));
    if (onComplete) {
      setTimeout(onComplete, 0);
    }
  }, [config]);

  // Memoize trace application to avoid re-rendering all nodes
  const { tracedNodes, tracedEdges } = useMemo(
    (): { tracedNodes: FlowNode<CustomNodeData>[]; tracedEdges: FlowEdge[] } => {
      if (trace.mode === 'none' || trace.mode === 'configuring' || trace.mode === 'pathfinding') {
        return { tracedNodes: flowNodes, tracedEdges: flowEdges };
      }

      const { nodes, edges } = applyTraceToFlow(flowNodes, flowEdges, trace, config);
      return { tracedNodes: nodes as FlowNode<CustomNodeData>[], tracedEdges: edges };
    },
    [flowNodes, flowEdges, trace, config]
  );

  return { trace, tracedNodes, tracedEdges, startTraceConfig, startTraceImmediate, applyTrace, startPathFinding, applyPath, endTrace, clearTrace };
}
