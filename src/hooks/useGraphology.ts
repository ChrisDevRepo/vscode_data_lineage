import { useState, useCallback } from 'react';
import Graph from 'graphology';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import { DatabaseModel, FilterState, ExtensionConfig, DEFAULT_CONFIG, type CustomNodeData } from '../engine/types';
import { buildGraph, buildGraphNoLayout, getGraphMetrics, hasCachedLayout, layoutCacheKey, objectLayoutInputForGraph, seedLayoutCache } from '../engine/graphBuilder';
import { refuseOverObjectLimit } from '../utils/objectLimitGuard';
import { filterBySchemas } from '../engine/dacpacExtractor';
import { applyExclusionFilter, applyIsolationFilter, applyAllowlistFilter } from '../engine/modelFilters';
import { createSchemaColorMap, getSchemaColorFromMap } from '../utils/schemaColors';
import { createLayoutWorkerClient } from '../utils/layoutWorkerClient';
import LayoutWorker from '../utils/layout.worker?worker&inline';

const logPrewarmSkipped = (reason: string): void => {
  window.vscode?.postMessage({ type: 'log', text: `[Filter] Layout prewarm skipped (${reason})`, level: 'debug' });
};

const layoutWorker = createLayoutWorkerClient(() => new LayoutWorker(), logPrewarmSkipped);

/**
 * Lays out the Object View graph in a worker and seeds the layout cache, so the later
 * Schema View → Object View switch finds its positions without running Dagre on the UI thread.
 * Without a usable worker the switch simply lays out on the main thread as before.
 */
function prewarmObjectLayout(graph: Graph, config: ExtensionConfig): void {
  if (typeof Worker === 'undefined') return;
  const input = objectLayoutInputForGraph(graph, config);
  const key = layoutCacheKey(input);
  if (hasCachedLayout(input, key)) return;
  layoutWorker.runDagre(input)?.then(
    (positions) => {
      if (!seedLayoutCache(input, positions, key)) logPrewarmSkipped('incomplete layout');
    },
    (e: unknown) => logPrewarmSkipped(e instanceof Error ? e.message : String(e)),
  );
}

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
   * @param skipLayout - Whether to skip full Dagre layout because the caller is rendering Schema View.
   * @param annotatedNodeIds - Ids carrying an AI badge or footnote, so Dagre reserves the
   *   vertical band those overlays need; see `AI_BADGE_BAND`/`AI_NOTE_BAND` in `graphBuilder.ts`.
   * @returns The total number of nodes in the resulting graph, or `-1` when the schema selection's
   *   object count exceeds `dataLineageViz.maxNodes` — nothing is built and the prior render state
   *   is left untouched.
   */
  buildFromModel: (model: DatabaseModel, filter: FilterState, config?: ExtensionConfig, skipLayout?: boolean, annotatedNodeIds?: readonly string[]) => number;
  /**
   * Runs the same maxNodes admission check `buildFromModel` starts with, without building. Returns
   * `true` and posts the refusal warning when the build would be refused, so a caller that defers the
   * build into a transition, or vets a candidate schema selection, learns about the refusal
   * synchronously. Only the filter's schema selection decides admission.
   */
  refusesBuild: (model: DatabaseModel, filter: Pick<FilterState, 'schemas'>, config?: ExtensionConfig) => boolean;
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

  const refusesBuild = useCallback((model: DatabaseModel, filter: Pick<FilterState, 'schemas'>, config: ExtensionConfig = DEFAULT_CONFIG): boolean =>
    refuseOverObjectLimit(filterBySchemas(model, filter.schemas), config.maxNodes, 'Filter') !== null, []);

  const buildFromModel = useCallback((model: DatabaseModel, filter: FilterState, config: ExtensionConfig = DEFAULT_CONFIG, skipLayout = false, annotatedNodeIds?: readonly string[]): number => {
    const log = (text: string, level: 'info' | 'debug' = 'debug') => window.vscode?.postMessage({ type: 'log', text, level });
    const filtered = filterBySchemas(model, filter.schemas);
    if (refuseOverObjectLimit(filtered, config.maxNodes, 'Filter') !== null) return -1;

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

    const schemas = [...new Set(
      allowlistFiltered.nodes.map(n => n.schema)
    )].filter(s => !!s && s.trim().length > 0).sort();
    const schemaColorMap = createSchemaColorMap(schemas, undefined, model.identifierCaseSensitive);
    setRenderedSchemas(schemas);

    const withSchemaColors = (nodes: FlowNode<CustomNodeData>[]): FlowNode<CustomNodeData>[] =>
      nodes.map((node) => {
        if (node.data.objectType === 'external') return node;
        return {
          ...node,
          data: {
            ...node.data,
            schemaColor: getSchemaColorFromMap(node.data.schema, schemaColorMap, model.identifierCaseSensitive),
          },
        };
      });

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

    if (skipLayout) {
      const result = buildGraphNoLayout(allowlistFiltered, config);
      setFlowNodes(withSchemaColors(result.flowNodes as FlowNode<CustomNodeData>[]));
      setFlowEdges(result.flowEdges);
      setGraph(result.graph);
      setMetrics(getGraphMetrics(result.graph));
      log(`[Filter] Schema View - ${count} nodes (layout skipped)`, 'info');
      prewarmObjectLayout(result.graph, config);
      return count;
    }

    const t0 = performance.now();
    let result: ReturnType<typeof buildGraph>;
    let layoutFailed = false;
    try {
      result = buildGraph(allowlistFiltered, config, annotatedNodeIds);
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

  return { flowNodes, flowEdges, graph, metrics, renderLimitHit, filteredCount, renderedSchemas, buildFromModel, refusesBuild };
}
