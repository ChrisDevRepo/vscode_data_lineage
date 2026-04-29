import { useState, useCallback } from 'react';
import Graph from 'graphology';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { CustomNodeData } from '../components/CustomNode';
import { DatabaseModel, FilterState, ExtensionConfig, DEFAULT_CONFIG } from '../engine/types';
import { buildGraph, buildGraphNoLayout, getGraphMetrics } from '../engine/graphBuilder';
import { filterBySchemas } from '../engine/dacpacExtractor';
import { applyExclusionFilter, applyIsolationFilter, applyAllowlistFilter } from '../engine/modelFilters';

/**
 * Return type for the useGraphology hook, encapsulating graph data and builders.
 */
interface UseGraphologyReturn {
  /** The list of nodes formatted for React Flow rendering. */
  flowNodes: FlowNode<CustomNodeData>[];
  /** The list of edges formatted for React Flow rendering. */
  flowEdges: FlowEdge[];
  /** The underlying graphology instance for structural analysis. */
  graph: Graph | null;
  /** High-level metrics derived from the current graph (degree, depth, etc.). */
  metrics: ReturnType<typeof getGraphMetrics> | null;
  /** When > 0, indicates the render limit was exceeded; contains the actual node count. */
  renderLimitHit: number;
  /** Total number of nodes remaining after all filters are applied. */
  filteredCount: number;
  /** Unique schema names found in the filtered node set, used for the legend. */
  renderedSchemas: string[];
  /**
   * Rebuilds the graph from the database model based on the current filter and configuration.
   * 
   * @param model - The database model to filter and build from.
   * @param filter - The current UI filter state.
   * @param config - Optional configuration overrides.
   * @param forceLayout - Whether to force a full Dagre layout even if the overview threshold is hit.
   * @returns The total number of nodes in the resulting graph.
   */
  buildFromModel: (model: DatabaseModel, filter: FilterState, config?: ExtensionConfig, forceLayout?: boolean) => number;
}

/**
 * Primary hook for managing graph state, filtering, and layout orchestration.
 * 
 * @remarks
 * This hook implements a high-performance filtering pipeline that runs on every
 * state change. It supports multiple rendering modes:
 * 1. **Full Mode**: Executes the Dagre layout engine for precise positioning.
 * 2. **Overview Mode**: Skips layout and renders nodes at origin to support massive graphs.
 * 3. **Pruned Mode**: Rejects rendering entirely if hard limits are exceeded.
 * 
 * The pipeline follows this order: Schema → Type → Exclusion → Isolation → Allowlist.
 * 
 * @returns An object containing the current graph state and the build function.
 */
