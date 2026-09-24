import type Graph from 'graphology';
import type { TraceState } from '../engine/types';

/**
 * Tree placement relative to the origin: `up` follows inbound edges, `down` outbound edges,
 * `connected` holds visible nodes neither directional walk reaches.
 */
export type TraceTreeSide = 'up' | 'down' | 'connected';

/** A group of tree nodes with their per-node grow candidates. */
export interface TraceTreeGroup {
  /** Tree placement of this group. */
  side: TraceTreeSide;
  /** Visible node ids in first-visit order. */
  nodeIds: string[];
  /**
   * Out-of-scope neighbors per node, in the group's direction (`up` inbound, `down` outbound,
   * `connected` both), pruned nodes excluded. An empty list disables the node's +level affordance.
   */
  grow: ReadonlyMap<string, string[]>;
}

/** One hop level of a trace side, depth counted outward from the origin. */
export interface TraceTreeLevel extends TraceTreeGroup {
  /** Hop distance from the origin; starts at 1. */
  depth: number;
}

/** L0-anchored projection of a trace scope for the tree navigator. */
export interface TraceTree {
  /** Trace origin id (level 0, the anchor). */
  originId: string;
  /** Upstream levels, depth 1 outward. */
  upstream: TraceTreeLevel[];
  /** Downstream levels, depth 1 outward. */
  downstream: TraceTreeLevel[];
  /** Visible nodes reached by neither directional walk; null when every node is placed. */
  connected: TraceTreeGroup | null;
  /** Total visible upstream node count, origin excluded. */
  totalUpstream: number;
  /** Total visible downstream node count, origin excluded. */
  totalDownstream: number;
}

/** Minimal trace read for tree shaping; the panel passes the live trace state through. */
export interface TraceTreeInput {
  /** Trace origin id; null when no trace is active. */
  originId: string | null;
  /** Currently visible trace node ids. */
  visibleNodeIds: ReadonlySet<string>;
  /** Manually pruned node ids, never offered as grow candidates. */
  prunedNodeIds: ReadonlySet<string>;
}

/**
 * Shapes a trace scope into an L0-anchored tree.
 *
 * Levels come from a direction-restricted breadth-first walk over the visible set, so they
 * always agree with what the canvas shows. A node reachable from both directions appears on
 * both sides; a visible node reachable from neither lands in `connected`, so every visible
 * node appears at least once. The walk is cycle-safe. A null origin or an origin outside the
 * visible set yields no tree.
 *
 * @param input - Origin, visible scope, and pruned set from the trace state.
 * @param graph - Full graphology graph (a superset of the visible scope) for traversal and grow checks.
 * @returns The anchored tree, or null when no trace is active.
 */
export function buildTraceTree(input: TraceTreeInput, graph: Graph | null): TraceTree | null {
  const { originId, visibleNodeIds, prunedNodeIds } = input;
  if (!originId || !graph || !graph.hasNode(originId) || !visibleNodeIds.has(originId)) {
    return null;
  }
  const scope = { graph, visibleNodeIds, prunedNodeIds };
  const upstream = walkSide(scope, originId, 'up');
  const downstream = walkSide(scope, originId, 'down');
  const placed = new Set<string>([originId]);
  for (const level of [...upstream, ...downstream]) level.nodeIds.forEach(id => placed.add(id));
  const unplaced = [...visibleNodeIds].filter(id => !placed.has(id) && graph.hasNode(id));
  return {
    originId,
    upstream,
    downstream,
    connected: unplaced.length > 0 ? group(scope, 'connected', unplaced) : null,
    totalUpstream: upstream.reduce((sum, level) => sum + level.nodeIds.length, 0),
    totalDownstream: downstream.reduce((sum, level) => sum + level.nodeIds.length, 0),
  };
}

/**
 * Reads the remove intent for a tree row from the live trace state.
 *
 * The tree never decides removability itself; it forwards the mode the
 * canvas already uses, so tree growth and canvas Delete stay one operation.
 */
export function traceRemoveKind(mode: TraceState['mode']): 'trace-prune' | 'none' {
  return mode === 'applied' || mode === 'filtered' ? 'trace-prune' : 'none';
}

interface Scope {
  graph: Graph;
  visibleNodeIds: ReadonlySet<string>;
  prunedNodeIds: ReadonlySet<string>;
}

function neighborsOf(graph: Graph, id: string, side: TraceTreeSide): string[] {
  if (side === 'up') return graph.inNeighbors(id);
  if (side === 'down') return graph.outNeighbors(id);
  return graph.neighbors(id);
}

function group(scope: Scope, side: TraceTreeSide, nodeIds: string[]): TraceTreeGroup {
  const grow = new Map<string, string[]>();
  for (const id of nodeIds) {
    grow.set(id, neighborsOf(scope.graph, id, side).filter(
      neighbor => !scope.visibleNodeIds.has(neighbor) && !scope.prunedNodeIds.has(neighbor),
    ));
  }
  return { side, nodeIds, grow };
}

function walkSide(scope: Scope, originId: string, side: 'up' | 'down'): TraceTreeLevel[] {
  const levels: TraceTreeLevel[] = [];
  const visited = new Set<string>([originId]);
  let frontier = [originId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of neighborsOf(scope.graph, id, side)) {
        if (!scope.visibleNodeIds.has(neighbor) || visited.has(neighbor)) continue;
        visited.add(neighbor);
        next.push(neighbor);
      }
    }
    if (next.length === 0) break;
    levels.push({ ...group(scope, side, next), depth: levels.length + 1 });
    frontier = next;
  }
  return levels;
}
