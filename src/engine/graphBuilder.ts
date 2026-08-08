/**
 * @module GraphBuilder
 * Orchestrates the transformation of the DatabaseModel into renderable React Flow graphs.
 *
 * This module is responsible for:
 * - Building the underlying `graphology` computational graph.
 * - Implementing spatial layout algorithms (Dagre, Grid) for node positioning.
 * - Managing graph operations such as upstream/downstream tracing and pathfinding.
 * - Converting computational graphs into React Flow nodes and edges with specialized styling.
 * - Handling bidirectional edge consolidation and canonical direction selection.
 * - Building schema-level overview graphs for macro-lineage visualization.
 */

import Graph from 'graphology';
import { bfsFromNode } from 'graphology-traversal';
import { findShortestPathOrdered } from './graphGuards';
import dagre from '@dagrejs/dagre';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import { DatabaseModel, TraceState, ExtensionConfig, DEFAULT_CONFIG, SchemaNodeData, ObjectType } from './types';
import { createSchemaColorMap, getExternalNodeColor, getSchemaColorFromMap, getSchemaDisplayColor, isExternalOnlyTypeBreakdown, type SchemaColorMap } from '../utils/schemaColors';
import {
  projectExpandedSchemaView,
  projectSchemaQuotient,
  type ExpandedSchemaViewRenderOptions,
  type SchemaBridgeEdge,
  type SchemaProjectionEdge,
  type SchemaProjectionNode,
} from './schemaProjection';
import { notifyUser } from '../utils/notify';

/** Width of a standard graph node in pixels. */
export const NODE_WIDTH = 220;
/** Height of a standard graph node in pixels. */
export const NODE_HEIGHT = 80;
/** Width of a schema-level node in pixels. */
export const SCHEMA_NODE_WIDTH = 200;
/** Height of a schema-level node in pixels. */
export const SCHEMA_NODE_HEIGHT = 80;

/** Typed tuple for React Flow edge label background padding. */
const LABEL_BG_PAD: [number, number] = [4, 4];
/** Default column count for grid-based analysis layouts. */
const GRID_DEFAULT_COLS = 4;
/** Padding between nodes in grid layout (px). */
const GRID_CELL_PADDING = 40;

/**
 * Collects edges between traced nodes with direction-aware filtering.
 *
 * @param graph - The underlying computational graph.
 * @param nodeIds - Set of node identifiers within the trace scope.
 * @param upDepth - Upstream depth mapping.
 * @param downDepth - Downstream depth mapping.
 * @returns A set of edge identifiers that conform to the tracing directionality.
 */
function collectTraceEdges(
  graph: Graph,
  nodeIds: Set<string>,
  upDepth: Map<string, number>,
  downDepth: Map<string, number>
): Set<string> {
  const edgeIds = new Set<string>();
  const hasUp = upDepth.size > 1;
  const hasDown = downDepth.size > 1;

  graph.forEachEdge((edge, _attrs, source, target) => {
    if (!nodeIds.has(source) || !nodeIds.has(target)) return;

    if (hasUp && hasDown) {
      edgeIds.add(edge);
      return;
    }

    if (hasUp) {
      const sD = upDepth.get(source);
      const tD = upDepth.get(target);
      if (sD !== undefined && tD !== undefined && sD >= tD) {
        edgeIds.add(edge);
      }
      return;
    }

    if (hasDown) {
      const sD = downDepth.get(source);
      const tD = downDepth.get(target);
      if (sD !== undefined && tD !== undefined && tD >= sD) {
        edgeIds.add(edge);
      }
    }
  });

  return edgeIds;
}

/**
 * Represents the structured result of graph compilation.
 */
export interface GraphResult {
  /** Nodes formatted for React Flow. */
  flowNodes: FlowNode[];
  /** Edges formatted for React Flow. */
  flowEdges: FlowEdge[];
  /** Underlying computational graph. */
  graph: Graph;
}

/**
 * Minimal node shape consumed by {@link buildLineageFlowNode} when constructing a React Flow node.
 * The `external*` fields are populated only for external references (objects outside the analyzed
 * project) and are therefore optional; internal objects leave them undefined.
 */
type LineageFlowNodeSource = {
  id: string;
  label: string;
  schema: string;
  fullName: string;
  objectType: ObjectType;
  /** External-reference source kind (e.g. file, db); set only for external nodes. */
  externalType?: string;
  /** External-reference URL; set only for external nodes that carry one. */
  externalUrl?: string;
  /** Originating database name for cross-database external references. */
  externalDatabase?: string;
};

function buildLineageFlowNode(
  source: LineageFlowNodeSource,
  graph: Graph,
  position: { x: number; y: number },
  options?: { highlighted?: boolean; schemaColor?: string },
): FlowNode {
  return {
    id: source.id,
    type: 'lineageNode',
    position,
    draggable: true,
    selectable: true,
    data: {
      label: source.label,
      schema: source.schema,
      fullName: source.fullName,
      objectType: source.objectType,
      inDegree: graph.hasNode(source.id) ? graph.inDegree(source.id) : 0,
      outDegree: graph.hasNode(source.id) ? graph.outDegree(source.id) : 0,
      ...(source.externalType && { externalType: source.externalType }),
      ...(source.externalUrl && { externalUrl: source.externalUrl }),
      ...(source.externalDatabase && { externalDatabase: source.externalDatabase }),
      ...(options?.highlighted !== undefined && { highlighted: options.highlighted }),
      ...(options?.schemaColor && { schemaColor: options.schemaColor }),
    },
  };
}

/**
 * Builds a directed graphology graph from a database model.
 *
 * @param model - The database model definitions.
 * @returns A populated graph instance.
 */
