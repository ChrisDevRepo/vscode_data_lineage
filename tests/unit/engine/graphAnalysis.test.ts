/**
 * Unit tests for graph analysis functions.
 *
 * @remarks
 * One `it` per behaviour rather than one per analysis function. These are independent
 * rules — a maxSize filter and an empty-graph guard fail for unrelated reasons — and
 * grouping them meant the first failure suppressed the rest of its analysis.
 */

import Graph from 'graphology';
import { describe, expect, it } from 'vitest';
import {
  analyzeCycles,
  analyzeExternalRefs,
  analyzeHubs,
  analyzeIslands,
  analyzeLongestPath,
  analyzeOrphans,
} from '../../../src/engine/graphAnalysis';
import { makeGraph } from '../helpers/testUtils';

const emptyGraph = () => new Graph({ type: 'directed', multi: false });

/** Builds a graph of `external`-typed nodes, which `makeGraph` cannot express. */
function externalGraph(nodes: Array<[string, Record<string, unknown>]>, edges: Array<[string, string]> = []): Graph {
  const graph = emptyGraph();
  for (const [id, attrs] of nodes) graph.addNode(id, attrs);
  for (const [source, target] of edges) graph.addEdgeWithKey(`${source}→${target}`, source, target, { type: 'body' });
  return graph;
}

// ─── analyzeIslands ──────────────────────────────────────────────────────────

describe('analyzeIslands', () => {
  const twoPairs = () => makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
    [['A', 'B'], ['C', 'D']],
  );
  const chain = () => makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);

  it('labels the result islands', () => {
    expect(analyzeIslands(twoPairs(), 2).type).toBe('islands');
  });

  it('finds each disconnected component', () => {
    expect(analyzeIslands(twoPairs(), 2).groups).toHaveLength(2);
  });

  it('treats a fully connected graph as a single island', () => {
    expect(analyzeIslands(chain(), 3).groups).toHaveLength(1);
  });

  it('filters out a component larger than maxSize', () => {
    expect(analyzeIslands(chain(), 2).groups).toEqual([]);
  });

  it('keeps a component exactly at maxSize', () => {
    expect(analyzeIslands(twoPairs(), 2).groups).toHaveLength(2);
  });

  it('returns nothing for an empty graph', () => {
    expect(analyzeIslands(emptyGraph(), 2).groups).toEqual([]);
  });

  it('does not count isolated nodes as islands — those are orphans', () => {
    const isolated = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], []);
    expect(analyzeIslands(isolated, 2).groups).toEqual([]);
  });

  it('reports the island and excludes the orphan when both are present', () => {
    const mixed = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B']]);
    const groups = analyzeIslands(mixed, 2).groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].nodeIds).toHaveLength(2);
  });
});

// ─── analyzeHubs ─────────────────────────────────────────────────────────────

describe('analyzeHubs', () => {
  const star = () => makeGraph(
    [
      { id: 'hub', type: 'table' },
      { id: 'sp1', type: 'procedure' }, { id: 'sp2', type: 'procedure' },
      { id: 'sp3', type: 'procedure' }, { id: 'sp4', type: 'procedure' },
    ],
    [['hub', 'sp1'], ['hub', 'sp2'], ['hub', 'sp3'], ['hub', 'sp4']],
  );

  it('labels the result hubs', () => {
    expect(analyzeHubs(star(), 3).type).toBe('hubs');
  });

  it('reports the node meeting minDegree, with its in and out degree split out', () => {
    const groups = analyzeHubs(star(), 3).groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].meta?.outDegree).toBe(4);
    expect(groups[0].meta?.inDegree).toBe(0);
  });

  it('reports nothing when no node meets minDegree', () => {
    expect(analyzeHubs(star(), 10).groups).toEqual([]);
  });

  it('counts both directions of a bidirectional edge toward degree', () => {
    const pair = makeGraph(
      [{ id: 'A', type: 'procedure' }, { id: 'B', type: 'table' }],
      [['A', 'B'], ['B', 'A']],
    );
    const groups = analyzeHubs(pair, 2).groups;
    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.meta?.degree)).toEqual([2, 2]);
  });

  it('returns nothing for an empty graph', () => {
    expect(analyzeHubs(emptyGraph(), 1).groups).toEqual([]);
  });

  it('sorts by degree descending', () => {
    const graph = makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }],
      [['A', 'B'], ['A', 'C'], ['A', 'D'], ['B', 'C']],
    );
    const degrees = analyzeHubs(graph, 2).groups.map(group => group.meta?.degree as number);
    expect(degrees[0]).toBe(3);
    expect([...degrees].sort((left, right) => right - left)).toEqual(degrees);
  });

  it('treats a virtual external node as a hub like any other', () => {
    const graph = makeGraph(
      [
        { id: 'file1', type: 'external' },
        { id: 'sp1', type: 'procedure' }, { id: 'sp2', type: 'procedure' }, { id: 'sp3', type: 'procedure' },
      ],
      [['file1', 'sp1'], ['file1', 'sp2'], ['file1', 'sp3']],
    );
    expect(analyzeHubs(graph, 3).groups.flatMap(group => group.nodeIds)).toContain('file1');
  });
});

