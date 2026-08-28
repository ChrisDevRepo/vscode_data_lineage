/**
 * Covers the graph shapes the traversal core has never been given.
 *
 * Every existing traversal test runs on a DAG: a chain, a star, a diamond with equal arms.
 * Nothing anywhere hands `traceNodeWithLevels`, `bfsReachable` or `findShortestPathOrdered`
 * a cycle, a self-loop, an asymmetric diamond, or a missing origin — so the termination and
 * dedup behaviour those functions rely on is assumed, never asserted. A regression that made
 * any of them revisit a node would hang the extension rather than fail a test.
 *
 * `bfsDepthMap` is included because no test called it at all; it reaches production only
 * through the AI report builder.
 */

import Graph from 'graphology';
import { describe, expect, it } from 'vitest';
import { traceNodeWithLevels } from '../../../src/engine/graphBuilder';
import {
  bfsDepthMap,
  bfsReachable,
  findShortestPathOrdered,
  firstDisconnectedRequiredNode,
} from '../../../src/engine/graphGuards';
import { makeGraph } from '../helpers/testUtils';

const NONE: ReadonlySet<string> = new Set();

/** Sorted node ids, so assertions pin membership without depending on BFS visit order. */
const traced = (graph: Graph, origin: string, up: number, down: number): string[] =>
  [...traceNodeWithLevels(graph, origin, up, down).nodeIds].sort();

/** `A -> B -> A` — the shortest cycle the extractor can produce (a read/write pair). */
const twoCycle = () => makeGraph([{ id: 'A' }, { id: 'B' }], [['A', 'B'], ['B', 'A']]);

/** `A -> B -> C -> A`. */
const threeCycle = () =>
  makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C'], ['C', 'A']]);

/** `X -> X`. */
const selfLoop = () => makeGraph([{ id: 'X' }], [['X', 'X']]);

/** `A -> B -> D` and `A -> C -> C2 -> D`: arms of length 2 and 3 converging on `D`. */
const asymmetricDiamond = () =>
  makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'C2' }, { id: 'D' }],
    [['A', 'B'], ['B', 'D'], ['A', 'C'], ['C', 'C2'], ['C2', 'D']],
  );

const emptyGraph = () => new Graph({ type: 'directed', multi: false });

// ─── Cycles ──────────────────────────────────────────────────────────────────

describe('traceNodeWithLevels — cycles', () => {
  it('terminates on a two-node cycle and returns both nodes once', () => {
    expect(traced(twoCycle(), 'A', Infinity, Infinity)).toEqual(['A', 'B']);
  });

  it('returns the same set from either member of a two-node cycle', () => {
    const graph = twoCycle();
    expect(traced(graph, 'A', Infinity, Infinity)).toEqual(traced(graph, 'B', Infinity, Infinity));
  });

  it('walks a three-node cycle all the way round in each direction', () => {
    const graph = threeCycle();
    expect(traced(graph, 'A', 0, Infinity)).toEqual(['A', 'B', 'C']);
    expect(traced(graph, 'A', Infinity, 0)).toEqual(['A', 'B', 'C']);
  });

  it('honours the depth cap inside a cycle rather than looping round to reach it', () => {
    // One hop downstream of A is B alone, even though C and A itself stay reachable.
    expect(traced(threeCycle(), 'A', 0, 1)).toEqual(['A', 'B']);
  });

  it('includes every edge of a cycle when both directions are traced', () => {
    expect(traceNodeWithLevels(threeCycle(), 'A', Infinity, Infinity).edgeIds).toEqual(
      new Set(['A→B', 'B→C', 'C→A']),
    );
  });
});

describe('traceNodeWithLevels — self-loop', () => {
  it('returns the node alone and does not hang', () => {
    expect(traced(selfLoop(), 'X', Infinity, Infinity)).toEqual(['X']);
  });

  // The gate this used to document is gone: collectTraceEdges no longer branches on the depth
  // maps, so an edge with both endpoints inside the trace is kept whatever the trace direction.
  // Reached only by a self-referencing object (a procedure that EXECs itself); no self-loop filter
  // exists in extraction, so the model can carry one.
  it('keeps the self-edge, whose endpoints are both inside the trace', () => {
    expect(traceNodeWithLevels(selfLoop(), 'X', Infinity, Infinity).edgeIds).toEqual(new Set(['X→X']));
  });
});

// ─── Depth semantics ─────────────────────────────────────────────────────────

describe('traceNodeWithLevels — depth boundary', () => {
  /** `A -> B -> C -> D`. */
  const chain = () =>
    makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      [['A', 'B'], ['B', 'C'], ['C', 'D']],
    );

  it.each([
    [1, ['A', 'B']],
    [2, ['A', 'B', 'C']],
    [3, ['A', 'B', 'C', 'D']],
    [4, ['A', 'B', 'C', 'D']],
  ])('admits exactly the nodes within %i downstream hops', (level, expected) => {
    expect(traced(chain(), 'A', 0, level)).toEqual(expected);
  });

  it('returns the origin alone when both caps are zero', () => {
    expect(traced(chain(), 'B', 0, 0)).toEqual(['B']);
  });

  it('follows both arms of an asymmetric diamond to the convergence node', () => {
    expect(traced(asymmetricDiamond(), 'A', 0, Infinity)).toEqual(['A', 'B', 'C', 'C2', 'D']);
  });

  it('admits the convergence node at its shortest depth, not its longest', () => {
    // D is 2 hops away via B and 3 via C→C2, so a cap of 2 must still include it.
    expect(traced(asymmetricDiamond(), 'A', 0, 2)).toEqual(['A', 'B', 'C', 'C2', 'D']);
  });
});

