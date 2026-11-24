import { useState, useCallback, useEffect, useMemo, useRef, startTransition } from 'react';
import Graph from 'graphology';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import { TraceState, ExtensionConfig, DEFAULT_CONFIG, AnalysisType, DatabaseModel, type CustomNodeData } from '../engine/types';
import { applyTraceToFlow, buildGraphologyGraph } from '../engine/graphBuilder';
import { buildTraceScopeGraph, buildVisibleTraceScope, canPruneTraceNode, isEditableTraceMode, traceRemovalSides, unionConnectingPaths } from '../engine/traceScope';
import { notifyUser } from '../utils/notify';
import { directNeighborIds } from '../engine/graphGuards';
import { computeShortestPath, resolveBfsGraph, traceNodeWithLevels } from '../engine/shared/lineageTrace';
import { traceSizeByDepth } from '../engine/graphDisplayMode';

/** State and control actions returned by `useInteractiveTrace`. */
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
  endTrace: () => void;
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
  /** Node count a trace from the current origin at these depths would render; BFS, no layout. */
  estimateTraceSize: (upstreamLevels: number, downstreamLevels: number) => number;
  /**
   * Shows only the origin→target routes for `targetIds`, against the pre-focus scope; an empty list
   * restores it. Returns false and leaves the scope untouched when a route is unreachable.
   */
  setFocusTargets: (targetIds: string[]) => boolean;
  /** Restores the scope stashed by the last focus, or ends the trace when nothing was stashed. */
  exitFocusPaths: () => void;
  /** Whether a tree focus narrowing is on stage. */
  isFocusPaths: boolean;
  /** Targets whose routes the focus shows; empty outside a focus. */
  focusTargetIds: readonly string[];
  /** The pre-focus trace while a focus is shown, else the trace itself; the navigator lists it. */
  navigatorTrace: TraceState;
  /** Drops manual add/prune edits, restoring the starting scope while staying in the trace. */
  resetTraceToStart: () => void;
  /** Adds a batch of direct scope neighbors in one update (tree level growth). */
  addTraceNeighbors: (nodeIds: string[]) => void;
  /** Traversal graph over the trace scope for tree path lighting and focus paths; null if none. */
  traceScopeGraph: Graph | null;
  /** Unfiltered traversal graph over the whole model; null until a model is loaded. */
  fullGraph: Graph | null;
}

const NO_TARGETS: readonly string[] = [];

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
  return directNeighborIds(model, candidateNodeId, 'in').some(id => visibleNodeIds.has(id))
    || directNeighborIds(model, candidateNodeId, 'out').some(id => visibleNodeIds.has(id));
}

