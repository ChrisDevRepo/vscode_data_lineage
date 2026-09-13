/**
 * Unit tests for the discovery scope-budget guard in `getScopeBundle`.
 *
 * Guards the routing fix: the node-cap now fires for a PLAIN scope bundle (no `include_ddl`),
 * not only when DDL is requested — so an over-cap discovery walk reliably trips
 * `over_discovery_budget`. Discovery stays in chat; the existing SM-offer pill is the opt-in.
 *
 * The caps travel with the call as one immutable per-turn budget, so each scenario passes the
 * caps it means to exercise and no scenario can observe another's. `loadDemoModel()` is awaited in
 * `beforeAll` (a top-level await outside an async function is a syntax error), with
 * `model`/`graph`/`origin` populated before any it() runs.
 */

import { loadDemoModel, makeGraph } from '../helpers/testUtils';
import { buildBareGraph } from '../../../src/ai/support/graphUtils';
import { getScopeBundle, runAnalysis } from '../../../src/ai/tools/tools';
import {
  createTurnTokenBudget,
  DEFAULT_TURN_TOKEN_BUDGET as BUDGET,
} from '../../../src/ai/support/tokenBudget';
import { GetScopeBundleInputSchema } from '../../../src/ai/tools/toolSchemas';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { describe, expect, it, beforeAll } from 'vitest';

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

/** Two bodied nodes so the ORIGIN's DDL can fit alone while the scope total does not. */
function makeTwoViewModel(originBody: string, neighborBody: string): DatabaseModel {
  const nodes: LineageNode[] = [
    { id: '[dbo].[viewo]', schema: 'dbo', name: 'ViewO', fullName: '[dbo].[ViewO]', type: 'view', columns: [], bodyScript: originBody },
    { id: '[dbo].[viewn]', schema: 'dbo', name: 'ViewN', fullName: '[dbo].[ViewN]', type: 'view', columns: [], bodyScript: neighborBody },
  ];
  return {
    nodes,
    edges: [{ source: '[dbo].[viewo]', target: '[dbo].[viewn]', type: 'body' }],
    schemas: [{ name: 'dbo', nodeCount: 2, types: { table: 0, view: 2, procedure: 0, function: 0, external: 0 } }],
    catalog: {},
    neighborIndex: {
      '[dbo].[viewo]': { in: [], out: ['[dbo].[viewn]'] },
      '[dbo].[viewn]': { in: ['[dbo].[viewo]'], out: [] },
    },
    dbPlatform: 'SQL Server',
  };
}

