/**
 * Shared graph-integrity guards: pure graph algorithms for scope edits (graph + sets as parameters,
 * no SM- or view-specific coupling, no VS Code imports, no side effects; safe to bundle in the
 * extension host and the webview). Single source of truth for prune validation (orphan, cascade and
 * disconnect guards), node reference validation (reject hallucinated names), bridge node injection
 * (reconnect orphan noted nodes in the result graph) and direct-neighbor lookup (an add must target
 * an adjacent node). All BFS is O(V+E), fast for 10K+ node graphs.
 */

import type Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path';
import { bfsFromNode } from 'graphology-traversal';
import type { DatabaseModel } from './types';

/** Direction in which a shortest path between two endpoints was found. */
type ShortestPathDirection = 'source_to_target' | 'target_to_source';

/** Ordered shortest path plus the direction in which it was found. */
export interface OrderedShortestPath {
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
 * Logging callback injected into state machines for operational tracing; the optional error
 * preserves caught stacks at production adapters without tying the engine to a concrete logger.
 */
export type LogFn = (level: 'info' | 'debug' | 'warn' | 'error', msg: string, err?: unknown) => void;

/** Directional side of a lineage node when listing direct neighbors. */
export type NeighborSide = 'in' | 'out';


/**
 * BFS reachability from a starting node, treating `removedSet` (pruned) nodes as non-existent.
 * Traversal is undirected (`graph.neighbors`) because relevance in a lineage scope runs both ways
 * (an inbound source table or an outbound target view).
 *
 * @param candidateId - Optional candidate excluded from reachability ("what-if" analysis).
 * @param scope - Optional set of allowed node IDs restricting the search.
 * @returns All node IDs reachable from the start node.
 */
export function bfsReachable(
  graph: Graph,
  startId: string,
  removedSet: ReadonlySet<string>,
  candidateId?: string,
  scope?: ReadonlySet<string>,
): Set<string> {
  if (!graph.hasNode(startId)) return new Set();
  const reachable = new Set<string>([startId]);
  const queue = [startId];
  let idx = 0;
  while (idx < queue.length) {
    const id = queue[idx++];
    for (const nid of graph.neighbors(id)) {
      if (reachable.has(nid)) continue;
      if (removedSet.has(nid) || nid === candidateId) continue;
      if (scope && !scope.has(nid)) continue;
      reachable.add(nid);
      queue.push(nid);
    }
  }
  return reachable;
}


/** A fixed directed lineage leg; combining legs never permits changing direction mid-walk. */
export type RemovalSide = 'upstream' | 'downstream';

/** Shared inputs for pruning one or more nodes from an existing lineage scope. */
export interface RemovalContext {
  originId: string;
  scope: ReadonlySet<string>;
  removedBefore: ReadonlySet<string>;
  removedAfter: ReadonlySet<string>;
  /** Only this active/clicked node may self-prune if already visited; omission means none. */
  currentNodeId?: string;
  /** Committed analysis anchors, protected from removal by any other node. */
  visited: ReadonlySet<string>;
  /** Explicit permitted legs; a zero-depth side must be omitted by its caller. */
  sides: ReadonlyArray<RemovalSide>;
}

/** Directed support and the open nodes removed by one atomic pruning proposal. */
export interface RemovalAnalysis {
  before: Set<string>;
  after: Set<string>;
  disconnectedVisited: string[];
  cutIds: string[];
  /** Invalid proposals have no cut. Callers must reject them before applying edits. */
  rejection?: 'origin' | 'invalid-scope' | 'unknown-node' | 'visited';
}

/**
 * Analyzes the one pruning policy shared by AI navigation and interactive traces. Each permitted
 * leg walks from the origin in one direction; the cut is every open node the legs reached before
 * the removal and no leg reaches after it, so a surviving shared join stays and nothing is left
 * without a directed path to the origin. A current node may remove itself, but losing support for
 * another visited anchor is reported for atomic rejection. The origin is protected. Invalid scopes
 * or unknown removal nodes return a rejection without traversing missing nodes. Never mutates its
 * graph or inputs.
 *
 * @param context - Explicit scope, removal proposal, committed anchors and open direction legs.
 * @returns Support before/after, disconnected committed anchors, and exclusive open cut nodes.
 */
export function analyzeRemoval(graph: Graph, context: RemovalContext): RemovalAnalysis {
  const { originId, scope, removedBefore, removedAfter, visited, sides, currentNodeId } = context;
  const invalid = (rejection: NonNullable<RemovalAnalysis['rejection']>): RemovalAnalysis =>
    ({ before: new Set(), after: new Set(), disconnectedVisited: [], cutIds: [], rejection });
  if (removedAfter.has(originId)) return invalid('origin');
  if (!graph.hasNode(originId)) return invalid('unknown-node');
  if (!scope.has(originId) || [...removedBefore].some(id => !removedAfter.has(id))) return invalid('invalid-scope');
  const starts = [...removedAfter].filter(id => !removedBefore.has(id));
  if (starts.some(id => !graph.hasNode(id))) return invalid('unknown-node');
  if (starts.some(id => !scope.has(id))) return invalid('invalid-scope');
  if (starts.some(id => visited.has(id) && id !== currentNodeId)) return invalid('visited');
  const modeFor = (side: RemovalSide): 'inbound' | 'outbound' => side === 'upstream' ? 'inbound' : 'outbound';
  const support = (removed: ReadonlySet<string>, side: RemovalSide): Set<string> => {
    const found = new Set<string>();
    bfsFromNode(graph, originId, id => {
      if (!scope.has(id) || removed.has(id)) return true;
      found.add(id);
      return false;
    }, { mode: modeFor(side) });
    return found;
  };
  const before = new Set<string>([originId]);
  const after = new Set<string>([originId]);
  for (const side of new Set(sides)) {
    for (const id of support(removedBefore, side)) before.add(id);
    for (const id of support(removedAfter, side)) after.add(id);
  }
  const lost = [...before].filter(id => !after.has(id) && !removedAfter.has(id));
  const disconnectedVisited = lost.filter(id => visited.has(id));
  return { before, after, disconnectedVisited, cutIds: disconnectedVisited.length ? [] : lost };
}

/**
 * Returns the exact direct neighbors (deduplicated ids) of one node on one lineage side. The single
 * add-guard primitive: an add must target a node directly adjacent to the current scope. Reads the
 * precomputed `neighborIndex` under the source comparison policy, falling back to an edge scan;
 * shared by the AI neighbor-column validator and the webview trace add-neighbor control.
 */
export function directNeighborIds(
  model: DatabaseModel,
  nodeId: string,
  side: NeighborSide,
): string[] {
  const indexed = model.neighborIndex?.[nodeId]
    ?? (model.identifierCaseSensitive ? undefined : model.neighborIndex?.[nodeId.toLowerCase()]);
  const fromIndex = indexed?.[side];
  if (fromIndex) return Array.from(new Set(fromIndex));

  const ids: string[] = [];
  for (const edge of model.edges) {
    if (side === 'in' && edge.target === nodeId) ids.push(edge.source);
    if (side === 'out' && edge.source === nodeId) ids.push(edge.target);
  }
  return Array.from(new Set(ids));
}

/**
 * Depth map (minimum hop distance, origin at depth 0) over a flat list of directed edges `[source,
 * target, type]`, used to sort nodes into tiers for reports and layout. Unreachable nodes are
 * excluded.
 */
export function bfsDepthMap(
  edges: ReadonlyArray<readonly [string, string, string]>,
  originNodeId: string,
): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const [s, t] of edges) {
    let targets = adj.get(s);
    if (!targets) { targets = []; adj.set(s, targets); }
    targets.push(t);
  }

  const depth = new Map<string, number>();
  depth.set(originNodeId, 0);
  const queue = [originNodeId];
  let idx = 0;
  while (idx < queue.length) {
    const id = queue[idx++];
    const d = depth.get(id)!;
    for (const nid of adj.get(id) ?? []) {
      if (depth.has(nid)) continue;
      depth.set(nid, d + 1);
      queue.push(nid);
    }
  }
  return depth;
}
