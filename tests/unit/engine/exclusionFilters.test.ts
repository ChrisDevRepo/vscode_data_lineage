/** Exclusion-filter equivalence guard. */

import { describe, it, expect } from 'vitest';
import {
  applyExclusionFilter,
  applyExclusionPatterns,
  scopeModelForVisualize,
} from '../../../src/engine/modelFilters';
import type {
  DatabaseModel,
  LineageNode,
  LineageEdge,
  ParseStats,
} from '../../../src/engine/shared/types';

const node = (schema: string, name: string): LineageNode => ({
  id: `${schema}.${name}`.toLowerCase(),
  schema,
  name,
  fullName: `[${schema}].[${name}]`,
  type: 'table',
});

const edge = (source: string, target: string): LineageEdge => ({
  source,
  target,
  type: 'body',
});

function model(
  nodes: LineageNode[],
  edges: LineageEdge[],
  parseStats?: ParseStats,
): DatabaseModel {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.schema, (counts.get(n.schema) ?? 0) + 1);
  const schemas = [...counts].map(([name, nodeCount]) => ({ name, nodeCount }));
  return { nodes, edges, schemas, parseStats } as unknown as DatabaseModel;
}

const sample = () =>
  model(
    [
      node('dbo', 'Orders'),
      node('dbo', 'Customers'),
      node('staging', 'Orders_TEST'),
      node('staging', 'Raw'),
    ],
    [
      edge('dbo.orders', 'dbo.customers'),
      edge('staging.orders_test', 'dbo.orders'),
      edge('staging.raw', 'staging.orders_test'),
    ],
  );

describe('exclusion filters', () => {
  it('returns the input model unchanged for an empty pattern list', () => {
    const input = sample();

    expect(applyExclusionFilter(input, [])).toBe(input);
    expect(applyExclusionPatterns(input, [])).toBe(input);
  });

  it('reports every unparseable pattern and returns the input when none survive', () => {
    const input = sample();
    const invalidFilter: string[] = [];
    const invalidPatterns: string[] = [];

    expect(
      applyExclusionFilter(input, ['[', '('], (p) => invalidFilter.push(p)),
    ).toBe(input);
    expect(
      applyExclusionPatterns(input, ['[', '('], (msg) =>
        invalidPatterns.push(msg),
      ),
    ).toBe(input);

    expect(invalidFilter).toEqual(['[', '(']);
    expect(invalidPatterns).toEqual([
      expect.stringMatching(/^Invalid exclude pattern "\[": /),
      expect.stringMatching(/^Invalid exclude pattern "\(": /),
    ]);
  });

  it('skips only the invalid pattern and still applies the valid ones', () => {
    const warnings: string[] = [];
    const filtered = applyExclusionPatterns(sample(), ['[', '_TEST$'], (msg) =>
      warnings.push(msg),
    );

    expect(warnings).toEqual([
      expect.stringMatching(/^Invalid exclude pattern "\[": /),
    ]);
    expect(filtered.nodes.map((n) => n.id)).toEqual([
      'dbo.orders',
      'dbo.customers',
      'staging.raw',
    ]);
  });

  it('excludes the same nodes and edges on both the load-time and graph-time paths', () => {
    const all = [
      'dbo.orders',
      'dbo.customers',
      'staging.orders_test',
      'staging.raw',
    ];
    const cases: Array<[string, string[], string[]]> = [
      [
        '_TEST$',
        ['dbo.orders', 'dbo.customers', 'staging.raw'],
        ['dbo.orders>dbo.customers'],
      ],
      [
        '^staging\\.',
        ['dbo.orders', 'dbo.customers'],
        ['dbo.orders>dbo.customers'],
      ],
      [
        '^\\[staging\\]',
        ['dbo.orders', 'dbo.customers'],
        ['dbo.orders>dbo.customers'],
      ],
      [
        'dbo\\.Orders$',
        ['dbo.customers', 'staging.orders_test', 'staging.raw'],
        ['staging.raw>staging.orders_test'],
      ],
      [
        'nomatch',
        all,
        [
          'dbo.orders>dbo.customers',
          'staging.orders_test>dbo.orders',
          'staging.raw>staging.orders_test',
        ],
      ],
    ];
    for (const [pattern, nodes, edges] of cases) {
      for (const result of [
        applyExclusionFilter(sample(), [pattern]),
        applyExclusionPatterns(sample(), [pattern]),
      ]) {
        expect(
          result.nodes.map((n) => n.id),
          pattern,
        ).toEqual(nodes);
        expect(
          result.edges.map((e) => `${e.source}>${e.target}`),
          pattern,
        ).toEqual(edges);
      }
    }
  });

  it('records excluded neighbours on the parse stats of surviving procedures', () => {
    const stats: ParseStats = {
      parsedRefs: 2,
      resolvedEdges: 2,
      droppedRefs: [],
      spDetails: [
        { name: 'dbo.Orders', inCount: 1, outCount: 1, unrelated: [] },
      ],
    };
    const input = model(
      [node('dbo', 'Orders'), node('staging', 'Raw_TEST')],
      [edge('staging.raw_test', 'dbo.orders')],
      stats,
    );

    const filtered = applyExclusionPatterns(input, ['_TEST$']);

    expect(filtered.parseStats?.spDetails[0].excluded).toEqual([
      'staging.Raw_TEST',
    ]);
    expect(stats.spDetails[0].excluded).toBeUndefined();
  });

  it('recounts Visualize schemas with the model case rule', () => {
    const scoped = scopeModelForVisualize(
      {
        ...model(
          [node('Sales', 'A'), node('sales', 'B'), node('Sales', 'C_TEST')],
          [],
        ),
        identifierCaseSensitive: true,
      },
      new Set(['Sales', 'sales']),
      ['_TEST$'],
    );
    expect(scoped.schemas.map((s) => [s.name, s.nodeCount]).sort()).toEqual([
      ['Sales', 1],
      ['sales', 1],
    ]);
  });

  it('leaves parse stats untouched when no node is excluded', () => {
    const stats: ParseStats = {
      parsedRefs: 1,
      resolvedEdges: 1,
      droppedRefs: [],
      spDetails: [
        { name: 'dbo.Orders', inCount: 1, outCount: 0, unrelated: [] },
      ],
    };
    const input = model([node('dbo', 'Orders')], [], stats);

    const filtered = applyExclusionPatterns(input, ['nomatch']);

    expect(filtered.parseStats).toBe(stats);
  });
});
