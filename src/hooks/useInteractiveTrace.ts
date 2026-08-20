import { useState, useCallback, useMemo, useRef } from 'react';
import Graph from 'graphology';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { CustomNodeData } from '../components/CustomNode';
import { TraceState, ExtensionConfig, DEFAULT_CONFIG, AnalysisType, DatabaseModel } from '../engine/types';
import { traceNodeWithLevels, applyTraceToFlow, computeShortestPath, buildGraphologyGraph } from '../engine/graphBuilder';
import { buildVisibleTraceScope, canPruneTraceNode, isEditableTraceMode } from '../engine/traceScope';
import { directNeighborIds } from '../engine/graphGuards';

/**
 * Return type for the useInteractiveTrace hook, providing state and control actions.
 */
interface UseInteractiveTraceReturn {
  /** The current state of the trace session (mode, focal node, depths). */
  trace: TraceState;
  /** The subset of nodes being displayed during the trace. */
  tracedNodes: FlowNode<CustomNodeData>[];
  /** The subset of edges being displayed during the trace. */
  tracedEdges: FlowEdge[];
  /** A graphology instance containing only the traced elements. */
  traceGraph: Graph | null;
  /** Initiates a trace configuration phase (shows depth selectors). */
  startTraceConfig: (nodeId: string) => void;
  /** Immediately applies a trace with default depths. */
  startTraceImmediate: (nodeId: string) => void;
  /** Applies the current trace configuration with specific upstream/downstream depths. */
  applyTrace: (upstreamLevels: number, downstreamLevels: number) => void;
  /** Enters pathfinding mode starting from a focal node. */
  startPathFinding: (nodeId: string) => void;
  /** Attempts to find and render the shortest path to a target node. */
  applyPath: (targetNodeId: string) => boolean;
  /** Manually applies a pre-computed subset of nodes and edges (used by analysis tools). */
  applyAnalysisSubset: (nodeIds: Set<string>, edgeIds: Set<string>, originId?: string, analysisType?: AnalysisType) => void;
  /** Ends the active trace and restores the full graph view. */
  endTrace: (onComplete?: () => void) => void;
  /** Clears the active trace (alias for endTrace). */
  clearTrace: (onComplete?: () => void) => void;
  /** Whether the trace should traverse the full database model vs. the filtered subset. */
  useFullModel: boolean;
  /** Toggles the full model traversal flag and re-runs the active trace. */
  toggleUseFullModel: () => void;
  /** The number of nodes matched by the trace but hidden by the active filter. */
  filteredOutCount: number;
  /** Adds one direct neighbor into the current trace scope. */
  addTraceNeighbor: (nodeId: string) => void;
  /** Removes one safe node from the current trace scope. */
  pruneTraceNode: (nodeId: string) => void;
}

/** Initial trace state factory */
const createInitialTrace = (config: ExtensionConfig): TraceState => ({
  mode: 'none',
  selectedNodeId: null,
  targetNodeId: null,
  upstreamLevels: config.trace.defaultUpstreamLevels,
  downstreamLevels: config.trace.defaultDownstreamLevels,
  baseNodeIds: new Set(),
  baseEdgeIds: new Set(),
  manualAddedNodeIds: new Set(),
  manualPrunedNodeIds: new Set(),
  tracedNodeIds: new Set(),
  tracedEdgeIds: new Set(),
});

const createTrace = (config: ExtensionConfig, overrides: Partial<TraceState>): TraceState => ({
  ...createInitialTrace(config),
  ...overrides,
});

function isDirectNeighborOfScope(
  model: DatabaseModel,
  visibleNodeIds: ReadonlySet<string>,
  candidateNodeId: string,
): boolean {
  if (visibleNodeIds.has(candidateNodeId)) return false;
  for (const visibleId of visibleNodeIds) {
    if (directNeighborIds(model, visibleId, 'in').includes(candidateNodeId)) return true;
    if (directNeighborIds(model, visibleId, 'out').includes(candidateNodeId)) return true;
  }
  return false;
}

