/** Shortest path between two objects: the directed path, retried in reverse when the endpoints are given against the edges. */

import { describe, expect, it } from 'vitest';
import { computeShortestPath } from '../../../src/engine/graphBuilder';
import { makeGraph } from '../helpers/modelFixtures';

/** `A → B → C`, plus `D` joining at `C`, and an unreachable `Z`. */
function chain() {
  return makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'Z' }],
    [
      ['A', 'B'],
      ['B', 'C'],
      ['D', 'C'],
    ],
  );
}

describe('computeShortestPath', () => {
  it('returns every node and edge along a directed path', () => {
    const result = computeShortestPath(chain(), 'A', 'C');
    expect([...result!.nodeIds]).toEqual(['A', 'B', 'C']);
    expect(result!.edgeIds).toEqual(new Set(['A→B', 'B→C']));
  });

  it('finds the path when the endpoints are given in reverse (bidirectional retry)', () => {
    const result = computeShortestPath(chain(), 'C', 'A');
    expect(result?.nodeIds).toEqual(new Set(['A', 'B', 'C']));
    expect(result?.edgeIds).toEqual(new Set(['A→B', 'B→C']));
  });
});