describe('traceNodeWithLevels — disconnected and missing input', () => {
  /** Two components that share no edge. */
  const split = () =>
    makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'X' }, { id: 'Y' }],
      [['A', 'B'], ['X', 'Y']],
    );

  it('never crosses into another component', () => {
    expect(traced(split(), 'A', Infinity, Infinity)).toEqual(['A', 'B']);
  });

  it('returns empty sets for an origin that is not in the graph', () => {
    const result = traceNodeWithLevels(split(), 'absent', Infinity, Infinity);
    expect(result.nodeIds).toEqual(new Set());
    expect(result.edgeIds).toEqual(new Set());
  });

  it('returns empty sets for an empty graph', () => {
    expect(traceNodeWithLevels(emptyGraph(), 'A', Infinity, Infinity).nodeIds).toEqual(new Set());
  });
});

// ─── bfsReachable / firstDisconnectedRequiredNode ────────────────────────────

describe('bfsReachable — cycles and self-reference', () => {
  it('visits each member of a cycle once and terminates', () => {
    expect([...bfsReachable(threeCycle(), 'A', NONE)].sort()).toEqual(['A', 'B', 'C']);
  });

  it('returns the node alone for a self-loop', () => {
    expect([...bfsReachable(selfLoop(), 'X', NONE)]).toEqual(['X']);
  });

  it('is undirected — an upstream-only neighbour is still reachable', () => {
    const graph = makeGraph([{ id: 'A' }, { id: 'B' }], [['B', 'A']]);
    expect([...bfsReachable(graph, 'A', NONE)].sort()).toEqual(['A', 'B']);
  });

  it('returns an empty set for a start node that is not present', () => {
    expect(bfsReachable(threeCycle(), 'absent', NONE)).toEqual(new Set());
  });

  it('returns an empty set for an empty graph', () => {
    expect(bfsReachable(emptyGraph(), 'A', NONE)).toEqual(new Set());
  });
});

describe('firstDisconnectedRequiredNode — cyclic topology', () => {
  it('reports nothing disconnected while the cycle keeps an alternate route', () => {
    // Removing B leaves C reachable from A the other way round the cycle.
    expect(firstDisconnectedRequiredNode(threeCycle(), 'A', new Set(['B']), new Set(['C']))).toBeNull();
  });

  it('names the node cut off once the only route is broken', () => {
    const graph = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
    expect(firstDisconnectedRequiredNode(graph, 'A', new Set(['B']), new Set(['C']))).toBe('C');
  });
});

// ─── findShortestPathOrdered ─────────────────────────────────────────────────

describe('findShortestPathOrdered — cycles and self-reference', () => {
  it('finds a forward path inside a cycle without looping', () => {
    expect(findShortestPathOrdered(threeCycle(), 'A', 'C')).toEqual({
      path: ['A', 'B', 'C'],
      direction: 'source_to_target',
    });
  });

  it('returns the single node for a path from a self-looping node to itself', () => {
    expect(findShortestPathOrdered(selfLoop(), 'X', 'X')?.path).toEqual(['X']);
  });

  it.each([
    ['absent target', 'A', 'absent'],
    ['absent source', 'absent', 'A'],
  ])('returns null for an %s', (_label, source, target) => {
    expect(findShortestPathOrdered(threeCycle(), source, target)).toBeNull();
  });
});

// ─── bfsDepthMap ─────────────────────────────────────────────────────────────

describe('bfsDepthMap', () => {
  it('assigns hop distance along a chain', () => {
    expect([...bfsDepthMap([['A', 'B', 'body'], ['B', 'C', 'body']], 'A')]).toEqual([
      ['A', 0], ['B', 1], ['C', 2],
    ]);
  });

  it('records the minimum distance when two paths reach the same node', () => {
    const edges: ReadonlyArray<readonly [string, string, string]> = [
      ['A', 'B', 'body'], ['B', 'D', 'body'],
      ['A', 'C', 'body'], ['C', 'C2', 'body'], ['C2', 'D', 'body'],
    ];
    expect(bfsDepthMap(edges, 'A').get('D')).toBe(2);
  });

  it('terminates on a cycle instead of revisiting the origin', () => {
    const edges: ReadonlyArray<readonly [string, string, string]> = [
      ['A', 'B', 'body'], ['B', 'C', 'body'], ['C', 'A', 'body'],
    ];
    expect([...bfsDepthMap(edges, 'A')]).toEqual([['A', 0], ['B', 1], ['C', 2]]);
  });

  it('terminates on a self-loop', () => {
    expect([...bfsDepthMap([['X', 'X', 'body']], 'X')]).toEqual([['X', 0]]);
  });

  it('follows edges only forwards, excluding what the origin cannot reach', () => {
    expect([...bfsDepthMap([['A', 'B', 'body'], ['Z', 'A', 'body']], 'A').keys()]).toEqual(['A', 'B']);
  });

  it('returns the origin alone when it has no outgoing edges', () => {
    expect([...bfsDepthMap([['B', 'C', 'body']], 'A')]).toEqual([['A', 0]]);
  });

  it('returns the origin alone for an empty edge list', () => {
    expect([...bfsDepthMap([], 'A')]).toEqual([['A', 0]]);
  });
});
