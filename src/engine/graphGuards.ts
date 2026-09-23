/**
 * Shared graph-integrity guards — pure graph algorithms for scope edits.
 *
 * @remarks
 * Pure graph algorithms: accept graph + sets as parameters, no SM- or view-specific coupling.
 * Single source of truth for add/prune rules:
 * - Prune validation (orphan guard, cascade guard, disconnect guard)
 * - Node reference validation (reject hallucinated names)
 * - Bridge node injection (reconnect orphan noted nodes in result graph)
 * - Direct-neighbor lookup (add must target an adjacent node)
 *
 * All BFS operations are O(V+E) — fast even for 10K+ node graphs.
 *
 * Zero VS Code imports. No side effects. Safe to bundle in both the extension
 * host and the webview.
 */

import type Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path';
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
 * @param sourceId - First endpoint (canonical, lowercase).
 * @param targetId - Second endpoint (canonical, lowercase).
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


/**
 * Computes the nodes a removal cuts loose from the origin — the shared self-prune cut applied by
 * both the AI navigation engine and the webview trace.
 *
 * @remarks
 * A cut node is one reachable from `originId` before the removal and not after: the removed
 * node's subtree, per the self-prune contract (a pruned node leaves together with every node
 * reachable from the origin only through it). The origin itself is never a member of the result
 * because it seeds both walks. `removedAfter` and `keep` are excluded from the result even when
 * the before/after reachability delta would otherwise include them.
 *
 * @param graph - Graphology instance to traverse.
 * @param originId - Exploration origin node id, never itself a cut candidate.
 * @param removedBefore - Node ids treated as removed before this removal.
 * @param removedAfter - Node ids treated as removed after this removal (superset of `removedBefore`).
 * @param scope - Optional traversal scope restriction, applied to both walks.
 * @param keep - Optional node ids excluded from the cut regardless of reachability (for example, already-visited nodes whose analysis is committed).
 * @returns Node ids reachable from origin before the removal, unreachable after, excluding `removedAfter` and `keep`.
 */
export function nodesCutByRemoval(
  graph: Graph,
  originId: string,
  removedBefore: ReadonlySet<string>,
  removedAfter: ReadonlySet<string>,
  scope?: ReadonlySet<string>,
  keep?: ReadonlySet<string>,
): string[] {
  const before = bfsReachable(graph, originId, removedBefore, undefined, scope);
  const after = bfsReachable(graph, originId, removedAfter, undefined, scope);
  return [...before].filter(id => !after.has(id) && !removedAfter.has(id) && !(keep?.has(id) ?? false));
}

/**
 * Returns exact direct neighbors for one node and lineage side.
 *
 * @remarks
 * The single add-guard primitive: an add must target a node directly adjacent to
 * the current scope. Reads the precomputed `neighborIndex` (case-insensitive),
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
  const indexed = model.neighborIndex?.[nodeId] ?? model.neighborIndex?.[nodeId.toLowerCase()];
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
 * Generates a depth map for a directed graph starting from an origin node.
 *
 * @remarks
 * Depth is the minimum hop distance from the origin, used to sort nodes into stages/tiers
 * for report generation and visualization layout.
 *
 * @param edges - A flat list of directed edges [source, target, type].
 * @param originNodeId - The root node from which to calculate depths (depth 0).
 * @returns A map of node IDs to their respective depth. Unreachable nodes are excluded.
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
