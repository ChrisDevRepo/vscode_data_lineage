/** Unit tests for graph analysis functions. */

import Graph from 'graphology';
import { describe, expect, it } from 'vitest';
import {
  analyzeCycles,
  analyzeExternalRefs,
  analyzeHubs,
  analyzeIslands,
  analyzeLongestPath,
  analyzeOrphans,
  runAnalysis,
} from '../../../src/engine/graphAnalysis';
import type { AnalysisConfig, AnalysisType } from '../../../src/engine/types';
import { makeGraph } from '../helpers/modelFixtures';

const emptyGraph = () => new Graph({ type: 'directed', multi: false });

/** Builds a graph of `external`-typed nodes, which `makeGraph` cannot express. */
function externalGraph(
  nodes: Array<[string, Record<string, unknown>]>,
  edges: Array<[string, string]> = [],
): Graph {
  const graph = emptyGraph();
  for (const [id, attrs] of nodes) graph.addNode(id, attrs);
  for (const [source, target] of edges)
    graph.addEdgeWithKey(`${source}→${target}`, source, target, {
      type: 'body',
    });
  return graph;
}

describe('analyzeIslands', () => {
  const chain = () =>
    makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      [
        ['A', 'B'],
        ['B', 'C'],
      ],
    );

  it.each([
    {
      name: 'finds each disconnected component',
      graph: () =>
        makeGraph(
          [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
          [
            ['A', 'B'],
            ['C', 'D'],
          ],
        ),
      maxSize: 2,
      islands: [
        ['A', 'B'],
        ['C', 'D'],
      ],
    },
    {
      name: 'treats a fully connected graph as a single island',
      graph: chain,
      maxSize: 3,
      islands: [['A', 'B', 'C']],
    },
    {
      name: 'filters out a component larger than maxSize',
      graph: chain,
      maxSize: 2,
      islands: [],
    },
    {
      name: 'does not count isolated nodes as islands — those are orphans',
      graph: () => makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], []),
      maxSize: 2,
      islands: [],
    },
    {
      name: 'reports the island and excludes the orphan when both are present',
      graph: () =>
        makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B']]),
      maxSize: 2,
      islands: [['A', 'B']],
    },
  ])('$name', ({ graph, maxSize, islands }) => {
    const found = analyzeIslands(graph(), maxSize).groups.map((group) =>
      [...group.nodeIds].sort(),
    );
    expect(found.sort()).toEqual(islands);
  });
});

describe('analyzeHubs', () => {
  const star = () =>
    makeGraph(
      [
        { id: 'hub', type: 'table' },
        { id: 'sp1', type: 'procedure' },
        { id: 'sp2', type: 'procedure' },
        { id: 'sp3', type: 'procedure' },
        { id: 'sp4', type: 'procedure' },
      ],
      [
        ['hub', 'sp1'],
        ['hub', 'sp2'],
        ['hub', 'sp3'],
        ['hub', 'sp4'],
      ],
    );

  it('reports the node meeting minDegree, with its in and out degree split out', () => {
    const groups = analyzeHubs(star(), 3).groups;
    expect(groups.map((group) => group.nodeIds)).toEqual([['hub']]);
    expect(groups[0].meta?.degree).toBe(4);
    expect(groups[0].meta?.outDegree).toBe(4);
    expect(groups[0].meta?.inDegree).toBe(0);
  });

  it('sorts by degree descending', () => {
    const graph = makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }],
      [
        ['A', 'B'],
        ['A', 'C'],
        ['A', 'D'],
        ['B', 'C'],
      ],
    );
    // Degrees by hand: A 3, B 2, C 2, D 1, E 0; B and C tie.
    const groups = analyzeHubs(graph, 2).groups;
    expect(groups.map((group) => group.meta?.degree)).toEqual([3, 2, 2]);
    expect(groups[0].nodeIds).toEqual(['A']);
    expect(groups.flatMap((group) => group.nodeIds).sort()).toEqual([
      'A',
      'B',
      'C',
    ]);
  });
});

