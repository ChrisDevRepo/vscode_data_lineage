/**
 * `lineage_get_scope_bundle` already computes each node's hop distance from the origin while
 * capping the BFS walk (`tools.ts` `walkWithCap`'s `depth` argument) and used to throw it away.
 * Every returned node now carries that distance back — `uh` (upstream hop distance) and/or `dh`
 * (downstream hop distance), scalar per side, never an array — so "which nodes are upstream, and
 * how far" is a transcription of the response instead of a graph walk the model has to redo over
 * the flat positional `edges[]`.
 *
 * Fixture (not the objects behind the measured defect): a two-hop upstream chain
 * `UpstreamTwo -> UpstreamOne -> Root`, a one-hop downstream neighbor `Root -> DownstreamOne`, and
 * a node reachable on both sides of `Root` (`BothSides`, one edge each direction) standing in for
 * a node that is both read and written by the origin.
 */
import { describe, expect, it } from 'vitest';
import { getScopeBundle } from '../../../src/ai/tools/tools';
import { buildBareGraph } from '../../../src/ai/support/graphUtils';
import { DEFAULT_TURN_TOKEN_BUDGET as BUDGET } from '../../../src/ai/support/tokenBudget';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import type { GetScopeBundleInput } from '../../../src/ai/tools/toolSchemas';

const ORIGIN = '[dbo].[root]';
const UPSTREAM_ONE = '[dbo].[upstreamone]';
const UPSTREAM_TWO = '[dbo].[upstreamtwo]';
const DOWNSTREAM_ONE = '[dbo].[downstreamone]';
const BOTH_SIDES = '[dbo].[bothsides]';

function makeHopModel(): DatabaseModel {
  const nodes: LineageNode[] = [
    { id: ORIGIN, schema: 'dbo', name: 'Root', fullName: '[dbo].[Root]', type: 'procedure', columns: [] },
    { id: UPSTREAM_ONE, schema: 'dbo', name: 'UpstreamOne', fullName: '[dbo].[UpstreamOne]', type: 'table', columns: [] },
    { id: UPSTREAM_TWO, schema: 'dbo', name: 'UpstreamTwo', fullName: '[dbo].[UpstreamTwo]', type: 'table', columns: [] },
    { id: DOWNSTREAM_ONE, schema: 'dbo', name: 'DownstreamOne', fullName: '[dbo].[DownstreamOne]', type: 'table', columns: [] },
    { id: BOTH_SIDES, schema: 'dbo', name: 'BothSides', fullName: '[dbo].[BothSides]', type: 'table', columns: [] },
  ];
  return {
    nodes,
    edges: [
      { source: UPSTREAM_TWO, target: UPSTREAM_ONE, type: 'body' },
      { source: UPSTREAM_ONE, target: ORIGIN, type: 'body' },
      { source: ORIGIN, target: DOWNSTREAM_ONE, type: 'body' },
      { source: BOTH_SIDES, target: ORIGIN, type: 'body' },
      { source: ORIGIN, target: BOTH_SIDES, type: 'body' },
    ],
    schemas: [{ name: 'dbo', nodeCount: 5, types: { table: 4, view: 0, procedure: 1, function: 0, external: 0 } }],
    catalog: {},
    neighborIndex: {
      [ORIGIN]: { in: [UPSTREAM_ONE, BOTH_SIDES], out: [DOWNSTREAM_ONE, BOTH_SIDES] },
      [UPSTREAM_ONE]: { in: [UPSTREAM_TWO], out: [ORIGIN] },
      [UPSTREAM_TWO]: { in: [], out: [UPSTREAM_ONE] },
      [DOWNSTREAM_ONE]: { in: [ORIGIN], out: [] },
      [BOTH_SIDES]: { in: [ORIGIN], out: [ORIGIN] },
    },
    dbPlatform: 'SQL Server',
  };
}

type BundleResult = {
  nodes: Array<Record<string, unknown>>;
  edges: Array<[string, string, string]>;
};