export function buildGraphologyGraph(model: DatabaseModel): Graph {
  const graph = new Graph({ type: 'directed', multi: false });
  for (const node of model.nodes) {
    if (!node.id) {
      window.vscode?.postMessage({ type: 'log', level: 'warn', text: `[Graph] Skipping node with empty ID: ${node.schema}.${node.name}` });
      continue;
    }
    if (graph.hasNode(node.id)) {
      window.vscode?.postMessage({ type: 'log', level: 'warn', text: `[Graph] Duplicate node ID skipped: ${node.id}` });
      continue;
    }
    graph.addNode(node.id, { ...node });
  }
  for (const edge of model.edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      const edgeId = `${edge.source}→${edge.target}`;
      if (!graph.hasEdge(edgeId)) {
        graph.addEdgeWithKey(edgeId, edge.source, edge.target, { type: edge.type });
      }
    }
  }
  return graph;
}

/**
 * Converts internal model and graph state into React Flow structures.
 */
function toFlowResult(
  model: DatabaseModel,
  graph: Graph,
  positions: Map<string, { x: number; y: number }>,
  config: ExtensionConfig
): GraphResult {
  const flowNodes: FlowNode[] = model.nodes.map((node) => buildLineageFlowNode(
    {
      id: node.id,
      label: node.name,
      schema: node.schema,
      fullName: node.fullName,
      objectType: node.type,
      externalType: node.externalType,
      externalUrl: node.externalUrl,
      externalDatabase: node.externalDatabase,
    },
    graph,
    positions.get(node.id) || { x: 0, y: 0 },
  ));
  const flowEdges: FlowEdge[] = buildFlowEdges(model.edges, graph, config);
  return { flowNodes, flowEdges, graph };
}

/**
 * Fully builds and layouts a graph for visualization.
 *
 * @param model - Database model to visualize.
 * @param config - Extension configuration.
 * @returns Complete graph result.
 */
export function buildGraph(model: DatabaseModel, config: ExtensionConfig = DEFAULT_CONFIG): GraphResult {
  const graph = buildGraphologyGraph(model);
  const positions = computeLayout(graph, config);
  return toFlowResult(model, graph, positions, config);
}

/**
 * Builds a graph without executing layout algorithms, preserving default positions.
 *
 * @param model - Database model to visualize.
 * @param config - Extension configuration.
 * @returns Complete graph result with zeroed positions.
 */
export function buildGraphNoLayout(model: DatabaseModel, config: ExtensionConfig = DEFAULT_CONFIG): GraphResult {
  const graph = buildGraphologyGraph(model);
  return toFlowResult(model, graph, new Map(), config);
}

/**
 * Traces a node's lineage (upstream/downstream) through the graph.
 *
 * @param graph - computational graph.
 * @param nodeId - Origin node ID.
 * @param mode - Trace direction.
 * @returns Nodes and edges in the trace.
 */
export function traceNode(
  graph: Graph,
  nodeId: string,
  mode: 'upstream' | 'downstream' | 'both'
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  if (!graph.hasNode(nodeId)) return { nodeIds: new Set<string>(), edgeIds: new Set<string>() };

  const nodeIds = new Set<string>([nodeId]);
  const upDepth = new Map<string, number>();
  const downDepth = new Map<string, number>();
  if (mode !== 'downstream') upDepth.set(nodeId, 0);
  if (mode !== 'upstream') downDepth.set(nodeId, 0);

  if (mode === 'upstream' || mode === 'both') {
    bfsFromNode(graph, nodeId, (node, _attrs, depth) => {
      nodeIds.add(node);
      upDepth.set(node, depth);
    }, { mode: 'inbound' });
  }
  if (mode === 'downstream' || mode === 'both') {
    bfsFromNode(graph, nodeId, (node, _attrs, depth) => {
      nodeIds.add(node);
      downDepth.set(node, depth);
    }, { mode: 'outbound' });
  }

  const edgeIds = collectTraceEdges(graph, nodeIds, upDepth, downDepth);
  return { nodeIds, edgeIds };
}

/**
 * Traces a node's lineage with separate upstream and downstream depth caps.
 *
 * @remarks
 * BFS is run per direction; a depth value of `0` for either argument suppresses
 * traversal in that direction entirely.
 *
 * @param graph - The graphology computational graph.
 * @param nodeId - Origin node for the trace.
 * @param upstreamLevels - Maximum hop depth in the inbound direction.
 * @param downstreamLevels - Maximum hop depth in the outbound direction.
 * @returns The set of reachable node ids and the edges connecting them.
 */
export function traceNodeWithLevels(
  graph: Graph,
  nodeId: string,
  upstreamLevels: number,
  downstreamLevels: number
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  if (!graph.hasNode(nodeId)) return { nodeIds: new Set<string>(), edgeIds: new Set<string>() };

  const nodeIds = new Set<string>([nodeId]);
  const upDepth = new Map<string, number>();
  const downDepth = new Map<string, number>();
  if (upstreamLevels > 0) upDepth.set(nodeId, 0);
  if (downstreamLevels > 0) downDepth.set(nodeId, 0);

  if (upstreamLevels > 0) {
    bfsFromNode(graph, nodeId, (node, _attrs, depth) => {
      if (depth > upstreamLevels) return true;
      nodeIds.add(node);
      upDepth.set(node, depth);
    }, { mode: 'inbound' });
  }

  if (downstreamLevels > 0) {
    bfsFromNode(graph, nodeId, (node, _attrs, depth) => {
      if (depth > downstreamLevels) return true;
      nodeIds.add(node);
      downDepth.set(node, depth);
    }, { mode: 'outbound' });
  }

  const edgeIds = collectTraceEdges(graph, nodeIds, upDepth, downDepth);
  return { nodeIds, edgeIds };
}

