import type Graph from 'graphology';
import type { TraceState } from '../engine/types';

/** Trace side relative to the origin: `up` follows inbound edges, `down` outbound edges. */
export type TraceTreeSide = 'up' | 'down';

/** One hop level of a trace side, depth counted outward from the origin. */
export interface TraceTreeLevel {
  /** Trace side this level belongs to. */
  side: TraceTreeSide;
  /** Hop distance from the origin; starts at 1. */
  depth: number;
  /** Visible node ids at exactly this depth, in first-visit order. */
  nodeIds: string[];
}

/** L0-anchored projection of a trace scope for the tree navigator. */
export interface TraceTree {
  /** Trace origin id (level 0, the anchor). */
  originId: string;
  /** Upstream levels, depth 1 outward. */
  upstream: TraceTreeLevel[];
  /** Downstream levels, depth 1 outward. */
  downstream: TraceTreeLevel[];
  /** Total visible upstream node count, origin excluded. */
  totalUpstream: number;
  /** Total visible downstream node count, origin excluded. */
  totalDownstream: number;
  /**
   * Per-leaf grow candidates: visible leaf id to out-of-scope neighbor ids
   * in the full graph, pruned nodes excluded. An empty list means the leaf
   * cannot grow and its +level affordance renders disabled.
   */
  leafGrow: Map<string, string[]>;
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
 * Levels come from a direction-restricted breadth-first walk over the visible
 * set, so they always agree with what the canvas shows. A node reachable from
 * both directions appears on both sides. The walk is cycle-safe. A null
 * origin or an origin outside the visible set yields an empty tree.
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
  const upstream = walkSide(graph, originId, visibleNodeIds, 'up');
  const downstream = walkSide(graph, originId, visibleNodeIds, 'down');
  const leafGrow = new Map<string, string[]>();
  for (const level of [...upstream, ...downstream]) {
    for (const id of level.nodeIds) {
      leafGrow.set(id, growCandidates(graph, id, visibleNodeIds, prunedNodeIds));
    }
  }
  return {
    originId,
    upstream,
    downstream,
    totalUpstream: upstream.reduce((sum, level) => sum + level.nodeIds.length, 0),
    totalDownstream: downstream.reduce((sum, level) => sum + level.nodeIds.length, 0),
    leafGrow,
  };
}

/**
 * Reads the remove intent for a tree row from the live trace state.
 *
 * The tree never decides removability itself; it forwards the mode the
 * canvas already uses, so tree Delete and canvas Delete stay one operation.
 */
export function traceRemoveKind(mode: TraceState['mode']): 'trace-prune' | 'none' {
  return mode === 'applied' || mode === 'filtered' ? 'trace-prune' : 'none';
}

function neighborsOf(graph: Graph, id: string, side: TraceTreeSide): string[] {
  return side === 'up' ? graph.inNeighbors(id) : graph.outNeighbors(id);
}

function walkSide(
  graph: Graph,
  originId: string,
  visibleNodeIds: ReadonlySet<string>,
  side: TraceTreeSide,
): TraceTreeLevel[] {
  const levels: TraceTreeLevel[] = [];
  const visited = new Set<string>([originId]);
  let frontier = [originId];
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of neighborsOf(graph, id, side)) {
        if (!visibleNodeIds.has(neighbor) || visited.has(neighbor)) continue;
        visited.add(neighbor);
        next.push(neighbor);
      }
    }
    if (next.length === 0) break;
    levels.push({ side, depth, nodeIds: next });
    frontier = next;
  }
  return levels;
}

function growCandidates(
  graph: Graph,
  id: string,
  visibleNodeIds: ReadonlySet<string>,
  prunedNodeIds: ReadonlySet<string>,
): string[] {
  if (!graph.hasNode(id)) return [];
  const candidates = new Set<string>();
  for (const neighbor of graph.neighbors(id)) {
    if (!visibleNodeIds.has(neighbor) && !prunedNodeIds.has(neighbor)) {
      candidates.add(neighbor);
    }
  }
  return [...candidates];
}
