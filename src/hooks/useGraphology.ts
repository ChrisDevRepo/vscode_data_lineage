import { useState, useCallback } from 'react';
import Graph from 'graphology';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import { DatabaseModel, FilterState, ExtensionConfig, DEFAULT_CONFIG, type CustomNodeData } from '../engine/types';
import { buildGraph, buildGraphNoLayout, getGraphMetrics } from '../engine/graphBuilder';
import { filterBySchemas } from '../engine/dacpacExtractor';
import { applyExclusionFilter, applyIsolationFilter, applyAllowlistFilter } from '../engine/modelFilters';
import { createSchemaColorMap, getSchemaColorFromMap } from '../utils/schemaColors';

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
   * @param skipLayout - Whether to skip full Dagre layout because the caller is rendering Schema View.
   * @returns The total number of nodes in the resulting graph.
   */
  buildFromModel: (model: DatabaseModel, filter: FilterState, config?: ExtensionConfig, skipLayout?: boolean) => number;
}

/**
 * Manages graph filtering, render limits, layout, and React Flow projection.
 *
 * @remarks
 * Filters run in schema, type, exclusion, isolation, then allowlist order. Object layout is
 * skipped for Schema View and entirely withheld when the render limit is exceeded.
 */
export function useGraphology(): UseGraphologyReturn {
  const [flowNodes, setFlowNodes] = useState<FlowNode<CustomNodeData>[]>([]);
  const [flowEdges, setFlowEdges] = useState<FlowEdge[]>([]);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [metrics, setMetrics] = useState<ReturnType<typeof getGraphMetrics> | null>(null);
  const [renderLimitHit, setRenderLimitHit] = useState(0);
  const [filteredCount, setFilteredCount] = useState(0);
  const [renderedSchemas, setRenderedSchemas] = useState<string[]>([]);

  const buildFromModel = useCallback((model: DatabaseModel, filter: FilterState, config: ExtensionConfig = DEFAULT_CONFIG, skipLayout = false): number => {
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
    const schemaColorMap = createSchemaColorMap(schemas);
    setRenderedSchemas(schemas);

    const withSchemaColors = (nodes: FlowNode<CustomNodeData>[]): FlowNode<CustomNodeData>[] =>
      nodes.map((node) => {
        if (node.data.objectType === 'external') return node;
        return {
          ...node,
          data: {
            ...node.data,
            schemaColor: getSchemaColorFromMap(node.data.schema, schemaColorMap),
          },
        };
      });

    // Guard 1: full-object render limit. Keep the graphology model available for schema
    // overview, expanded schema view, trace/path, and analysis surfaces; only the full object
    // React Flow surface is blocked by render-limit mode.
    if (count > config.renderLimit) {
      log(`[Filter] Graph too large to display (${count} objects exceed render limit of ${config.renderLimit})`, 'info');
      const result = buildGraphNoLayout(allowlistFiltered, config);
      setFlowNodes(withSchemaColors(result.flowNodes as FlowNode<CustomNodeData>[]));
      setFlowEdges(result.flowEdges);
      setGraph(result.graph);
      setMetrics(getGraphMetrics(result.graph));
      setRenderLimitHit(count);
      return count;
    }

    setRenderLimitHit(0);

    // Guard 2: schema/object surface. App owns the initial threshold decision on load/reset;
    // this hook skips layout only when the caller explicitly asks for Schema View.
    if (skipLayout) {
      const result = buildGraphNoLayout(allowlistFiltered, config);
      setFlowNodes(withSchemaColors(result.flowNodes as FlowNode<CustomNodeData>[]));
      setFlowEdges(result.flowEdges);
      setGraph(result.graph);
      setMetrics(getGraphMetrics(result.graph));
      log(`[Filter] Schema View - ${count} nodes (layout skipped)`, 'info');
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
    setFlowNodes(withSchemaColors(result.flowNodes as FlowNode<CustomNodeData>[]));
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
