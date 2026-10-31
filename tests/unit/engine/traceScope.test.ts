import { makeGraph } from '../helpers/modelFixtures';
import {
  buildTraceScopeGraph,
  buildVisibleTraceScope,
  canPruneTraceNode,
  collectScopeEdgeIds,
} from '../../../src/engine/traceScope';
import type {
  DatabaseModel,
  LineageEdge,
  LineageNode,
} from '../../../src/engine/types';
import { describe, expect, it } from 'vitest';

describe('Trace Scope Safety Tests', () => {
  function edges(...pairs: Array<[string, string]>): LineageEdge[] {
    return pairs.map(([source, target]) => ({
      source,
      target,
      type: 'body' as const,
    }));
  }
  it.each([
    {
      name: 'base only',
      base: ['A', 'B', 'C'],
      added: [],
      pruned: [],
      visible: ['A', 'B', 'C'],
    },
    {
      name: 'add',
      base: ['A', 'B'],
      added: ['C'],
      pruned: [],
      visible: ['A', 'B', 'C'],
    },
    {
      name: 'prune',
      base: ['A', 'B', 'C'],
      added: [],
      pruned: ['B'],
      visible: ['A', 'C'],
    },
    // C added then pruned → absent: a pruned node stays hidden whether it came from base or add.
    {
      name: 'add+prune',
      base: ['A', 'B'],
      added: ['C', 'D'],
      pruned: ['B', 'C'],
      visible: ['A', 'D'],
    },
  ])(
    '$name: visible nodes are (base ∪ added) − pruned',
    ({ base, added, pruned, visible }) => {
      const { nodeIds } = buildVisibleTraceScope(
        new Set(base),
        new Set(added),
        new Set(pruned),
        [],
      );
      expect(nodeIds).toEqual(new Set(visible));
    },
  );

  it('edge collection: keeps edges with both ends in scope, drops the rest', () => {
    const base = new Set(['A', 'B', 'C']);
    const edgeList = edges(['A', 'B'], ['B', 'C'], ['A', 'C'], ['B', 'D']);
    const { nodeIds, edgeIds } = buildVisibleTraceScope(
      base,
      new Set(),
      new Set(),
      edgeList,
    );
    expect(nodeIds).toEqual(new Set(['A', 'B', 'C']));
    // B→D leaves the scope: D is not visible.
    expect(edgeIds).toEqual(new Set(['A→B', 'B→C', 'A→C']));
  });

  it.each([
    { name: 'empty node scope', pairs: [['A', 'B']], scope: [], ids: [] },
    {
      name: 'self-loop in scope',
      pairs: [['A', 'A']],
      scope: ['A'],
      ids: ['A→A'],
    },
  ] as const)('edge collection: $name', ({ pairs, scope, ids }) => {
    expect(
      collectScopeEdgeIds(
        edges(...pairs.map(([s, t]): [string, string] => [s, t])),
        new Set(scope),
      ),
    ).toEqual(new Set(ids));
  });

  const both = ['downstream', 'upstream'] as const;

  it.each([
    {
      name: 'origin prune',
      origin: 'O',
      visible: ['O', 'A'],
      target: 'O',
      reason: 'origin',
    },
    {
      name: 'not-visible prune',
      origin: 'O',
      visible: ['O', 'A'],
      target: 'HIDDEN',
      reason: 'not-visible',
    },
    {
      name: 'null origin',
      origin: null,
      visible: ['A'],
      target: 'A',
      reason: 'origin',
    },
    {
      name: 'origin not in visible',
      origin: 'O',
      visible: ['A'],
      target: 'A',
      reason: 'origin',
    },
  ])(
    '$name: refused with reason $reason',
    ({ origin, visible, target, reason }) => {
      const g = makeGraph([{ id: 'O' }, { id: 'A' }], [['O', 'A']]);
      expect(
        canPruneTraceNode(g, origin, new Set(visible), target, [...both]),
      ).toEqual({ safe: false, reason });
    },
  );
});

describe('buildTraceScopeGraph', () => {
  function node(name: string): LineageNode {
    return {
      id: `[dbo].[${name}]`,
      schema: 'dbo',
      name,
      fullName: `[dbo].[${name}]`,
      type: 'table',
    };
  }
  function edge(source: string, target: string): LineageEdge {
    return {
      source: `[dbo].[${source}]`,
      target: `[dbo].[${target}]`,
      type: 'body',
    };
  }
  const model: DatabaseModel = {
    nodes: [node('A'), node('B'), node('C'), node('D')],
    edges: [edge('A', 'B'), edge('B', 'C'), edge('C', 'D')],
    schemas: [],
    catalog: {},
    neighborIndex: {},
  };

  it('keeps only scope members and internal edges', () => {
    const graph = buildTraceScopeGraph(
      model,
      new Set(['[dbo].[A]', '[dbo].[B]']),
    );
    expect(graph.nodes().sort(), 'scope members only').toEqual([
      '[dbo].[A]',
      '[dbo].[B]',
    ]);
    expect(
      graph.mapEdges((_key, _attrs, source, target) => [source, target]),
      'only the internal edge survives',
    ).toEqual([['[dbo].[A]', '[dbo].[B]']]);
  });
});
