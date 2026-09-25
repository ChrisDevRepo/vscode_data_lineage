/**
 * Pins `applyIsolationFilter` (Hide Isolated Nodes): flag on drops every degree-zero node and any
 * dangling edge; flag off passes the model through untouched.
 */

import { describe, it, expect } from 'vitest';
import { applyIsolationFilter } from '../../../src/engine/modelFilters';
import type { DatabaseModel, LineageNode, LineageEdge, ParseStats } from '../../../src/engine/types';

const node = (schema: string, name: string): LineageNode =>
  ({ id: `${schema}.${name}`.toLowerCase(), schema, name, fullName: `[${schema}].[${name}]`, type: 'table' });

const edge = (source: string, target: string): LineageEdge =>
  ({ source, target, type: 'body' });

function model(nodes: LineageNode[], edges: LineageEdge[], parseStats?: ParseStats): DatabaseModel {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.schema, (counts.get(n.schema) ?? 0) + 1);
  const schemas = [...counts].map(([name, nodeCount]) => ({ name, nodeCount }));
  return { nodes, edges, schemas, parseStats } as unknown as DatabaseModel;
}

const sample = () =>
  model(
    [node('dbo', 'Orders'), node('dbo', 'Customers'), node('dbo', 'Orphan')],
    [edge('dbo.orders', 'dbo.customers')],
  );

describe('isolation filter', () => {
  it('passes the model through untouched when the flag is off', () => {
    const input = sample();
    const filtered = applyIsolationFilter(input, false);

    expect(filtered).toBe(input);
  });

  it('removes degree-zero nodes and keeps every edge between survivors', () => {
    const filtered = applyIsolationFilter(sample(), true);

    expect(filtered.nodes.map((n) => n.id)).toEqual(['dbo.orders', 'dbo.customers']);
    expect(filtered.edges).toEqual([edge('dbo.orders', 'dbo.customers')]);
  });

  it('empties an edgeless model', () => {
    const filtered = applyIsolationFilter(model([node('dbo', 'A'), node('dbo', 'B')], []), true);

    expect(filtered.nodes).toEqual([]);
    expect(filtered.edges).toEqual([]);
  });
});
