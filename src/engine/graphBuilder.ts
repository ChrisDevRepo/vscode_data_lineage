import Graph from 'graphology';
import { bfsFromNode } from 'graphology-traversal';
import dagre from '@dagrejs/dagre';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import { DacpacModel, TraceState, ExtensionConfig, DEFAULT_CONFIG } from './types';

// ─── Constants ──────────────────────────────────────────────────────────────

const NODE_WIDTH = 220;
const NODE_HEIGHT = 60;

/** Collect edges that flow between depth levels in the BFS direction.
 *  Upstream edges: A→B where A.depth > B.depth (further → closer to origin).
 *  Downstream edges: A→B where B.depth > A.depth (closer → further from origin).
 *  Cross-connections (upstream↔downstream or same-depth siblings) are excluded. */
function collectTraceEdges(
  graph: Graph,
  upstreamDepths: Map<string, number>,
  downstreamDepths: Map<string, number>
): Set<string> {
  const edgeIds = new Set<string>();
  graph.forEachEdge((edge, _attrs, source, target) => {
    const srcUp = upstreamDepths.get(source);
    const tgtUp = upstreamDepths.get(target);
    if (srcUp !== undefined && tgtUp !== undefined && srcUp > tgtUp) {
      edgeIds.add(edge);
      return;
    }
    const srcDown = downstreamDepths.get(source);
    const tgtDown = downstreamDepths.get(target);
    if (srcDown !== undefined && tgtDown !== undefined && tgtDown > srcDown) {
      edgeIds.add(edge);
      return;
    }
  });
  return edgeIds;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface GraphResult {
  flowNodes: FlowNode[];
  flowEdges: FlowEdge[];
  graph: Graph;
}

export function buildGraph(model: DacpacModel, config: ExtensionConfig = DEFAULT_CONFIG): GraphResult {
  const graph = new Graph({ type: 'directed', multi: false });

  // Add nodes
  for (const node of model.nodes) {
    graph.addNode(node.id, { ...node });
  }

  // Add edges
  for (const edge of model.edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      const edgeId = `${edge.source}→${edge.target}`;
      if (!graph.hasEdge(edgeId)) {
        graph.addEdgeWithKey(edgeId, edge.source, edge.target, { type: edge.type });
      }
    }
  }

  // Layout with dagre (using config)
  const positions = computeLayout(graph, config);

  // Convert to React Flow format
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
    },
  }));

  const flowEdges: FlowEdge[] = buildFlowEdges(model, graph, config);

  return { flowNodes, flowEdges, graph };
}

// ─── Trace Logic ────────────────────────────────────────────────────────────

export function traceNode(
  graph: Graph,
  nodeId: string,
  mode: 'upstream' | 'downstream' | 'both'
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const nodeIds = new Set<string>([nodeId]);

  if (!graph.hasNode(nodeId)) return { nodeIds, edgeIds: new Set() };

  const upstreamDepths = new Map<string, number>();
  const downstreamDepths = new Map<string, number>();
  upstreamDepths.set(nodeId, 0);
  downstreamDepths.set(nodeId, 0);

  if (mode === 'upstream' || mode === 'both') {
    bfsFromNode(graph, nodeId, (node, _attrs, depth) => {
      nodeIds.add(node);
      upstreamDepths.set(node, depth);
    }, { mode: 'inbound' });
  }
  if (mode === 'downstream' || mode === 'both') {
    bfsFromNode(graph, nodeId, (node, _attrs, depth) => {
      nodeIds.add(node);
      downstreamDepths.set(node, depth);
    }, { mode: 'outbound' });
  }

  return { nodeIds, edgeIds: collectTraceEdges(graph, upstreamDepths, downstreamDepths) };
}

/**
 * Trace node with level limits using graphology BFS depth callback.
 * Returning true from bfsFromNode stops traversal down that branch.
 */
export function traceNodeWithLevels(
  graph: Graph,
  nodeId: string,
  upstreamLevels: number,
  downstreamLevels: number
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const nodeIds = new Set<string>([nodeId]);

  if (!graph.hasNode(nodeId)) return { nodeIds, edgeIds: new Set() };

  const upstreamDepths = new Map<string, number>();
  const downstreamDepths = new Map<string, number>();
  upstreamDepths.set(nodeId, 0);
  downstreamDepths.set(nodeId, 0);

  if (upstreamLevels > 0) {
    bfsFromNode(graph, nodeId, (node, _attrs, depth) => {
      if (depth > upstreamLevels) return true; // stop exploring
      nodeIds.add(node);
      upstreamDepths.set(node, depth);
    }, { mode: 'inbound' });
  }

  if (downstreamLevels > 0) {
    bfsFromNode(graph, nodeId, (node, _attrs, depth) => {
      if (depth > downstreamLevels) return true; // stop exploring
      nodeIds.add(node);
      downstreamDepths.set(node, depth);
    }, { mode: 'outbound' });
  }

  return { nodeIds, edgeIds: collectTraceEdges(graph, upstreamDepths, downstreamDepths) };
}