// ─── analyzeOrphans ──────────────────────────────────────────────────────────

describe('analyzeOrphans', () => {
  const mixed = () => makeGraph(
    [
      { id: 'A', schema: 'dbo', type: 'table' },
      { id: 'B', schema: 'dbo', type: 'table' },
      { id: 'C', schema: 'dbo', type: 'table' },
      { id: 'D', schema: 'sales', type: 'view' },
    ],
    [['A', 'B']],
  );

  it('labels the result orphans', () => {
    expect(analyzeOrphans(mixed()).type).toBe('orphans');
  });

  it('reports every zero-degree node and no connected one', () => {
    const orphans = analyzeOrphans(mixed()).groups.flatMap(group => group.nodeIds);
    expect(orphans.sort()).toEqual(['C', 'D']);
  });

  it('groups orphans by schema and type', () => {
    // C is dbo/table, D is sales/view — two groups, not one bucket of two nodes.
    expect(analyzeOrphans(mixed()).groups).toHaveLength(2);
  });

  it('reports nothing when every node is connected', () => {
    expect(analyzeOrphans(makeGraph([{ id: 'A' }, { id: 'B' }], [['A', 'B']])).groups).toEqual([]);
  });

  it('returns nothing for an empty graph', () => {
    expect(analyzeOrphans(emptyGraph()).groups).toEqual([]);
  });
});

// ─── analyzeLongestPath ──────────────────────────────────────────────────────

describe('analyzeLongestPath', () => {
  const chain = () => makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
    [['A', 'B'], ['B', 'C'], ['C', 'D']],
  );

  it('labels the result longest-path', () => {
    expect(analyzeLongestPath(chain(), 2).type).toBe('longest-path');
  });

  it('reports the chain end to end, with its depth in steps', () => {
    const group = analyzeLongestPath(chain(), 2).groups[0];
    expect(group.meta?.depth).toBe(3);
    expect(group.nodeIds.at(0)).toBe('A');
    expect(group.nodeIds.at(-1)).toBe('D');
  });

  it('filters out a chain shorter than minNodes', () => {
    expect(analyzeLongestPath(chain(), 5).groups).toEqual([]);
  });

  it('picks the longest branch when the graph forks', () => {
    const forked = makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }],
      [['A', 'B'], ['B', 'C'], ['A', 'D'], ['D', 'E']],
    );
    expect(analyzeLongestPath(forked, 2).groups[0].nodeIds).toHaveLength(3);
  });

  it('terminates on a cyclic graph instead of looping forever', () => {
    const cyclic = makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      [['A', 'B'], ['B', 'C'], ['C', 'A']],
    );
    for (const group of analyzeLongestPath(cyclic, 2).groups) {
      expect(new Set(group.nodeIds).size).toBe(group.nodeIds.length);
    }
  });

  // A chain that enters a two-node cycle and leaves it again. The cycle must not truncate the
  // chain at its exit: the tail beyond the cycle belongs to the same dependency path.
  const throughCycle = (ids: string[]) => makeGraph(
    ids.map(id => ({ id })),
    [['X1', 'X2'], ['X2', 'X3'], ['X3', 'X4'], ['X4', 'B'], ['B', 'C'], ['C', 'B'], ['C', 'D']],
  );
  const CHAIN_ORDER = ['X1', 'X2', 'X3', 'X4', 'B', 'C', 'D'];

  it('follows a chain past a cycle to the far end', () => {
    const group = analyzeLongestPath(throughCycle(CHAIN_ORDER), 2).groups[0];
    expect(group.nodeIds).toEqual(CHAIN_ORDER);
    expect(group.meta?.depth).toBe(6);
  });

  it('reports the same chain whichever order the nodes were added in', () => {
    const forward = analyzeLongestPath(throughCycle(CHAIN_ORDER), 2).groups[0];
    const reversed = analyzeLongestPath(throughCycle([...CHAIN_ORDER].reverse()), 2).groups[0];
    expect(reversed.nodeIds).toEqual(forward.nodeIds);
  });

  it('returns nothing for an empty graph', () => {
    expect(analyzeLongestPath(emptyGraph(), 2).groups).toEqual([]);
  });
});

// ─── analyzeCycles ───────────────────────────────────────────────────────────