describe('analyzeOrphans', () => {
  const mixed = () =>
    makeGraph(
      [
        { id: 'A', schema: 'dbo', type: 'table' },
        { id: 'B', schema: 'dbo', type: 'table' },
        { id: 'C', schema: 'dbo', type: 'table' },
        { id: 'D', schema: 'sales', type: 'view' },
      ],
      [['A', 'B']],
    );

  it('reports every zero-degree node and no connected one', () => {
    const orphans = analyzeOrphans(mixed()).groups.flatMap(
      (group) => group.nodeIds,
    );
    expect(orphans.sort()).toEqual(['C', 'D']);
  });

  it('groups orphans by schema and type', () => {
    const groups = analyzeOrphans(mixed())
      .groups.map((group) => ({ label: group.label, nodeIds: group.nodeIds }))
      .sort((left, right) => left.label.localeCompare(right.label));
    expect(groups).toEqual([
      { label: '[dbo] tables', nodeIds: ['C'] },
      { label: '[sales] views', nodeIds: ['D'] },
    ]);
  });
});

describe('analyzeLongestPath', () => {
  const chain = () =>
    makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      [
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'D'],
      ],
    );

  it('reports the chain end to end, with its depth in steps', () => {
    const group = analyzeLongestPath(chain(), 2).groups[0];
    expect(group.meta?.depth).toBe(3);
    expect(group.nodeIds).toEqual(['A', 'B', 'C', 'D']);
  });

  it('filters out a chain shorter than minNodes', () => {
    expect(analyzeLongestPath(chain(), 5).groups).toEqual([]);
  });

  it('picks the longest branch when the graph forks', () => {
    // A-B-C-F has four nodes, A-D-E three: only the longer branch is the deepest chain.
    const forked = makeGraph(
      [
        { id: 'A' },
        { id: 'B' },
        { id: 'C' },
        { id: 'D' },
        { id: 'E' },
        { id: 'F' },
      ],
      [
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'F'],
        ['A', 'D'],
        ['D', 'E'],
      ],
    );
    const [deepest] = analyzeLongestPath(forked, 2).groups;
    expect(deepest.nodeIds).toEqual(['A', 'B', 'C', 'F']);
    expect(deepest.meta?.depth).toBe(3);
  });

  it('terminates on a cyclic graph instead of looping forever', () => {
    const cyclic = makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      [
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'A'],
      ],
    );
    const groups = analyzeLongestPath(cyclic, 2).groups;
    expect(groups).toHaveLength(1);
    expect([...groups[0].nodeIds].sort()).toEqual(['A', 'B', 'C']);
    expect(groups[0].meta?.depth).toBe(2);
  });

  it('deduplicates chains reaching the same endpoint', () => {
    const graph = makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'T' }],
      [
        ['A', 'B'],
        ['B', 'T'],
        ['C', 'D'],
        ['D', 'T'],
      ],
    );
    const result = analyzeLongestPath(graph, 2, 5);
    expect(result.groups).toHaveLength(1);
    // Both chains have three nodes; either one may represent the endpoint T.
    expect([
      ['A', 'B', 'T'],
      ['C', 'D', 'T'],
    ]).toContainEqual(result.groups[0].nodeIds);
  });

  const throughCycle = (ids: string[]) =>
    makeGraph(
      ids.map((id) => ({ id })),
      [
        ['X1', 'X2'],
        ['X2', 'X3'],
        ['X3', 'X4'],
        ['X4', 'B'],
        ['B', 'C'],
        ['C', 'B'],
        ['C', 'D'],
      ],
    );
  const CHAIN_ORDER = ['X1', 'X2', 'X3', 'X4', 'B', 'C', 'D'];

  it('follows a chain past a cycle to the far end', () => {
    const group = analyzeLongestPath(throughCycle(CHAIN_ORDER), 2).groups[0];
    expect(group.nodeIds).toEqual(CHAIN_ORDER);
    expect(group.meta?.depth).toBe(6);
  });

  const competingRoots = () =>
    makeGraph(
      [
        { id: 'R1a' },
        { id: 'R1b' },
        { id: 'R1c' },
        { id: 'R1d' },
        { id: 'R1e' },
        { id: 'R2a' },
        { id: 'C1' },
        { id: 'C2' },
        { id: 'C3' },
        { id: 'C4' },
        { id: 'C5' },
        { id: 'R2b' },
      ],
      [
        ['R1a', 'R1b'],
        ['R1b', 'R1c'],
        ['R1c', 'R1d'],
        ['R1d', 'R1e'],
        ['R2a', 'C1'],
        ['C1', 'C2'],
        ['C2', 'C3'],
        ['C3', 'C4'],
        ['C4', 'C5'],
        ['C5', 'C1'],
        ['C5', 'R2b'],
      ],
    );

  it('ranks a root crossing a multi-node cycle by its real expanded length, not component-hop count', () => {
    const group = analyzeLongestPath(competingRoots(), 2, 1).groups[0];
    expect(group.nodeIds).toEqual(['R2a', 'C1', 'C2', 'C3', 'C4', 'C5', 'R2b']);
    expect(group.meta?.depth).toBe(6);
  });

  const twoBridges = () =>
    makeGraph(
      [
        { id: 'A1' },
        { id: 'A2' },
        { id: 'Short' },
        { id: 'L1' },
        { id: 'L2' },
        { id: 'L3' },
      ],
      [
        ['A1', 'A2'],
        ['A2', 'A1'],
        ['A1', 'Short'],
        ['A2', 'L1'],
        ['L1', 'L2'],
        ['L2', 'L3'],
      ],
    );

  it('keeps every inter-component bridge, not only the first edge seen', () => {
    const group = analyzeLongestPath(twoBridges(), 2).groups[0];
    expect(group.nodeIds).toEqual(['A1', 'A2', 'L1', 'L2', 'L3']);
    expect(group.meta?.depth).toBe(4);
  });
});