describe('discovery-budget-guard', () => {
  let model: DatabaseModel;
  let graph: ReturnType<typeof buildBareGraph>;
  let origin: string;

  /** A node cap far above any demo-model walk, for the cases that exercise something else. */
  const wideNodes = createTurnTokenBudget({ discoveryNodeCap: 10_000 });

  beforeAll(async () => {
    model = await loadDemoModel();
    graph = buildBareGraph(model);
    // An origin with at least one neighbor → BFS scope ≥ 2 nodes.
    origin = model.edges.length ? model.edges[0].source : model.nodes[0].id;
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
    const res = getScopeBundle(model, graph, { origin, direction: 'upstream' }, wideNodes) as Record<string, any>;
    expect(res.depth, 'directional omission applies backend depth=3').toBe(3);
  });

  // ── node-cap fires WITHOUT include_ddl (the strengthened guard); the reply is a partial bundle ──
  it('plain scope bundle over node-cap → over_discovery_budget partial bundle (no include_ddl)', () => {
    const oneNode = createTurnTokenBudget({ discoveryNodeCap: 1, discoveryTokenBudget: 10_000 });
    const res = getScopeBundle(model, graph, { origin, direction: 'bidirectional', depth: 2 }, oneNode) as Record<string, any>;
    expect(res.reason, 'plain scope bundle over node-cap → over_discovery_budget (no include_ddl)').toBe('over_discovery_budget');
    expect(res.partial, 'over-budget reply is a partial bundle').toBe(true);
    expect(typeof res.message === 'string' && res.message.includes('not a complete answer'), 'partial bundle says it is not a complete answer').toBe(true);
    expect(res.origin?.id, 'partial bundle carries the canonical origin').toBe(origin);
    expect(typeof res.up === 'number' && typeof res.dn === 'number', 'partial bundle carries numeric up/dn counts').toBe(true);
    expect(!!res.scope_proposal?.origin, 'partial bundle keeps the scope_proposal origin').toBe(true);
    expect(typeof res.hint === 'string' && /detailed analysis/i.test(res.hint), 'over-budget hint names a detailed analysis').toBe(true);
    expect(typeof res.hint === 'string' && !/hop-by-hop/i.test(res.hint), 'over-budget hint must not say hop-by-hop').toBe(true);
  });

  // ── explicit include_ddl over the token budget → same partial bundle (site 2), origin DDL
  //    omitted — never sliced — when the origin body alone busts the budget ──
  it('explicit include_ddl over the token budget → partial bundle, metadata-only origin when its body alone busts the budget', () => {
    const tightTokens = createTurnTokenBudget({ discoveryTokenBudget: 1_000 });
    const ddlModel = makeDdlModel('x'.repeat(20_000));
    const res = getScopeBundle(ddlModel, buildBareGraph(ddlModel), {
      origin: '[dbo].[viewa]',
      direction: 'upstream',
      depth: 1,
      include_ddl: true,
    }, tightTokens) as Record<string, any>;
    expect(res.reason, 'explicit include_ddl over budget keeps the shared wire value').toBe('over_discovery_budget');
    expect(res.partial, 'site-2 overflow is a partial bundle too').toBe(true);
    expect(typeof res.message === 'string' && res.message.includes('not a complete answer'), 'partial bundle says it is not a complete answer').toBe(true);
    expect(res.origin?.id, 'metadata-only fallback still carries the origin').toBe('[dbo].[viewa]');
    expect(res.origin?.ddl, 'origin DDL is omitted, never sliced, when it alone busts the budget').toBeUndefined();
    expect(typeof res.up === 'number' && typeof res.dn === 'number', 'partial bundle carries numeric up/dn counts').toBe(true);
    expect(!!res.scope_proposal?.origin, 'partial bundle keeps the scope_proposal origin').toBe(true);
  });

  // ── same site, origin body fits alone → the origin DDL rides the partial bundle whole ──
  it('explicit include_ddl over the token budget serves the origin DDL whole when it alone fits', () => {
    const tightTokens = createTurnTokenBudget({ discoveryTokenBudget: 1_000 });
    const ddlModel = makeTwoViewModel('CREATE VIEW dbo.ViewO AS SELECT 1;', 'x'.repeat(20_000));
    const res = getScopeBundle(ddlModel, buildBareGraph(ddlModel), {
      origin: '[dbo].[viewo]',
      direction: 'downstream',
      depth: 1,
      include_ddl: true,
    }, tightTokens) as Record<string, any>;
    expect(res.reason, 'explicit include_ddl over budget keeps the shared wire value').toBe('over_discovery_budget');
    expect(res.partial, 'site-2 overflow is a partial bundle too').toBe(true);
    expect(typeof res.message === 'string' && res.message.includes('not a complete answer'), 'partial bundle says it is not a complete answer').toBe(true);
    expect(res.origin?.id, 'partial bundle carries the canonical origin').toBe('[dbo].[viewo]');
    expect(res.origin?.ddl, 'origin DDL is served whole, never sliced, when it alone fits').toBe('CREATE VIEW dbo.ViewO AS SELECT 1;');
    expect(typeof res.up === 'number' && typeof res.dn === 'number', 'partial bundle carries numeric up/dn counts').toBe(true);
    expect(!!res.scope_proposal?.origin, 'partial bundle keeps the scope_proposal origin').toBe(true);
  });

  // ── under the cap → normal bundle, no budget rejection ──
  it('scope bundle under node-cap is not budget-rejected', () => {
    const res = getScopeBundle(model, graph, { origin, direction: 'bidirectional', depth: 2 }, wideNodes) as Record<string, unknown>;
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
    }, BUDGET) as Record<string, any>;
    expect(Array.isArray(res.nodes), 'auto-DDL scope bundle returns nodes').toBe(true);
    const viewPayload = (res.nodes as Array<Record<string, unknown>>).find(n => n.id === '[dbo].[viewa]');
    expect(res.include_ddl, 'scope bundle auto-enables DDL when it fits').toBe(true);
    expect(typeof viewPayload?.ddl === 'string' && viewPayload.ddl.length > 0, 'script node carries DDL when auto-enabled').toBe(true);
    expect((res.scope as Record<string, number>).estimated_ddl_tokens > 0, 'auto-enabled DDL reports token estimate').toBe(true);
  });

  // ── Oversized DDL without explicit include_ddl stays inline metadata-only ──
  it('Oversized DDL without explicit include_ddl stays inline metadata-only', () => {
    const tightTokens = createTurnTokenBudget({ discoveryTokenBudget: 1_000 });
    const ddlModel = makeDdlModel('x'.repeat(20_000));
    const res = getScopeBundle(ddlModel, buildBareGraph(ddlModel), {
      origin: '[dbo].[Source]',
      direction: 'downstream',
      depth: 1,
    }, tightTokens) as Record<string, any>;
    expect(res.reason !== 'over_discovery_budget', 'oversized implicit DDL does not force SM').toBe(true);
    expect(res.include_ddl, 'oversized implicit DDL stays disabled').toBe(false);
    expect((res.scope as Record<string, number>).estimated_ddl_tokens, 'metadata-only response reports zero included DDL tokens').toBe(0);
  });

  // ── both-side 0 (bidirectional) is a degenerate origin-only request → engine rejects it ──
  it('both-side 0 rejects with the shared asymmetric_depth_both_zero code', () => {
    const res = getScopeBundle(model, graph, { origin, direction: 'bidirectional', upstream_depth: 0, downstream_depth: 0 }, wideNodes) as Record<string, unknown>;
    expect(res.error, 'both-side 0 rejects with the shared asymmetric_depth_both_zero code').toBe('asymmetric_depth_both_zero');
    expect(typeof res.hint === 'string' && res.hint.length > 0, 'both-side 0 rejection carries a field-specific hint').toBe(true);
    expect(res.nodes === undefined, 'both-side 0 rejection carries no scope payload').toBe(true);
  });

  it('one-side-0/one-side-active bidirectional scope is not rejected', () => {
    // A single-direction 0 (e.g. upstream disabled, downstream active) is unaffected — only the
    // bidirectional-both-zero combination is degenerate.
    const res = getScopeBundle(model, graph, { origin, direction: 'bidirectional', upstream_depth: 0, downstream_depth: 2 }, wideNodes) as Record<string, unknown>;
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
      const res = runAnalysis(hubHeavyGraph(), 'hubs', BUDGET, 4) as Record<string, unknown>;
      expect(res.total_groups).toBe(60);
      expect(res.groups).toHaveLength(60);
      expect(res.groups_omitted).toBeUndefined();
    });

    it('omits the group list rather than slicing it when the report exceeds the budget', () => {
      const tightTokens = createTurnTokenBudget({ discoveryTokenBudget: 1_000 });
      const res = runAnalysis(hubHeavyGraph(), 'hubs', tightTokens, 4) as Record<string, unknown>;
      expect(res.total_groups).toBe(60);
      expect(res.groups).toBeUndefined();
      expect(res.groups_omitted).toBe(true);
      expect(typeof res.hint).toBe('string');
    });
  });
});
