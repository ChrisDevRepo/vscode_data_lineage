/**
 * Shared State Machine Guards — graph integrity functions for CT and BB.
 *
 * Pure graph algorithms: accept graph + sets as parameters, no SM-specific coupling.
 * Used by NavigationEngine for:
 * - Prune validation (orphan guard, cascade guard)
 * - Node reference validation (reject hallucinated names)
 * - Bridge node injection (reconnect orphan noted nodes in result graph)
 *
 * All BFS operations are O(V+E) — fast even for 10K+ node graphs.
 *
 * Zero VS Code imports. No side effects.
 */

import type Graph from 'graphology';


/**
 * Logging callback injected into state machines for operational tracing.
 *
 * @remarks
 * Only `info` / `debug` / `warn` are permitted here; `error` flows through
 * dedicated channels with notification escalation.
 */
export type LogFn = (level: 'info' | 'debug' | 'warn', msg: string) => void;


/**
 * Performs a BFS reachability check from a starting node, respecting a set of removed (pruned) nodes.
 *
 * @remarks
 * This function uses undirected traversal (graph.neighbors) to ensure that both upstream
 * and downstream nodes are correctly identified within the lineage scope. This is essential
 * because a node's relevance is often determined by its connection to source tables (inbound)
 * as well as target views (outbound).
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
 * Determines if pruning a candidate node would orphan any previously noted nodes from the origin.
 *
 * @remarks
 * This guard prevents the AI from accidentally cutting off access to nodes it has already
 * flagged as important ("noted") during an exploration.
 *
 * @param graph - The graphology instance to check.
 * @param originId - The ID of the exploration's origin node.
 * @param removedSet - The current set of pruned nodes.
 * @param notedIds - The set of nodes previously noted by the AI.
 * @param candidateId - The ID of the node being considered for pruning.
 * @returns The ID of the first orphaned noted node found, or `null` if no orphaning occurs.
 */
export function wouldOrphanNotedNode(
  graph: Graph,
  originId: string,
  removedSet: ReadonlySet<string>,
  notedIds: ReadonlySet<string>,
  candidateId: string,
): string | null {
  if (notedIds.size === 0) return null;
  const reachable = bfsReachable(graph, originId, removedSet, candidateId);
  for (const id of notedIds) {
    if (!reachable.has(id)) return id;
  }
  return null;
}

/**
 * Returns the first required node that would become disconnected from origin after removals.
 *
 * @remarks
 * Shared closed-graph guard for prune operations. Any node in `requiredNodeIds` that
 * is not removed must stay reachable from the origin.
 *
 * @param graph - The graphology instance to check.
 * @param originId - Exploration origin node id.
 * @param removedSet - Node ids treated as removed.
 * @param requiredNodeIds - Nodes that must remain connected from origin.
 * @param scope - Optional traversal scope restriction.
 * @returns First disconnected required node id, otherwise `null`.
 */
export function firstDisconnectedRequiredNode(
  graph: Graph,
  originId: string,
  removedSet: ReadonlySet<string>,
  requiredNodeIds: ReadonlySet<string>,
  scope?: ReadonlySet<string>,
): string | null {
  if (requiredNodeIds.size === 0) return null;
  const reachable = bfsReachable(graph, originId, removedSet, undefined, scope);
  for (const id of requiredNodeIds) {
    if (removedSet.has(id)) continue;
    if (!reachable.has(id)) return id;
  }
  return null;
}

/**
 * Generates a depth map for a directed graph starting from an origin node.
 *
 * @remarks
 * This function calculates the minimum hop distance from the origin to all reachable nodes
 * in a result subgraph. It is primarily used to sort nodes into "stages" or "tiers" for
 * structured report generation and visualization layout.
 *
 * @param edges - A flat list of directed edges [source, target, type].
 * @param originNodeId - The root node from which to calculate depths (depth 0).
 * @returns A map of node IDs to their respective depth. Unreachable nodes are excluded.
 */
export function bfsDepthMap(
  edges: ReadonlyArray<readonly [string, string, string]>,
  originNodeId: string,
): Map<string, number> {
  // Build adjacency list (directed: source → targets)
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
