/** Owns synthetic traceNodeWithLevels membership, depth and edge contracts. Per .agents/rules/testing.md, every distinct scenario retains equivalent assertions. Other graph APIs stay in their owning suites. Covers the graph shapes that stress traversal termination and dedup: cycles, self-loops, asymmetric diamonds, missing origins and depth caps, for `traceNodeWithLevels`, `bfsReachable`, `findShortestPathOrdered`, `directNeighborIds`, `analyzeRemoval` and `buildGraphologyGraph`. A regression that made any of them revisit a node would hang the extension rather than fail a test. */

import { describe, expect, it } from 'vitest';
import { buildGraphologyGraph, traceNodeWithLevels } from '../../../src/engine/graphBuilder';
import type { DatabaseModel } from '../../../src/engine/types';
import {
  bfsReachable,
  directNeighborIds,
  findShortestPathOrdered,
  analyzeRemoval,
} from '../../../src/engine/graphGuards';
import { makeGraph } from '../helpers/modelFixtures';
import { buildModel } from '../../../src/engine/modelBuilder';

const NONE: ReadonlySet<string> = new Set();

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

const chain = () => makeGraph(['A', 'B', 'C', 'D'].map(id => ({ id })), [['A', 'B'], ['B', 'C'], ['C', 'D']]);
const split = () => makeGraph(['A', 'B', 'X', 'Y'].map(id => ({ id })), [['A', 'B'], ['X', 'Y']]);
const fan = () => makeGraph(['P', 'X', 'S', 'S2', 'K', 'Q'].map(id => ({ id })),
  [['P', 'X'], ['P', 'S'], ['S', 'S2'], ['X', 'K'], ['Q', 'K']]);
const siblings = () => makeGraph(['GP', 'P1', 'P2', 'X', 'C1', 'C2'].map(id => ({ id })),
  [['GP', 'P1'], ['GP', 'P2'], ['P1', 'X'], ['P2', 'X'], ['X', 'C1'], ['X', 'C2'], ['P1', 'C1']]);
const readWritePair = () => makeGraph(['Table', 'SP1', 'TableA', 'SP2', 'TableB', 'SP3', 'TableC']
  .map(id => ({ id, type: id.startsWith('SP') ? 'procedure' : 'table' })),
  [['SP1', 'Table'], ['Table', 'SP1'], ['TableA', 'SP1'], ['SP1', 'TableA'], ['SP2', 'TableA'], ['TableB', 'SP2'], ['SP3', 'TableB'], ['TableC', 'SP3']]);
const longChain = () => makeGraph(['U2', 'U1', 'O', 'D1', 'D2', 'D3'].map(id => ({ id })),
  [['U2', 'U1'], ['U1', 'O'], ['O', 'D1'], ['D1', 'D2'], ['D2', 'D3']]);
const backEdge = () => makeGraph(['ORIGIN', 'A', 'S'].map(id => ({ id })), [['A', 'ORIGIN'], ['S', 'A'], ['A', 'S']]);

type TraceCase = {
  name: string; graph: typeof chain; origin: string; up: number; down: number;
  nodes: string[]; edges: string[];
};

