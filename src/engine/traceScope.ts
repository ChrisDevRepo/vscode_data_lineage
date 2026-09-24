/**
 * Pure helpers for interactive trace scope edits.
 *
 * These functions keep the webview trace UX aligned with SM graph-integrity
 * rules: the origin is an anchor, a prune takes the subtree reachable only
 * through the pruned node with it, and traversal is cycle-safe.
 */

import type Graph from 'graphology';
import type { DatabaseModel, LineageEdge, TraceState } from './types';
import { buildGraphologyGraph, computeShortestPath } from './graphBuilder';
import { nodesCutByRemoval } from './graphGuards';

/**
 * Whether a trace mode permits manual add/prune edits.
 *
 * Only an applied or filter-narrowed trace is editable; config, pathfinding,
 * and analysis-subset modes expose no neighbor controls.
 *
 * @param mode - Trace mode to evaluate.
 *
 * @returns Whether editable trace mode.
 */
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

/**
 * Detects (does not apply) an in-place trace-scope edit on top of the same original BFS scope.
 *
 * The graph canvas calls this and, when it returns `true`, preserves the user's viewport while
 * they add or prune trace neighbours. Fresh traces, depth changes, full-model toggles, path
 * changes, and analysis scopes return `false` and so use the normal fit/zoom behavior.
 *
 * @param previous - Existing preview state.
 * @param next - Next trace state to compare.
 *
 * @returns `true` when `next` is the same BFS scope as `previous` with only manual add/prune edits.
 */
export function isManualTraceScopeEdit(previous: TraceState, next: TraceState): boolean {
  if (!isEditableTraceMode(previous.mode) || !isEditableTraceMode(next.mode)) return false;
  if (previous.selectedNodeId !== next.selectedNodeId) return false;
  if (previous.targetNodeId !== next.targetNodeId) return false;
  if (previous.upstreamLevels !== next.upstreamLevels) return false;
  if (previous.downstreamLevels !== next.downstreamLevels) return false;
  if (previous.autoPromoted !== next.autoPromoted) return false;
  if (!sameIdSet(previous.baseNodeIds, next.baseNodeIds)) return false;
  if (!sameIdSet(previous.baseEdgeIds, next.baseEdgeIds)) return false;

  return !sameIdSet(previous.manualAddedNodeIds, next.manualAddedNodeIds)
    || !sameIdSet(previous.manualPrunedNodeIds, next.manualPrunedNodeIds);
}

/**
 * Result of validating whether a visible trace node can be pruned.
 *
 * @remarks
 * A prune takes its subtree with it, so only the origin and a node outside the visible scope
 * are refused.
 */
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

/**
 * Returns all model edge IDs whose endpoints are both present in the node scope.
 *
 * @param edges - Edges available for traversal.
 * @param nodeIds - Node IDs to inspect.
 *
 * @returns Edge IDs whose source and target are both inside the node scope.
 */
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

/**
 * Applies manual add/prune sets on top of an original BFS trace scope.
 *
 * @param baseNodeIds - Original trace node IDs.
 * @param manualAddedNodeIds - Nodes manually added to the trace.
 * @param manualPrunedNodeIds - Nodes manually removed from the trace.
 * @param edges - Edges available for traversal.
 *
 * @returns Visible node IDs plus the edge IDs connecting those visible nodes.
 */
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

/**
 * Checks whether one visible trace node can be pruned, and what leaves with it.
 *
 * @remarks
 * A self-prune like the AI backend's `end_branch`: the candidate leaves together with its
 * subtree — every node reachable from the origin only through it — computed by
 * {@link nodesCutByRemoval}, the same cut the NavigationEngine applies at a hop resolution. The
 * walk is scoped to the visible trace nodes and undirected: relevance in a trace runs both ways.
 * The result never leaves an island, and the origin is never removable.
 *
 * @param graph - Graphology graph spanning the trace nodes and their edges.
 * @param originNodeId - Origin node ID (anchor, never prunable).
 * @param visibleNodeIds - Currently visible node IDs.
 * @param candidateNodeId - Node ID being tested.
 *
 * @returns Prune verdict; `cutNodeIds` lists the subtree leaving alongside the candidate when safe.
 */
/**
 * Unions the origin→target shortest paths for a focus set.
 *
 * Returns null when the origin is unknown to the graph or any target is
 * unreachable: focus is all-or-nothing, never a partial union.
 *
 * @param graph - Graph spanning the trace scope.
 * @param originId - Focus anchor (the trace origin).
 * @param targetIds - Checked node ids, origin excluded by the caller.
 * @returns Unioned path node and edge ids, or null when any leg fails.
 */
/**
 * Builds the traversal graph for a trace scope from the full model.
 *
 * Mirrors the scope graph `applyTraceToFlow` builds when synthesis runs, so
 * focus and path operations see the same node/edge membership on every trace,
 * not only on synthesized ones.
 *
 * @param model - The full database model.
 * @param nodeIds - Trace scope membership; edges leaving the scope are dropped.
 * @returns Graphology graph over the scope.
 */
export function buildTraceScopeGraph(model: DatabaseModel, nodeIds: ReadonlySet<string>): Graph {
  return buildGraphologyGraph({
    ...model,
    nodes: model.nodes.filter((n) => nodeIds.has(n.id)),
    edges: model.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target)),
  });
}

export function unionShortestPaths(
  graph: Graph,
  originId: string,
  targetIds: ReadonlyArray<string>,
): { nodeIds: Set<string>; edgeIds: Set<string> } | null {
  if (!graph.hasNode(originId)) return null;
  const nodeIds = new Set<string>([originId]);
  const edgeIds = new Set<string>();
  for (const targetId of targetIds) {
    if (targetId === originId) continue;
    const leg = computeShortestPath(graph, originId, targetId);
    if (!leg) return null;
    for (const id of leg.nodeIds) nodeIds.add(id);
    for (const id of leg.edgeIds) edgeIds.add(id);
  }
  return { nodeIds, edgeIds };
}

export function canPruneTraceNode(
  graph: Graph,
  originNodeId: string | null,
  visibleNodeIds: ReadonlySet<string>,
  candidateNodeId: string,
): TracePruneCheck {
  if (!originNodeId || candidateNodeId === originNodeId) return { safe: false, reason: 'origin' };
  if (!visibleNodeIds.has(candidateNodeId)) return { safe: false, reason: 'not-visible' };
  if (!visibleNodeIds.has(originNodeId)) return { safe: false, reason: 'origin' };

  const cutNodeIds = nodesCutByRemoval(
    graph,
    originNodeId,
    new Set<string>(),
    new Set<string>([candidateNodeId]),
    visibleNodeIds,
  );
  return { safe: true, cutNodeIds };
}
