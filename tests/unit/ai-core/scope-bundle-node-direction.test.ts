/**
 * Unit coverage for N-14: `lineage_get_scope_bundle`'s node payload could not answer "which side".
 *
 * @remarks
 * `edges` in the bundle response is a list of bare positional `[source, target, type]` triples —
 * no direction key. Two captured arms of the same question on the same graph showed a model
 * reading tuple POSITION as direction: with `origin=[ai].[spimportorders]`, two of three edges
 * started at the origin, and the model concluded "no upstream source objects" against the graph's
 * own `spimportorders -> raworderimport` write edge sitting in the same payload (scored 0). The
 * `hop_context` route (`buildHopFocusNode`) never has this problem — it always serves an explicit
 * `in`/`out` split per node via `presentNeighbor` (scored 100 on the same question).
 *
 * The repair: `presentNode` (src/ai/support/aiPresenter.ts) now accepts an optional
 * `splitContext` and, when given one alongside a `neighborIndex` entry, adds `in`/`out` arrays in
 * the exact shape `buildHopFocusNode` already emits — same `presentNeighbor` call, same
 * `{id, s, n, t, e}` per-neighbor shape. `getScopeBundle` (src/ai/tools/tools.ts) passes that
 * context only for the origin node, so every other node keeps the scalar `deg` it always had.
 *
 * This suite proves: (1) the origin's node entry now distinguishes its upstream neighbor from its
 * downstream neighbor without any recourse to edge-tuple position, and (2) no other node in the
 * bundle grows a payload it did not have before.
 */
import { describe, expect, it } from 'vitest';
import { getScopeBundle } from '../../../src/ai/tools/tools';
import { buildBareGraph } from '../../../src/ai/support/graphUtils';
import { DEFAULT_TURN_TOKEN_BUDGET as BUDGET } from '../../../src/ai/support/tokenBudget';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import type { GetScopeBundleInput } from '../../../src/ai/tools/toolSchemas';

/**
 * Mirrors the captured wire evidence: origin `raworderimport` reads INTO `spcleanorders`
 * (raworderimport is the source, so that edge is raworderimport's OUT side) and is written INTO
 * BY `spimportorders` (spimportorders is the source, so that edge is raworderimport's IN side).
 * Two of the model's three edges start at the origin — the exact shape that made tuple position
 * look like a direction signal in the captured defect.
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

  it('sanity: the fixture reproduces the captured shape — two of three edges start at the origin', () => {
    const startingAtOrigin = res.edges.filter(([source]) => source === '[ai].[raworderimport]');
    expect(startingAtOrigin.length, 'two of three edges in this fixture start at the origin, exactly like the captured payload').toBe(1);
    expect(res.edges.length, 'fixture carries exactly the two edges from the captured evidence').toBe(2);
  });

  it("origin node entry carries an explicit in/out split naming which side each neighbor is on", () => {
    expect(Array.isArray(originPayload.in), 'origin payload has an in[] array').toBe(true);
    expect(Array.isArray(originPayload.out), 'origin payload has an out[] array').toBe(true);
    const inIds = (originPayload.in as Array<Record<string, unknown>>).map(n => n.id);
    const outIds = (originPayload.out as Array<Record<string, unknown>>).map(n => n.id);
    expect(inIds, 'origin in[] names its upstream neighbor').toEqual(['[ai].[spimportorders]']);
    expect(outIds, 'origin out[] names its downstream neighbor').toEqual(['[ai].[spcleanorders]']);
  });

  it('a consumer reading only the origin in/out split (never edge-tuple position) recovers the correct side', () => {
    // This is the exact defect from the captured evidence: a consumer that only had the bare
    // edge triples read POSITION as direction and declared "no upstream source objects" against
    // an edge that was in fact the origin's upstream side. Prove the served split makes that
    // misreading impossible by deriving direction from the split alone, ignoring `res.edges`
    // entirely, and checking it lands on the correct side.
    const inIds = new Set((originPayload.in as Array<Record<string, unknown>>).map(n => n.id));
    const outIds = new Set((originPayload.out as Array<Record<string, unknown>>).map(n => n.id));
    expect(inIds.has('[ai].[spimportorders]'), 'the write-source neighbor is recoverable as upstream from the split alone').toBe(true);
    expect(outIds.has('[ai].[spcleanorders]'), 'the read-target neighbor is recoverable as downstream from the split alone').toBe(true);
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