describe('analyzeCycles', () => {
  it.each([3, 4])(
    'captures every node of a %i-node cycle in one group',
    (size) => {
      const ids = ['A', 'B', 'C', 'D'].slice(0, size);
      const ring = makeGraph(
        ids.map((id) => ({ id })),
        ids.map((id, i): [string, string] => [id, ids[(i + 1) % size]]),
      );
      expect(
        analyzeCycles(ring).groups.map((group) => [...group.nodeIds].sort()),
      ).toEqual([ids]);
    },
  );

  it('keeps two disjoint cycles in separate groups', () => {
    const disjoint = makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'X' }, { id: 'Y' }],
      [
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'A'],
        ['X', 'Y'],
        ['Y', 'X'],
      ],
    );
    // Groups sort by size descending: the triangle before the pair.
    expect(
      analyzeCycles(disjoint).groups.map((group) => [...group.nodeIds].sort()),
    ).toEqual([
      ['A', 'B', 'C'],
      ['X', 'Y'],
    ]);
  });

  it('reports no cycle in a DAG', () => {
    const dag = makeGraph(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      [
        ['A', 'B'],
        ['A', 'C'],
      ],
    );
    expect(analyzeCycles(dag).groups).toEqual([]);
  });
});

describe('analyzeExternalRefs', () => {
  const file = (
    id: string,
    name?: string,
    externalUrl?: string,
  ): [string, Record<string, unknown>] => [
    id,
    { schema: '', name, type: 'external', externalType: 'file', externalUrl },
  ];
  const db = (
    id: string,
    name: string,
    externalDatabase?: string,
  ): [string, Record<string, unknown>] => [
    id,
    {
      schema: 'dbo',
      name,
      type: 'external',
      externalType: 'db',
      externalDatabase,
    },
  ];

  it.each([
    {
      name: 'a file source by its URL basename',
      node: file('file1', 'report.csv', 'https://host/path/report.csv'),
      label: 'report.csv',
      meta: { kind: 'file' },
    },
    {
      name: 'a file source with no URL by the node name',
      node: file('file1', 'orphan.csv', ''),
      label: 'orphan.csv',
      meta: { kind: 'file' },
    },
    {
      name: 'a file source whose URL has no path segment by the node name',
      node: file('file1', 'slash-only', '///'),
      label: 'slash-only',
      meta: { kind: 'file' },
    },
    {
      name: 'a file source with no name by the node id',
      node: file('file-id'),
      label: 'file-id',
      meta: { kind: 'file' },
    },
    {
      name: 'a database cross-reference as "database / name"',
      node: db('db1', 'dbo.Sales', 'OtherDB'),
      label: 'OtherDB / dbo.Sales',
      meta: { database: 'OtherDB' },
    },
    {
      name: 'a database cross-reference with no database by the node name',
      node: db('db1', 'dbo.Sales'),
      label: 'dbo.Sales',
      meta: { database: '' },
    },
  ])('labels $name', ({ node, label, meta }) => {
    const groups = analyzeExternalRefs(externalGraph([node])).groups;
    expect(groups.map((group) => group.label)).toEqual([label]);
    expect(groups[0].meta).toMatchObject(meta);
  });

  it('sorts files before databases, by label within each kind and within one database', () => {
    const graph = externalGraph([
      db('db1', 'schema.T1', 'BDB'),
      file('file2', 'zz.csv', 'https://host/zz.csv'),
      db('db4', 'schema.Z', 'SameDB'),
      file('file1', 'aa.csv', 'https://host/aa.csv'),
      db('db2', 'schema.T2', 'ADB'),
      db('db3', 'schema.A', 'SameDB'),
    ]);
    expect(
      analyzeExternalRefs(graph).groups.map((group) => group.label),
    ).toEqual([
      'aa.csv',
      'zz.csv',
      'ADB / schema.T2',
      'BDB / schema.T1',
      'SameDB / schema.A',
      'SameDB / schema.Z',
    ]);
  });

  it('includes the external node and every neighbour that reads it', () => {
    const graph = externalGraph(
      [
        file('file1', 'data.csv', 'https://host/data.csv'),
        ['sp1', { schema: 'dbo', name: 'sp1', type: 'procedure' }],
        ['sp2', { schema: 'dbo', name: 'sp2', type: 'procedure' }],
      ],
      [
        ['file1', 'sp1'],
        ['file1', 'sp2'],
      ],
    );
    const groups = analyzeExternalRefs(graph).groups;
    expect(groups).toHaveLength(1);
    expect([...groups[0].nodeIds].sort()).toEqual(['file1', 'sp1', 'sp2']);
  });
});

