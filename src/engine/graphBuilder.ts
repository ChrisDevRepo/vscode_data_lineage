import Graph from 'graphology';
import { bfsFromNode } from 'graphology-traversal';
import { bidirectional } from 'graphology-shortest-path';
import dagre from '@dagrejs/dagre';
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import { DatabaseModel, TraceState, ExtensionConfig, DEFAULT_CONFIG, SchemaNodeData } from './types';
import { getSchemaColor } from '../utils/schemaColors';

// ─── Constants ──────────────────────────────────────────────────────────────

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 80;
export const SCHEMA_NODE_WIDTH = 200;
export const SCHEMA_NODE_HEIGHT = 80;

/** Typed tuple for React Flow edge label background padding. */
const LABEL_BG_PAD: [number, number] = [4, 4];

/** Collect edges between traced nodes with direction-aware filtering.
 *  When only one direction is active (the other is 0), edges are filtered
 *  to only show data flow in the requested direction using BFS depth:
 *    - Upstream only: include edge A→B if A.upDepth >= B.upDepth (toward origin)
 *    - Downstream only: include edge A→B if B.downDepth >= A.downDepth (away from origin)
 *  When both directions are active, ALL edges between traced nodes are shown.
 *  Uses >= (not >) to include same-depth cross-edges. */
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

// ─── Public API ─────────────────────────────────────────────────────────────

export interface GraphResult {
  flowNodes: FlowNode[];
  flowEdges: FlowEdge[];
  graph: Graph;
}

/** Build graphology graph from model (shared by buildGraph and buildGraphNoLayout). */
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

/** Convert model + graphology graph + positions into React Flow nodes/edges. */
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

export function buildGraph(model: DatabaseModel, config: ExtensionConfig = DEFAULT_CONFIG): GraphResult {
  const graph = buildGraphologyGraph(model);
  const positions = computeLayout(graph, config);
  return toFlowResult(model, graph, positions, config);
}

/** Build graph without dagre layout — positions default to {0,0}.
 *  Used when node count exceeds overview threshold (dagre positions never rendered). */
export function buildGraphNoLayout(model: DatabaseModel, config: ExtensionConfig = DEFAULT_CONFIG): GraphResult {
  const graph = buildGraphologyGraph(model);
  return toFlowResult(model, graph, new Map(), config);
}

// ─── Trace Logic ────────────────────────────────────────────────────────────

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
 * Trace node with level limits using graphology BFS depth callback.
 * Returning true from bfsFromNode stops traversal down that branch.
 * Depth maps drive direction-aware edge filtering in collectTraceEdges.
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
 * Find the shortest directed path between two nodes.
 * Tries source→target first (downstream), then target→source (upstream).
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

// ─── Analysis-Specific Layouts ──────────────────────────────────────────────

function gridLayout(nodeIds: string[], cols: number = 4): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const cellW = NODE_WIDTH + 40;
  const cellH = NODE_HEIGHT + 40;
  nodeIds.forEach((id, i) => {
    positions.set(id, { x: (i % cols) * cellW, y: Math.floor(i / cols) * cellH });
  });
  return positions;
}

export function applyTraceToFlow(
  flowNodes: FlowNode[],
  flowEdges: FlowEdge[],
  trace: TraceState,
  config: ExtensionConfig = DEFAULT_CONFIG,
  model?: DatabaseModel | null
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  if (trace.mode === 'none' || trace.mode === 'configuring' || trace.mode === 'pathfinding') {
    return { nodes: flowNodes, edges: flowEdges };
  }
  if (trace.tracedNodeIds.size === 0) {
    return { nodes: flowNodes, edges: flowEdges };
  }

  // FILTER nodes to only show traced subset
  const filteredNodes = flowNodes.filter((n) => trace.tracedNodeIds.has(n.id));

  if (filteredNodes.length === 0 && flowNodes.length > 0) {
    // Pure utility — no outputChannel available; console.warn is the allowed exception per CLAUDE.md §4
    console.warn(`[Trace] applyTraceToFlow: 0 of ${flowNodes.length} flowNodes matched ${trace.tracedNodeIds.size} tracedNodeIds (mode=${trace.mode})`);
  }

  // Synthesize FlowNodes for path/full-graph nodes outside the current filter
  if (filteredNodes.length < trace.tracedNodeIds.size && (trace.mode === 'path-applied' || trace.useFullGraph) && model) {
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

  // Synthesize FlowEdges for path/full-graph edges outside the current filter
  if ((trace.mode === 'path-applied' || trace.useFullGraph) && model) {
    const existingEdgeIds = new Set(filteredEdges.map(e => e.id));
    for (const edgeId of trace.tracedEdgeIds) {
      if (existingEdgeIds.has(edgeId)) continue;
      // Also check if a bidirectional edge already covers this
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
      filteredNeighborGap: trace.filteredNeighborGaps?.get(n.id),
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

// LRU layout cache — avoids recomputing dagre for identical node/edge/config sets
const LAYOUT_CACHE_SIZE = 12;
const layoutCache: Array<{ key: string; positions: Map<string, { x: number; y: number }> }> = [];

function layoutCacheKey(nodeIds: string[], edges: Array<{ source: string; target: string }>, config: ExtensionConfig, ranker?: string): string {
  const sortedNodes = [...nodeIds].sort();
  const sortedEdges = edges.map(e => `${e.source}→${e.target}`).sort();
  return `${config.layout.direction}|${config.layout.rankSeparation}|${config.layout.nodeSeparation}|${ranker ?? ''}|${sortedNodes.join(',')}|${sortedEdges.join(',')}`;
}

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

// ─── Bidirectional Canonical Direction ────────────────────────────────────────

/** For bidirectional edges, pick canonical direction based on write semantics:
 *  procedure/function → table/view (output direction), else alphabetical. */
function canonicalDirection(graph: Graph, a: string, b: string): [string, string] {
  const aType = graph.getNodeAttributes(a).type;
  const bType = graph.getNodeAttributes(b).type;
  const aIsTransformer = aType === 'procedure' || aType === 'function';
  const bIsTransformer = bType === 'procedure' || bType === 'function';

  if (aIsTransformer && !bIsTransformer) return [a, b]; // a (proc) → b (table)
  if (bIsTransformer && !aIsTransformer) return [b, a]; // b (proc) → a (table)
  return a < b ? [a, b] : [b, a];                       // fallback: alphabetical
}

// ─── Edge Building (bidirectional detection) ────────────────────────────────

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

// ─── Schema Overview (flat super-nodes) ──────────────────────────────────────

/**
 * Aggregate object-level edges to schema-level edge counts.
 * Bidirectional schema pairs are merged using the same canonical-direction
 * logic as buildFlowEdges — procedure/function schema on the "source" side.
 * Returns: Map<canonSourceSchema, Map<canonTargetSchema, totalCount>>
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

/** Log-scaled stroke weight for schema overview edges (flow-map technique). */
function schemaEdgeStroke(count: number): { strokeWidth: number; opacity: number } {
  const t = Math.min(Math.log2(Math.max(count, 1)) / 6, 1);
  return { strokeWidth: 0.8 + t * 2.2, opacity: 0.55 + t * 0.45 };
}

/**
 * Build React Flow schema super-nodes + aggregated edges for overview mode.
 * Only includes schemas present in visibleSchemas.
 * Uses dedicated dagre spacing (larger than object graph).
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

// ─── Dagre Layout (full graph) ──────────────────────────────────────────────

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
