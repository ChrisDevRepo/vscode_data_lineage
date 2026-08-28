/**
 * Covers the host-side exported `graphBuilder` surface that no test named: pathfinding,
 * the layout engine and its cache, graph metrics, and the no-layout build.
 *
 * These sit between the BFS trace and what the user sees. A defect here shows as a
 * correct trace rendered wrongly — a node missing from the view, an edge dropped —
 * which no analysis-level test can detect.
 *
 * `applyTraceToFlow` is covered in tests/unit/webview/applyTraceToFlow.test.ts: it runs
 * only under the webview hook, and its warning path reaches `window`.
 */

import { describe, expect, it } from 'vitest';
import {
  buildGraphNoLayout,
  computeShortestPath,
  dagreLayout,
  getGraphMetrics,
  traceNodeWithLevels,
} from '../../../src/engine/graphBuilder';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { loadAdventureWorksModel, makeGraph } from '../helpers/testUtils';

/** `A → B → C`, plus `D` joining at `C`, and an unreachable `Z`. */
function chain() {
  return makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'Z' }],
    [['A', 'B'], ['B', 'C'], ['D', 'C']],
  );
}

// ─── computeShortestPath ──────────────────────────────────────────────────────

describe('computeShortestPath', () => {
  it('returns every node and edge along a directed path', () => {
    const result = computeShortestPath(chain(), 'A', 'C');
    expect(result).not.toBeNull();
    expect([...result!.nodeIds]).toEqual(['A', 'B', 'C']);
    expect(result!.edgeIds.size).toBe(2);
  });

  it('finds the path when the endpoints are given in reverse (bidirectional retry)', () => {
    const result = computeShortestPath(chain(), 'C', 'A');
    expect(result).not.toBeNull();
    expect(result!.nodeIds).toEqual(new Set(['A', 'B', 'C']));
  });

  it('returns the single node for a path from a node to itself', () => {
    expect([...computeShortestPath(chain(), 'A', 'A')!.nodeIds]).toEqual(['A']);
  });

  it.each([
    ['unknown source', 'nope', 'C'],
    ['unknown target', 'A', 'nope'],
    ['no connecting path', 'A', 'Z'],
  ])('returns null for %s', (_label, source, target) => {
    expect(computeShortestPath(chain(), source, target)).toBeNull();
  });
});

// ─── getGraphMetrics ──────────────────────────────────────────────────────────

describe('getGraphMetrics', () => {
  it('counts roots by in-degree and leaves by out-degree', () => {
    // A and D have no inbound edge; C has no outbound. Z is isolated, so it is both.
    expect(getGraphMetrics(chain())).toEqual({
      totalNodes: 5,
      totalEdges: 3,
      rootNodes: 3,
      leafNodes: 2,
    });
  });

  it('reports an empty graph as all zeroes', () => {
    expect(getGraphMetrics(makeGraph([], []))).toEqual({
      totalNodes: 0, totalEdges: 0, rootNodes: 0, leafNodes: 0,
    });
  });
});

// ─── dagreLayout ──────────────────────────────────────────────────────────────

describe('dagreLayout', () => {
  const input = () => ({
    nodeIds: ['A', 'B', 'C'],
    edges: [{ source: 'A', target: 'B' }, { source: 'B', target: 'C' }],
    config: DEFAULT_CONFIG,
  });

  it('positions every requested node', () => {
    const positions = dagreLayout(input());
    expect([...positions.keys()].sort()).toEqual(['A', 'B', 'C']);
    for (const point of positions.values()) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    }
  });

  it('serves an identical request from the cache rather than re-running dagre', () => {
    const first = dagreLayout(input());
    expect(dagreLayout(input())).toBe(first);
  });

  it('treats a different direction as a different layout, not a cache hit', () => {
    const horizontal = dagreLayout({ ...input(), direction: 'LR' });
    expect(dagreLayout({ ...input(), direction: 'TB' })).not.toBe(horizontal);
  });

  it('treats different node sizes as a different layout — sizeOf is part of the cache key', () => {
    const narrow = dagreLayout({ ...input(), sizeOf: () => ({ width: 10, height: 10 }) });
    const wide = dagreLayout({ ...input(), sizeOf: () => ({ width: 400, height: 90 }) });
    expect(wide).not.toBe(narrow);
    const moved = ['A', 'B', 'C'].some(id => wide.get(id)!.x !== narrow.get(id)!.x || wide.get(id)!.y !== narrow.get(id)!.y);
    expect(moved).toBe(true);
  });

  it('returns an empty map for no nodes instead of throwing', () => {
    expect(dagreLayout({ nodeIds: [], edges: [], config: DEFAULT_CONFIG }).size).toBe(0);
  });
});

// ─── buildGraphNoLayout ───────────────────────────────────────────────────────

describe('buildGraphNoLayout', () => {
  it('builds the full node and edge set with positions left at the origin', async () => {
    const model = await loadAdventureWorksModel();
    const result = buildGraphNoLayout(model);

    expect(result.flowNodes.length).toBeGreaterThan(0);
    expect(result.graph.order).toBe(result.flowNodes.length);
    for (const flowNode of result.flowNodes) {
      expect(flowNode.position).toEqual({ x: 0, y: 0 });
    }
  });
});

// ─── traceNodeWithLevels — asymmetric depth ───────────────────────────────────

describe('traceNodeWithLevels — directional depth caps', () => {
  it('walks upstream only when the downstream cap is zero', () => {
    const result = traceNodeWithLevels(chain(), 'B', 1, 0);
    expect(result.nodeIds).toEqual(new Set(['A', 'B']));
  });

  it('walks downstream only when the upstream cap is zero', () => {
    const result = traceNodeWithLevels(chain(), 'B', 0, 1);
    expect(result.nodeIds).toEqual(new Set(['B', 'C']));
  });

  it('returns the origin alone when both caps are zero', () => {
    expect(traceNodeWithLevels(chain(), 'B', 0, 0).nodeIds).toEqual(new Set(['B']));
  });

  it('returns nothing for an unknown origin', () => {
    expect(traceNodeWithLevels(chain(), 'nope', 2, 2).nodeIds.size).toBe(0);
  });
});
