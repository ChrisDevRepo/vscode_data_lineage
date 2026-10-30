import type { Edge as FlowEdge } from '@xyflow/react';
import { LIT_CLASS_NAME, pruneStaleEntries, sameKey } from './nodeDecoration';

/** One edge id's last decoration, kept with the source object that produced it. */
interface EdgeCacheEntry {
  source: FlowEdge;
  key: readonly unknown[];
  result: FlowEdge;
}

/** Retains the decorated edge produced for each id across renders. */
type EdgeDecorationCache = Map<string, EdgeCacheEntry>;

/** Rendered edge count up to which edges keep their full color and width. */
const SPARSE_EDGE_COUNT = 100;
/** Rendered edge count from which edges sit at the theme's floor color strength and width. */
const DENSE_EDGE_COUNT = 2000;
/** Density step; one rounding step keeps a single trimmed or added edge from repainting every edge. */
const DENSITY_STEP = 0.05;

/** Edge density of the rendered graph in [0, 1]: 0 up to {@link SPARSE_EDGE_COUNT} edges, 1 from {@link DENSE_EDGE_COUNT}, log-linear between. */
export function edgeDensity(edgeCount: number): number {
  if (edgeCount <= SPARSE_EDGE_COUNT) return 0;
  if (edgeCount >= DENSE_EDGE_COUNT) return 1;
  const density =
    Math.log(edgeCount / SPARSE_EDGE_COUNT) /
    Math.log(DENSE_EDGE_COUNT / SPARSE_EDGE_COUNT);
  return Number((Math.round(density / DENSITY_STEP) * DENSITY_STEP).toFixed(2));
}

/** Creates the retention map {@link decorateFlowEdges} reuses across renders. */
export function createEdgeDecorationCache(): EdgeDecorationCache {
  return new Map();
}

/** Applies the click-selection connected/dimmed style to each edge, reusing the previous result whenever an edge's connectedness and animation eligibility are unchanged. */
export function decorateFlowEdges(
  edges: readonly FlowEdge[],
  connectedTo: string | null | undefined,
  litAnimated: boolean,
  cache: EdgeDecorationCache,
  routeEdgeIds?: ReadonlySet<string>,
): FlowEdge[] {
  const present = new Set<string>();
  const decorated = edges.map((edge) => {
    present.add(edge.id);
    const connected = routeEdgeIds
      ? routeEdgeIds.has(`${edge.source}→${edge.target}`) ||
        routeEdgeIds.has(`${edge.target}→${edge.source}`)
      : !!connectedTo &&
        (edge.source === connectedTo || edge.target === connectedTo);
    const key = [connected, connected && litAnimated] as const;
    const cached = cache.get(edge.id);
    if (cached && cached.source === edge && sameKey(cached.key, key)) {
      return cached.result;
    }
    const result: FlowEdge = connected
      ? { ...edge, className: LIT_CLASS_NAME, animated: litAnimated }
      : edge;
    cache.set(edge.id, { source: edge, key, result });
    return result;
  });
  pruneStaleEntries(cache, present);
  return decorated;
}