/**
 * Calculates the shortest directed path between two nodes as node/edge id sets.
 *
 * @remarks
 * Delegates path-finding to the shared {@link findShortestPathOrdered} (bidirectional
 * retry) so the GUI "Find Path" feature has a single source of truth for path lookup.
 *
 * @param graph - The graphology computational graph.
 * @param sourceId - Path start node.
 * @param targetId - Path end node.
 * @returns The set of node and edge ids on the shortest path, or `null` if
 *   either endpoint is unknown or no path exists in either direction.
 */
export function computeShortestPath(
  graph: Graph,
  sourceId: string,
  targetId: string
): { nodeIds: Set<string>; edgeIds: Set<string> } | null {
  const result = findShortestPathOrdered(graph, sourceId, targetId);
  if (!result) return null;

  const { path } = result;
  const nodeIds = new Set(path);
  const edgeIds = new Set<string>();
  for (let i = 0; i < path.length - 1; i++) {
    const edge = graph.edge(path[i], path[i + 1]);
    if (edge) edgeIds.add(edge);
  }
  return { nodeIds, edgeIds };
}

/**
 * Lays out nodes in a uniform grid.
 */
function gridLayout(nodeIds: string[], cols: number = GRID_DEFAULT_COLS): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const cellW = NODE_WIDTH + GRID_CELL_PADDING;
  const cellH = NODE_HEIGHT + GRID_CELL_PADDING;
  nodeIds.forEach((id, i) => {
    positions.set(id, { x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH });
  });
  return positions;
}

/** Emits a `[Trace] <msg>` log line through the webview→host bridge at `warn` level. */
function logTraceWarn(msg: string): void {
  window.vscode?.postMessage({ type: 'log', level: 'warn', text: `[Trace] ${msg}` });
}

/** Trace modes that trigger synthesis of out-of-filter nodes and edges into the visible set. */
function isSynthesizingMode(trace: TraceState, synthesizeOutOfFilter?: boolean): boolean {
  return trace.mode === 'path-applied' || !!synthesizeOutOfFilter;
}

/**
 * Projects the full flow onto the traced node / edge sets.
 *
 * @remarks
 * Handles bidirectional-edge aliasing (`A↔B` matches either `A→B` or `B→A`).
 */
function projectFlowToTrace(
  flowNodes: FlowNode[],
  flowEdges: FlowEdge[],
  trace: TraceState,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes = flowNodes.filter((n) => trace.tracedNodeIds.has(n.id));
  const edges = flowEdges.filter((e) => {
    if (trace.tracedEdgeIds.has(e.id)) return true;
    if (e.id.includes('↔')) {
      const [a, b] = e.id.split('↔');
      return trace.tracedEdgeIds.has(`${a}→${b}`) || trace.tracedEdgeIds.has(`${b}→${a}`);
    }
    return false;
  });
  return { nodes, edges };
}

/**
 * Adds traced nodes / edges that are not in the visible flow back into the scope.
 *
 * @remarks
 * Used for `path-applied` and explicit out-of-filter synthesis. Mutates the passed
 * arrays in place so that subsequent layout and degree recomputation observe the
 * full trace scope.
 */
function synthesizeMissingTraceScope(
  filteredNodes: FlowNode[],
  filteredEdges: FlowEdge[],
  trace: TraceState,
  config: ExtensionConfig,
  model: DatabaseModel,
): void {
  const flowNodeIdSet = new Set(filteredNodes.map((n) => n.id));
  const modelNodeMap = new Map(model.nodes.map((n) => [n.id, n]));
  for (const id of trace.tracedNodeIds) {
    if (flowNodeIdSet.has(id)) continue;
    const mn = modelNodeMap.get(id);
    if (!mn) continue;
    filteredNodes.push({
      id: mn.id,
      type: 'lineageNode',
      position: { x: 0, y: 0 },
      draggable: true,
      selectable: true,
      data: {
        label: mn.name,
        schema: mn.schema,
        fullName: mn.fullName,
        objectType: mn.type,
        inDegree: 0,
        outDegree: 0,
        ...(mn.externalType && { externalType: mn.externalType }),
        ...(mn.externalUrl && { externalUrl: mn.externalUrl }),
        ...(mn.externalDatabase && { externalDatabase: mn.externalDatabase }),
      },
    });
  }

  const existingEdgeIds = new Set(filteredEdges.map((e) => e.id));
  for (const edgeId of trace.tracedEdgeIds) {
    if (existingEdgeIds.has(edgeId)) continue;
    const [src, tgt] = edgeId.split('→');
    if (!src || !tgt) continue;
    if (existingEdgeIds.has(`${src}↔${tgt}`) || existingEdgeIds.has(`${tgt}↔${src}`)) continue;
    filteredEdges.push({
      id: edgeId,
      source: src,
      target: tgt,
      type: config.layout.edgeStyle === 'default' ? undefined : config.layout.edgeStyle,
      style: { stroke: 'var(--ln-edge-color)', strokeWidth: 1.2 },
    });
  }
}

/**
 * Recomputes `inDegree` / `outDegree` for nodes that were synthesized with zero degree.
 *
 * @remarks
 * Only touches nodes whose original degree was 0/0, so nodes carried over from the
 * visible flow retain their full-graph degree.
 */
