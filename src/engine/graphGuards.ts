/** Shared graph-integrity guards — pure graph algorithms for scope edits. */

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

/** Finds the shortest directed dependency path between two endpoints, trying both directions. */
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


/** Logging callback injected into state machines for operational tracing. */
export type LogFn = (level: 'info' | 'debug' | 'warn' | 'error', msg: string, err?: unknown) => void;

/** Directional side of a lineage node when listing direct neighbors. */
export type NeighborSide = 'in' | 'out';


/** Performs a BFS reachability check from a starting node, respecting a set of removed (pruned) nodes. */
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

/** Analyzes the same pruning policy for AI navigation and interactive traces. */
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

/** Returns exact direct neighbors for one node and lineage side. */
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