const CONFIG: AnalysisConfig = {
  hubMinDegree: 2,
  islandMaxSize: 4,
  longestPathMinNodes: 2,
};

/**
 * One hub (`H`, degree 4), one 2-node island (`I1`→`I2`), one orphan (`O`), one cycle
 * (`C1`→`C2`→`C1`) and a chain long enough for the longest-path analysis.
 */
function mixedGraph(): Graph {
  return makeGraph(
    [
      { id: 'H' },
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
      { id: 'I1' },
      { id: 'I2' },
      { id: 'O' },
      { id: 'C1' },
      { id: 'C2' },
    ],
    [
      ['a', 'H'],
      ['b', 'H'],
      ['H', 'c'],
      ['H', 'd'],
      ['I1', 'I2'],
      ['C1', 'C2'],
      ['C2', 'C1'],
    ],
  );
}

describe('runAnalysis — dispatch', () => {
  const TYPES: AnalysisType[] = [
    'islands',
    'hubs',
    'orphans',
    'longest-path',
    'cycles',
    'external-refs',
  ];

  it.each(TYPES)(
    'returns an empty %s report for an empty graph instead of throwing',
    (type) => {
      const result = runAnalysis(
        new Graph({ type: 'directed', multi: false }),
        type,
        CONFIG,
      );
      expect(result.type).toBe(type);
      expect(result.groups).toEqual([]);
    },
  );

  it('finds the island, the hub, the orphan and the cycle each under its own type', () => {
    const graph = mixedGraph();
    const nodesOf = (type: AnalysisType): string[] =>
      runAnalysis(graph, type, CONFIG)
        .groups.flatMap((group) => group.nodeIds)
        .sort();
    expect(nodesOf('islands')).toEqual(['C1', 'C2', 'I1', 'I2']);
    expect(
      runAnalysis(graph, 'hubs', CONFIG).groups.map((group) => group.id),
    ).toEqual(['hub-H', 'hub-C1', 'hub-C2']);
    expect(nodesOf('orphans')).toEqual(['O']);
    expect(nodesOf('cycles')).toEqual(['C1', 'C2']);
  });

  it('caps how many chains longest-path reports, without displacing the deepest one', () => {
    const nodes: Array<{ id: string }> = [];
    const edges: Array<[string, string]> = [];
    for (let chain = 0; chain < 40; chain++) {
      for (let step = 0; step < 6; step++) {
        nodes.push({ id: `n${chain}_${step}` });
        if (step > 0)
          edges.push([`n${chain}_${step - 1}`, `n${chain}_${step}`]);
      }
    }
    for (let step = 0; step < 9; step++) {
      nodes.push({ id: `deep_${step}` });
      if (step > 0) edges.push([`deep_${step - 1}`, `deep_${step}`]);
    }

    const groups = runAnalysis(
      makeGraph(nodes, edges),
      'longest-path',
      CONFIG,
    ).groups;
    expect(groups.length).toBeLessThan(40);
    expect(groups[0].nodeIds).toHaveLength(9);
  });
});