describe('get_scope_bundle serves per-node hop distance from the origin (uh/dh)', () => {
  const model = makeHopModel();
  const graph = buildBareGraph(model);

  it('a node two hops upstream carries uh:2 and no dh', () => {
    const input: GetScopeBundleInput = {
      origin: ORIGIN,
      direction: 'bidirectional',
      upstream_depth: 2,
      downstream_depth: 1,
    } as GetScopeBundleInput;
    const res = getScopeBundle(model, graph, input, BUDGET) as BundleResult;

    const upstreamTwo = res.nodes.find(n => n.id === UPSTREAM_TWO)!;
    expect(upstreamTwo, 'the two-hop node is in scope').toBeDefined();
    expect(upstreamTwo.uh, 'two hops upstream of the origin').toBe(2);
    expect(upstreamTwo.dh, 'never reached on the downstream walk').toBeUndefined();

    const upstreamOne = res.nodes.find(n => n.id === UPSTREAM_ONE)!;
    expect(upstreamOne.uh, 'one hop upstream of the origin').toBe(1);
    expect(upstreamOne.dh).toBeUndefined();
  });

  it('a node reachable on both sides carries both uh and dh', () => {
    const input: GetScopeBundleInput = {
      origin: ORIGIN,
      direction: 'bidirectional',
      upstream_depth: 2,
      downstream_depth: 1,
    } as GetScopeBundleInput;
    const res = getScopeBundle(model, graph, input, BUDGET) as BundleResult;

    const both = res.nodes.find(n => n.id === BOTH_SIDES)!;
    expect(both.uh, 'reached one hop upstream').toBe(1);
    expect(both.dh, 'reached one hop downstream').toBe(1);
  });

  it('the origin carries 0 on both sides', () => {
    const input: GetScopeBundleInput = {
      origin: ORIGIN,
      direction: 'bidirectional',
      upstream_depth: 2,
      downstream_depth: 1,
    } as GetScopeBundleInput;
    const res = getScopeBundle(model, graph, input, BUDGET) as BundleResult;

    const originPayload = res.nodes.find(n => n.id === ORIGIN)!;
    expect(originPayload.uh, 'origin is distance 0 upstream of itself').toBe(0);
    expect(originPayload.dh, 'origin is distance 0 downstream of itself').toBe(0);
  });

  it('upstream_depth: 1 still returns only distance-1 upstream nodes — no behaviour change at depth 1', () => {
    const input: GetScopeBundleInput = {
      origin: ORIGIN,
      direction: 'bidirectional',
      upstream_depth: 1,
      downstream_depth: 1,
    } as GetScopeBundleInput;
    const res = getScopeBundle(model, graph, input, BUDGET) as BundleResult;

    expect(res.nodes.find(n => n.id === UPSTREAM_TWO), 'two-hop node excluded at upstream_depth 1').toBeUndefined();
    const upstreamOne = res.nodes.find(n => n.id === UPSTREAM_ONE)!;
    expect(upstreamOne.uh).toBe(1);
  });

  it('edges[] and the origin in/out split are unchanged for the same input', () => {
    const input: GetScopeBundleInput = {
      origin: ORIGIN,
      direction: 'bidirectional',
      upstream_depth: 2,
      downstream_depth: 1,
    } as GetScopeBundleInput;
    const res = getScopeBundle(model, graph, input, BUDGET) as BundleResult;

    expect(res.edges.sort()).toEqual(
      [
        [UPSTREAM_TWO, UPSTREAM_ONE, 'read'],
        [UPSTREAM_ONE, ORIGIN, 'read'],
        [ORIGIN, DOWNSTREAM_ONE, 'write'],
        [BOTH_SIDES, ORIGIN, 'read'],
        [ORIGIN, BOTH_SIDES, 'write'],
      ].sort(),
    );

    const originPayload = res.nodes.find(n => n.id === ORIGIN)!;
    const inIds = (originPayload.in as Array<Record<string, unknown>>).map(n => n.id).sort();
    const outIds = (originPayload.out as Array<Record<string, unknown>>).map(n => n.id).sort();
    expect(inIds).toEqual([BOTH_SIDES, UPSTREAM_ONE].sort());
    expect(outIds).toEqual([BOTH_SIDES, DOWNSTREAM_ONE].sort());
  });
});