function recomputeSynthesizedDegrees(filteredNodes: FlowNode[], filteredEdges: FlowEdge[]): void {
  const synthesizedIds = new Set(
    filteredNodes.filter((n) => n.data.inDegree === 0 && n.data.outDegree === 0).map((n) => n.id),
  );
  if (synthesizedIds.size === 0) return;

  const inCount = new Map<string, number>();
  const outCount = new Map<string, number>();
  for (const e of filteredEdges) {
    if (synthesizedIds.has(e.target)) inCount.set(e.target, (inCount.get(e.target) ?? 0) + 1);
    if (synthesizedIds.has(e.source)) outCount.set(e.source, (outCount.get(e.source) ?? 0) + 1);
  }
  for (const n of filteredNodes) {
    if (!synthesizedIds.has(n.id)) continue;
    n.data.inDegree = inCount.get(n.id) ?? 0;
    n.data.outDegree = outCount.get(n.id) ?? 0;
  }
}

/** Picks the trace-scope layout: grid for orphan analysis, Dagre otherwise. */
function layoutTraceFlow(
  filteredNodes: FlowNode[],
  filteredEdges: FlowEdge[],
  trace: TraceState,
  config: ExtensionConfig,
): Map<string, { x: number; y: number }> {
  if (trace.mode === 'analysis' && trace.analysisType === 'orphans') {
    return gridLayout(filteredNodes.map((n) => n.id));
  }
  return dagreLayout({
    nodeIds: filteredNodes.map((n) => n.id),
    edges: filteredEdges.map((e) => ({ source: e.source, target: e.target })),
    config,
  });
}

/**
 * Applies active trace state to the visual graph, filtering and re-layouting as needed.
 *
 * @param flowNodes - Flow nodes to decorate.
 * @param flowEdges - Flow edges to decorate.
 * @param trace - Current trace state to serialize.
 * @param config - Rendering configuration for the trace view.
 * @param model - Database model to inspect.
 * @param synthesizeOutOfFilter - Whether to synthesize hidden out-of-filter nodes.
 *
 * @returns Trace-scoped nodes and edges, plus a graphology graph over the synthesized
 * scope when out-of-filter synthesis ran.
 */
export function applyTraceToFlow(
  flowNodes: FlowNode[],
  flowEdges: FlowEdge[],
  trace: TraceState,
  config: ExtensionConfig = DEFAULT_CONFIG,
  model?: DatabaseModel | null,
  synthesizeOutOfFilter?: boolean
): { nodes: FlowNode[]; edges: FlowEdge[]; graph?: Graph } {
  if (trace.mode === 'none' || trace.mode === 'configuring' || trace.mode === 'pathfinding') {
    return { nodes: flowNodes, edges: flowEdges };
  }
  if (trace.tracedNodeIds.size === 0) {
    logTraceWarn(`applyTraceToFlow: tracedNodeIds empty, mode=${trace.mode}`);
    notifyUser('Trace produced no results.');
    return { nodes: flowNodes, edges: flowEdges };
  }

  const { nodes: filteredNodes, edges: filteredEdges } = projectFlowToTrace(flowNodes, flowEdges, trace);

  if (filteredNodes.length === 0 && flowNodes.length > 0) {
    logTraceWarn(`applyTraceToFlow: 0 match for ${trace.tracedNodeIds.size} ids (mode=${trace.mode})`);
    notifyUser('Traced nodes are not visible in the current view.');
  }

  const synth = isSynthesizingMode(trace, synthesizeOutOfFilter);
  if (synth && model && filteredNodes.length < trace.tracedNodeIds.size) {
    synthesizeMissingTraceScope(filteredNodes, filteredEdges, trace, config, model);
  }
  if (synth && model) {
    recomputeSynthesizedDegrees(filteredNodes, filteredEdges);
  }

  let traceGraph: Graph | undefined;
  if (synth && model) {
    const nodeIdSet = new Set(filteredNodes.map((n) => n.id));
    traceGraph = buildGraphologyGraph({
      ...model,
      nodes: model.nodes.filter((n) => nodeIdSet.has(n.id)),
      edges: model.edges.filter((e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target)),
    });
  }

  const positions = layoutTraceFlow(filteredNodes, filteredEdges, trace, config);

  const nodes = filteredNodes.map((n) => ({
    ...n,
    position: positions.get(n.id) || n.position,
    data: {
      ...n.data,
      highlighted: n.id === trace.selectedNodeId
        ? true
        : n.id === trace.targetNodeId
          ? ('yellow' as const)
          : false,
    },
  }));
  const edges = filteredEdges.map((e) => ({ ...e, style: { ...e.style, strokeWidth: 1.8 } }));

  return { nodes, edges, graph: traceGraph };
}

interface LayoutInput {
  nodeIds: string[];
  edges: Array<{ source: string; target: string }>;
  config: ExtensionConfig;
  ranker?: string;
}

const LAYOUT_CACHE_SIZE = 12;
const layoutCache: Array<{ key: string; positions: Map<string, { x: number; y: number }> }> = [];

function layoutCacheKey(nodeIds: string[], edges: Array<{ source: string; target: string }>, config: ExtensionConfig, ranker?: string): string {
  const sortedNodes = [...nodeIds].sort();
  const sortedEdges = edges.map(e => `${e.source}→${e.target}`).sort();
  return `${config.layout.direction}|${config.layout.rankSeparation}|${config.layout.nodeSeparation}|${ranker ?? ''}|${sortedNodes.join(',')}|${sortedEdges.join(',')}`;
}

/**
 * Computes spatial positions using the Dagre layout engine with LRU caching.
 */
