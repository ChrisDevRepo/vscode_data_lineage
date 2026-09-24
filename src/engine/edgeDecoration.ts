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

/**
 * Edge density of the rendered graph in [0, 1]: 0 up to {@link SPARSE_EDGE_COUNT} edges, 1 from
 * {@link DENSE_EDGE_COUNT}, log-linear between.
 *
 * @remarks
 * The canvas root carries it as `--ln-edge-density`; the CSS in `src/index.css` fades the edge color
 * toward transparent and thins the stroke by it, down to per-theme floors, so overlapping lines on a
 * large graph read as density instead of solid ink while a small graph keeps its full-strength lines.
 *
 * @param edgeCount - Edges rendered on the canvas.
 * @returns The density, rounded to {@link DENSITY_STEP}.
 */
export function edgeDensity(edgeCount: number): number {
  if (edgeCount <= SPARSE_EDGE_COUNT) return 0;
  if (edgeCount >= DENSE_EDGE_COUNT) return 1;
  const density = Math.log(edgeCount / SPARSE_EDGE_COUNT) / Math.log(DENSE_EDGE_COUNT / SPARSE_EDGE_COUNT);
  return Number((Math.round(density / DENSITY_STEP) * DENSITY_STEP).toFixed(2));
}

/**
 * Creates the retention map {@link decorateFlowEdges} reuses across renders.
 *
 * @returns An empty cache, owned by the caller for the lifetime of the canvas.
 */
export function createEdgeDecorationCache(): EdgeDecorationCache {
  return new Map();
}

/**
 * Applies the click-selection connected/dimmed style to each edge, reusing the previous result
 * whenever an edge's connectedness and animation eligibility are unchanged.
 *
 * @remarks
 * Mirrors {@link decorateFlowNodes} (`src/engine/nodeDecoration.ts`): an edge connected to
 * `connectedTo` is marked {@link LIT_CLASS_NAME} and `animated`; the lit stroke color/width and the
 * dimmed 0.35-opacity, scaled-down appearance of every other edge are both expressed once as CSS
 * rules keyed off `.ln-has-selection` and {@link LIT_CLASS_NAME} (`src/index.css`), reading each
 * edge's own base width back out of the `--ln-edge-w` custom property `GraphCanvas.tsx` sets when
 * the edge is built. An edge's object identity therefore never needs to change just because a
 * *different* node was clicked.
 *
 * @param edges - Edges to decorate, in render order.
 * @param connectedTo - Node whose incident edges are lit; null/undefined when nothing is focused.
 * @param litAnimated - Whether a lit edge animates, already resolved from config and the rendered
 * edge count.
 * @param cache - Retention map from {@link createEdgeDecorationCache}, mutated in place.
 * @param routeEdgeIds - `source→target` keys of a lit route; when given, only route edges are lit
 * (either direction, matching the bidirectional-edge aliasing) instead of every incident edge.
 * @returns The decorated edges, in the order given.
 */
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
      ? routeEdgeIds.has(`${edge.source}→${edge.target}`) || routeEdgeIds.has(`${edge.target}→${edge.source}`)
      : !!connectedTo && (edge.source === connectedTo || edge.target === connectedTo);
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
