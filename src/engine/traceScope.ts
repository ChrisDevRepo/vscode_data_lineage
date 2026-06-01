/**
 * Pure helpers for interactive trace scope edits.
 *
 * These functions keep the webview trace UX aligned with SM graph-integrity
 * rules: the origin is an anchor, prune is disabled when it would disconnect
 * the remaining trace, and traversal is cycle-safe.
 */

import type Graph from 'graphology';
import type { LineageEdge, TraceState } from './types';
import { firstDisconnectedRequiredNode } from './graphGuards';

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
 * Detects an in-place trace-scope edit on top of the same original BFS scope.
 *
 * The graph canvas uses this to preserve the user's viewport while they add or
 * prune trace neighbours. Fresh traces, depth changes, full-model toggles, path
 * changes, and analysis scopes still use the normal fit/zoom behavior.
 *
 * @param previous - Existing preview state.
 * @param next - Next trace state to compare.
 *
 * @returns Whether manual trace scope edit.
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

/** Result of validating whether a visible trace node can be pruned safely. */
export interface TracePruneCheck {
  /** True when pruning preserves origin reachability for all remaining visible trace nodes. */
  safe: boolean;
  /** Stable reason code when pruning is rejected. */
  reason?: 'origin' | 'not-visible' | 'disconnected';
  /** First remaining node that would become disconnected from the origin. */
  disconnectedNodeId?: string;
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
 * @returns String result.
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
 * @returns String result.
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
 * Checks whether removing one visible trace node preserves origin reachability.
 *
 * @remarks
 * Delegates to {@link firstDisconnectedRequiredNode}, the same disconnect guard
 * the NavigationEngine applies to hop-by-hop prunes. The walk is scoped to the
 * visible trace nodes and undirected: pruning a connector is unsafe when any
 * remaining visible node would no longer be reachable from the origin,
 * irrespective of lineage edge direction.
 *
 * @param graph - Graphology graph spanning the trace nodes and their edges.
 * @param originNodeId - Origin node ID (anchor, never prunable).
 * @param visibleNodeIds - Currently visible node IDs.
 * @param candidateNodeId - Node ID being tested.
 *
 * @returns Structured result.
 */
export function canPruneTraceNode(
  graph: Graph,
  originNodeId: string | null,
  visibleNodeIds: ReadonlySet<string>,
  candidateNodeId: string,
): TracePruneCheck {
  if (!originNodeId || candidateNodeId === originNodeId) return { safe: false, reason: 'origin' };
  if (!visibleNodeIds.has(candidateNodeId)) return { safe: false, reason: 'not-visible' };
  if (!visibleNodeIds.has(originNodeId)) return { safe: false, reason: 'origin' };

  const required = new Set(visibleNodeIds);
  required.delete(candidateNodeId);
  const removed = new Set<string>([candidateNodeId]);
  const disconnected = firstDisconnectedRequiredNode(graph, originNodeId, removed, required, visibleNodeIds);
  if (disconnected) return { safe: false, reason: 'disconnected', disconnectedNodeId: disconnected };
  return { safe: true };
}