describe('analyzeCycles', () => {
  const triangle = () => makeGraph(
    [{ id: 'A', schema: 'dbo' }, { id: 'B', schema: 'dbo' }, { id: 'C', schema: 'dbo' }],
    [['A', 'B'], ['B', 'C'], ['C', 'A']],
  );

  it('labels the result cycles', () => {
    expect(analyzeCycles(triangle()).type).toBe('cycles');
  });

  it('captures every node of a 3-node cycle in one group', () => {
    const groups = analyzeCycles(triangle()).groups;
    expect(groups).toHaveLength(1);
    expect(groups.flatMap(group => group.nodeIds).sort()).toEqual(['A', 'B', 'C']);
  });

  it('captures every node of a 4-node cycle in one group', () => {
    const square = makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A']],
    );
    const groups = analyzeCycles(square).groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].nodeIds).toHaveLength(4);
  });

  it('labels a two-node cycle as bidirectional', () => {
    const pair = makeGraph(
      [{ id: 'A', name: 'TableA' }, { id: 'B', name: 'ProcB' }],
      [['A', 'B'], ['B', 'A']],
    );
    const groups = analyzeCycles(pair).groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toContain('Bidirectional');
  });

  it('keeps two disjoint cycles in separate groups', () => {
    const disjoint = makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'X' }, { id: 'Y' }],
      [['A', 'B'], ['B', 'C'], ['C', 'A'], ['X', 'Y'], ['Y', 'X']],
    );
    expect(analyzeCycles(disjoint).groups).toHaveLength(2);
  });

  it('reports no cycle in a DAG', () => {
    const dag = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['A', 'C']]);
    expect(analyzeCycles(dag).groups).toEqual([]);
  });

  it('reports no cycle for a self-loop, which the extractor prevents but analysis must still tolerate', () => {
    const selfLoop = externalGraph([['X', { schema: 'dbo', name: 'X', type: 'table' }]]);
    selfLoop.addEdgeWithKey('X→X', 'X', 'X', { type: 'body' });
    const result = analyzeCycles(selfLoop);
    expect(result.type).toBe('cycles');
    // A self-loop is a strongly connected component of one node; the size>=2 filter drops it.
    expect(result.groups).toEqual([]);
  });

  it('returns nothing for an empty graph', () => {
    expect(analyzeCycles(emptyGraph()).groups).toEqual([]);
  });
});

// ─── analyzeExternalRefs ─────────────────────────────────────────────────────

describe('analyzeExternalRefs', () => {
  it('labels the result external-refs and summarises an empty graph', () => {
    const result = analyzeExternalRefs(makeGraph([], []));
    expect(result.type).toBe('external-refs');
    expect(result.groups).toEqual([]);
    expect(result.summary).toBe('No nodes in graph');
  });

  it('labels a file source with the URL basename', () => {
    const graph = externalGraph([['file1', {
      schema: '', name: 'report.csv', type: 'external',
      externalType: 'file', externalUrl: 'https://host/path/report.csv', externalDatabase: '',
    }]]);
    const groups = analyzeExternalRefs(graph).groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('report.csv');
    expect(String(groups[0].meta?.kind)).toBe('file');
  });

  it('labels a database cross-reference as "database / name"', () => {
    const graph = externalGraph([['db1', {
      schema: 'dbo', name: 'dbo.Sales', type: 'external',
      externalType: 'db', externalUrl: '', externalDatabase: 'OtherDB',
    }]]);
    const groups = analyzeExternalRefs(graph).groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('OtherDB / dbo.Sales');
    expect(String(groups[0].meta?.database)).toBe('OtherDB');
  });

  it('sorts files before databases, alphabetically within each kind', () => {
    const graph = externalGraph([
      ['db1', { schema: '', name: 'schema.T1', type: 'external', externalType: 'db', externalUrl: '', externalDatabase: 'BDB' }],
      ['file2', { schema: '', name: 'zz.csv', type: 'external', externalType: 'file', externalUrl: 'https://host/zz.csv', externalDatabase: '' }],
      ['file1', { schema: '', name: 'aa.csv', type: 'external', externalType: 'file', externalUrl: 'https://host/aa.csv', externalDatabase: '' }],
      ['db2', { schema: '', name: 'schema.T2', type: 'external', externalType: 'db', externalUrl: '', externalDatabase: 'ADB' }],
    ]);
    expect(analyzeExternalRefs(graph).groups.map(group => group.label))
      .toEqual(['aa.csv', 'zz.csv', 'ADB / schema.T2', 'BDB / schema.T1']);
  });

  it('includes the external node and every neighbour that reads it', () => {
    const graph = externalGraph(
      [
        ['file1', { schema: '', name: 'data.csv', type: 'external', externalType: 'file', externalUrl: 'https://host/data.csv', externalDatabase: '' }],
        ['sp1', { schema: 'dbo', name: 'sp1', type: 'procedure', externalType: undefined }],
        ['sp2', { schema: 'dbo', name: 'sp2', type: 'procedure', externalType: undefined }],
      ],
      [['file1', 'sp1'], ['file1', 'sp2']],
    );
    const groups = analyzeExternalRefs(graph).groups;
    expect(groups).toHaveLength(1);
    expect([...groups[0].nodeIds].sort()).toEqual(['file1', 'sp1', 'sp2']);
  });
});
