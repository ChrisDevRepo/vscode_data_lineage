/**
 * Unit tests for `searchObjects` list-all semantics.
 *
 * Guards the fix where an EMPTY query paired with an explicit `schemas[]` scope is a
 * legitimate "list everything in schema X" request — it must enumerate the schema, not
 * reject with `query_too_short` and not hand an empty string to `searchCatalog` (which
 * matches nothing). A short query with NO schema scope must still reject.
 */

import { describe, expect, it } from 'vitest';
import { searchObjects } from '../../../src/ai/tools/tools';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';

function makeModel(): DatabaseModel {
  const nodes: LineageNode[] = [
    { id: '[ai].[activeregions]', schema: 'ai', name: 'ActiveRegions', fullName: '[ai].[ActiveRegions]', type: 'table', columns: [] },
    { id: '[ai].[archiveorders]', schema: 'ai', name: 'ArchiveOrders', fullName: '[ai].[ArchiveOrders]', type: 'table', columns: [] },
    { id: '[ai].[vwsales]', schema: 'ai', name: 'vwSales', fullName: '[ai].[vwSales]', type: 'view', columns: [] },
    { id: '[dbo].[customers]', schema: 'dbo', name: 'Customers', fullName: '[dbo].[Customers]', type: 'table', columns: [] },
  ];
  return {
    nodes,
    edges: [],
    schemas: [
      { name: 'ai', nodeCount: 3, types: { table: 2, view: 1, procedure: 0, function: 0, external: 0 } },
      { name: 'dbo', nodeCount: 1, types: { table: 1, view: 0, procedure: 0, function: 0, external: 0 } },
    ],
    catalog: {},
    neighborIndex: {},
    dbPlatform: 'SQL Server',
  };
}

describe('search-objects-listall', () => {
  const model = makeModel();

  it('empty query + schema scope enumerates the schema', () => {
    const res = searchObjects(model, '', undefined, ['ai']) as Record<string, unknown>;
    expect('error' in res, 'empty query with schemas[] does not reject').toBe(false);
    const results = res.results as Array<Record<string, unknown>>;
    expect(results.length, 'lists all 3 objects in the [ai] schema').toBe(3);
    expect(results.every(r => (r.s as string) === 'ai'), 'every result is in the requested schema').toBe(true);
  });

  it('schema match is case-insensitive', () => {
    const res = searchObjects(model, '', undefined, ['AI']) as Record<string, unknown>;
    const results = res.results as Array<Record<string, unknown>>;
    expect(results.length, 'schema match is case-insensitive (AI == ai)').toBe(3);
  });

  it('empty query + schema scope honors the type filter', () => {
    const res = searchObjects(model, '', ['table'], ['ai']) as Record<string, unknown>;
    const results = res.results as Array<Record<string, unknown>>;
    expect(results.length, 'list-all honors the type filter (2 tables in [ai])').toBe(2);
  });

  it('empty type filter means no filter for schema enumeration', () => {
    const res = searchObjects(model, '', [], ['ai']) as Record<string, unknown>;
    const results = res.results as Array<Record<string, unknown>>;
    expect(results.length, 'list-all treats types:[] as no type filter').toBe(3);
  });

  it('empty query WITHOUT a schema scope still rejects', () => {
    const res = searchObjects(model, '', undefined, undefined) as Record<string, unknown>;
    expect(res.error, 'empty query with no schema scope still rejects').toBe('query_too_short');
  });

  it('one-char query without schema still rejects', () => {
    const res = searchObjects(model, 'a', undefined, undefined) as Record<string, unknown>;
    expect(res.error, 'sub-2-char query without schema rejects').toBe('query_too_short');
  });

  it('a real substring query is unaffected', () => {
    const res = searchObjects(model, 'order', undefined, ['ai']) as Record<string, unknown>;
    expect('error' in res, 'substring query does not reject').toBe(false);
    const results = res.results as Array<Record<string, unknown>>;
    expect(results.some(r => r.id === '[ai].[archiveorders]'), 'substring query still finds ArchiveOrders').toBe(true);
  });

  it('empty type filter means no filter for ordinary substring search', () => {
    const res = searchObjects(model, 'sales', [], ['ai']) as Record<string, unknown>;
    const results = res.results as Array<Record<string, unknown>>;
    expect(results.some(r => r.id === '[ai].[vwsales]'), 'substring search treats types:[] as no type filter').toBe(true);
  });

  it('explicit non-empty type filter remains active', () => {
    const res = searchObjects(model, 'sales', ['table'], ['ai']) as Record<string, unknown>;
    const results = res.results as Array<Record<string, unknown>>;
    expect(results.length, 'substring search preserves explicit non-empty type filtering').toBe(0);
  });
});