// Expected nodes and edges are declared independently of the graph builder and traversal.
const TRACE_CASES: TraceCase[] = [
  { name: 'two-cycle from A terminates without duplicates', graph: twoCycle, origin: 'A', up: Infinity, down: Infinity,
    nodes: ['A', 'B'], edges: ['A→B', 'B→A'] },
  { name: 'two-cycle from B has the same membership', graph: twoCycle, origin: 'B', up: Infinity, down: Infinity,
    nodes: ['A', 'B'], edges: ['A→B', 'B→A'] },
  { name: 'three-cycle downstream', graph: threeCycle, origin: 'A', up: 0, down: Infinity,
    nodes: ['A', 'B', 'C'], edges: ['A→B', 'B→C', 'C→A'] },
  { name: 'three-cycle upstream', graph: threeCycle, origin: 'A', up: Infinity, down: 0,
    nodes: ['A', 'B', 'C'], edges: ['A→B', 'B→C', 'C→A'] },
  { name: 'three-cycle at the downstream border', graph: threeCycle, origin: 'A', up: 0, down: 1,
    nodes: ['A', 'B'], edges: ['A→B'] },
  { name: 'three-cycle keeps every internal edge with both sides open', graph: threeCycle, origin: 'A', up: Infinity, down: Infinity,
    nodes: ['A', 'B', 'C'], edges: ['A→B', 'B→C', 'C→A'] },
  { name: 'self-loop retains its node and edge', graph: selfLoop, origin: 'X', up: Infinity, down: Infinity,
    nodes: ['X'], edges: ['X→X'] },
  { name: 'chain at downstream depth 1', graph: chain, origin: 'A', up: 0, down: 1,
    nodes: ['A', 'B'], edges: ['A→B'] },
  { name: 'chain at downstream depth 2', graph: chain, origin: 'A', up: 0, down: 2,
    nodes: ['A', 'B', 'C'], edges: ['A→B', 'B→C'] },
  { name: 'chain at downstream depth 3', graph: chain, origin: 'A', up: 0, down: 3,
    nodes: ['A', 'B', 'C', 'D'], edges: ['A→B', 'B→C', 'C→D'] },
  { name: 'chain beyond its last level', graph: chain, origin: 'A', up: 0, down: 4,
    nodes: ['A', 'B', 'C', 'D'], edges: ['A→B', 'B→C', 'C→D'] },
  { name: 'asymmetric diamond follows both arms', graph: asymmetricDiamond, origin: 'A', up: 0, down: Infinity,
    nodes: ['A', 'B', 'C', 'C2', 'D'], edges: ['A→B', 'A→C', 'B→D', 'C→C2', 'C2→D'] },
  { name: 'asymmetric diamond uses the shortest depth to the join', graph: asymmetricDiamond, origin: 'A', up: 0, down: 2,
    nodes: ['A', 'B', 'C', 'C2', 'D'], edges: ['A→B', 'A→C', 'B→D', 'C→C2', 'C2→D'] },
  { name: 'disconnected component stays outside the trace', graph: split, origin: 'A', up: Infinity, down: Infinity,
    nodes: ['A', 'B'], edges: ['A→B'] },
  { name: 'missing origin returns no nodes or edges', graph: split, origin: 'absent', up: Infinity, down: Infinity,
    nodes: [], edges: [] },
  { name: 'both-direction trace excludes sideways siblings', graph: fan, origin: 'X', up: Infinity, down: Infinity,
    nodes: ['K', 'P', 'X'], edges: ['P→X', 'X→K'] },
  { name: 'finite both-direction trace excludes co-parents', graph: fan, origin: 'X', up: 5, down: 5,
    nodes: ['K', 'P', 'X'], edges: ['P→X', 'X→K'] },
  { name: 'zero closes both sides', graph: fan, origin: 'X', up: 0, down: 0, nodes: ['X'], edges: [] },
  { name: 'negative caps close both sides', graph: fan, origin: 'X', up: -1, down: -1, nodes: ['X'], edges: [] },
  { name: 'NaN caps close both sides', graph: fan, origin: 'X', up: NaN, down: NaN, nodes: ['X'], edges: [] },
  { name: 'settings maximum covers the complete shallow graph', graph: fan, origin: 'P', up: 99, down: 99,
    nodes: ['K', 'P', 'S', 'S2', 'X'], edges: ['P→S', 'P→X', 'S→S2', 'X→K'] },
  { name: 'uncapped trace has the same shallow-graph membership', graph: fan, origin: 'P', up: Infinity, down: Infinity,
    nodes: ['K', 'P', 'S', 'S2', 'X'], edges: ['P→S', 'P→X', 'S→S2', 'X→K'] },
  { name: 'siblings at depth 1 retain the parent-to-child shortcut', graph: siblings, origin: 'X', up: 1, down: 1,
    nodes: ['C1', 'C2', 'P1', 'P2', 'X'], edges: ['P1→C1', 'P1→X', 'P2→X', 'X→C1', 'X→C2'] },
  { name: 'siblings with both caps infinite include the grandparent', graph: siblings, origin: 'X', up: Infinity, down: Infinity,
    nodes: ['C1', 'C2', 'GP', 'P1', 'P2', 'X'], edges: ['GP→P1', 'GP→P2', 'P1→C1', 'P1→X', 'P2→X', 'X→C1', 'X→C2'] },
  { name: 'grandparent at upstream depth 2 retains every internal edge', graph: siblings, origin: 'X', up: 2, down: 0,
    nodes: ['GP', 'P1', 'P2', 'X'], edges: ['GP→P1', 'GP→P2', 'P1→X', 'P2→X'] },
  { name: 'closed upstream side retains only children', graph: siblings, origin: 'X', up: 0, down: 1,
    nodes: ['C1', 'C2', 'X'], edges: ['X→C1', 'X→C2'] },
  { name: 'upstream traversal walks past read/write pairs', graph: readWritePair, origin: 'Table', up: 7, down: 0,
    nodes: ['SP1', 'SP2', 'SP3', 'Table', 'TableA', 'TableB', 'TableC'],
    edges: ['SP1→Table', 'SP1→TableA', 'SP2→TableA', 'SP3→TableB', 'TableA→SP1', 'TableB→SP2', 'TableC→SP3', 'Table→SP1'] },
  { name: 'both-direction read/write trace keeps every edge', graph: readWritePair, origin: 'Table', up: 7, down: 7,
    nodes: ['SP1', 'SP2', 'SP3', 'Table', 'TableA', 'TableB', 'TableC'],
    edges: ['SP1→Table', 'SP1→TableA', 'SP2→TableA', 'SP3→TableB', 'TableA→SP1', 'TableB→SP2', 'TableC→SP3', 'Table→SP1'] },
  { name: 'read/write pair counts once at the depth border', graph: readWritePair, origin: 'Table', up: 2, down: 0,
    nodes: ['SP1', 'Table', 'TableA'], edges: ['SP1→Table', 'SP1→TableA', 'TableA→SP1', 'Table→SP1'] },
  { name: 'infinite upstream cap covers the full read/write chain', graph: readWritePair, origin: 'Table', up: Infinity, down: 0,
    nodes: ['SP1', 'SP2', 'SP3', 'Table', 'TableA', 'TableB', 'TableC'],
    edges: ['SP1→Table', 'SP1→TableA', 'SP2→TableA', 'SP3→TableB', 'TableA→SP1', 'TableB→SP2', 'TableC→SP3', 'Table→SP1'] },
  { name: 'asymmetric caps apply independently: upstream 1 downstream 3', graph: longChain, origin: 'O', up: 1, down: 3,
    nodes: ['D1', 'D2', 'D3', 'O', 'U1'], edges: ['D1→D2', 'D2→D3', 'O→D1', 'U1→O'] },
  { name: 'asymmetric caps apply independently: upstream 2 downstream 1', graph: longChain, origin: 'O', up: 2, down: 1,
    nodes: ['D1', 'O', 'U1', 'U2'], edges: ['O→D1', 'U1→O', 'U2→U1'] },
  { name: 'upstream trace draws the internal edge pointing away from origin', graph: backEdge, origin: 'ORIGIN', up: 2, down: 0,
    nodes: ['A', 'ORIGIN', 'S'], edges: ['A→ORIGIN', 'A→S', 'S→A'] },
  { name: 'both-direction trace retains the same internal back edge', graph: backEdge, origin: 'ORIGIN', up: 2, down: 2,
    nodes: ['A', 'ORIGIN', 'S'], edges: ['A→ORIGIN', 'A→S', 'S→A'] },
  { name: 'depth cap drops edges to the excluded endpoint', graph: backEdge, origin: 'ORIGIN', up: 1, down: 0,
    nodes: ['A', 'ORIGIN'], edges: ['A→ORIGIN'] },
];

