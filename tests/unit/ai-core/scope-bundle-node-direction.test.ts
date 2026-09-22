/**
 * `lineage_get_scope_bundle`'s origin node entry carries an explicit `in`/`out` split (same shape
 * as `buildHopFocusNode`/`presentNeighbor`), so a consumer never has to infer direction from bare
 * `[source, target, type]` edge-tuple position. Every other node in the bundle keeps the scalar
 * `deg` it always had — the split is origin-only.
 */
import { describe, expect, it } from 'vitest';
import { getScopeBundle } from '../../../src/ai/tools/tools';
import { buildBareGraph } from '../../../src/ai/support/graphUtils';
import { DEFAULT_TURN_TOKEN_BUDGET as BUDGET } from '../../../src/ai/support/tokenBudget';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import type { GetScopeBundleInput } from '../../../src/ai/tools/toolSchemas';

/**
 * Origin `raworderimport` reads INTO `spcleanorders` (OUT side) and is written INTO BY
 * `spimportorders` (IN side) — both edges start at the origin, so tuple position alone cannot
 * distinguish them.
 */
function makeSplitModel(): DatabaseModel {
  const nodes: LineageNode[] = [
    { id: '[ai].[spimportorders]', schema: 'ai', name: 'spImportOrders', fullName: '[ai].[spImportOrders]', type: 'procedure', columns: [] },
    { id: '[ai].[raworderimport]', schema: 'ai', name: 'RawOrderImport', fullName: '[ai].[RawOrderImport]', type: 'table', columns: [] },
    { id: '[ai].[spcleanorders]', schema: 'ai', name: 'spCleanOrders', fullName: '[ai].[spCleanOrders]', type: 'procedure', columns: [] },
  ];
  return {
    nodes,
    edges: [
      { source: '[ai].[raworderimport]', target: '[ai].[spcleanorders]', type: 'body' },
      { source: '[ai].[spimportorders]', target: '[ai].[raworderimport]', type: 'body' },
    ],
    schemas: [{ name: 'ai', nodeCount: 3, types: { table: 1, view: 0, procedure: 2, function: 0, external: 0 } }],
    catalog: {},
    neighborIndex: {
      '[ai].[spimportorders]': { in: [], out: ['[ai].[raworderimport]'] },
      '[ai].[raworderimport]': { in: ['[ai].[spimportorders]'], out: ['[ai].[spcleanorders]'] },
      '[ai].[spcleanorders]': { in: ['[ai].[raworderimport]'], out: [] },
    },
    dbPlatform: 'SQL Server',
  };
}

describe('get_scope_bundle origin node serves an explicit in/out split (N-14)', () => {
  const model = makeSplitModel();
  const graph = buildBareGraph(model);
  const input: GetScopeBundleInput = {
    origin: '[ai].[raworderimport]',
    direction: 'bidirectional',
    depth: 1,
  } as GetScopeBundleInput;

  const res = getScopeBundle(model, graph, input, BUDGET) as {
    nodes: Array<Record<string, unknown>>;
    edges: Array<[string, string, string]>;
  };

  const originPayload = res.nodes.find(n => n.id === '[ai].[raworderimport]')!;
  const upstreamPayload = res.nodes.find(n => n.id === '[ai].[spimportorders]')!;
  const downstreamPayload = res.nodes.find(n => n.id === '[ai].[spcleanorders]')!;

  it('sanity: both fixture edges start at the origin, so tuple position cannot signal direction', () => {
    const startingAtOrigin = res.edges.filter(([source]) => source === '[ai].[raworderimport]');
    expect(startingAtOrigin.length).toBe(1);
    expect(res.edges.length).toBe(2);
  });

  it("origin node entry carries an explicit in/out split naming which side each neighbor is on — recoverable from the split alone, ignoring res.edges entirely", () => {
    expect(Array.isArray(originPayload.in), 'origin payload has an in[] array').toBe(true);
    expect(Array.isArray(originPayload.out), 'origin payload has an out[] array').toBe(true);
    const inIds = (originPayload.in as Array<Record<string, unknown>>).map(n => n.id);
    const outIds = (originPayload.out as Array<Record<string, unknown>>).map(n => n.id);
    expect(inIds, 'origin in[] names its upstream neighbor').toEqual(['[ai].[spimportorders]']);
    expect(outIds, 'origin out[] names its downstream neighbor').toEqual(['[ai].[spcleanorders]']);
  });

  it('origin in[] neighbor entry carries edge direction/type metadata in the same shape as buildHopFocusNode (id/s/n/t/e)', () => {
    const entry = (originPayload.in as Array<Record<string, unknown>>)[0];
    expect(entry.id, 'neighbor entry names the neighbor id').toBe('[ai].[spimportorders]');
    expect(entry.s, 'neighbor entry carries schema').toBe('ai');
    expect(entry.n, 'neighbor entry carries name').toBe('spImportOrders');
    expect(entry.t, 'neighbor entry carries type').toBe('procedure');
    expect(entry.e, 'a procedure-sourced body edge is surfaced as write, matching edgeApiType').toBe('write');
  });

  it('origin out[] neighbor entry reports the read edge type', () => {
    const entry = (originPayload.out as Array<Record<string, unknown>>)[0];
    expect(entry.id, 'neighbor entry names the neighbor id').toBe('[ai].[spcleanorders]');
    expect(entry.e, 'a table-sourced body edge is surfaced as read, matching edgeApiType').toBe('read');
  });

  it('collateral check: non-origin nodes in the same bundle keep the scalar deg only, no in/out growth', () => {
    expect(upstreamPayload.in, 'non-origin neighbor payload gets no in[] array').toBeUndefined();
    expect(upstreamPayload.out, 'non-origin neighbor payload gets no out[] array').toBeUndefined();
    expect(downstreamPayload.in, 'non-origin neighbor payload gets no in[] array').toBeUndefined();
    expect(downstreamPayload.out, 'non-origin neighbor payload gets no out[] array').toBeUndefined();
    expect(typeof upstreamPayload.deg, 'non-origin node payload keeps its scalar degree').toBe('number');
    expect(typeof downstreamPayload.deg, 'non-origin node payload keeps its scalar degree').toBe('number');
  });
});
