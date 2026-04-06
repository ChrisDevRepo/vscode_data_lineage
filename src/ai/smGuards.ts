/**
 * Shared State Machine Guards — graph integrity functions for CT and BB.
 *
 * Pure graph algorithms: accept graph + sets as parameters, no SM-specific coupling.
 * Used by both columnTraceState and blackboardState for:
 * - Prune validation (orphan guard, cascade guard)
 * - Node reference validation (reject hallucinated names)
 * - Bridge node injection (reconnect orphan noted nodes in result graph)
 *
 * All BFS operations are O(V+E) — fast even for 10K+ node graphs.
 *
 * Zero VS Code imports. No side effects.
 */

import type Graph from 'graphology';

// ─── Shared types ─────────────────────────────────────────────────────────────

/** Logging callback injected into state machines — 'trace' is the most verbose level. */
export type LogFn = (level: 'info' | 'debug' | 'warn' | 'trace', msg: string) => void;

// ─── BFS Reachability ────────────────────────────────────────────────────────

/**
 * BFS reachability from startId — undirected (graph.neighbors) to match bfsScope/seedAgenda.
 * The scope is built with undirected traversal so reachability checks must use the same strategy:
 * upstream source tables are connected via inbound edges only and would be falsely unreachable
 * if we used directed (outbound-only) traversal.
 * Cycle-safe: reachable set guards against revisits.
 * Exported so cascadePrune can reuse — single BFS implementation for the entire SM layer.
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

// ─── Prune Guards ────────────────────────────────────────────────────────────

/**
 * Would pruning candidateId disconnect any noted node from origin?
 * BFS from origin excluding removedSet + candidate (no Set copy — candidateId checked inline).
 * @returns first orphaned noteId, or null if all noted nodes remain reachable.
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
 * How many agenda/frontier nodes would be cascade-removed if candidateId is pruned?
 * BFS from origin excluding removedSet + candidate, scoped to scopeNodeIds.
 * Counts agenda entries that become unreachable.
 */
export function countCascadeIfPruned(
  graph: Graph,
  originId: string,
  removedSet: ReadonlySet<string>,
  scopeNodeIds: ReadonlySet<string>,
  agendaNodeIds: ReadonlySet<string>,
  candidateId: string,
): number {
  const reachable = bfsReachable(graph, originId, removedSet, candidateId, scopeNodeIds);
  let count = 0;
  for (const id of agendaNodeIds) {
    if (!reachable.has(id)) count++;
  }
  return count;
}

// ─── Node Validation ─────────────────────────────────────────────────────────

/**
 * Validate node IDs against the model's nodeMap.
 * SM owns the model — every AI reference must be validated. Silent drops are bugs.
 * @returns valid + invalid arrays. Invalid entries include reason string.
 */
export function validateNodeIds<T extends { nodeId: string }>(
  nodeMap: ReadonlyMap<string, unknown>,
  entries: T[],
): { valid: T[]; invalid: Array<T & { reason: string }> } {
  const valid: T[] = [];
  const invalid: Array<T & { reason: string }> = [];
  for (const entry of entries) {
    if (nodeMap.has(entry.nodeId)) {
      valid.push(entry);
    } else {
      invalid.push({ ...entry, reason: `"${entry.nodeId}" does not exist in the model` });
    }
  }
  return { valid, invalid };
}

// ─── Bridge Node Injection ───────────────────────────────────────────────────

export interface BridgeNode {
  id: string;
  schema: string;
  name: string;
  type: string;
}

export interface BridgeResult {
  bridgeNodes: BridgeNode[];
  bridgeEdges: Array<[string, string, string]>;
  orphanCount: number;
  reconnectedCount: number;
}

/**
 * Find orphan noted nodes (zero edges in result) and bridge paths to reconnect them.
 * BFS from each orphan to the nearest connected noted node through the full graph.
 * Returns intermediate bridge nodes + edges to inject into the result.
 * Diamond-safe: bridge paths respect existing graph topology.
 * Edge direction: uses edgeTypeMap to emit edges in actual directed order, not BFS traversal order.
 */