describe('traceNodeWithLevels — membership and depth contracts', () => {
  it.each(TRACE_CASES)('$name', row => {
    const traced = traceNodeWithLevels(row.graph(), row.origin, row.up, row.down);
    expect(traced.nodeIds).toEqual(new Set(row.nodes));
    expect(traced.edgeIds).toEqual(new Set(row.edges));
  });
});

describe.each([false, true])('direct neighbors under source identifier policy (CS=%s)', cs => {
  it.each(['in', 'out'] as const)('uses CI normalization or exact CS edge fallback for %s neighbors', side => {
    const model = buildModel([], [], undefined, undefined, true, undefined, cs);
    model.neighborIndex = { '[dbo].[report]': { in: ['LowerSource'], out: ['LowerTarget'] } };
    model.edges = [
      { source: 'UpperSource', target: '[dbo].[Report]', type: 'body' },
      { source: '[dbo].[Report]', target: 'UpperTarget', type: 'body' },
    ];
    expect(directNeighborIds(model, '[dbo].[Report]', side)).toEqual([`${cs ? 'Upper' : 'Lower'}${side === 'in' ? 'Source' : 'Target'}`]);
    expect(directNeighborIds(model, '[dbo].[report]', side)).toEqual([`Lower${side === 'in' ? 'Source' : 'Target'}`]);
    expect(directNeighborIds(model, '[DBO].[REPORT]', side)).toEqual(cs ? [] : [`Lower${side === 'in' ? 'Source' : 'Target'}`]);
  });
});


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

});

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

