/**
 * Exclusion-filter equivalence guard.
 *
 * `applyExclusionFilter` (graph-time, modelFilters) and `applyExclusionPatterns`
 * (load-time, dacpacExtractor) must exclude exactly the same nodes and edges for
 * the same patterns; the load-time function adds parse-stat bookkeeping on top and
 * nothing else. These tests pin that contract so the two paths cannot drift.
 */

import { describe, it, expect } from 'vitest';
import { applyExclusionFilter } from '../../../src/engine/modelFilters';
import { applyExclusionPatterns } from '../../../src/engine/dacpacExtractor';
import type { DatabaseModel, LineageNode, LineageEdge, ParseStats } from '../../../src/engine/types';

const node = (schema: string, name: string): LineageNode =>
  ({ id: `${schema}.${name}`.toLowerCase(), schema, name, fullName: `[${schema}].[${name}]`, type: 'table' }) as LineageNode;

const edge = (source: string, target: string): LineageEdge =>
  ({ source, target, type: 'body' }) as LineageEdge;

function model(nodes: LineageNode[], edges: LineageEdge[], parseStats?: ParseStats): DatabaseModel {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.schema, (counts.get(n.schema) ?? 0) + 1);
  const schemas = [...counts].map(([name, nodeCount]) => ({ name, nodeCount }));
  return { nodes, edges, schemas, parseStats } as unknown as DatabaseModel;
}

const sample = () =>
  model(
    [node('dbo', 'Orders'), node('dbo', 'Customers'), node('staging', 'Orders_TEST'), node('staging', 'Raw')],
    [
      edge('dbo.orders', 'dbo.customers'),
      edge('staging.orders_test', 'dbo.orders'),
      edge('staging.raw', 'staging.orders_test'),
    ],
  );

describe('exclusion filters', () => {
  it('removes matching nodes and every edge touching them', () => {
    const filtered = applyExclusionFilter(sample(), ['_TEST$']);

    expect(filtered.nodes.map((n) => n.id)).toEqual(['dbo.orders', 'dbo.customers', 'staging.raw']);
    expect(filtered.edges).toEqual([edge('dbo.orders', 'dbo.customers')]);
  });

  it('matches against fullName as well as schema.name', () => {
    const filtered = applyExclusionFilter(sample(), ['^\\[staging\\]']);

    expect(filtered.nodes.map((n) => n.id)).toEqual(['dbo.orders', 'dbo.customers']);
  });

  it('returns the input model unchanged for an empty pattern list', () => {
    const input = sample();

    expect(applyExclusionFilter(input, [])).toBe(input);
    expect(applyExclusionPatterns(input, [])).toBe(input);
  });

  it('reports every unparseable pattern and returns the input when none survive', () => {
    const input = sample();
    const invalidFilter: string[] = [];
    const invalidPatterns: string[] = [];

    expect(applyExclusionFilter(input, ['[', '('], (p) => invalidFilter.push(p))).toBe(input);
    expect(applyExclusionPatterns(input, ['[', '('], (msg) => invalidPatterns.push(msg))).toBe(input);

    expect(invalidFilter).toEqual(['[', '(']);
    expect(invalidPatterns).toHaveLength(2);
    expect(invalidPatterns[0]).toMatch(/^Invalid exclude pattern "\[": /);
  });

  it('skips only the invalid pattern and still applies the valid ones', () => {
    const warnings: string[] = [];
    const filtered = applyExclusionPatterns(sample(), ['[', '_TEST$'], (msg) => warnings.push(msg));

    expect(warnings).toHaveLength(1);
    expect(filtered.nodes.map((n) => n.id)).toEqual(['dbo.orders', 'dbo.customers', 'staging.raw']);
  });

  it('excludes the same nodes and edges on both the load-time and graph-time paths', () => {
    for (const patterns of [['_TEST$'], ['^staging\\.'], ['^\\[staging\\]'], ['dbo\\.Orders$'], ['nomatch']]) {
      const viaFilter = applyExclusionFilter(sample(), patterns);
      const viaPatterns = applyExclusionPatterns(sample(), patterns);

      expect(viaPatterns.nodes.map((n) => n.id)).toEqual(viaFilter.nodes.map((n) => n.id));
      expect(viaPatterns.edges).toEqual(viaFilter.edges);
    }
  });

  it('records excluded neighbours on the parse stats of surviving procedures', () => {
    const stats: ParseStats = {
      parsedRefs: 2,
      resolvedEdges: 2,
      droppedRefs: [],
      spDetails: [{ name: 'dbo.Orders', inCount: 1, outCount: 1, unrelated: [] }],
    };
    const input = model(
      [node('dbo', 'Orders'), node('staging', 'Raw_TEST')],
      [edge('staging.raw_test', 'dbo.orders')],
      stats,
    );

    const filtered = applyExclusionPatterns(input, ['_TEST$']);

    expect(filtered.parseStats?.spDetails[0].excluded).toEqual(['staging.Raw_TEST']);
    expect(stats.spDetails[0].excluded).toBeUndefined();
  });

  it('leaves parse stats untouched when no node is excluded', () => {
    const stats: ParseStats = {
      parsedRefs: 1,
      resolvedEdges: 1,
      droppedRefs: [],
      spDetails: [{ name: 'dbo.Orders', inCount: 1, outCount: 0, unrelated: [] }],
    };
    const input = model([node('dbo', 'Orders')], [], stats);

    const filtered = applyExclusionPatterns(input, ['nomatch']);

    expect(filtered.parseStats).toBe(stats);
  });
});