export function findBridgeNodes(
  graph: Graph,
  notedIds: ReadonlySet<string>,
  resultEdges: ReadonlyArray<[string, string, string]>,
  edgeTypeMap: ReadonlyMap<string, string>,
): BridgeResult {
  // Identify nodes that participate in at least one result edge
  const edgeParticipants = new Set<string>();
  for (const [s, t] of resultEdges) {
    edgeParticipants.add(s);
    edgeParticipants.add(t);
  }

  // Orphans = noted nodes with zero edges in the result
  const orphans = [...notedIds].filter(id => !edgeParticipants.has(id));
  if (orphans.length === 0) return { bridgeNodes: [], bridgeEdges: [], orphanCount: 0, reconnectedCount: 0 };

  const bridgeNodes: BridgeNode[] = [];
  const bridgeEdges: Array<[string, string, string]> = [];
  const addedBridgeIds = new Set<string>();
  const addedEdgeKeys = new Set<string>();
  let reconnected = 0;

  for (const orphanId of orphans) {
    // BFS from orphan to nearest node in edgeParticipants (the connected component)
    const path = bfsShortestPath(graph, orphanId, edgeParticipants, edgeTypeMap);
    if (!path) continue; // truly disconnected — no path exists
    reconnected++;

    // Add intermediate bridge nodes
    for (const nodeId of path.intermediates) {
      if (!addedBridgeIds.has(nodeId) && !notedIds.has(nodeId)) {
        addedBridgeIds.add(nodeId);
        if (graph.hasNode(nodeId)) {
          const attrs = graph.getNodeAttributes(nodeId);
          bridgeNodes.push({
            id: nodeId,
            schema: (attrs.schema as string) ?? '',
            name: nodeId.replace(/^\[.*?\]\.\[/, '').replace(/\]$/, ''), // extract name from [schema].[name]
            type: (attrs.type as string) ?? 'unknown',
          });
        }
      }
    }

    // Add edges along the path — already in correct directed order from bfsShortestPath
    for (const [s, t] of path.edgePairs) {
      const key = `${s}→${t}`;
      if (!addedEdgeKeys.has(key)) {
        addedEdgeKeys.add(key);
        const type = edgeTypeMap.get(key) ?? 'read';
        bridgeEdges.push([s, t, type]);
      }
    }
  }

  return { bridgeNodes, bridgeEdges, orphanCount: orphans.length, reconnectedCount: reconnected };
}

// ─── BFS Depth Map ───────────────────────────────────────────────────────────

/**
 * Directed BFS from originNodeId over a result-graph edge list.
 * Returns the minimum distance (in hops) from origin to each reachable node.
 * Used by orderAndAssemble() to sort badge groups in data-flow order.
 *
 * @param edges  Flat edge list from ResultGraph — [source, target, type].
 * @param originNodeId  The root node; gets depth 0.
 * @returns Map<nodeId, depth>. Nodes unreachable from origin are absent (treated as Infinity).
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

// ─── Private BFS Utilities ───────────────────────────────────────────────────

/**
 * BFS shortest path from startId to any node in targetSet.
 * Returns intermediate nodes + edge pairs in correct directed order (via edgeTypeMap lookup).
 * Undirected traversal via graph.neighbors — finds path regardless of edge direction.
 */
function bfsShortestPath(
  graph: Graph,
  startId: string,
  targetSet: ReadonlySet<string>,
  edgeTypeMap: ReadonlyMap<string, string>,
): { intermediates: string[]; edgePairs: Array<[string, string]> } | null {
  if (targetSet.has(startId)) return { intermediates: [], edgePairs: [] };
  if (!graph.hasNode(startId)) return null;

  const parent = new Map<string, string>();
  const queue = [startId];
  parent.set(startId, '');
  let idx = 0;

  while (idx < queue.length) {
    const id = queue[idx++];
    if (!graph.hasNode(id)) continue;
    for (const nid of graph.neighbors(id)) {
      if (parent.has(nid)) continue;
      parent.set(nid, id);
      if (targetSet.has(nid)) {
        // Reconstruct path: startId → ... → nid
        const intermediates: string[] = [];
        const edgePairs: Array<[string, string]> = [];
        let cur = nid;
        while (cur !== startId) {
          const prev = parent.get(cur)!;
          // Emit edge in actual directed order — not BFS traversal order
          if (edgeTypeMap.has(`${prev}→${cur}`)) {
            edgePairs.unshift([prev, cur]);
          } else {
            edgePairs.unshift([cur, prev]); // actual directed edge is cur→prev
          }
          if (cur !== nid && cur !== startId) intermediates.push(cur);
          cur = prev;
        }
        return { intermediates, edgePairs };
      }
      queue.push(nid);
    }
  }
  return null; // no path exists
}
