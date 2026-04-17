import Graph from 'graphology';
import { bfsFromNode } from 'graphology-traversal';
import { bidirectional } from 'graphology-shortest-path';
import dagre from '@dagrejs/dagre';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import { DatabaseModel, TraceState, ExtensionConfig, DEFAULT_CONFIG, SchemaNodeData } from './types';
import { getSchemaColor } from '../utils/schemaColors';
import { notifyUser } from '../utils/notify';

/**
 * Width of a standard graph node in pixels.
 */
export const NODE_WIDTH = 220;

/**
 * Height of a standard graph node in pixels.
 */
export const NODE_HEIGHT = 80;

/**
 * Width of a schema-level node in pixels.
 */
export const SCHEMA_NODE_WIDTH = 200;

/**
 * Height of a schema-level node in pixels.
 */
export const SCHEMA_NODE_HEIGHT = 80;

/**
 * Typed tuple for React Flow edge label background padding.
 */
const LABEL_BG_PAD: [number, number] = [4, 4];

/**
 * Default column count for grid-based analysis layouts.
 */
const GRID_DEFAULT_COLS = 4;

/**
 * Padding between nodes in grid layout (px).
 */
const GRID_CELL_PADDING = 40;

/**
 * Collects edges between traced nodes with direction-aware filtering.
 * When only one direction is active (the other is 0), edges are filtered
 * to only show data flow in the requested direction using BFS depth:
 *   - Upstream only: include edge A→B if A.upDepth >= B.upDepth (toward origin)
 *   - Downstream only: include edge A→B if B.downDepth >= A.downDepth (away from origin)
 * When both directions are active, ALL edges between traced nodes are shown.
 * Uses >= (not >) to include same-depth cross-edges.
 *
 * @param graph - The underlying computational graph instance.
 * @param nodeIds - Set of node identifiers within the trace scope.
 * @param upDepth - Mapping of node identifiers to their upstream depth relative to the origin.
 * @param downDepth - Mapping of node identifiers to their downstream depth relative to the origin.
 * @returns A set of edge identifiers that conform to the tracing directionality.
 */
