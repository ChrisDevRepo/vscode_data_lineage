/**
 * Shared graph-integrity guards — pure graph algorithms for scope edits.
 *
 * @remarks
 * Pure graph algorithms: accept graph + sets as parameters, no SM- or view-specific coupling.
 * Single source of truth for:
 * - Shortest-path lookup in either direction
 * - Undirected reachability under a removal set
 * - Prune analysis (directed support before and after a removal, protected anchors)
 * - Direct-neighbor lookup (add must target an adjacent node)
 *
 * All BFS operations are O(V+E) — fast even for 10K+ node graphs.
 *
 * Zero VS Code imports. No side effects. Safe to bundle in both the extension
 * host and the webview.
 */

import type Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path';
import { bfsFromNode } from 'graphology-traversal';
import type { DatabaseModel } from './types';

/** Direction in which a shortest path between two endpoints was found. */
export type ShortestPathDirection = 'source_to_target' | 'target_to_source';

/** Ordered shortest path plus the direction in which it was found. */
export interface OrderedShortestPath {
  /** Ordered node ids along the directed path, in the found direction. */
  path: string[];
  /** Whether the directed path runs source→target or (on reverse retry) target→source. */
  direction: ShortestPathDirection;
}

/**
 * Finds the shortest directed dependency path between two endpoints, trying both directions.
 *
 * @remarks
 * Single source of truth for shortest-path lookup, consumed by the GUI "Find Path" feature
 * ({@link computeShortestPath}). Tries `source → target` first; on no directed path, retries `target → source` so the
 * result matches what the GUI surfaces. Returns `null` only when the two nodes are not
 * connected in either direction (or an endpoint is absent).
 *
 * @param graph - Graphology directed dependency graph.
 * @param sourceId - First canonical endpoint.
 * @param targetId - Second canonical endpoint.
 * @returns The ordered path and the direction it was found in, or `null` when disconnected.
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
 * Logging callback injected into state machines for operational tracing.
 *
 * @remarks
 * The optional error argument preserves caught exception stacks at production
 * adapters without requiring the engine to depend on a concrete logger.
 */
export type LogFn = (level: 'info' | 'debug' | 'warn' | 'error', msg: string, err?: unknown) => void;

/** Directional side of a lineage node when listing direct neighbors. */
export type NeighborSide = 'in' | 'out';


/**
 * Performs a BFS reachability check from a starting node, respecting a set of removed (pruned) nodes.
 *
 * @remarks
 * Traversal is undirected (`graph.neighbors`) because relevance in a lineage scope runs both
 * ways — a node can matter through an inbound source table or an outbound target view.
 *
 * @param graph - The graphology instance to traverse.
 * @param startId - The ID of the node to start the BFS from.
 * @param removedSet - A set of node IDs that have been pruned and should be treated as non-existent.
 * @param candidateId - An optional candidate node ID to exclude from reachability (used for "what-if" analysis).
 * @param scope - An optional set of allowed node IDs to restrict the search.
 * @returns A set of all node IDs reachable from the start node.
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
  /** Only this active/clicked node may self-prune if already visited. Omission permits no exception. */
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
 * Analyzes the same pruning policy for AI navigation and interactive traces.
 *
 * Each permitted leg walks from the origin in one direction. The cut is every open node the
 * legs reached before the removal and no leg reaches after it, so a surviving shared join stays
 * and nothing is left without a directed path to the origin. A current node may remove
 * itself, but losing support for another visited anchor is reported for atomic rejection.
 * The origin is protected. Invalid scopes or unknown removal nodes return a rejection without
 * invoking traversal on missing nodes. This function never mutates its graph or input sets.
 *
 * @param graph - Directed dependency graph.
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
 * Returns exact direct neighbors for one node and lineage side.
 *
 * @remarks
 * The single add-guard primitive: an add must target a node directly adjacent to
 * the current scope. Reads the precomputed `neighborIndex` under the source comparison policy,
 * falling back to an edge scan. Shared by the AI neighbor-column validator and
 * the webview trace add-neighbor control.
 *
 * @param model - Database model to inspect.
 * @param nodeId - Node ID to inspect.
 * @param side - Neighbor direction to collect.
 * @returns Array of matching neighbor ids (deduplicated).
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