function dagreLayout({ nodeIds, edges, config, ranker }: LayoutInput): Map<string, { x: number; y: number }> {
  const key = layoutCacheKey(nodeIds, edges, config, ranker);
  const cached = layoutCache.find(e => e.key === key);
  if (cached) {
    layoutCache.splice(layoutCache.indexOf(cached), 1);
    layoutCache.unshift(cached);
    return cached.positions;
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: config.layout.direction,
    ranksep: config.layout.rankSeparation,
    nodesep: config.layout.nodeSeparation,
    ...(ranker && { ranker }),
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const id of nodeIds) g.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const { source, target } of edges) g.setEdge(source, target);

  try {
    dagre.layout(g);
  } catch (e) {
    // Dagre coordinate assignment crashes on disconnected graphs with longest-path ranker.
    // Return empty positions; toFlowResult falls back to {x:0,y:0} per-node.
    window.vscode?.postMessage({ type: 'log', level: 'warn', text: `[Graph] Dagre layout failed — ${e instanceof Error ? e.message : String(e)}` });
    return new Map();
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const id of g.nodes()) {
    const n = g.node(id);
    if (n) positions.set(id, { x: n.x - NODE_WIDTH / 2, y: n.y - NODE_HEIGHT / 2 });
  }

  layoutCache.unshift({ key, positions });
  if (layoutCache.length > LAYOUT_CACHE_SIZE) layoutCache.pop();

  return positions;
}

/**
 * Calculates graph metrics for diagnostic purposes.
 *
 * @param graph - Graph instance to traverse.
 *
 * @returns Node and edge totals plus root (in-degree 0) and leaf (out-degree 0) counts.
 */
export function getGraphMetrics(graph: Graph): { totalNodes: number; totalEdges: number; rootNodes: number; leafNodes: number } {
  let rootNodes = 0;
  let leafNodes = 0;

  graph.forEachNode((node) => {
    if (graph.inDegree(node) === 0) rootNodes++;
    if (graph.outDegree(node) === 0) leafNodes++;
  });

  return {
    totalNodes: graph.order,
    totalEdges: graph.size,
    rootNodes,
    leafNodes,
  };
}

/**
 * Selects a canonical direction for a bidirectional edge pair, favoring data flows (transformers → sinks).
 */
function canonicalDirection(graph: Graph, a: string, b: string): [string, string] {
  const aType = graph.getNodeAttributes(a).type;
  const bType = graph.getNodeAttributes(b).type;
  const aIsTransformer = aType === 'procedure' || aType === 'function';
  const bIsTransformer = bType === 'procedure' || bType === 'function';

  if (aIsTransformer && !bIsTransformer) return [a, b];
  if (bIsTransformer && !aIsTransformer) return [b, a];
  return a < b ? [a, b] : [b, a];
}

/**
 * Transforms relational model edges into React Flow edges, handling bidirectionality.
 */
function buildFlowEdges(edges: ReadonlyArray<{ source: string; target: string }>, graph: Graph, config: ExtensionConfig = DEFAULT_CONFIG): FlowEdge[] {
  const valid = edges.filter(
    (e) => graph.hasNode(e.source) && graph.hasNode(e.target)
  );

  const consumed = new Set<string>();
  const result: FlowEdge[] = [];

  for (const edge of valid) {
    const fwd = `${edge.source}→${edge.target}`;
    const rev = `${edge.target}→${edge.source}`;

    if (consumed.has(fwd)) continue;

    if (graph.hasEdge(edge.target, edge.source) && !consumed.has(rev)) {
      const [canonSource, canonTarget] = canonicalDirection(graph, edge.source, edge.target);
      consumed.add(fwd);
      consumed.add(rev);
      result.push({
        id: `${canonSource}↔${canonTarget}`,
        source: canonSource,
        target: canonTarget,
        type: config.layout.edgeStyle === 'default' ? undefined : config.layout.edgeStyle,
        label: '⇄',
        labelStyle: { fontSize: 16, fill: 'var(--ln-edge-color)', fontWeight: 700 },
        labelBgStyle: { fill: 'transparent' },
        labelBgPadding: LABEL_BG_PAD,
        style: {
          stroke: 'var(--ln-edge-color)',
          strokeWidth: 1.2,
        },
        markerEnd: { type: 'arrowclosed' as const, width: 20, height: 20, color: 'var(--ln-edge-color)' },
        markerStart: { type: 'arrow' as const, width: 16, height: 16, color: 'var(--ln-edge-color)' },
      });
    } else {
      consumed.add(fwd);
      result.push({
        id: fwd,
        source: edge.source,
        target: edge.target,
        type: config.layout.edgeStyle === 'default' ? undefined : config.layout.edgeStyle,
        style: {
          stroke: 'var(--ln-edge-color)',
          strokeWidth: 1.2,
        },
        markerEnd: { type: 'arrowclosed' as const, width: 20, height: 20, color: 'var(--ln-edge-color)' },
      });
    }
  }

  return result;
}

/**
 * Calculates visual stroke properties based on schema-to-schema connection count.
 */
function schemaEdgeStroke(count: number): { strokeWidth: number; opacity: number } {
  const t = Math.min(Math.log2(Math.max(count, 1)) / 6, 1);
  return { strokeWidth: 0.8 + t * 2.2, opacity: 0.55 + t * 0.45 };
}

function schemaNamesFromGraph(graph: Graph): string[] {
  const present = new Set<string>();
  graph.forEachNode((id) => {
    const schema = String(graph.getNodeAttribute(id, 'schema') ?? '');
    const type = graph.getNodeAttribute(id, 'type');
    if (schema && type !== 'external') present.add(schema);
  });
  return [...present].sort((a, b) => a.localeCompare(b));
}

/**
 * Builds the working-set schema color map shared by every overview surface.
 */