export function applyTraceToFlow(
  flowNodes: FlowNode[],
  flowEdges: FlowEdge[],
  trace: TraceState,
  config: ExtensionConfig = DEFAULT_CONFIG
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  if (trace.mode === 'none' || trace.mode === 'configuring' || !trace.selectedNodeId) {
    return { nodes: flowNodes, edges: flowEdges };
  }

  // FILTER nodes to only show traced subset
  const filteredNodes = flowNodes.filter((n) => trace.tracedNodeIds.has(n.id));

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

  // RELAYOUT the traced subset with dagre for optimal positioning
  const positions = dagreLayout({
    nodeIds: filteredNodes.map(n => n.id),
    edges: filteredEdges.map(e => ({ source: e.source, target: e.target })),
    config,
  });

  const nodes = filteredNodes.map((n) => ({
    ...n,
    position: positions.get(n.id) || n.position,
    data: {
      ...n.data,
      highlighted: n.id === trace.selectedNodeId,
    },
  }));

  const edges = filteredEdges.map((e) => ({
    ...e,
    style: {
      ...e.style,
      strokeWidth: 1.8,
    },
  }));

  return { nodes, edges };
}

// ─── Shared Dagre Layout Helper ─────────────────────────────────────────────

interface LayoutInput {
  nodeIds: string[];
  edges: Array<{ source: string; target: string }>;
  config: ExtensionConfig;
  ranker?: string;
}

function dagreLayout({ nodeIds, edges, config, ranker }: LayoutInput): Map<string, { x: number; y: number }> {
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
  return positions;
}

// ─── Graph Metrics ──────────────────────────────────────────────────────────

export function getGraphMetrics(graph: Graph) {
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

// ─── Edge Building (bidirectional detection) ────────────────────────────────

function buildFlowEdges(model: DacpacModel, graph: Graph, config: ExtensionConfig = DEFAULT_CONFIG): FlowEdge[] {
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
      // Use canonical order (alphabetical) so dagre layout direction is consistent
      const [canonSource, canonTarget] = edge.source < edge.target
        ? [edge.source, edge.target]
        : [edge.target, edge.source];
      consumed.add(fwd);
      consumed.add(rev);
      result.push({
        id: `${canonSource}↔${canonTarget}`,
        source: canonSource,
        target: canonTarget,
        type: config.edgeStyle === 'default' ? undefined : config.edgeStyle,
        label: '⇄',
        labelStyle: { fontSize: 16, fill: '#94a3b8', fontWeight: 700 },
        labelBgStyle: { fill: 'transparent' },
        labelBgPadding: [4, 4] as [number, number],
        style: {
          stroke: '#94a3b8',
          strokeWidth: 1.2,
        },
        markerEnd: { type: 'arrowclosed' as const, width: 20, height: 20, color: '#94a3b8' },
        markerStart: { type: 'arrow' as const, width: 16, height: 16, color: '#94a3b8' },
      });
    } else {
      // Unidirectional
      consumed.add(fwd);
      result.push({
        id: fwd,
        source: edge.source,
        target: edge.target,
        type: config.edgeStyle === 'default' ? undefined : config.edgeStyle,
        style: {
          stroke: '#94a3b8',
          strokeWidth: 1.2,
        },
        markerEnd: { type: 'arrowclosed' as const, width: 20, height: 20, color: '#94a3b8' },
      });
    }
  }

  return result;
}

// ─── Dagre Layout (full graph) ──────────────────────────────────────────────

function computeLayout(graph: Graph, config: ExtensionConfig = DEFAULT_CONFIG): Map<string, { x: number; y: number }> {
  // Collect edges, deduplicating bidirectional pairs to canonical order
  const seen = new Set<string>();
  const edges: Array<{ source: string; target: string }> = [];

  graph.forEachEdge((_edge, _attrs, source, target) => {
    if (graph.hasEdge(target, source)) {
      // Bidirectional — canonical alphabetical order consistent with buildFlowEdges
      const [s, t] = source < target ? [source, target] : [target, source];
      const key = `${s}→${t}`;
      if (!seen.has(key)) { seen.add(key); edges.push({ source: s, target: t }); }
    } else {
      edges.push({ source, target });
    }
  });

  return dagreLayout({ nodeIds: graph.nodes(), edges, config, ranker: 'longest-path' });
}