/** Pick BFS graph — auto-promotes to fullGraph when node is filtered out. */
function resolveBfsGraph(
  nodeId: string,
  preferFull: boolean,
  graph: Graph | null,
  fullGraph: Graph | null,
): { bfsGraph: Graph | null; autoPromoted: boolean } {
  const preferred = preferFull ? (fullGraph ?? graph) : graph;
  if (preferred?.hasNode(nodeId)) return { bfsGraph: preferred, autoPromoted: false };
  // Auto-fallback: node not in preferred graph, try fullGraph
  if (!preferFull && fullGraph?.hasNode(nodeId)) return { bfsGraph: fullGraph, autoPromoted: true };
  // Node not in any graph — caller gets the usual empty-result path
  return { bfsGraph: preferred, autoPromoted: false };
}

/**
 * Custom hook for managing interactive data lineage traces and pathfinding.
 *
 * @remarks
 * This hook manages the lifecycle of "drilling into" specific nodes. It supports:
 * 1. **Level-based Tracing**: Upstream and downstream traversal.
 * 2. **Shortest Path**: Finding connections between two specific nodes.
 * 3. **Analysis Subsets**: Highlighting architectural patterns (hubs, islands).
 *
 * It handles the complex logic of "Auto-Promotion", where a trace on a node that is
 * currently filtered out will automatically switch to the `fullGraph` to ensure
 * the user can always see the requested lineage.
 *
 * @param graph - The currently active (filtered) graph instance.
 * @param flowNodes - The current set of React Flow nodes.
 * @param flowEdges - The current set of React Flow edges.
 * @param config - The application configuration (for default depths).
 * @param model - The full database model (required for unfiltered pathfinding).
 * @param baseRenderLimited - Whether the base object graph is blocked by the React Flow render limit.
 * @returns An object containing the trace state, subsets, and action handlers.
 */