function buildOverviewColorMap(graph: Graph): SchemaColorMap {
  return createSchemaColorMap(schemaNamesFromGraph(graph));
}

/**
 * Builds the macro-level Schema View graph.
 *
 * @param graph - The current filtered Graphology working graph.
 * @param config - Layout and edge-style settings shared with the other graph views.
 * @returns React Flow nodes and edges for Schema View.
 */
export function buildSchemaGraph(
  graph: Graph,
  config: ExtensionConfig = DEFAULT_CONFIG,
): { nodes: FlowNode<SchemaNodeData>[]; edges: FlowEdge[] } {
  const projection = projectSchemaQuotient(graph);
  const schemaIdSet = new Set(projection.nodes.keys());
  const schemaIds = [...schemaIdSet];
  const schemaColorMap = buildOverviewColorMap(graph);
  const edgesForLayout: Array<{ source: string; target: string }> = [];
  for (const edge of projection.edges) edgesForLayout.push({ source: edge.sourceSchema, target: edge.targetSchema });

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: config.layout.direction,
    ranksep: config.layout.rankSeparation,
    nodesep: config.layout.nodeSeparation,
    marginx: 30,
    marginy: 30,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of schemaIds) g.setNode(id, { width: SCHEMA_NODE_WIDTH, height: SCHEMA_NODE_HEIGHT });
  for (const { source, target } of edgesForLayout) {
    if (g.hasNode(source) && g.hasNode(target)) g.setEdge(source, target);
  }
  try {
    dagre.layout(g);
  } catch (e) {
    // Disconnected schema singletons can trigger the same longest-path crash as regular nodes.
    // Fall through: g.node() returns undefined per node → positions fallback to {x:0,y:0}.
    window.vscode?.postMessage({ type: 'log', level: 'warn', text: `[Graph] Schema layout failed — ${e instanceof Error ? e.message : String(e)}` });
  }

  const nodes: FlowNode<SchemaNodeData>[] = schemaIds.map((schema) => {
    const pos = g.node(schema);
    const meta = projection.nodes.get(schema)!;
    return {
      id: `__schema__${schema}`,
      type: 'schemaNode',
      position: pos
        ? { x: pos.x - SCHEMA_NODE_WIDTH / 2, y: pos.y - SCHEMA_NODE_HEIGHT / 2 }
        : { x: 0, y: 0 },
      draggable: true,
      selectable: true,
      data: {
        schemaName: schema,
        objectCount: meta.objectCount,
        typeBreakdown: meta.typeBreakdown,
        color: getSchemaDisplayColor(schema, schemaColorMap, meta.typeBreakdown),
        isExternalOnly: isExternalOnlyTypeBreakdown(meta.typeBreakdown),
      },
    };
  });

  const edges: FlowEdge[] = [];
  for (const edge of projection.edges) {
    const srcId = `__schema__${edge.sourceSchema}`;
    const tgtId = `__schema__${edge.targetSchema}`;
    if (!schemaIdSet.has(edge.sourceSchema) || !schemaIdSet.has(edge.targetSchema)) continue;

    const { strokeWidth, opacity } = schemaEdgeStroke(edge.totalCount);
    edges.push({
      id: edge.bidirectional
        ? `__schema__${edge.sourceSchema}↔${edge.targetSchema}`
        : `__schema__${edge.sourceSchema}→${edge.targetSchema}`,
      source: srcId,
      target: tgtId,
      type: config.layout.edgeStyle === 'default' ? undefined : config.layout.edgeStyle,
      label: edge.bidirectional ? `⇄ ${edge.totalCount}` : `${edge.count}`,
      labelStyle: { fontSize: 11, fill: 'var(--ln-fg-muted)' },
      labelBgStyle: { fill: 'var(--ln-bg)', opacity: 0.8 },
      labelBgPadding: LABEL_BG_PAD,
      style: { stroke: 'var(--ln-edge-color)', strokeWidth, opacity },
      markerEnd: { type: 'arrowclosed' as const, width: 18, height: 18, color: 'var(--ln-edge-color)' },
      ...(edge.bidirectional && {
        markerStart: { type: 'arrow' as const, width: 14, height: 14, color: 'var(--ln-edge-color)' },
      }),
    });
  }

  return { nodes, edges };
}

/**
 * Computes spatial layout for the object graph.
 *
 * @remarks
 * Nodes with no edges (disconnected singletons — e.g. cross-DB virtual nodes
 * whose only counterpart is outside the current schema filter) are positioned
 * in a row below the main Dagre layout instead of being passed to Dagre.
 * Dagre's longest-path ranker crashes on fully disconnected components.
 */
function computeLayout(graph: Graph, config: ExtensionConfig = DEFAULT_CONFIG): Map<string, { x: number; y: number }> {
  const seen = new Set<string>();
  const edges: Array<{ source: string; target: string }> = [];

  graph.forEachEdge((_edge, _attrs, source, target) => {
    if (graph.hasEdge(target, source)) {
      const [s, t] = canonicalDirection(graph, source, target);
      const key = `${s}→${t}`;
      if (!seen.has(key)) { seen.add(key); edges.push({ source: s, target: t }); }
    } else {
      edges.push({ source, target });
    }
  });

  // Separate nodes that participate in at least one edge from disconnected singletons.
  const connectedIds = new Set<string>();
  for (const { source, target } of edges) { connectedIds.add(source); connectedIds.add(target); }
  const allIds = graph.nodes();
  const isolatedIds = allIds.filter(id => !connectedIds.has(id));
  const layoutIds  = allIds.filter(id =>  connectedIds.has(id));

  const positions = dagreLayout({ nodeIds: layoutIds, edges, config, ranker: 'longest-path' });

  // Place isolated nodes in a row below the main layout.
  if (isolatedIds.length > 0) {
    let maxY = 0;
    for (const pos of positions.values()) {
      if (pos.y + NODE_HEIGHT > maxY) maxY = pos.y + NODE_HEIGHT;
    }
    const rowY = maxY > 0 ? maxY + GRID_CELL_PADDING * 2 : 0;
    const cellW = NODE_WIDTH + GRID_CELL_PADDING;
    isolatedIds.forEach((id, i) => positions.set(id, { x: i * cellW, y: rowY }));
  }

  return positions;
}

