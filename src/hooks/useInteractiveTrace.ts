import { useState, useCallback, useMemo } from 'react';
import Graph from 'graphology';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import { TraceState, ExtensionConfig, DEFAULT_CONFIG } from '../engine/types';
import { traceNodeWithLevels, applyTraceToFlow } from '../engine/graphBuilder';

interface UseInteractiveTraceReturn {
  trace: TraceState;
  tracedNodes: FlowNode[];
  tracedEdges: FlowEdge[];
  startTraceConfig: (nodeId: string) => void;
  startTraceImmediate: (nodeId: string) => void;
  applyTrace: (upstreamLevels: number, downstreamLevels: number) => void;
  endTrace: (onComplete?: () => void) => void;
  clearTrace: (onComplete?: () => void) => void;
}

// Initial trace state factory
const createInitialTrace = (config: ExtensionConfig): TraceState => ({
  mode: 'none',
  selectedNodeId: null,
  upstreamLevels: config.trace.defaultUpstreamLevels,
  downstreamLevels: config.trace.defaultDownstreamLevels,
  tracedNodeIds: new Set(),
  tracedEdgeIds: new Set(),
});

export function useInteractiveTrace(
  graph: Graph | null,
  flowNodes: FlowNode[],
  flowEdges: FlowEdge[],
  config: ExtensionConfig = DEFAULT_CONFIG
): UseInteractiveTraceReturn {
  const [trace, setTrace] = useState<TraceState>(() => createInitialTrace(config));

  // Phase 1: Start configuring trace (show InlineTraceControls)
  const startTraceConfig = useCallback((nodeId: string) => {
    setTrace({
      mode: 'configuring',
      selectedNodeId: nodeId,
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
        upstreamLevels,
        downstreamLevels,
        tracedNodeIds: nodeIds,
        tracedEdgeIds: edgeIds,
      });
    },
    [graph, trace.selectedNodeId]
  );

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
    () => {
      if (trace.mode === 'none' || trace.mode === 'configuring') {
        return { tracedNodes: flowNodes, tracedEdges: flowEdges };
      }
      
      const { nodes, edges } = applyTraceToFlow(flowNodes, flowEdges, trace, config);
      return { tracedNodes: nodes, tracedEdges: edges };
    },
    [flowNodes, flowEdges, trace, config]
  );

  return { trace, tracedNodes, tracedEdges, startTraceConfig, startTraceImmediate, applyTrace, endTrace, clearTrace };
}
