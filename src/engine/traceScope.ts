/** Pure helpers for interactive trace scope edits. */

import type Graph from 'graphology';
import type { DatabaseModel, LineageEdge, TraceState } from './types';
import { bfsFromNode } from 'graphology-traversal';
import { buildGraphologyGraph } from './graphBuilder';
import { analyzeRemoval, bfsReachable, type RemovalSide } from './graphGuards';

/** Whether a trace mode permits manual add/prune edits. */
export function isEditableTraceMode(mode: TraceState['mode']): boolean {
  return mode === 'applied' || mode === 'filtered';
}

function sameIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

/** Detects (does not apply) an in-place trace-scope edit on top of the same original BFS scope. */
export function isManualTraceScopeEdit(
  previous: TraceState,
  next: TraceState,
): boolean {
  if (!isEditableTraceMode(previous.mode) || !isEditableTraceMode(next.mode))
    return false;
  if (previous.selectedNodeId !== next.selectedNodeId) return false;
  if (previous.targetNodeId !== next.targetNodeId) return false;
  if (previous.upstreamLevels !== next.upstreamLevels) return false;
  if (previous.downstreamLevels !== next.downstreamLevels) return false;
  if (previous.autoPromoted !== next.autoPromoted) return false;
  if (!sameIdSet(previous.baseNodeIds, next.baseNodeIds)) return false;
  if (!sameIdSet(previous.baseEdgeIds, next.baseEdgeIds)) return false;

  return (
    !sameIdSet(previous.manualAddedNodeIds, next.manualAddedNodeIds) ||
    !sameIdSet(previous.manualPrunedNodeIds, next.manualPrunedNodeIds)
  );
}

/** Result of validating whether a visible trace node can be pruned. */
export interface TracePruneCheck {
  /** True when the candidate is prunable — the origin and every out-of-scope node are the only refusals. */
  safe: boolean;
  /** Stable reason code when pruning is rejected. */
  reason?: 'origin' | 'not-visible';
  /** Node ids that leave together with the candidate (its subtree). Present only when `safe`. */
  cutNodeIds?: string[];
}

function edgeId(source: string, target: string): string {
  return `${source}→${target}`;
}

/** Returns all model edge IDs whose endpoints are both present in the node scope. */
export function collectScopeEdgeIds(
  edges: ReadonlyArray<LineageEdge>,
  nodeIds: ReadonlySet<string>,
): Set<string> {
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      edgeIds.add(edgeId(edge.source, edge.target));
    }
  }
  return edgeIds;
}

/** Applies manual add/prune sets on top of an original BFS trace scope. */
export function buildVisibleTraceScope(
  baseNodeIds: ReadonlySet<string>,
  manualAddedNodeIds: ReadonlySet<string>,
  manualPrunedNodeIds: ReadonlySet<string>,
  edges: ReadonlyArray<LineageEdge>,
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const nodeIds = new Set<string>(baseNodeIds);
  for (const id of manualAddedNodeIds) nodeIds.add(id);
  for (const id of manualPrunedNodeIds) nodeIds.delete(id);
  return { nodeIds, edgeIds: collectScopeEdgeIds(edges, nodeIds) };
}

/** Builds the traversal graph for a trace scope from the full model. */
export function buildTraceScopeGraph(
  model: DatabaseModel,
  nodeIds: ReadonlySet<string>,
): Graph {
  return buildGraphologyGraph({
    ...model,
    nodes: model.nodes.filter((n) => nodeIds.has(n.id)),
    edges: model.edges.filter(
      (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
    ),
  });
}

/** Unions every origin↔target connecting path for a route set. */
export function unionConnectingPaths(
  graph: Graph,
  originId: string,
  targetIds: ReadonlyArray<string>,
): { nodeIds: Set<string>; edgeIds: Set<string> } | null {
  if (!graph.hasNode(originId)) return null;
  const nodeIds = new Set<string>([originId]);
  const edgeIds = new Set<string>();
  for (const targetId of targetIds) {
    if (targetId === originId) continue;
    if (!graph.hasNode(targetId)) return null;
    const route =
      pathsBetween(graph, originId, targetId) ??
      pathsBetween(graph, targetId, originId);
    if (!route) return null;
    for (const id of route.nodeIds) nodeIds.add(id);
    for (const id of route.edgeIds) edgeIds.add(id);
  }
  return { nodeIds, edgeIds };
}

function pathsBetween(
  graph: Graph,
  sourceId: string,
  sinkId: string,
): { nodeIds: Set<string>; edgeIds: Set<string> } | null {
  const fromSource = reachable(graph, sourceId, 'outbound', sinkId);
  if (!fromSource.has(sinkId)) return null;
  const toSink = reachable(graph, sinkId, 'inbound', sourceId);
  const nodeIds = new Set([...fromSource].filter((id) => toSink.has(id)));
  const edgeIds = new Set<string>();
  for (const id of nodeIds) {
    if (id === sinkId) continue;
    graph.forEachOutEdge(id, (edge, _attrs, _source, target) => {
      if (target !== sourceId && nodeIds.has(target)) edgeIds.add(edge);
    });
  }
  return { nodeIds, edgeIds };
}

/** Nodes reachable from `startId` in `mode`, never expanding past `stopId`. */
function reachable(
  graph: Graph,
  startId: string,
  mode: 'inbound' | 'outbound',
  stopId: string,
): Set<string> {
  const seen = new Set<string>();
  bfsFromNode(
    graph,
    startId,
    (id) => {
      seen.add(id);
      return id === stopId;
    },
    { mode },
  );
  return seen;
}

/** Gets the fixed pruning legs from the trace's effective open levels. */
export function traceRemovalSides(
  upstreamLevels: number,
  downstreamLevels: number,
): RemovalSide[] {
  const sides: RemovalSide[] = [];
  if (upstreamLevels > 0) sides.push('upstream');
  if (downstreamLevels > 0) sides.push('downstream');
  return sides;
}

/** Previews the shared directed self-prune policy for one visible trace node. */
export function canPruneTraceNode(
  graph: Graph,
  originNodeId: string | null,
  visibleNodeIds: ReadonlySet<string>,
  candidateNodeId: string,
  sides: ReadonlyArray<RemovalSide>,
): TracePruneCheck {
  if (!originNodeId || candidateNodeId === originNodeId)
    return { safe: false, reason: 'origin' };
  if (!visibleNodeIds.has(candidateNodeId) || !graph.hasNode(candidateNodeId))
    return { safe: false, reason: 'not-visible' };
  if (!visibleNodeIds.has(originNodeId) || !graph.hasNode(originNodeId))
    return { safe: false, reason: 'origin' };
  const analysis = analyzeRemoval(graph, {
    originId: originNodeId,
    scope: visibleNodeIds,
    removedBefore: new Set(),
    removedAfter: new Set([candidateNodeId]),
    currentNodeId: candidateNodeId,
    visited: new Set(),
    sides,
  });
  if (analysis.rejection)
    return {
      safe: false,
      reason: analysis.rejection === 'origin' ? 'origin' : 'not-visible',
    };
  const leaving = new Set([candidateNodeId, ...analysis.cutIds]);
  const linkedBefore = bfsReachable(
    graph,
    originNodeId,
    new Set(),
    undefined,
    visibleNodeIds,
  );
  const linkedAfter = bfsReachable(
    graph,
    originNodeId,
    leaving,
    undefined,
    visibleNodeIds,
  );
  const stranded = [...linkedBefore].filter(
    (id) => !leaving.has(id) && !linkedAfter.has(id),
  );
  return { safe: true, cutNodeIds: [...analysis.cutIds, ...stranded] };
}