/** Prefix for an expanded-schema-view schema-cluster node id. */
const EXPANDED_SCHEMA_VIEW_CLUSTER_PREFIX = '__expandedschemaviewcluster__';

type LayoutEdge = { source: string; target: string };

function expandedSchemaViewClusterId(schema: string): string {
  return `${EXPANDED_SCHEMA_VIEW_CLUSTER_PREFIX}${schema}`;
}

function toBridgeLayoutEdge(bridge: SchemaBridgeEdge): LayoutEdge {
  return bridge.dir === 'down'
    ? { source: bridge.nearId, target: expandedSchemaViewClusterId(bridge.schema) }
    : { source: expandedSchemaViewClusterId(bridge.schema), target: bridge.nearId };
}

function collectConnectedIds(edges: readonly LayoutEdge[]): Set<string> {
  const connectedIds = new Set<string>();
  for (const edge of edges) {
    connectedIds.add(edge.source);
    connectedIds.add(edge.target);
  }
  return connectedIds;
}

function buildExpandedSchemaViewPositions(
  individualIds: readonly string[],
  clusterSchemas: readonly string[],
  individualEdges: readonly LayoutEdge[],
  bridges: ReadonlyMap<string, SchemaBridgeEdge>,
  schemaClusterEdges: readonly SchemaProjectionEdge[],
  config: ExtensionConfig,
): Map<string, { x: number; y: number }> {
  const clusterNodeIds = clusterSchemas.map(expandedSchemaViewClusterId);
  const bridgeLayoutEdges = [...bridges.values()].map(toBridgeLayoutEdge);
  const schemaClusterLayoutEdges = schemaClusterEdges.map((edge) => ({
    source: expandedSchemaViewClusterId(edge.sourceSchema),
    target: expandedSchemaViewClusterId(edge.targetSchema),
  }));

  const layoutEdges = [...individualEdges, ...bridgeLayoutEdges, ...schemaClusterLayoutEdges];
  const connectedIds = collectConnectedIds(layoutEdges);
  const candidateIds = [...individualIds, ...clusterNodeIds];
  const positions = dagreLayout({
    nodeIds: candidateIds.filter((id) => connectedIds.has(id)),
    edges: layoutEdges,
    config,
  });

  const isolatedIds = candidateIds.filter((id) => !connectedIds.has(id));
  if (isolatedIds.length === 0) return positions;

  let maxY = 0;
  for (const position of positions.values()) {
    if (position.y + NODE_HEIGHT > maxY) maxY = position.y + NODE_HEIGHT;
  }

  const rowY = maxY > 0 ? maxY + GRID_CELL_PADDING * 2 : 0;
  const cellW = NODE_WIDTH + GRID_CELL_PADDING;
  isolatedIds.forEach((id, index) => positions.set(id, { x: index * cellW, y: rowY }));
  return positions;
}

function buildExpandedSchemaViewFlowNodes(
  individualIds: readonly string[],
  clusterMeta: ReadonlyMap<string, SchemaProjectionNode>,
  positions: ReadonlyMap<string, { x: number; y: number }>,
  graph: Graph,
  colorMap: SchemaColorMap,
  focusId: string | null,
  hideClusters = false,
): FlowNode[] {
  const flowNodes: FlowNode[] = [];

  for (const id of individualIds) {
    if (!graph.hasNode(id)) continue;
    const n = graph.getNodeAttributes(id) as {
      id?: string;
      name?: string;
      schema?: string;
      fullName?: string;
      type?: ObjectType;
      externalType?: string;
      externalUrl?: string;
      externalDatabase?: string;
    };
    const source: LineageFlowNodeSource = {
      id: String(n.id ?? id),
      label: String(n.name ?? id),
      schema: String(n.schema ?? ''),
      fullName: String(n.fullName ?? id),
      objectType: n.type ?? 'table',
      externalType: n.externalType,
      externalUrl: n.externalUrl,
      externalDatabase: n.externalDatabase,
    };
    flowNodes.push(buildLineageFlowNode(
      source,
      graph,
      positions.get(id) ?? { x: 0, y: 0 },
      {
        highlighted: id === focusId,
        schemaColor: source.objectType === 'external' ? getExternalNodeColor() : getSchemaColorFromMap(source.schema, colorMap),
      },
    ));
  }

  for (const [schema, meta] of clusterMeta) {
    flowNodes.push({
      id: expandedSchemaViewClusterId(schema),
      type: 'schemaNode',
      position: positions.get(expandedSchemaViewClusterId(schema)) ?? { x: 0, y: 0 },
      draggable: true,
      selectable: true,
      ...(hideClusters && { hidden: true }),
      data: {
        schemaName: schema,
        objectCount: meta.objectCount,
        typeBreakdown: meta.typeBreakdown,
        color: getSchemaDisplayColor(schema, colorMap, meta.typeBreakdown),
        isExternalOnly: isExternalOnlyTypeBreakdown(meta.typeBreakdown),
        isExpandedSchemaViewCluster: true,
      } satisfies SchemaNodeData,
    });
  }

  return flowNodes;
}

