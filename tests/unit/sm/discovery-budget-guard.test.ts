/**
 * Unit tests for the discovery scope-budget guard in `getScopeBundle`.
 *
 * Guards the routing fix: the node-cap now fires for a PLAIN scope bundle (no `include_ddl`),
 * not only when DDL is requested — so an over-cap discovery walk reliably trips
 * `over_discovery_budget`, which the host turns into the SM reroute. See
 * docs/ai-concept/routing-old-vs-new.md (Part B5).
 *
 * Vitest registers every it() during synchronous collection and only runs the callbacks
 * afterward, so a cap-setting call (`setDiscoveryNodeCap`/`setDiscoveryTokenBudget` — process-wide
 * mutable module state in src/ai/tools/tools.ts) left outside an it() would fire during
 * collection, before any test runs, and every it() would then see only the LAST cap value set.
 * Each cap-setting call is made inside the it() it applies to (vitest runs it()s in a file
 * sequentially by default), so each scenario observes its own intended cap. `loadDemoModel()` is
 * awaited in `beforeAll` (a top-level await outside an async function is a syntax error), with
 * `model`/`graph`/`origin` populated before any it() runs.
 */

import { loadDemoModel, makeGraph } from '../helpers/testUtils';
import { buildBareGraph } from '../../../src/ai/support/graphUtils';
import { getScopeBundle, runAnalysis, setDiscoveryNodeCap, setDiscoveryTokenBudget } from '../../../src/ai/tools/tools';
import { GetScopeBundleInputSchema } from '../../../src/ai/tools/toolSchemas';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

function makeDdlModel(bodyScript: string): DatabaseModel {
  const nodes: LineageNode[] = [
    { id: '[dbo].[source]', schema: 'dbo', name: 'Source', fullName: '[dbo].[Source]', type: 'table', columns: [] },
    { id: '[dbo].[viewa]', schema: 'dbo', name: 'ViewA', fullName: '[dbo].[ViewA]', type: 'view', columns: [], bodyScript },
  ];
  return {
    nodes,
    edges: [{ source: '[dbo].[source]', target: '[dbo].[viewa]', type: 'body' }],
    schemas: [{ name: 'dbo', nodeCount: 2, types: { table: 1, view: 1, procedure: 0, function: 0, external: 0 } }],
    catalog: {},
    neighborIndex: {
      '[dbo].[source]': { in: [], out: ['[dbo].[viewa]'] },
      '[dbo].[viewa]': { in: ['[dbo].[source]'], out: [] },
    },
    dbPlatform: 'SQL Server',
  };
}