export function useInteractiveTrace(
  graph: Graph | null,
  flowNodes: FlowNode<CustomNodeData>[],
  flowEdges: FlowEdge[],
  config: ExtensionConfig = DEFAULT_CONFIG,
  model: DatabaseModel | null = null,
  baseRenderLimited = false,
): UseInteractiveTraceReturn {
  const [trace, setTrace] = useState<TraceState>(() => createInitialTrace(config));
  const [useFullModel, setUseFullModel] = useState(false);

  // Full (unfiltered) graph for path-finding and unfiltered trace —
  // traverses all model nodes, not just the filtered subset.
  const fullGraph = useMemo(() => model ? buildGraphologyGraph(model) : null, [model]);

  const useFullModelRef = useRef(useFullModel);
  useFullModelRef.current = useFullModel;

  const startTraceConfig = useCallback((nodeId: string) => {
    setTrace(createTrace(config, {
      mode: 'configuring',
      selectedNodeId: nodeId,
    }));
  }, [config]);

  const startTraceImmediate = useCallback((nodeId: string) => {
    const { bfsGraph, autoPromoted } = resolveBfsGraph(nodeId, useFullModelRef.current, graph, fullGraph);
    if (!bfsGraph) {
      window.vscode?.postMessage({ type: 'log', text: `[Trace] Immediate skipped — graph not ready` });
      return;
    }
    if (autoPromoted) {
      window.vscode?.postMessage({ type: 'log', text: `[Trace] "${nodeId}" not in filtered graph — auto-promoting to full model` });
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
      `[Trace] Immediate: "${nodeId}" up=${config.trace.defaultUpstreamLevels} down=${config.trace.defaultDownstreamLevels} fullModel=${useFullModelRef.current}${autoPromoted ? ' (auto-promoted)' : ''} → ${nodeIds.size} nodes, ${edgeIds.size} edges (${ms}ms)`
    });

    if (nodeIds.size === 0 && fullGraph?.hasNode(nodeId)) {
      window.vscode?.postMessage({ type: 'log', level: 'warn', text:
        `[Trace] 0 results for "${nodeId}" — exists in model but has no connections` });
    }

    setTrace(createTrace(config, {
      mode: 'filtered',
      selectedNodeId: nodeId,
      upstreamLevels: config.trace.defaultUpstreamLevels,
      downstreamLevels: config.trace.defaultDownstreamLevels,
      baseNodeIds: nodeIds,
      baseEdgeIds: edgeIds,
      tracedNodeIds: nodeIds,
      tracedEdgeIds: edgeIds,
      autoPromoted,
    }));
  }, [graph, fullGraph, config]);

  const applyTrace = useCallback(
    (upstreamLevels: number, downstreamLevels: number) => {
      if (!trace.selectedNodeId) {
        window.vscode?.postMessage({ type: 'log', text: `[Trace] Apply skipped — no selectedNode` });
        return;
      }
      const { bfsGraph, autoPromoted } = resolveBfsGraph(trace.selectedNodeId, useFullModelRef.current, graph, fullGraph);
      if (!bfsGraph) {
        window.vscode?.postMessage({ type: 'log', text: `[Trace] Apply skipped — graph not ready` });
        return;
      }
      if (autoPromoted) {
        window.vscode?.postMessage({ type: 'log', text: `[Trace] "${trace.selectedNodeId}" not in filtered graph — auto-promoting to full model` });
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
        `[Trace] Apply: "${trace.selectedNodeId}" up=${upstreamLevels} down=${downstreamLevels} fullModel=${useFullModelRef.current}${autoPromoted ? ' (auto-promoted)' : ''} → ${nodeIds.size} nodes, ${edgeIds.size} edges (${ms}ms)`
      });

      setTrace(createTrace(config, {
        mode: 'applied',
        selectedNodeId: trace.selectedNodeId,
        upstreamLevels,
        downstreamLevels,
        baseNodeIds: nodeIds,
        baseEdgeIds: edgeIds,
        tracedNodeIds: nodeIds,
        tracedEdgeIds: edgeIds,
        autoPromoted,
      }));
    },
    [config, graph, fullGraph, trace.selectedNodeId]
  );

  const startPathFinding = useCallback((nodeId: string) => {
    setTrace(createTrace(config, {
      mode: 'pathfinding',
      selectedNodeId: nodeId,
      upstreamLevels: 0,
      downstreamLevels: 0,
    }));
  }, [config]);

  // Compute and apply shortest path — returns true if path found
  // Always prefers fullGraph so paths can traverse nodes hidden by filters.
  const applyPath = useCallback((targetNodeId: string): boolean => {
    if (!trace.selectedNodeId) {
      window.vscode?.postMessage({ type: 'log', text: `[Trace] Path skipped — no selectedNode` });
      return false;
    }
    const { bfsGraph: pathGraph } = resolveBfsGraph(trace.selectedNodeId, true, graph, fullGraph);
    if (!pathGraph) {
      window.vscode?.postMessage({ type: 'log', text: `[Trace] Path skipped — graph not ready` });
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

    setTrace(createTrace(config, {
      mode: 'path-applied',
      selectedNodeId: trace.selectedNodeId,
      targetNodeId,
      upstreamLevels: 0,
      downstreamLevels: 0,
      baseNodeIds: result.nodeIds,
      baseEdgeIds: result.edgeIds,
      tracedNodeIds: result.nodeIds,
      tracedEdgeIds: result.edgeIds,
    }));
    return true;
  }, [config, fullGraph, graph, trace.selectedNodeId]);

  const applyAnalysisSubset = useCallback((
    nodeIds: Set<string>,
    edgeIds: Set<string>,
    originId?: string,
    analysisType?: AnalysisType
  ) => {
    window.vscode?.postMessage({ type: 'log', text:
      `[Trace] Analysis subset: ${analysisType ?? 'unknown'} — ${nodeIds.size} nodes, ${edgeIds.size} edges (flowNodes: ${flowNodes.length})`
    });
    setTrace(createTrace(config, {
      mode: 'analysis',
      analysisType,
      selectedNodeId: originId || null,
      upstreamLevels: 0,
      downstreamLevels: 0,
      baseNodeIds: nodeIds,
      baseEdgeIds: edgeIds,
      tracedNodeIds: nodeIds,
      tracedEdgeIds: edgeIds,
    }));
  }, [config, flowNodes.length]);

  const toggleUseFullModel = useCallback(() => {
    const next = !useFullModelRef.current;
    setUseFullModel(next);

    const isTraceActive = isEditableTraceMode(trace.mode);
    if (!isTraceActive || !trace.selectedNodeId) return;

    const { bfsGraph, autoPromoted } = resolveBfsGraph(trace.selectedNodeId, next, graph, fullGraph);
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

    setTrace(prev => {
      const scope = model
        ? buildVisibleTraceScope(nodeIds, prev.manualAddedNodeIds, prev.manualPrunedNodeIds, model.edges)
        : { nodeIds, edgeIds };
      return {
        ...prev,
        baseNodeIds: nodeIds,
        baseEdgeIds: edgeIds,
        tracedNodeIds: scope.nodeIds,
        tracedEdgeIds: scope.edgeIds,
        autoPromoted,
      };
    });
  }, [graph, fullGraph, model, trace.mode, trace.selectedNodeId, trace.upstreamLevels, trace.downstreamLevels]);

  const addTraceNeighbor = useCallback((nodeId: string) => {
    if (!model) return;
    setTrace(prev => {
      if (!isEditableTraceMode(prev.mode)) return prev;
      if (!isDirectNeighborOfScope(model, prev.tracedNodeIds, nodeId)) return prev;
      const manualAddedNodeIds = new Set(prev.manualAddedNodeIds);
      const manualPrunedNodeIds = new Set(prev.manualPrunedNodeIds);
      manualAddedNodeIds.add(nodeId);
      manualPrunedNodeIds.delete(nodeId);
      const scope = buildVisibleTraceScope(prev.baseNodeIds, manualAddedNodeIds, manualPrunedNodeIds, model.edges);
      return {
        ...prev,
        manualAddedNodeIds,
        manualPrunedNodeIds,
        tracedNodeIds: scope.nodeIds,
        tracedEdgeIds: scope.edgeIds,
      };
    });
  }, [model]);

  const pruneTraceNode = useCallback((nodeId: string) => {
    if (!model || !fullGraph) return;
    setTrace(prev => {
      if (!isEditableTraceMode(prev.mode) || nodeId === prev.selectedNodeId) return prev;
      if (!canPruneTraceNode(fullGraph, prev.selectedNodeId, prev.tracedNodeIds, nodeId).safe) return prev;
      const manualAddedNodeIds = new Set(prev.manualAddedNodeIds);
      const manualPrunedNodeIds = new Set(prev.manualPrunedNodeIds);
      manualAddedNodeIds.delete(nodeId);
      manualPrunedNodeIds.add(nodeId);
      const scope = buildVisibleTraceScope(prev.baseNodeIds, manualAddedNodeIds, manualPrunedNodeIds, model.edges);
      return {
        ...prev,
        manualAddedNodeIds,
        manualPrunedNodeIds,
        tracedNodeIds: scope.nodeIds,
        tracedEdgeIds: scope.edgeIds,
      };
    });
  }, [model, fullGraph]);

  const endTrace = useCallback((onComplete?: () => void) => {
    setTrace(createInitialTrace(config));
    setUseFullModel(false);
    if (onComplete) {
      setTimeout(onComplete, 0);
    }
  }, [config]);

  const clearTrace = endTrace;

  const filteredOutCount = useMemo(() => {
    const isTraceActive = isEditableTraceMode(trace.mode);
    if (useFullModel || trace.autoPromoted || !isTraceActive || !trace.selectedNodeId || !fullGraph) return 0;
    const fullResult = traceNodeWithLevels(
      fullGraph,
      trace.selectedNodeId,
      trace.upstreamLevels,
      trace.downstreamLevels
    );
    return Math.max(0, fullResult.nodeIds.size - trace.tracedNodeIds.size);
  }, [fullGraph, trace.mode, trace.selectedNodeId, trace.upstreamLevels, trace.downstreamLevels, trace.tracedNodeIds, useFullModel, trace.autoPromoted]);

  const { tracedNodes, tracedEdges, traceGraph } = useMemo(
    (): { tracedNodes: FlowNode<CustomNodeData>[]; tracedEdges: FlowEdge[]; traceGraph: Graph | null } => {
      if (trace.mode === 'none' || trace.mode === 'configuring' || trace.mode === 'pathfinding') {
        return { tracedNodes: flowNodes, tracedEdges: flowEdges, traceGraph: null };
      }

      const synthesize = baseRenderLimited || useFullModel || !!trace.autoPromoted || trace.manualAddedNodeIds.size > 0;
      const { nodes, edges, graph: tGraph } = applyTraceToFlow(flowNodes, flowEdges, trace, config, model, synthesize);
      return { tracedNodes: nodes as FlowNode<CustomNodeData>[], tracedEdges: edges, traceGraph: tGraph ?? null };
    },
    [flowNodes, flowEdges, trace, config, model, useFullModel, baseRenderLimited]
  );

  return { trace, tracedNodes, tracedEdges, traceGraph, startTraceConfig, startTraceImmediate, applyTrace, startPathFinding, applyPath, applyAnalysisSubset, endTrace, clearTrace, useFullModel, toggleUseFullModel, filteredOutCount, addTraceNeighbor, pruneTraceNode };
}
