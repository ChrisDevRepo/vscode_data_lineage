/**
 * The graph view's trace by level and Find Path, as pure graph algorithms over a graphology graph:
 * the one implementation the webview and the AI tools both call (no VS Code imports).
 */
import type Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path';
import { bfsFromNode } from 'graphology-traversal';

/** Direction in which a shortest path between two endpoints was found. */
type ShortestPathDirection = 'source_to_target' | 'target_to_source';

/** Ordered shortest path plus the direction in which it was found. */
interface OrderedShortestPath {
  /** Ordered node ids along the directed path, in the found direction. */
  path: string[];
  /** Whether the directed path runs source→target or (on reverse retry) target→source. */
  direction: ShortestPathDirection;
}

/**
 * Finds the shortest directed dependency path between two endpoints, trying `source → target` first
 * and retrying `target → source`, so the result matches the GUI "Find Path"
 * ({@link computeShortestPath}), the single source of truth for path lookup. `null` only when the
 * nodes are disconnected in both directions or an endpoint is absent.
 *
 * @returns The ordered path and the direction it was found in.
 */
export function findShortestPathOrdered(
  graph: Graph,
  sourceId: string,
  targetId: string,
): OrderedShortestPath | null {
  if (!graph.hasNode(sourceId) || !graph.hasNode(targetId)) return null;
  const forward = bidirectional(graph, sourceId, targetId);
  if (forward) return { path: forward, direction: 'source_to_target' };
  const reverse = bidirectional(graph, targetId, sourceId);
  if (reverse) return { path: reverse, direction: 'target_to_source' };
  return null;
}

/**
 * Collects every edge whose endpoints both sit inside the traced node set. Direction governs which
 * nodes a trace admits, not which edges are drawn between admitted nodes: an upstream-only trace
 * holding both `A` and `S` still draws `A → S`.
 */
function collectTraceEdges(graph: Graph, nodeIds: Set<string>): Set<string> {
  const edgeIds = new Set<string>();

  graph.forEachEdge((edge, _attrs, source, target) => {
    if (nodeIds.has(source) && nodeIds.has(target)) edgeIds.add(edge);
  });

  return edgeIds;
}

/** Receives each node a trace reaches, with the side and the level it was reached at (origin 0). */
type TraceReach = (nodeId: string, side: 'upstream' | 'downstream', level: number) => void;

/**
 * Traces a node's lineage with separate upstream and downstream depth caps. BFS runs per direction;
 * a depth of `0` suppresses that direction entirely.
 *
 * @returns The reachable node ids and the edges connecting them.
 */
export function traceNodeWithLevels(
  graph: Graph,
  nodeId: string,
  upstreamLevels: number,
  downstreamLevels: number,
  onReach?: TraceReach,
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const nodeIds = traceNodeIdsWithLevels(graph, nodeId, upstreamLevels, downstreamLevels, onReach);
  return { nodeIds, edgeIds: collectTraceEdges(graph, nodeIds) };
}

/**
 * The node half of {@link traceNodeWithLevels}: reachable node ids alone, without the O(E) edge
 * collection, for callers that only count or probe a scope.
 */
export function traceNodeIdsWithLevels(
  graph: Graph,
  nodeId: string,
  upstreamLevels: number,
  downstreamLevels: number,
  onReach?: TraceReach,
): Set<string> {
  if (!graph.hasNode(nodeId)) return new Set<string>();

  const nodeIds = new Set<string>([nodeId]);

  if (upstreamLevels > 0) {
    bfsFromNode(graph, nodeId, (node, _attrs, depth) => {
      if (depth > upstreamLevels) return true;
      nodeIds.add(node);
      onReach?.(node, 'upstream', depth);
    }, { mode: 'inbound' });
  }

  if (downstreamLevels > 0) {
    bfsFromNode(graph, nodeId, (node, _attrs, depth) => {
      if (depth > downstreamLevels) return true;
      nodeIds.add(node);
      onReach?.(node, 'downstream', depth);
    }, { mode: 'outbound' });
  }

  return nodeIds;
}

/**
 * Calculates the shortest directed path between two nodes as node/edge id sets, via
 * {@link findShortestPathOrdered} (bidirectional retry) so "Find Path" has one source of truth.
 *
 * @returns The node ids in path order and the edge ids on the path, or `null` if either endpoint
 *   is unknown or no path exists in either direction.
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
 * The graph a trace or path walks: the filtered graph, or the full model when `preferFull` is set,
 * auto-promoting to the full model when the node is filtered out, so the requested lineage is
 * always reachable.
 */
export function resolveBfsGraph(
  nodeId: string,
  preferFull: boolean,
  graph: Graph | null,
  fullGraph: Graph | null,
): { bfsGraph: Graph | null; autoPromoted: boolean } {
  const preferred = preferFull ? (fullGraph ?? graph) : graph;
  if (preferred?.hasNode(nodeId)) return { bfsGraph: preferred, autoPromoted: false };
  if (!preferFull && fullGraph?.hasNode(nodeId)) return { bfsGraph: fullGraph, autoPromoted: true };
  return { bfsGraph: preferred, autoPromoted: false };
}