function buildMixedBridgeEdges(bridges: Iterable<SchemaBridgeEdge>): FlowEdge[] {
  return [...bridges].map((bridge) => {
    const cluster = expandedSchemaViewClusterId(bridge.schema);
    const [source, target] = bridge.dir === 'down' ? [bridge.nearId, cluster] : [cluster, bridge.nearId];
    return {
      id: `__bridge__${source}→${target}`,
      source,
      target,
      label: `${bridge.count}`,
      labelStyle: { fontSize: 11, fill: 'var(--ln-fg-muted)' },
      labelBgStyle: { fill: 'var(--ln-bg)', opacity: 0.8 },
      labelBgPadding: LABEL_BG_PAD,
      style: { stroke: 'var(--ln-edge-color)', strokeWidth: 1.0, strokeDasharray: '4 3', opacity: 0.5 },
      markerEnd: { type: 'arrowclosed' as const, width: 18, height: 18, color: 'var(--ln-edge-color)' },
    };
  });
}

function buildMixedClusterEdges(
  schemaClusterEdges: readonly SchemaProjectionEdge[],
): FlowEdge[] {
  return schemaClusterEdges.map((edge) => {
    const source = expandedSchemaViewClusterId(edge.sourceSchema);
    const target = expandedSchemaViewClusterId(edge.targetSchema);
    const { strokeWidth, opacity } = schemaEdgeStroke(edge.totalCount);
    return {
      id: edge.bidirectional ? `__clusteredge__${edge.sourceSchema}↔${edge.targetSchema}` : `__clusteredge__${edge.sourceSchema}→${edge.targetSchema}`,
      source,
      target,
      label: edge.bidirectional ? `⇄ ${edge.totalCount}` : `${edge.count}`,
      labelStyle: { fontSize: 11, fill: 'var(--ln-fg-muted)' },
      labelBgStyle: { fill: 'var(--ln-bg)', opacity: 0.8 },
      labelBgPadding: LABEL_BG_PAD,
      style: { stroke: 'var(--ln-edge-color)', strokeWidth, strokeDasharray: '4 3', opacity },
      markerEnd: { type: 'arrowclosed' as const, width: 18, height: 18, color: 'var(--ln-edge-color)' },
      ...(edge.bidirectional && {
        markerStart: { type: 'arrow' as const, width: 14, height: 14, color: 'var(--ln-edge-color)' },
      }),
    };
  });
}

function buildExpandedSchemaViewFlowEdges(
  graph: Graph,
  individualEdges: readonly LayoutEdge[],
  bridges: ReadonlyMap<string, SchemaBridgeEdge>,
  schemaClusterEdges: readonly SchemaProjectionEdge[],
  config: ExtensionConfig,
  hideClusters = false,
): FlowEdge[] {
  return [
    ...buildFlowEdges(individualEdges, graph, config),
    ...buildMixedBridgeEdges(bridges.values()).map(e => hideClusters ? { ...e, hidden: true } : e),
    ...buildMixedClusterEdges(schemaClusterEdges).map(e => hideClusters ? { ...e, hidden: true } : e),
  ];
}

/**
 * Builds the expanded schema view flow graph.
 *
 * @remarks
 * Objects whose schema is in `expandedSchemas` are shown in full (individual); every remaining
 * schema is collapsed into one schema-cluster node (the regular schema-view node, flagged
 * `isExpandedSchemaViewCluster`), joined
 * to the individual nodes or other schema clusters by aggregated bridge edges.
 * One dagre pass positions the connected core;
 * isolated individual nodes and unconnected clusters drop into a peripheral row (same as
 * {@link computeLayout}). The filter is never consulted — the caller passes the already-filtered
 * working-set graph.
 *
 * @param graph - The filtered working-set graphology graph.
 * @param expandedSchemas - Schemas shown as individual objects; all others collapse per schema.
 * @param focusId - The node opened in expanded schema view (for highlight + centering); `null` when entered via a
 *   schema double-click, in which case no node is highlighted.
 * @param config - Extension configuration (layout).
 * @param options - Render-only options such as hiding collapsed schema clusters without changing filters.
 * @returns React Flow nodes (individual + schema-cluster nodes) and edges (real + bridge).
 */
export function buildExpandedSchemaViewGraph(
  graph: Graph,
  expandedSchemas: ReadonlySet<string>,
  focusId: string | null,
  config: ExtensionConfig = DEFAULT_CONFIG,
  options: ExpandedSchemaViewRenderOptions = {},
): { flowNodes: FlowNode[]; flowEdges: FlowEdge[] } {
  // Always include clusters so Dagre receives the same node set regardless of visibility —
  // cache key stays stable → positions don't shift when the hide toggle fires.
  const projection = projectExpandedSchemaView(graph, expandedSchemas,
    { ...options, includeCollapsedSchemaClusters: true });
  const hideClusters = options.hideClusters ?? false;
  const colorMap = buildOverviewColorMap(graph);
  const individualIds = [...projection.individual];
  const positions = buildExpandedSchemaViewPositions(
    individualIds,
    [...projection.collapsedSchemas.keys()],
    projection.individualEdges,
    projection.bridges,
    projection.schemaClusterEdges,
    config,
  );

  return {
    flowNodes: buildExpandedSchemaViewFlowNodes(individualIds, projection.collapsedSchemas, positions, graph, colorMap, focusId, hideClusters),
    flowEdges: buildExpandedSchemaViewFlowEdges(graph, projection.individualEdges, projection.bridges, projection.schemaClusterEdges, config, hideClusters),
  };
}
