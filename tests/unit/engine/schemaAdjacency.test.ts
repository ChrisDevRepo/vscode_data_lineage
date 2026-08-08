/**
 * Model-level schema connectivity guard.
 *
 * Verifies the debug-dump connectivity summary reflects the true topology:
 * a self-contained schema is reported ISOLATED, cross-schema links concentrated
 * in a hub schema make the hub bridge the others, and dropping the hub (as a GUI
 * schema filter would) fragments the remainder into separate components. This is
 * the exact situation behind the "orphan clusters until dbo is added" report.
 */

import { describe, it, expect } from 'vitest';
import { summarizeModelConnectivity } from '../../../src/engine/schemaAdjacency';
import type { DatabaseModel, LineageNode, LineageEdge } from '../../../src/engine/types';

const node = (id: string, schema: string): LineageNode =>
  ({ id, schema, name: id, fullName: id, type: 'table' });
const edge = (source: string, target: string): LineageEdge => ({ source, target, type: 'body' });

function model(nodes: LineageNode[], edges: LineageEdge[]): DatabaseModel {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.schema, (counts.get(n.schema) ?? 0) + 1);
  const schemas = [...counts].map(([name, nodeCount]) => ({ name, nodeCount }));
  return { nodes, edges, schemas } as unknown as DatabaseModel;
}

describe('Model Schema Connectivity', () => {
  it('full model: ai self-contained; dbo bridges Production + Sales', () => {
    const nodes = [
      node('ai.a', 'ai'), node('ai.b', 'ai'),
      node('prod.x', 'Production'), node('prod.y', 'Production'),
      node('sales.s', 'Sales'),
      node('dbo.p', 'dbo'), node('dbo.f', 'dbo'),
    ];
    const edges = [
      edge('ai.a', 'ai.b'),          // intra-ai — must not create an inter-schema edge
      edge('prod.x', 'dbo.p'),       // Production → dbo
      edge('sales.s', 'dbo.f'),      // Sales → dbo
    ];
    const conn = summarizeModelConnectivity(model(nodes, edges));

    expect(conn.components.length, 'two components: {ai} and {Production,dbo,Sales}').toBe(2);
    expect(conn.isolatedSchemas.includes('ai'), 'ai reported as isolated').toBe(true);
    expect(conn.isolatedSchemas.length === 1, 'only ai is isolated').toBe(true);

    const bridged = conn.components.find((c) => c.schemas.includes('dbo'));
    expect(!!bridged, 'a component contains dbo').toBe(true);
    expect(
      !!bridged && bridged.schemas.includes('Production') && bridged.schemas.includes('Sales'),
      'dbo component also contains Production and Sales',
    ).toBe(true);

    const hasProdDbo = conn.interSchemaEdges.some((e) =>
      (e.source === 'Production' && e.target === 'dbo') || (e.source === 'dbo' && e.target === 'Production'));
    const hasSalesDbo = conn.interSchemaEdges.some((e) =>
      (e.source === 'Sales' && e.target === 'dbo') || (e.source === 'dbo' && e.target === 'Sales'));
    expect(hasProdDbo, 'inter-schema edge Production–dbo recorded').toBe(true);
    expect(hasSalesDbo, 'inter-schema edge Sales–dbo recorded').toBe(true);

    expect(
      conn.interSchemaEdges.some((e) => e.source === e.target),
      'no intra-schema self relation',
    ).toBe(false);
  });

  it('filtered model (dbo dropped): the bridge is gone → three orphans', () => {
    const nodes = [
      node('ai.a', 'ai'), node('ai.b', 'ai'),
      node('prod.x', 'Production'), node('prod.y', 'Production'),
      node('sales.s', 'Sales'),
    ];
    const edges = [edge('ai.a', 'ai.b')]; // only intra-ai survives; cross-schema edges went through dbo
    const conn = summarizeModelConnectivity(model(nodes, edges));

    expect(conn.components.length, 'three components once the dbo bridge is filtered out').toBe(3);
    expect(conn.isolatedSchemas.length, 'ai, Production and Sales all isolated').toBe(3);
    expect(conn.interSchemaEdges.length, 'no inter-schema edges remain').toBe(0);
  });
});