describe('discovery-budget-guard', () => {
  let model: DatabaseModel;
  let graph: ReturnType<typeof buildBareGraph>;
  let origin: string;

  beforeAll(async () => {
    model = await loadDemoModel();
    graph = buildBareGraph(model);
    // An origin with at least one neighbor → BFS scope ≥ 2 nodes.
    origin = model.edges.length ? model.edges[0].source : model.nodes[0].id;
  });

  afterAll(() => {
    // restore defaults so later modules in the shared process see the production caps
    setDiscoveryNodeCap(10);
    setDiscoveryTokenBudget(10_000);
  });

  it('directional scope may omit depth for the backend default', () => {
    expect(GetScopeBundleInputSchema.safeParse({ origin, direction: 'upstream' }).success, 'directional scope may omit depth for the backend default').toBe(true);
  });

  it('whole-chain depth is typed explicitly', () => {
    expect(GetScopeBundleInputSchema.safeParse({ origin, direction: 'upstream', depth: 'all' }).success, 'whole-chain depth is typed explicitly').toBe(true);
  });

  it('asymmetric scope requires both depths', () => {
    expect(!GetScopeBundleInputSchema.safeParse({ origin, direction: 'bidirectional', upstream_depth: 1 }).success, 'asymmetric scope requires both depths').toBe(true);
  });

  it('flat dispatcher schema accepts a full asymmetric depth payload (the narrower GetScopeBundleModelSchema is the AI-facing projection layered on top, see toolSchemas.ts)', () => {
    expect(GetScopeBundleInputSchema.safeParse({ origin, direction: 'bidirectional', upstream_depth: 'all', downstream_depth: 1 }).success, 'flat dispatcher schema accepts a full asymmetric depth payload (the narrower GetScopeBundleModelSchema is the AI-facing projection layered on top, see toolSchemas.ts)').toBe(true);
  });

  it('flat provider schema still rejects mixed symmetric+asymmetric depth shapes before dispatch', () => {
    expect(!GetScopeBundleInputSchema.safeParse({ origin, direction: 'bidirectional', depth: 'all', upstream_depth: 'all', downstream_depth: 1 }).success, 'flat provider schema still rejects mixed symmetric+asymmetric depth shapes before dispatch').toBe(true);
  });

  // ── omitted depth uses the single declared backend default (3) ──
  it('directional omission applies backend depth=3', () => {
    setDiscoveryNodeCap(10_000);
    const res = getScopeBundle(model, graph, { origin, direction: 'upstream' }) as Record<string, any>;
    expect(res.depth, 'directional omission applies backend depth=3').toBe(3);
  });

  // ── node-cap fires WITHOUT include_ddl (the strengthened guard) ──
  it('plain scope bundle over node-cap → over_discovery_budget (no include_ddl)', () => {
    setDiscoveryNodeCap(1);
    setDiscoveryTokenBudget(10_000);
    const res = getScopeBundle(model, graph, { origin, direction: 'bidirectional', depth: 2 }) as Record<string, unknown>;
    expect(res.reason, 'plain scope bundle over node-cap → over_discovery_budget (no include_ddl)').toBe('over_discovery_budget');
  });

  // ── under the cap → normal bundle, no budget rejection ──
  it('scope bundle under node-cap is not budget-rejected', () => {
    setDiscoveryNodeCap(10_000);
    const res = getScopeBundle(model, graph, { origin, direction: 'bidirectional', depth: 2 }) as Record<string, unknown>;
    expect(res.reason !== 'over_discovery_budget', 'scope bundle under node-cap is not budget-rejected').toBe(true);
    expect(Array.isArray(res.nodes), 'scope bundle returns nodes when under budget').toBe(true);
  });

  // ── DDL auto-grounding: include DDL when it fits even if the model omitted include_ddl ──
  it('DDL auto-grounding: include DDL when it fits even if the model omitted include_ddl', () => {
    const ddlModel = makeDdlModel('CREATE VIEW dbo.ViewA AS SELECT * FROM dbo.Source;');
    const res = getScopeBundle(ddlModel, buildBareGraph(ddlModel), {
      origin: '[dbo].[Source]',
      direction: 'downstream',
      depth: 1,
    }) as Record<string, any>;
    expect(Array.isArray(res.nodes), 'auto-DDL scope bundle returns nodes').toBe(true);
    const viewPayload = (res.nodes as Array<Record<string, unknown>>).find(n => n.id === '[dbo].[viewa]');
    expect(res.include_ddl, 'scope bundle auto-enables DDL when it fits').toBe(true);
    expect(typeof viewPayload?.ddl === 'string' && viewPayload.ddl.length > 0, 'script node carries DDL when auto-enabled').toBe(true);
    expect((res.scope as Record<string, number>).estimated_ddl_tokens > 0, 'auto-enabled DDL reports token estimate').toBe(true);
  });

  // ── Oversized DDL without explicit include_ddl stays inline metadata-only ──
  it('Oversized DDL without explicit include_ddl stays inline metadata-only', () => {
    setDiscoveryTokenBudget(1_000);
    const ddlModel = makeDdlModel('x'.repeat(20_000));
    const res = getScopeBundle(ddlModel, buildBareGraph(ddlModel), {
      origin: '[dbo].[Source]',
      direction: 'downstream',
      depth: 1,
    }) as Record<string, any>;
    expect(res.reason !== 'over_discovery_budget', 'oversized implicit DDL does not force SM').toBe(true);
    expect(res.include_ddl, 'oversized implicit DDL stays disabled').toBe(false);
    expect((res.scope as Record<string, number>).estimated_ddl_tokens, 'metadata-only response reports zero included DDL tokens').toBe(0);
  });

  // ── both-side 0 (bidirectional) is a degenerate origin-only request → engine rejects it ──
  it('both-side 0 rejects with the shared asymmetric_depth_both_zero code', () => {
    setDiscoveryNodeCap(10_000);
    const res = getScopeBundle(model, graph, { origin, direction: 'bidirectional', upstream_depth: 0, downstream_depth: 0 }) as Record<string, unknown>;
    expect(res.error, 'both-side 0 rejects with the shared asymmetric_depth_both_zero code').toBe('asymmetric_depth_both_zero');
    expect(typeof res.hint === 'string' && res.hint.length > 0, 'both-side 0 rejection carries a field-specific hint').toBe(true);
    expect(res.nodes === undefined, 'both-side 0 rejection carries no scope payload').toBe(true);
  });

  it('one-side-0/one-side-active bidirectional scope is not rejected', () => {
    // A single-direction 0 (e.g. upstream disabled, downstream active) is unaffected — only the
    // bidirectional-both-zero combination is degenerate.
    const res = getScopeBundle(model, graph, { origin, direction: 'bidirectional', upstream_depth: 0, downstream_depth: 2 }) as Record<string, unknown>;
    expect(res.error === undefined, 'one-side-0/one-side-active bidirectional scope is not rejected').toBe(true);
  });

  // ── the same token guard on the pattern-detection report ──
  // Hub, orphan and external-ref reports are bounded by the graph rather than by a threshold, so
  // the group list is the one discovery payload that had no budget guard at all.
  describe('detect_graph_patterns group list', () => {
    /** 60 hub centres, each with 4 inbound spokes — every centre clears a min-degree of 4. */
    function hubHeavyGraph() {
      const nodes: Array<{ id: string }> = [];
      const edges: Array<[string, string]> = [];
      for (let hub = 0; hub < 60; hub++) {
        nodes.push({ id: `hub${hub}` });
        for (let spoke = 0; spoke < 4; spoke++) {
          nodes.push({ id: `hub${hub}_spoke${spoke}` });
          edges.push([`hub${hub}_spoke${spoke}`, `hub${hub}`]);
        }
      }
      return makeGraph(nodes, edges);
    }

    it('inlines the group list when the report fits the discovery budget', () => {
      setDiscoveryTokenBudget(10_000);
      const res = runAnalysis(hubHeavyGraph(), 'hubs', 4) as Record<string, unknown>;
      expect(res.total_groups).toBe(60);
      expect(res.groups).toHaveLength(60);
      expect(res.groups_omitted).toBeUndefined();
    });

    it('omits the group list rather than slicing it when the report exceeds the budget', () => {
      setDiscoveryTokenBudget(1_000);
      const res = runAnalysis(hubHeavyGraph(), 'hubs', 4) as Record<string, unknown>;
      expect(res.total_groups).toBe(60);
      expect(res.groups).toBeUndefined();
      expect(res.groups_omitted).toBe(true);
      expect(typeof res.hint).toBe('string');
    });
  });
});
