import { useState, useCallback, useMemo, useRef } from 'react';
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
  useFullModel: boolean;
  toggleUseFullModel: () => void;
  filteredOutCount: number;
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
  const [useFullModel, setUseFullModel] = useState(false);

  // Full (unfiltered) graph for path-finding and unfiltered trace —
  // traverses all model nodes, not just the filtered subset.
  const fullGraph = useMemo(() => model ? buildGraphologyGraph(model) : null, [model]);

  // Keep a ref to useFullModel so callbacks don't go stale
  const useFullModelRef = useRef(useFullModel);
  useFullModelRef.current = useFullModel;

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
    const bfsGraph = useFullModelRef.current ? (fullGraph ?? graph) : graph;
    if (!bfsGraph) {
      window.vscode?.postMessage({ type: 'log', text: `[Trace] Immediate skipped — graph not ready` });
      return;
    }

    const t0 = performance.now();
    const { nodeIds, edgeIds } = traceNodeWithLevels(
      bfsGraph,
      nodeId,
      config.trace.defaultUpstreamLevels,
      config.trace.defaultDownstreamLevels
    );
    const ms = (performance.now() - t0).toFixed(1);
    window.vscode?.postMessage({ type: 'log', text:
      `[Trace] Immediate: "${nodeId}" up=${config.trace.defaultUpstreamLevels} down=${config.trace.defaultDownstreamLevels} fullModel=${useFullModelRef.current} → ${nodeIds.size} nodes, ${edgeIds.size} edges (${ms}ms)`
    });

    setTrace({
      mode: 'filtered',
      selectedNodeId: nodeId,
      targetNodeId: null,
      upstreamLevels: config.trace.defaultUpstreamLevels,
      downstreamLevels: config.trace.defaultDownstreamLevels,
      tracedNodeIds: nodeIds,
      tracedEdgeIds: edgeIds,
    });
  }, [graph, fullGraph, config.trace.defaultUpstreamLevels, config.trace.defaultDownstreamLevels]);

  // Phase 2: Apply trace with levels (filter graph, keep controls visible briefly)
  const applyTrace = useCallback(
    (upstreamLevels: number, downstreamLevels: number) => {
      const bfsGraph = useFullModelRef.current ? (fullGraph ?? graph) : graph;
      if (!bfsGraph || !trace.selectedNodeId) {
        window.vscode?.postMessage({ type: 'log', text: `[Trace] Apply skipped — graph=${!!bfsGraph} selectedNode=${trace.selectedNodeId}` });
        return;
      }

      const t0 = performance.now();
      const { nodeIds, edgeIds } = traceNodeWithLevels(
        bfsGraph,
        trace.selectedNodeId,
        upstreamLevels,
        downstreamLevels
      );
      const ms = (performance.now() - t0).toFixed(1);
      window.vscode?.postMessage({ type: 'log', text:
        `[Trace] Apply: "${trace.selectedNodeId}" up=${upstreamLevels} down=${downstreamLevels} fullModel=${useFullModelRef.current} → ${nodeIds.size} nodes, ${edgeIds.size} edges (${ms}ms)`
      });

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

  // Toggle between filtered and full-model BFS — re-runs trace immediately
  const toggleUseFullModel = useCallback(() => {
    const next = !useFullModelRef.current;
    setUseFullModel(next);

    // Re-run trace on the alternate graph if a trace is active
    const isTraceActive = trace.mode === 'applied' || trace.mode === 'filtered';
    if (!isTraceActive || !trace.selectedNodeId) return;

    const bfsGraph = next ? (fullGraph ?? graph) : graph;
    if (!bfsGraph) return;

    const t0 = performance.now();
    const { nodeIds, edgeIds } = traceNodeWithLevels(
      bfsGraph,
      trace.selectedNodeId,
      trace.upstreamLevels,
      trace.downstreamLevels
    );
    const ms = (performance.now() - t0).toFixed(1);
    window.vscode?.postMessage({ type: 'log', text:
      `[Trace] Toggle fullModel=${next}: "${trace.selectedNodeId}" → ${nodeIds.size} nodes, ${edgeIds.size} edges (${ms}ms)`
    });

    setTrace(prev => ({
      ...prev,
      tracedNodeIds: nodeIds,
      tracedEdgeIds: edgeIds,
    }));
  }, [graph, fullGraph, trace.mode, trace.selectedNodeId, trace.upstreamLevels, trace.downstreamLevels]);

  const endTrace = useCallback((onComplete?: () => void) => {
    setTrace(createInitialTrace(config));
    setUseFullModel(false);
    if (onComplete) {
      setTimeout(onComplete, 0);
    }
  }, [config]);

  const clearTrace = endTrace;

  // Compute how many nodes are hidden by the active filter (only when filter is inherited)
  const filteredOutCount = useMemo(() => {
    const isTraceActive = trace.mode === 'applied' || trace.mode === 'filtered';
    if (useFullModel || !isTraceActive || !trace.selectedNodeId || !fullGraph) return 0;
    const fullResult = traceNodeWithLevels(
      fullGraph,
      trace.selectedNodeId,
      trace.upstreamLevels,
      trace.downstreamLevels
    );
    return Math.max(0, fullResult.nodeIds.size - trace.tracedNodeIds.size);
  }, [fullGraph, trace.mode, trace.selectedNodeId, trace.upstreamLevels, trace.downstreamLevels, trace.tracedNodeIds, useFullModel]);

  // Memoize trace application to avoid re-rendering all nodes
  const { tracedNodes, tracedEdges } = useMemo(
    (): { tracedNodes: FlowNode<CustomNodeData>[]; tracedEdges: FlowEdge[] } => {
      if (trace.mode === 'none' || trace.mode === 'configuring' || trace.mode === 'pathfinding') {
        return { tracedNodes: flowNodes, tracedEdges: flowEdges };
      }

      const { nodes, edges } = applyTraceToFlow(flowNodes, flowEdges, trace, config, model, useFullModel);
      return { tracedNodes: nodes as FlowNode<CustomNodeData>[], tracedEdges: edges };
    },
    [flowNodes, flowEdges, trace, config, model, useFullModel]
  );

  return { trace, tracedNodes, tracedEdges, startTraceConfig, startTraceImmediate, applyTrace, startPathFinding, applyPath, applyAnalysisSubset, endTrace, clearTrace, useFullModel, toggleUseFullModel, filteredOutCount };
}