/**
 * Manages interactive lineage traces and pathfinding. Auto-promotes to `fullGraph` when the
 * selected node is filtered out of the base graph, so the requested lineage is always visible.
 *
 * @param model - The full model, required for unfiltered pathfinding.
 * @param baseRenderLimited - Whether the render limit blocks the base object graph.
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
  const [focus, setFocus] = useState<{ previous: TraceState; targetIds: readonly string[] } | null>(null);

  const fullGraph = useMemo(() => model ? buildGraphologyGraph(model) : null, [model]);

  const useFullModelRef = useRef(useFullModel);
  useFullModelRef.current = useFullModel;

  const startTraceConfig = useCallback((nodeId: string) => {
    setFocus(null);
    setTrace(createTrace(config, {
      mode: 'configuring',
      selectedNodeId: nodeId,
    }));
  }, [config]);

  const runTrace = useCallback((
    label: 'Immediate' | 'Apply',
    mode: 'filtered' | 'applied',
    nodeId: string,
    upstreamLevels: number,
    downstreamLevels: number,
  ) => {
    const { bfsGraph, autoPromoted } = resolveBfsGraph(nodeId, useFullModelRef.current, graph, fullGraph);
    if (!bfsGraph) {
      window.vscode?.postMessage({ type: 'log', text: `[Trace] ${label} skipped — graph not ready` });
      return;
    }
    if (autoPromoted) {
      window.vscode?.postMessage({ type: 'log', text: `[Trace] "${nodeId}" not in filtered graph — auto-promoting to full model` });
    }

    const t0 = performance.now();
    const { nodeIds, edgeIds } = traceNodeWithLevels(bfsGraph, nodeId, upstreamLevels, downstreamLevels);
    const ms = (performance.now() - t0).toFixed(1);
    window.vscode?.postMessage({ type: 'log', text:
      `[Trace] ${label}: "${nodeId}" up=${upstreamLevels} down=${downstreamLevels} fullModel=${useFullModelRef.current}${autoPromoted ? ' (auto-promoted)' : ''} → ${nodeIds.size} nodes, ${edgeIds.size} edges (${ms}ms)`
    });

    if (mode === 'filtered' && nodeIds.size === 0 && fullGraph?.hasNode(nodeId)) {
      window.vscode?.postMessage({ type: 'log', level: 'warn', text:
        `[Trace] 0 results for "${nodeId}" — exists in model but has no connections` });
    }

    setFocus(null);
    startTransition(() => {
      setTrace(createTrace(config, {
        mode,
        selectedNodeId: nodeId,
        upstreamLevels,
        downstreamLevels,
        baseNodeIds: nodeIds,
        baseEdgeIds: edgeIds,
        tracedNodeIds: nodeIds,
        tracedEdgeIds: edgeIds,
        autoPromoted,
      }));
    });
  }, [graph, fullGraph, config]);

  const startTraceImmediate = useCallback((nodeId: string) => {
    runTrace('Immediate', 'filtered', nodeId, config.trace.defaultUpstreamLevels, config.trace.defaultDownstreamLevels);
  }, [runTrace, config]);

  const applyTrace = useCallback(
    (upstreamLevels: number, downstreamLevels: number) => {
      if (!trace.selectedNodeId) {
        window.vscode?.postMessage({ type: 'log', text: `[Trace] Apply skipped — no selectedNode` });
        return;
      }
      runTrace('Apply', 'applied', trace.selectedNodeId, upstreamLevels, downstreamLevels);
    },
    [runTrace, trace.selectedNodeId]
  );

  const startPathFinding = useCallback((nodeId: string) => {
    setFocus(null);
    setTrace(createTrace(config, {
      mode: 'pathfinding',
      selectedNodeId: nodeId,
      upstreamLevels: 0,
      downstreamLevels: 0,
    }));
  }, [config]);

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

    setFocus(null);
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
    setFocus(null);
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

  const pruneTraceNode = useCallback((nodeId: string) => {
    if (!model || !fullGraph) return;
    setTrace(prev => {
      if (!isEditableTraceMode(prev.mode) || nodeId === prev.selectedNodeId) return prev;
      const check = canPruneTraceNode(fullGraph, prev.selectedNodeId, prev.tracedNodeIds, nodeId, traceRemovalSides(prev.upstreamLevels, prev.downstreamLevels));
      if (!check.safe) return prev;
      const manualAddedNodeIds = new Set(prev.manualAddedNodeIds);
      const manualPrunedNodeIds = new Set(prev.manualPrunedNodeIds);
      manualAddedNodeIds.delete(nodeId);
      manualPrunedNodeIds.add(nodeId);
      for (const cutId of check.cutNodeIds ?? []) {
        manualAddedNodeIds.delete(cutId);
        manualPrunedNodeIds.add(cutId);
      }
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

  const endTrace = useCallback(() => {
    setTrace(createInitialTrace(config));
    setUseFullModel(false);
    setFocus(null);
  }, [config]);

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

  const traced = useMemo(
    (): { tracedNodes: FlowNode<CustomNodeData>[]; tracedEdges: FlowEdge[]; traceGraph: Graph | null; notice?: string } => {
      if (trace.mode === 'none' || trace.mode === 'configuring' || trace.mode === 'pathfinding') {
        return { tracedNodes: flowNodes, tracedEdges: flowEdges, traceGraph: null };
      }
      if (trace.tracedNodeIds.size > config.renderLimit) {
        return { tracedNodes: [], tracedEdges: [], traceGraph: null };
      }

      const synthesize = baseRenderLimited || useFullModel || !!trace.autoPromoted || trace.manualAddedNodeIds.size > 0;
      const { nodes, edges, graph: tGraph, notice } = applyTraceToFlow(flowNodes, flowEdges, trace, config, model, synthesize);
      return { tracedNodes: nodes as FlowNode<CustomNodeData>[], tracedEdges: edges, traceGraph: tGraph ?? null, notice };
    },
    [flowNodes, flowEdges, trace, config, model, useFullModel, baseRenderLimited]
  );
  const { tracedNodes, tracedEdges, traceGraph } = traced;

  /** Shows the empty/invisible-trace warning once per computed view; the memo stays pure. */
  useEffect(() => {
    if (traced.notice) notifyUser(traced.notice);
  }, [traced]);

  /**
   * Node count a trace from the current origin at these depths would render; the same BFS graph
   * {@link applyTrace} uses.
   */
  const estimateTraceSize = useCallback((upstreamLevels: number, downstreamLevels: number): number => {
    if (!trace.selectedNodeId) return 0;
    const { bfsGraph } = resolveBfsGraph(trace.selectedNodeId, useFullModelRef.current, graph, fullGraph);
    if (!bfsGraph) return 0;
    return traceSizeByDepth(bfsGraph, trace.selectedNodeId, upstreamLevels, downstreamLevels);
  }, [graph, fullGraph, trace.selectedNodeId]);

  /**
   * Traversal graph over the trace scope; the flow-provided graph exists only on synthesized
   * traces.
   */
  const traceScopeGraph = useMemo(() => {
    if (traceGraph) return traceGraph;
    if (!model || !isEditableTraceMode(trace.mode) || trace.tracedNodeIds.size === 0) return null;
    return buildTraceScopeGraph(model, trace.tracedNodeIds);
  }, [traceGraph, model, trace.mode, trace.tracedNodeIds]);

  /** Scope graph the focus routes resolve against: the pre-focus scope, never the narrowed one. */
  const focusBaseGraph = useMemo(
    () => (focus && model ? buildTraceScopeGraph(model, focus.previous.tracedNodeIds) : traceScopeGraph),
    [focus, model, traceScopeGraph],
  );

  const exitFocusPaths = useCallback(() => {
    if (focus) {
      setFocus(null);
      setTrace(focus.previous);
    } else {
      endTrace();
    }
  }, [focus, endTrace]);

  /**
   * Shows the union of every path between the origin and each checked target. All-or-nothing: if
   * any route is unreachable the scope is untouched. Routes resolve against the pre-focus scope, so
   * a target hidden by the current focus can be added.
   */
  const setFocusTargets = useCallback((targetIds: string[]): boolean => {
    const base = focus?.previous ?? trace;
    if (targetIds.length === 0) {
      if (focus) exitFocusPaths();
      return true;
    }
    if (!base.selectedNodeId || !isEditableTraceMode(base.mode) || !focusBaseGraph) return false;
    const union = unionConnectingPaths(focusBaseGraph, base.selectedNodeId, targetIds);
    if (!union) {
      window.vscode?.postMessage({ type: 'log', text: `[Trace] Focus paths skipped — a route is unreachable`, level: 'debug' });
      return false;
    }
    window.vscode?.postMessage({ type: 'log', text:
      `[Trace] Focus paths: "${base.selectedNodeId}" → ${targetIds.length} targets, ${union.nodeIds.size} nodes, ${union.edgeIds.size} edges`
    });
    setFocus({ previous: base, targetIds });
    setTrace(createTrace(config, {
      mode: 'path-applied',
      selectedNodeId: base.selectedNodeId,
      targetNodeId: null,
      upstreamLevels: 0,
      downstreamLevels: 0,
      baseNodeIds: union.nodeIds,
      baseEdgeIds: union.edgeIds,
      tracedNodeIds: union.nodeIds,
      tracedEdgeIds: union.edgeIds,
    }));
    return true;
  }, [config, trace, focus, focusBaseGraph, exitFocusPaths]);

  const resetTraceToStart = useCallback(() => {
    if (!model) return;
    setTrace(prev => {
      if (!isEditableTraceMode(prev.mode)) return prev;
      if (prev.manualAddedNodeIds.size === 0 && prev.manualPrunedNodeIds.size === 0) return prev;
      const scope = buildVisibleTraceScope(prev.baseNodeIds, new Set(), new Set(), model.edges);
      return {
        ...prev,
        manualAddedNodeIds: new Set(),
        manualPrunedNodeIds: new Set(),
        tracedNodeIds: scope.nodeIds,
        tracedEdgeIds: scope.edgeIds,
      };
    });
  }, [model]);

  const addTraceNeighbors = useCallback((nodeIds: string[]) => {
    if (!model || nodeIds.length === 0) return;
    setTrace(prev => {
      if (!isEditableTraceMode(prev.mode)) return prev;
      const manualAddedNodeIds = new Set(prev.manualAddedNodeIds);
      const manualPrunedNodeIds = new Set(prev.manualPrunedNodeIds);
      let changed = false;
      for (const nodeId of nodeIds) {
        if (!isDirectNeighborOfScope(model, prev.tracedNodeIds, nodeId)) continue;
        manualAddedNodeIds.add(nodeId);
        manualPrunedNodeIds.delete(nodeId);
        changed = true;
      }
      if (!changed) return prev;
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

  const addTraceNeighbor = useCallback((nodeId: string) => addTraceNeighbors([nodeId]), [addTraceNeighbors]);

  return { trace, tracedNodes, tracedEdges, traceGraph, startTraceConfig, startTraceImmediate, applyTrace, startPathFinding, applyPath, applyAnalysisSubset, endTrace, useFullModel, toggleUseFullModel, filteredOutCount, addTraceNeighbor, pruneTraceNode, estimateTraceSize, setFocusTargets, exitFocusPaths, isFocusPaths: focus !== null, focusTargetIds: focus?.targetIds ?? NO_TARGETS, navigatorTrace: focus?.previous ?? trace, resetTraceToStart, addTraceNeighbors, traceScopeGraph, fullGraph };
}