export function useGraphology(): UseGraphologyReturn {
  const [flowNodes, setFlowNodes] = useState<FlowNode<CustomNodeData>[]>([]);
  const [flowEdges, setFlowEdges] = useState<FlowEdge[]>([]);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [metrics, setMetrics] = useState<ReturnType<typeof getGraphMetrics> | null>(null);
  const [renderLimitHit, setRenderLimitHit] = useState(0);
  const [filteredCount, setFilteredCount] = useState(0);
  const [renderedSchemas, setRenderedSchemas] = useState<string[]>([]);

  const buildFromModel = useCallback((model: DatabaseModel, filter: FilterState, config: ExtensionConfig = DEFAULT_CONFIG, forceLayout = false): number => {
    const log = (text: string, level: 'info' | 'debug' = 'debug') => window.vscode?.postMessage({ type: 'log', text, level });
    const filtered = filterBySchemas(model, filter.schemas, config.maxNodes);
    
    // Fused type + ext refs filter (single node pass)
    const isVirtual = (n: { externalType?: string }) =>
      n.externalType === 'file' || n.externalType === 'db';
    const allExtRefsVisible = filter.showExternalRefs && filter.externalRefTypes.has('file') && filter.externalRefTypes.has('db');

    const fusedNodes = filtered.nodes.filter((n) => {
      if (!filter.types.has(n.type)) return false;
      if (allExtRefsVisible || !isVirtual(n)) return true;
      if (!filter.showExternalRefs) return false;
      return filter.externalRefTypes.has(n.externalType as 'file' | 'db');
    });
    const fusedNodeIds = new Set(fusedNodes.map((n) => n.id));
    const fusedEdges = filtered.edges.filter((e) => fusedNodeIds.has(e.source) && fusedNodeIds.has(e.target));

    const exclusionFiltered = applyExclusionFilter(
      { ...filtered, nodes: fusedNodes, edges: fusedEdges },
      filter.exclusionPatterns,
      (pattern, err) => log(`[Filter] Skipping invalid exclusion pattern "${pattern}": ${err instanceof Error ? err.message : String(err)}`, 'debug'),
    );
    const isolationFiltered = applyIsolationFilter(exclusionFiltered, filter.hideIsolated);
    const allowlistFiltered = applyAllowlistFilter(isolationFiltered, filter.allowlistNodeIds);

    const count = allowlistFiltered.nodes.length;
    setFilteredCount(count);

    // Derive visible schemas from filtered nodes — schemas containing only external objects
    // are included here to keep them selectable in the filter, but will be filtered out
    // in the visual Legend component in GraphCanvas.
    const schemas = [...new Set(
      allowlistFiltered.nodes.map(n => n.schema)
    )].filter(s => !!s && s.trim().length > 0).sort();
    setRenderedSchemas(schemas);

    // Guard 1: hard render limit — skip everything
    if (count > config.renderLimit) {
      log(`[Filter] Graph too large to display (${count} objects exceed render limit of ${config.renderLimit})`, 'info');
      setFlowNodes([]);
      setFlowEdges([]);
      setGraph(null);
      setMetrics(null);
      setRenderLimitHit(count);
      return count;
    }

    setRenderLimitHit(0);

    // Guard 2: overview threshold — build graph for traces/metrics, skip expensive dagre layout.
    // Bypassed when forceLayout=true (user manually toggled overview→full or drilled down).
    if (!forceLayout && count > config.overview.threshold) {
      const result = buildGraphNoLayout(allowlistFiltered, config);
      setFlowNodes(result.flowNodes as FlowNode<CustomNodeData>[]);
      setFlowEdges(result.flowEdges);
      setGraph(result.graph);
      setMetrics(getGraphMetrics(result.graph));
      log(`[Filter] Overview mode — ${count} nodes (layout skipped)`, 'info');
      return count;
    }

    // Full mode — dagre runs; fall back to unpositioned graph on any layout failure.
    const t0 = performance.now();
    let result: ReturnType<typeof buildGraph>;
    let layoutFailed = false;
    try {
      result = buildGraph(allowlistFiltered, config);
    } catch (e) {
      layoutFailed = true;
      log(`[Filter] Layout failed (${e instanceof Error ? e.message : String(e)}) — rendering without positions`, 'info');
      try {
        result = buildGraphNoLayout(allowlistFiltered, config);
      } catch (e2) {
        log(`[Filter] Graph build completely failed — ${e2 instanceof Error ? e2.message : String(e2)}`, 'info');
        setFlowNodes([]);
        setFlowEdges([]);
        setGraph(null);
        setMetrics(null);
        return count;
      }
    }
    setFlowNodes(result.flowNodes as FlowNode<CustomNodeData>[]);
    setFlowEdges(result.flowEdges);
    setGraph(result.graph);
    setMetrics(getGraphMetrics(result.graph));
    if (!layoutFailed) {
      log(`[Filter] Graph built — ${count} nodes (${Math.round(performance.now() - t0)}ms)`, 'info');
    }
    return count;
  }, []);

  return { flowNodes, flowEdges, graph, metrics, renderLimitHit, filteredCount, renderedSchemas, buildFromModel };
}