describe('analyzeRemoval — cycles', () => {
  it('cuts nothing when the removed node sits on a cycle that still reaches the origin', () => {
    expect( analyzeRemoval(threeCycle(), {originId:'A',scope:new Set(threeCycle().nodes()),removedBefore:NONE,removedAfter:new Set(['B']),visited:new Set(),sides:['downstream','upstream']}).cutIds).toEqual([]);
  });

  it('terminates on a two-node cycle and cuts nothing beyond the removed node', () => {
    expect( analyzeRemoval(twoCycle(), {originId:'A',scope:new Set(twoCycle().nodes()),removedBefore:NONE,removedAfter:new Set(['B']),visited:new Set(),sides:['downstream','upstream']}).cutIds).toEqual([]);
  });
});

const sorted = (ids: Iterable<string>) => [...ids].sort();

describe('traceNodeWithLevels — stable ordering', () => {
  it('returns ids in a stable order across repeated runs', () => {
    const graph = fan();
    const first = traceNodeWithLevels(graph, 'X', 3, 3);
    for (let i = 0; i < 5; i++) {
      const next = traceNodeWithLevels(graph, 'X', 3, 3);
      expect([...next.nodeIds]).toEqual([...first.nodeIds]);
      expect([...next.edgeIds]).toEqual([...first.edgeIds]);
    }
  });
});

describe('buildGraphologyGraph — identity and malformed input', () => {
  const node = (id: string) => ({ id, name: id, schema: 'dbo', fullName: id, type: 'table' as const });
  const model = (ids: string[], edges: [string, string][], caseSensitive = false): DatabaseModel => ({
    nodes: ids.map(node),
    edges: edges.map(([source, target]) => ({ source, target, type: 'body' as const })),
    schemas: [],
    parseStats: { parsedRefs: 0, resolvedEdges: 0, droppedRefs: [] },
    ...(caseSensitive && { identifierCaseSensitive: true }),
  } as unknown as DatabaseModel);

  it('keeps ids that differ only by case distinct under a case-sensitive model', () => {
    const graph = buildGraphologyGraph(model(['[dbo].[A]', '[dbo].[a]', '[dbo].[V]'], [['[dbo].[A]', '[dbo].[V]']], true));
    expect(sorted(traceNodeWithLevels(graph, '[dbo].[V]', Infinity, 0).nodeIds)).toEqual(['[dbo].[A]', '[dbo].[V]']);
    expect(sorted(traceNodeWithLevels(graph, '[dbo].[a]', Infinity, Infinity).nodeIds)).toEqual(['[dbo].[a]']);
  });

  it('does not resolve an origin by case — the caller passes the canonical id', () => {
    const graph = buildGraphologyGraph(model(['[dbo].[a]'], []));
    expect(traceNodeWithLevels(graph, '[dbo].[A]', 1, 1).nodeIds.size).toBe(0);
  });

});