function collectTraceEdges(
  graph: Graph,
  nodeIds: Set<string>,
  upDepth: Map<string, number>,
  downDepth: Map<string, number>
): Set<string> {
  const edgeIds = new Set<string>();
  const hasUp = upDepth.size > 1;   // more than just origin
  const hasDown = downDepth.size > 1;

  graph.forEachEdge((edge, _attrs, source, target) => {
    if (!nodeIds.has(source) || !nodeIds.has(target)) return;

    if (hasUp && hasDown) {
      // Both directions active: show all edges between traced nodes
      edgeIds.add(edge);
      return;
    }

    if (hasUp) {
      // Upstream only: edge flows toward origin when source is further from origin
      const sD = upDepth.get(source);
      const tD = upDepth.get(target);
      if (sD !== undefined && tD !== undefined && sD >= tD) {
        edgeIds.add(edge);
      }
      return;
    }

    if (hasDown) {
      // Downstream only: edge flows away from origin when target is further
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
 * Represents the structured result of graph compilation, including React Flow
 * compatibility arrays and the underlying computational graph instance.
 */
export interface GraphResult {
  /** Array of nodes formatted for React Flow rendering. */
  flowNodes: FlowNode[];
  /** Array of edges formatted for React Flow rendering. */
  flowEdges: FlowEdge[];
  /** The underlying graphology computational graph instance. */
  graph: Graph;
}

/**
 * Builds a directed graphology computational graph from a database model.
 * Instantiates nodes and edges, ensuring structural integrity and deduplication.
 *
 * @param model - The database model containing structural node and edge definitions.
 * @returns A directed `Graph` instance populated with the model's structural data.
 */
export function buildGraphologyGraph(model: DatabaseModel): Graph {
  const graph = new Graph({ type: 'directed', multi: false });
  for (const node of model.nodes) {
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
 * Converts a unified model, graphology graph, and spatial coordinates into React Flow arrays.
 *
 * @param model - The relational database model.
 * @param graph - The computational graph instance.
 * @param positions - Spatial layout positioning mapped by node ID.
 * @param config - The extension configuration governing styling choices.
 * @returns A comprehensive `GraphResult` ready for renderer consumption.
 */
function toFlowResult(
  model: DatabaseModel,
  graph: Graph,
  positions: Map<string, { x: number; y: number }>,
  config: ExtensionConfig
): GraphResult {
  const flowNodes: FlowNode[] = model.nodes.map((node) => ({
    id: node.id,
    type: 'lineageNode',
    position: positions.get(node.id) || { x: 0, y: 0 },
    draggable: true,
    selectable: true,
    data: {
      label: node.name,
      schema: node.schema,
      fullName: node.fullName,
      objectType: node.type,
      inDegree: graph.hasNode(node.id) ? graph.inDegree(node.id) : 0,
      outDegree: graph.hasNode(node.id) ? graph.outDegree(node.id) : 0,
      ...(node.externalType && { externalType: node.externalType }),
      ...(node.externalUrl && { externalUrl: node.externalUrl }),
      ...(node.externalDatabase && { externalDatabase: node.externalDatabase }),
    },
  }));
  const flowEdges: FlowEdge[] = buildFlowEdges(model, graph, config);
  return { flowNodes, flowEdges, graph };
}

/**
 * Compiles a database model into a React Flow compatible graph layout.
 * Generates spatial positions using Dagre and prepares renderable nodes and edges.
 *
 * @param model - The relational database model to visualize.
 * @param config - Extension configuration providing layout parameters. Defaults to `DEFAULT_CONFIG`.
 * @returns A complete `GraphResult` encompassing both rendering arrays and computational state.
 */
export function buildGraph(model: DatabaseModel, config: ExtensionConfig = DEFAULT_CONFIG): GraphResult {
  const graph = buildGraphologyGraph(model);
  const positions = computeLayout(graph, config);
  return toFlowResult(model, graph, positions, config);
}

/**
 * Compiles a database model into a React Flow graph without executing spatial positioning algorithms.
 * Optimizes performance for extensive graphs that exceed threshold constraints.
 *
 * @param model - The relational database model.
 * @param config - Extension configuration parameters. Defaults to `DEFAULT_CONFIG`.
 * @returns A `GraphResult` maintaining structural data with default zeroed coordinates.
 */
export function buildGraphNoLayout(model: DatabaseModel, config: ExtensionConfig = DEFAULT_CONFIG): GraphResult {
  const graph = buildGraphologyGraph(model);
  return toFlowResult(model, graph, new Map(), config);
}

/**
 * Performs a comprehensive Breadth-First Search (BFS) traversal to map dependencies
 * outward from a central origin across targeted structural dimensions.
 *
 * @param graph - The underlying graphology instance.
 * @param nodeId - The node identifier forming the traversal origin.
 * @param mode - Directions to trace: `'upstream'`, `'downstream'`, or `'both'`.
 * @returns Resolved sets indicating traversed node identifiers and correlating edge flow identifiers.
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
 * Traces a computational graph while strictly enforcing designated algorithmic hop limitations.
 * Incorporates specific branch halting via callback returns based on upstream and downstream bounds.
 *
 * @param graph - The directed graphology computational graph.
 * @param nodeId - The origin node identifier.
 * @param upstreamLevels - Maximum permitted inbound traversal depth.
 * @param downstreamLevels - Maximum permitted outbound traversal depth.
 * @returns Constrained sets of connected node and corresponding edge identifiers.
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
      if (depth > upstreamLevels) return true; // stop exploring
      nodeIds.add(node);
      upDepth.set(node, depth);
    }, { mode: 'inbound' });
  }

  if (downstreamLevels > 0) {
    bfsFromNode(graph, nodeId, (node, _attrs, depth) => {
      if (depth > downstreamLevels) return true; // stop exploring
      nodeIds.add(node);
      downDepth.set(node, depth);
    }, { mode: 'outbound' });
  }

  const edgeIds = collectTraceEdges(graph, nodeIds, upDepth, downDepth);
  return { nodeIds, edgeIds };
}

/**
 * Identifies the shortest topological directed path coupling a source and a target node.
 * Evaluates source-to-target routing first, resorting to target-to-source if disconnected.
 *
 * @param graph - The directed computational graph.
 * @param sourceId - Starting node identifier.
 * @param targetId - Goal node identifier.
 * @returns Evaluated collections of intermediary nodes and edge identifiers defining the path, or null if unreachable.
 */
export function computeShortestPath(
  graph: Graph,
  sourceId: string,
  targetId: string
): { nodeIds: Set<string>; edgeIds: Set<string> } | null {
  if (!graph.hasNode(sourceId) || !graph.hasNode(targetId)) return null;

  let path = bidirectional(graph, sourceId, targetId);
  if (!path) {
    path = bidirectional(graph, targetId, sourceId);
  }
  if (!path) return null;

  const nodeIds = new Set(path);
  const edgeIds = new Set<string>();
  for (let i = 0; i < path.length - 1; i++) {
    const edge = graph.edge(path[i], path[i + 1]);
    if (edge) edgeIds.add(edge);
  }
  return { nodeIds, edgeIds };
}

/**
 * Constructs mapping coordinates using a uniform grid distribution.
 *
 * @param nodeIds - Array of identifier keys to place within the grid.
 * @param cols - Maximum column width before wrapping row logic. Defaults to `GRID_DEFAULT_COLS`.
 * @returns Spatial coordinate mapping correlating nodes to `x`/`y` planes.
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

/**
 * Projects a constrained trace state across a broader React Flow canvas element matrix.
 * Modifies node highlights, filters untraced components, synthesizes graph gaps conditionally,
 * and enacts secondary layout computations based on the resolved subgraph topology.
 *
 * @param flowNodes - Primary array of visual graph nodes.
 * @param flowEdges - Primary array of visual graph edges.
 * @param trace - The tracing context metadata detailing active search parameters and matches.
 * @param config - Extension context preferences and visual settings. Defaults to `DEFAULT_CONFIG`.
 * @param model - Original underlying structural database model mapping.
 * @param synthesizeOutOfFilter - Flag allowing reconstruction of elements filtered out of view but active within trace logic.
 * @returns The dynamically updated nodes and edges, complemented potentially by a standalone trace subgraph.
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
    const msg = `[Trace] applyTraceToFlow: tracedNodeIds empty, mode=${trace.mode} — returning unchanged`;
    window.vscode?.postMessage({ type: 'log', level: 'warn', text: msg });
    notifyUser('Trace produced no results. The traced nodes may have been removed or filtered out.');
    return { nodes: flowNodes, edges: flowEdges };
  }

  // FILTER nodes to only show traced subset
  const filteredNodes = flowNodes.filter((n) => trace.tracedNodeIds.has(n.id));

  if (filteredNodes.length === 0 && flowNodes.length > 0) {
    const msg = `[Trace] applyTraceToFlow: 0 of ${flowNodes.length} flowNodes matched ${trace.tracedNodeIds.size} tracedNodeIds (mode=${trace.mode})`;
    window.vscode?.postMessage({ type: 'log', level: 'warn', text: msg });
    notifyUser('Traced nodes are not visible in the current view. Adjust your schema or type filters to include them.');
  }

  // Synthesize FlowNodes for path/unfiltered-trace nodes outside the current filter
  if (filteredNodes.length < trace.tracedNodeIds.size && (trace.mode === 'path-applied' || synthesizeOutOfFilter) && model) {
    const flowNodeIdSet = new Set(filteredNodes.map(n => n.id));
    const modelNodeMap = new Map(model.nodes.map(n => [n.id, n]));
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
  } else if (filteredNodes.length < trace.tracedNodeIds.size) {
    const flowNodeIdSet = new Set(flowNodes.map(n => n.id));
    const missing = [...trace.tracedNodeIds].filter(id => !flowNodeIdSet.has(id));
    if (missing.length > 0) {
      window.vscode?.postMessage({ type: 'log', text:
        `[Trace] Gap: BFS found ${trace.tracedNodeIds.size}, view has ${filteredNodes.length}. ` +
        `Missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}`
      });
    }
  }

  // FILTER edges to only show traced subset
  const filteredEdges = flowEdges.filter((e) => {
    // Check if edge is in traced set
    let traced = trace.tracedEdgeIds.has(e.id);
    // Bidirectional edges use ↔ ID; check both directions
    if (!traced && e.id.includes('↔')) {
      const [a, b] = e.id.split('↔');
      traced = trace.tracedEdgeIds.has(`${a}→${b}`) || trace.tracedEdgeIds.has(`${b}→${a}`);
    }
    return traced;
  });

  // Synthesize FlowEdges for path/unfiltered-trace edges outside the current filter
  if ((trace.mode === 'path-applied' || synthesizeOutOfFilter) && model) {
    const existingEdgeIds = new Set(filteredEdges.map(e => e.id));
    for (const edgeId of trace.tracedEdgeIds) {
      if (existingEdgeIds.has(edgeId)) continue;
      const [src, tgt] = edgeId.split('→');
      if (!src || !tgt) continue;
      const bidir = `${src}↔${tgt}`;
      const bidirRev = `${tgt}↔${src}`;
      if (existingEdgeIds.has(bidir) || existingEdgeIds.has(bidirRev)) continue;
      filteredEdges.push({
        id: edgeId,
        source: src,
        target: tgt,
        type: config.layout.edgeStyle === 'default' ? undefined : config.layout.edgeStyle,
        style: { stroke: 'var(--ln-edge-color)', strokeWidth: 1.2 },
      });
    }
  }

  // Recalculate in/out degree for synthesized nodes from the final edge set
  if ((trace.mode === 'path-applied' || synthesizeOutOfFilter) && model) {
    const synthesizedIds = new Set(
      filteredNodes.filter(n => n.data.inDegree === 0 && n.data.outDegree === 0).map(n => n.id)
    );
    if (synthesizedIds.size > 0) {
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
  }

  // Build graphology graph for the traced subgraph when synthesis added out-of-filter nodes.
  // Reuses buildGraphologyGraph to honor the same attribute/edge contract as buildGraph().
  let traceGraph: Graph | undefined;
  if ((trace.mode === 'path-applied' || synthesizeOutOfFilter) && model) {
    const nodeIdSet = new Set(filteredNodes.map(n => n.id));
    const traceModel: DatabaseModel = {
      ...model,
      nodes: model.nodes.filter(n => nodeIdSet.has(n.id)),
      edges: model.edges.filter(e => nodeIdSet.has(e.source) && nodeIdSet.has(e.target)),
    };
    traceGraph = buildGraphologyGraph(traceModel);
  }

  // RELAYOUT the traced subset — dispatch layout by analysis type
  let positions: Map<string, { x: number; y: number }>;
  if (trace.mode === 'analysis' && trace.analysisType === 'orphans') {
    positions = gridLayout(filteredNodes.map(n => n.id));
  } else {
    positions = dagreLayout({
      nodeIds: filteredNodes.map(n => n.id),
      edges: filteredEdges.map(e => ({ source: e.source, target: e.target })),
      config,
    });
  }

  const nodes = filteredNodes.map((n) => ({
    ...n,
    position: positions.get(n.id) || n.position,
    data: {
      ...n.data,
      highlighted: n.id === trace.selectedNodeId
        ? true
        : n.id === trace.targetNodeId
          ? 'yellow' as const
          : false,
    },
  }));

  const edges = filteredEdges.map((e) => ({
    ...e,
    style: {
      ...e.style,
      strokeWidth: 1.8,
    },
  }));

  return { nodes, edges, graph: traceGraph };
}

/**
 * Structural bounds interface for layout algorithms traversing partial node clusters.
 */
interface LayoutInput {
  nodeIds: string[];
  edges: Array<{ source: string; target: string }>;
  config: ExtensionConfig;
  ranker?: string;
}

// LRU layout cache — avoids recomputing dagre for identical node/edge/config sets
const LAYOUT_CACHE_SIZE = 12;
const layoutCache: Array<{ key: string; positions: Map<string, { x: number; y: number }> }> = [];

/**
 * Derives an LRU caching identifier based upon the topology and spatial bounds of the network.
 *
 * @param nodeIds - Correlating identifier strings.
 * @param edges - Linking directional mappings.
 * @param config - Instantiated style configurations affecting layout geometry.
 * @param ranker - Optional network ranking parameter influencing algorithm weighting.
 * @returns Deterministic cache identifier hash key.
 */
function layoutCacheKey(nodeIds: string[], edges: Array<{ source: string; target: string }>, config: ExtensionConfig, ranker?: string): string {
  const sortedNodes = [...nodeIds].sort();
  const sortedEdges = edges.map(e => `${e.source}→${e.target}`).sort();
  return `${config.layout.direction}|${config.layout.rankSeparation}|${config.layout.nodeSeparation}|${ranker ?? ''}|${sortedNodes.join(',')}|${sortedEdges.join(',')}`;
}

/**
 * Executes core Dagre ranking layout computations, assigning x and y coordinates 
 * resolving directional interdependencies against topological complexity.
 * Utilizes deterministic LRU caching to reduce redundant re-evaluations.
 *
 * @param layoutInput - Structured wrapper specifying constraints alongside ranker flags.
 * @returns Evaluated positional Map tying identifiers to computed vector coordinates.
 */
function dagreLayout({ nodeIds, edges, config, ranker }: LayoutInput): Map<string, { x: number; y: number }> {
  const key = layoutCacheKey(nodeIds, edges, config, ranker);
  const cached = layoutCache.find(e => e.key === key);
  if (cached) {
    // Move to front (most recently used)
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

  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const id of g.nodes()) {
    const n = g.node(id);
    if (n) positions.set(id, { x: n.x - NODE_WIDTH / 2, y: n.y - NODE_HEIGHT / 2 });
  }

  // Store in cache (evict oldest if full)
  layoutCache.unshift({ key, positions });
  if (layoutCache.length > LAYOUT_CACHE_SIZE) layoutCache.pop();

  return positions;
}

/**
 * Evaluates core compositional structure counts regarding instantiated structural elements.
 * Calculates graph scale statistics measuring bounds logic points.
 *
 * @param graph - Focused computational topology.
 * @returns Structured payload enumerating scale constraints including total nodes, edges, root nodes, and leaf nodes.
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
 * Canonicalizes directional relationships evaluating logical write operations.
 * Defaults toward procedural or functional objects sourcing into table or view equivalents.
 * Reverts toward alphabetic prioritization fallback protocols.
 *
 * @param graph - Graphology mapping establishing typed relationships.
 * @param a - First boundary key limit.
 * @param b - Second boundary key limit.
 * @returns Ordered tuple projecting preferred canonical dependency.
 */
function canonicalDirection(graph: Graph, a: string, b: string): [string, string] {
  const aType = graph.getNodeAttributes(a).type;
  const bType = graph.getNodeAttributes(b).type;
  const aIsTransformer = aType === 'procedure' || aType === 'function';
  const bIsTransformer = bType === 'procedure' || bType === 'function';

  if (aIsTransformer && !bIsTransformer) return [a, b]; // a (proc) → b (table)
  if (bIsTransformer && !aIsTransformer) return [b, a]; // b (proc) → a (table)
  return a < b ? [a, b] : [b, a];                       // fallback: alphabetical
}

/**
 * Formats relational models into renderable edge pathways.
 * Distinguishes bidirectional logic merging loops toward canonical structures.
 *
 * @param model - Structural mappings containing base edges.
 * @param graph - Linked topology indicating active bounds logic relationships.
 * @param config - Visual parameters assigning edge stroke patterns. Defaults to `DEFAULT_CONFIG`.
 * @returns Iterated array elements formatted explicitly for graph flow structures.
 */
function buildFlowEdges(model: DatabaseModel, graph: Graph, config: ExtensionConfig = DEFAULT_CONFIG): FlowEdge[] {
  const valid = model.edges.filter(
    (e) => graph.hasNode(e.source) && graph.hasNode(e.target)
  );

  // Detect bidirectional pairs using graphology's hasEdge
  const consumed = new Set<string>();
  const result: FlowEdge[] = [];

  for (const edge of valid) {
    const fwd = `${edge.source}→${edge.target}`;
    const rev = `${edge.target}→${edge.source}`;

    if (consumed.has(fwd)) continue;

    if (graph.hasEdge(edge.target, edge.source) && !consumed.has(rev)) {
      // Bidirectional — single edge with markers on both ends
      // Use write direction (proc→table) so layout places target on output side
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
      // Unidirectional
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
 * Aggregates object-level edges to schema-level edge occurrences spanning relational systems.
 * Consolidates bidirectionality mapping procedural logic explicitly weighting structures.
 *
 * @param model - Ground structure containing object linkages.
 * @param visibleSchemas - Filter bounds distinguishing targeted structures.
 * @returns Matrix enumerating canonical flow mapping weights mapped sequentially.
 */
export function buildSchemaEdges(
  model: DatabaseModel,
  visibleSchemas: Set<string>
): Map<string, Map<string, number>> {
  // First pass: count raw directed schema→schema edge occurrences
  const raw = new Map<string, Map<string, number>>();
  const nodeSchemaMap = new Map<string, string>();
  const nodeTypeMap = new Map<string, string>();
  for (const n of model.nodes) {
    nodeSchemaMap.set(n.id, n.schema);
    nodeTypeMap.set(n.id, n.type);
  }

  for (const e of model.edges) {
    const srcSchema = nodeSchemaMap.get(e.source);
    const tgtSchema = nodeSchemaMap.get(e.target);
    if (!srcSchema || !tgtSchema) continue;
    if (!visibleSchemas.has(srcSchema) && !visibleSchemas.has(tgtSchema)) continue;
    if (srcSchema === tgtSchema) continue; // same-schema edges not shown in overview

    if (!raw.has(srcSchema)) raw.set(srcSchema, new Map());
    raw.get(srcSchema)!.set(tgtSchema, (raw.get(srcSchema)!.get(tgtSchema) ?? 0) + 1);
  }

  // Pre-compute which schemas contain procedures/functions (for canonical direction selection)
  const schemaProcSet = new Set<string>();
  for (const n of model.nodes) {
    if (n.type === 'procedure' || n.type === 'function') schemaProcSet.add(n.schema);
  }

  // Second pass: merge bidirectional pairs into canonical direction
  const result = new Map<string, Map<string, number>>();
  const consumed = new Set<string>();

  for (const [src, targets] of raw) {
    for (const [tgt, count] of targets) {
      const key = `${src}→${tgt}`;
      if (consumed.has(key)) continue;

      const revCount = raw.get(tgt)?.get(src) ?? 0;
      if (revCount > 0) {
        // Bidirectional — pick canonical direction: procedure/function schema on source side
        const srcHasProc = schemaProcSet.has(src);
        const tgtHasProc = schemaProcSet.has(tgt);
        let canonSrc = src;
        let canonTgt = tgt;
        if (tgtHasProc && !srcHasProc) { canonSrc = tgt; canonTgt = src; }
        else if (!srcHasProc && !tgtHasProc && src > tgt) { canonSrc = tgt; canonTgt = src; }

        consumed.add(key);
        consumed.add(`${tgt}→${src}`);
        if (!result.has(canonSrc)) result.set(canonSrc, new Map());
        result.get(canonSrc)!.set(canonTgt, count + revCount);
      } else {
        consumed.add(key);
        if (!result.has(src)) result.set(src, new Map());
        result.get(src)!.set(tgt, count);
      }
    }
  }

  return result;
}

/**
 * Dynamically computes mathematical logarithmic scale strokes corresponding
 * visually against overarching complexity mapped paths.
 *
 * @param count - Integer frequency sum marking flow weight boundaries.
 * @returns Correlating render dimensions adjusting width mapping structures alongside bounds opacity.
 */
function schemaEdgeStroke(count: number): { strokeWidth: number; opacity: number } {
  const t = Math.min(Math.log2(Math.max(count, 1)) / 6, 1);
  return { strokeWidth: 0.8 + t * 2.2, opacity: 0.55 + t * 0.45 };
}

/**
 * Analyzes relational structures determining React Flow macro architecture nodes alongside consolidated paths.
 * Establishes spacing logic optimizing broader conceptual overviews.
 *
 * @param model - Active bounds network limiting system links.
 * @param visibleSchemas - Filter subset maintaining isolated architectural rendering rules.
 * @returns React Flow elements array explicitly targeting system schemas.
 */
export function buildSchemaGraph(
  model: DatabaseModel,
  visibleSchemas: Set<string>
): { nodes: FlowNode<SchemaNodeData>[]; edges: FlowEdge[] } {
  const schemaEdgeCounts = buildSchemaEdges(model, visibleSchemas);

  // Build schema → object count + type breakdown
  const schemaMeta = new Map<string, { count: number; types: Partial<Record<string, number>> }>();
  for (const n of model.nodes) {
    if (!visibleSchemas.has(n.schema)) continue;
    if (!schemaMeta.has(n.schema)) schemaMeta.set(n.schema, { count: 0, types: {} });
    const meta = schemaMeta.get(n.schema)!;
    meta.count++;
    meta.types[n.type] = (meta.types[n.type] ?? 0) + 1;
  }

  // Dagre layout for schema nodes — wider spacing than object graph
  const schemaIdSet = new Set([...visibleSchemas].filter(s => schemaMeta.has(s)));
  const schemaIds = [...schemaIdSet];
  const edgesForLayout: Array<{ source: string; target: string }> = [];
  for (const [src, targets] of schemaEdgeCounts) {
    for (const tgt of targets.keys()) {
      edgesForLayout.push({ source: src, target: tgt });
    }
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: 160, nodesep: 80, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of schemaIds) g.setNode(id, { width: SCHEMA_NODE_WIDTH, height: SCHEMA_NODE_HEIGHT });
  for (const { source, target } of edgesForLayout) {
    if (g.hasNode(source) && g.hasNode(target)) g.setEdge(source, target);
  }
  dagre.layout(g);

  const nodes: FlowNode<SchemaNodeData>[] = schemaIds.map((schema) => {
    const pos = g.node(schema);
    const meta = schemaMeta.get(schema)!;
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
        objectCount: meta.count,
        typeBreakdown: meta.types as Partial<Record<string, number>>,
        color: getSchemaColor(schema),
      },
    };
  });

  const edges: FlowEdge[] = [];
  for (const [src, targets] of schemaEdgeCounts) {
    for (const [tgt, count] of targets) {
      const srcId = `__schema__${src}`;
      const tgtId = `__schema__${tgt}`;
      if (!schemaIdSet.has(src) || !schemaIdSet.has(tgt)) continue;

      const revCount = schemaEdgeCounts.get(tgt)?.get(src);
      const isBidi = revCount !== undefined;
      const { strokeWidth, opacity } = schemaEdgeStroke(count);

      edges.push({
        id: isBidi ? `__schema__${src}↔${tgt}` : `__schema__${src}→${tgt}`,
        source: srcId,
        target: tgtId,
        label: `${count}`,
        labelStyle: { fontSize: 11, fill: 'var(--ln-fg-muted)' },
        labelBgStyle: { fill: 'var(--ln-bg)', opacity: 0.8 },
        labelBgPadding: LABEL_BG_PAD,
        style: { stroke: 'var(--ln-edge-color)', strokeWidth, opacity },
        markerEnd: { type: 'arrowclosed' as const, width: 18, height: 18, color: 'var(--ln-edge-color)' },
        ...(isBidi && {
          label: `⇄ ${count}`,
          markerStart: { type: 'arrow' as const, width: 14, height: 14, color: 'var(--ln-edge-color)' },
        }),
      });
    }
  }

  return { nodes, edges };
}

/**
 * Computes logical hierarchy configurations directing placement rules onto computational graphs.
 * Distinguishes directional components mapped effectively assigning ranking criteria mapping coordinates.
 *
 * @param graph - Initialized structure evaluating boundaries mappings.
 * @param config - Architectural styling values limiting topological complexity bounds. Defaults to `DEFAULT_CONFIG`.
 * @returns Resulting node mappings binding spatial placement values against specific keys.
 */
function computeLayout(graph: Graph, config: ExtensionConfig = DEFAULT_CONFIG): Map<string, { x: number; y: number }> {
  // Collect edges, deduplicating bidirectional pairs to canonical order
  const seen = new Set<string>();
  const edges: Array<{ source: string; target: string }> = [];

  graph.forEachEdge((_edge, _attrs, source, target) => {
    if (graph.hasEdge(target, source)) {
      // Bidirectional — write direction (proc→table) consistent with buildFlowEdges
      const [s, t] = canonicalDirection(graph, source, target);
      const key = `${s}→${t}`;
      if (!seen.has(key)) { seen.add(key); edges.push({ source: s, target: t }); }
    } else {
      edges.push({ source, target });
    }
  });

  return dagreLayout({ nodeIds: graph.nodes(), edges, config, ranker: 'longest-path' });
}
