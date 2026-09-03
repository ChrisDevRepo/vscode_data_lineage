import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { DEFAULT_SM_START_DEPTH, resolveDepthIntent } from '../../../src/ai/sm/smTypes';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe("NavigationEngine Robustness", () => {
  const nodes: LineageNode[] = [
    // Bodied origin (procedure) — required by the bipartite agenda rule:
    // only SCRIPT_TYPES (view/procedure/function) take hops.
    makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
    makeNode({ id: 'child_a', schema: 'dbo', name: 'child_a', type: 'view' }),
    makeNode({ id: 'child_b', schema: 'dbo', name: 'child_b', type: 'view' }),
  ];
  const edges: Array<[string, string]> = [
    ['origin', 'child_a'],
    ['child_a', 'child_b'],
  ];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);
  it("Status check", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect(engine.status === 'created', 'status created').toBe(true);

  engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });
  expect(engine.status === 'initialized', 'status initialized').toBe(true);

  engine.getHopContext();
  expect(engine.status === 'awaiting_findings', 'status awaiting_findings').toBe(true);

  engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'Root node' }],
    summary: 'analyzed origin',
    verdict: 'analyze',
  });
  expect(engine.status === 'exploring', 'status exploring').toBe(true);
});

  it("peekHopContext — non-mutating re-render of the current focus (sub-agent worker keystone)", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });

  expect(engine.peekHopContext() === null, 'peek is null before the first hop').toBe(true);

  const hop = engine.getHopContext();                    // advance to the origin focus
  const peek1 = engine.peekHopContext();
  expect(peek1?.focus_node?.id === hop.focus_node?.id, 'peek focus matches the advanced focus').toBe(true);
  expect(peek1?.focus_node?.id === 'origin', 'peek focus is the origin').toBe(true);
  expect((peek1?.neighbors?.length ?? 0) >= 1, 'peek surfaces the focus neighbours').toBe(true);

  const hopBefore = engine.currentHop;
  const agendaBefore = peek1?.agenda_remaining;
  const peek2 = engine.peekHopContext();
  expect(engine.currentHop === hopBefore, 'peek does not advance the hop count').toBe(true);
  expect(peek2?.agenda_remaining === agendaBefore, 'peek does not mutate the agenda').toBe(true);
  expect(peek2?.focus_node?.id === 'origin', 'peek is stable across calls (still origin)').toBe(true);

  // peek must not consume the hop: a real submit on the same focus still succeeds.
  const res = engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'Root' }], summary: 'ok', verdict: 'analyze' });
  expect(!('error' in res), 'submit after peek still applies (peek did not consume the focus)').toBe(true);
});

  it("Tally tracking", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });

  engine.getHopContext();
  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'Root' }], summary: 'ok', verdict: 'analyze' });

  engine.getHopContext();
  // pass (not prune — a node can't remove itself); child_b must be followed (completeness).
  engine.submitFindings({ focus_node_id: 'child_a', sections: [{ angle: 'business' as const, text: 'child' }], summary: 'ok', verdict: 'passthrough', route_requests: [{ nodeId: 'child_b', question: '?' }] });

  const diag = engine.getHopDiagnostics();
  expect(diag.tally.analyze === 1, 'analyze tally 1').toBe(true);
  expect(diag.tally.passthrough === 1, 'pass tally 1').toBe(true);
});

  it("Path grounding", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });

  const ctx1 = engine.getHopContext() as any;
  expect(ctx1.working_memory.topological_map.navigation_path === 'origin', 'path 1').toBe(true);

  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'ok' }], summary: 'ok', verdict: 'analyze' });

  const ctx2 = engine.getHopContext() as any;
  expect(ctx2.working_memory.topological_map.navigation_path === 'origin → child_a', 'path 2').toBe(true);
});

  it("it and keeps exploring (it never reaches `done` from an AI flag).", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });

  engine.getHopContext();
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    complete: true,
  } as any);

  expect(!('done' in result), 'engine ignores an out-of-contract complete flag — no AI-forced done').toBe(true);
  expect(engine.status === 'exploring', 'status exploring').toBe(true);
});

  it("Unknown route references are dropped with a visible notice so they cannot consume the retry budget.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });

  engine.getHopContext();
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'NON_EXISTENT', question: '?' }],
  });

  expect('ok' in result, 'unknown route is a nonfatal drop-with-notice').toBe(true);
  const outcomes = 'ok' in result ? result.route_outcomes ?? [] : [];
  expect(outcomes.some((o) => o.nodeId === 'NON_EXISTENT' && o.reason === 'unresolved'), 'unknown route has an unresolved route outcome').toBe(true);
  expect(engine.toJSON().memory.recentRejections.some((r) => r.nodeId === 'NON_EXISTENT'), 'unknown route notice is recorded').toBe(true);
});

  it("A known transitive route remains valid when it is reachable from the origin in the approved direction.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });

  engine.getHopContext();
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'child_b', question: '?' }],
  });
  expect('ok' in result, 'transitive reachable route is accepted').toBe(true);
  const outcomes = 'ok' in result ? result.route_outcomes ?? [] : [];
  expect(outcomes.some((o) => o.nodeId === 'child_b' && o.accepted), 'transitive route has an accepted outcome').toBe(true);
});

  it("Route target IDs resolve across casing/bracket normalization before rejection", () => {
  const mixedNodes: LineageNode[] = [
    makeNode({ id: '[dbo].[OriginProc]', schema: 'dbo', name: 'OriginProc', type: 'procedure' }),
    makeNode({ id: '[dbo].[ChildView]', schema: 'dbo', name: 'ChildView', type: 'view' }),
  ];
  const mixedEdges: Array<[string, string]> = [['[dbo].[OriginProc]', '[dbo].[ChildView]']];
  const mixedModel: DatabaseModel = makeModel(mixedNodes, mixedEdges, ['dbo']);
  const mixedGraph = makeGraph(mixedNodes, mixedEdges);
  const engine = new NavigationEngine(mixedModel, mixedGraph, () => {}, {});
  engine.init({ origin: '[dbo].[originproc]', question: 'test', direction: 'downstream' });

  engine.getHopContext();
  const result = engine.submitFindings({
    focus_node_id: '[dbo].[originproc]',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    route_requests: [{ nodeId: '[dbo].[childview]', question: 'trace child' }],
  });

  expect(!('error' in result), 'casing-only route target resolves before validation').toBe(true);
});

  it("Diagnostics archive counter", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'test', direction: 'downstream' });

  engine.getHopContext();
  engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'a'.repeat(100) }],
    summary: 's'.repeat(10),
    verdict: 'analyze',
  });

  const d1 = engine.getHopDiagnostics();
  expect(d1.archiveChars === 110, 'archiveChars 110').toBe(true);
  expect(d1.tally.analyze === 1, 'tally 1').toBe(true);

  engine.getHopContext();
  engine.submitFindings({
    focus_node_id: 'child_a',
    sections: [{ angle: 'business' as const, text: 'b'.repeat(50) }],
    summary: 't'.repeat(5),
    verdict: 'analyze',
    // child_a's downstream neighbor child_b must be accounted for (BB completeness guard).
    route_requests: [{ nodeId: 'child_b', question: 'trace child_b' }],
  });

  const d2 = engine.getHopDiagnostics();
  expect(d2.archiveChars === 165, 'archiveChars 165').toBe(true);
});

  it("and a later route beyond an explicit level count is deferred, not admitted.", () => {
  // A level count the AI copied from the user's question is a border, not a seed: the route is
  // still recorded — as a post-synthesis follow-up — but the node never enters the analysis.
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const res = engine.init({ origin: 'origin', question: 'Show the downstream flow, 1 level down', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });
  expect(!('error' in res) && res.scopeSize === 2, 'explicit depth seeds the reviewed scope').toBe(true);
  expect(engine.currentDepth === 1, 'explicit depth is retained as the border').toBe(true);

  engine.getHopContext();
  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'root' }], summary: 'root', verdict: 'analyze' });
  const child = engine.getHopContext();
  expect(child.focus_node?.id === 'child_a', 'seeded child is the next focus').toBe(true);
  const beyond = engine.submitFindings({
    focus_node_id: 'child_a',
    sections: [{ angle: 'business' as const, text: 'child' }],
    summary: 'child',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'child_b', question: 'Inspect the next transformation.' }],
  });
  expect(!('error' in beyond), 'routing past the border is accepted, not rejected — it is deferred').toBe(true);
  expect(engine.deferredQuestions.some(q => q.nodeId.toLowerCase() === 'child_b' && q.reason === 'depth'), 'the node past the border surfaces as a depth-reason follow-up lead').toBe(true);
  const drained = engine.getHopContext();
  expect(drained.done === true, 'no work past the border remains on the agenda').toBe(true);
  expect(engine.status === 'complete', 'the border resolves the agenda').toBe(true);
  expect(!engine.getResult().detail_slots.some(s => s.nodeId.toLowerCase() === 'child_b'), 'a deferred node is never analyzed').toBe(true);
});

  it("but an unstated depth stays a seed the AI may grow, and an expanded focus may still be pruned.", () => {
  // The soft path is unchanged: with no level count from the user, an explicit route still
  // grows the agenda, and the AI may prune the expanded focus after inspecting it.
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const res = engine.init({ origin: 'origin', question: 'Show the downstream flow', direction: 'downstream', depthIntent: { kind: 'default_start' } });
  expect(!('error' in res), 'default_start seeds without error').toBe(true);

  engine.getHopContext();
  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'root' }], summary: 'root', verdict: 'analyze' });
  const child = engine.getHopContext();
  expect(child.focus_node?.id === 'child_a', 'seeded child is the next focus').toBe(true);
  const expanded = engine.submitFindings({
    focus_node_id: 'child_a',
    sections: [{ angle: 'business' as const, text: 'child' }],
    summary: 'child',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'child_b', question: 'Inspect the next transformation.' }],
  });
  expect(!('error' in expanded), 'an unstated depth lets an explicit AI route grow the seed').toBe(true);
  const beyondSeed = engine.getHopContext();
  expect(beyondSeed.focus_node?.id === 'child_b', 'beyond-seed route becomes active agenda work').toBe(true);
  const pruned = engine.submitFindings({
    focus_node_id: 'child_b',
    sections: [{ angle: 'business' as const, text: 'not relevant after inspection' }],
    summary: 'not relevant',
    verdict: 'prune',
  });
  expect(!('error' in pruned), 'AI may prune an explicitly expanded focus after inspection').toBe(true);
  const drained = engine.getHopContext();
  expect(drained.done === true, 'agenda drain is observed after pruning the expanded focus').toBe(true);
  expect(engine.status === 'complete', 'pruning the expanded focus resolves the agenda').toBe(true);
});

  it("full_frontier seeds the whole chain", () => {
  // "all" → full directional frontier, no depth cap.
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const res = engine.init({ origin: 'origin', question: 'Trace all downstream targets of origin', direction: 'downstream', depthIntent: { kind: 'full_frontier' } });
  expect(!('error' in res) && res.scopeSize === 3, 'full_frontier seeds the whole chain').toBe(true);
  expect(engine.currentDepth === null, 'full_frontier leaves depth unbounded (no cap)').toBe(true);
});

  it("default_start seeds the reasonable default depth", () => {
  // Unstated depth → default_start seed; the engine picks the reasonable default, not the model.
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const res = engine.init({ origin: 'origin', question: 'Trace downstream targets of origin', direction: 'downstream', depthIntent: { kind: 'default_start' } });
  expect(!('error' in res) && res.scopeSize === 3, 'default_start seeds the reasonable default depth').toBe(true);
  expect(engine.currentDepth === DEFAULT_SM_START_DEPTH, 'default_start locks the default depth budget').toBe(true);
});

  it("resolveDepthIntent: positive → explicit with levels", () => { expect(resolveDepthIntent(2).kind === 'explicit' && (resolveDepthIntent(2) as { levels: number }).levels === 2, 'resolveDepthIntent: positive → explicit with levels').toBe(true); });

  it("resolveDepthIntent: 'all' → full_frontier", () => { expect(resolveDepthIntent('all').kind === 'full_frontier', "resolveDepthIntent: 'all' → full_frontier").toBe(true); });

  it("resolveDepthIntent: null → default_start", () => { expect(resolveDepthIntent(null).kind === 'default_start', 'resolveDepthIntent: null → default_start').toBe(true); });

  it("resolveDepthIntent: undefined → default_start", () => { expect(resolveDepthIntent(undefined).kind === 'default_start', 'resolveDepthIntent: undefined → default_start').toBe(true); });

  it("Asymmetric depth is valid only for a bidirectional exploration and seeds each side independently.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const invalid = engine.init({
    origin: 'origin',
    question: 'Trace upstream only',
    direction: 'upstream',
    depthIntent: { kind: 'asymmetric', upstream: 'all', downstream: 1 },
  });
  expect('error' in invalid, 'engine rejects asymmetric depth outside bidirectional mode').toBe(true);
});

  it("accepted (not rejected) when direction is left undefined rather than explicitly stated.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const valid = engine.init({
    origin: 'origin',
    question: 'Trace independently in each direction',
    depthIntent: { kind: 'asymmetric', upstream: 'all', downstream: 1 },
  });
  expect(!('error' in valid), 'engine accepts asymmetric depth when direction is undefined (implicit bidirectional default)').toBe(true);
});

  it("upstream chain to the stated depth and excludes every downstream node beyond the origin.", () => {
  const asymNodes: LineageNode[] = [
    makeNode({ id: 'grandparent', schema: 'dbo', name: 'grandparent', type: 'view' }),
    makeNode({ id: 'parent', schema: 'dbo', name: 'parent', type: 'view' }),
    makeNode({ id: 'origin2', schema: 'dbo', name: 'origin2', type: 'procedure' }),
    makeNode({ id: 'downstream_child', schema: 'dbo', name: 'downstream_child', type: 'view' }),
  ];
  const asymEdges: Array<[string, string]> = [
    ['grandparent', 'parent'],
    ['parent', 'origin2'],
    ['origin2', 'downstream_child'],
  ];
  const asymModel: DatabaseModel = makeModel(asymNodes, asymEdges, ['dbo']);
  const asymGraph = makeGraph(asymNodes, asymEdges);
  const engine = new NavigationEngine(asymModel, asymGraph, () => {}, {});
  const res = engine.init({
    origin: 'origin2',
    question: 'Trace upstream only, two levels',
    depthIntent: { kind: 'asymmetric', upstream: 2, downstream: 0 },
  });
  expect(!('error' in res), 'engine accepts {upstream:2,downstream:0} (direction omitted, implicit bidirectional)').toBe(true);
  if (!('error' in res)) {
    const result = engine.getResult();
    const scopeIds = new Set(result.fullNodes.map(n => n.id));
    expect(scopeIds.has('origin2'), 'scope contains the origin').toBe(true);
    expect(scopeIds.has('parent'), 'scope contains the upstream neighbor at depth 1').toBe(true);
    expect(scopeIds.has('grandparent'), 'scope contains the upstream neighbor at depth 2').toBe(true);
    expect(!scopeIds.has('downstream_child'), 'scope excludes the downstream neighbor (downstream:0 suppresses that direction)').toBe(true);
    expect(res.scopeSize === 3, 'seeded scope is exactly the origin plus the two upstream levels').toBe(true);
  }
});

  it("the default depth of 3, distinct from an explicit 0 (which is preserved verbatim).", () => {
  const bothOmitted = resolveDepthIntent({});
  expect(bothOmitted.kind === 'asymmetric'
      && (bothOmitted as { upstream: number | 'all' }).upstream === DEFAULT_SM_START_DEPTH
      && (bothOmitted as { downstream: number | 'all' }).downstream === DEFAULT_SM_START_DEPTH, 'resolveDepthIntent: {} → both sides default to 3').toBe(true);
  const oneNull = resolveDepthIntent({ upstream: 5, downstream: null });
  expect(oneNull.kind === 'asymmetric'
      && (oneNull as { upstream: number | 'all' }).upstream === 5
      && (oneNull as { downstream: number | 'all' }).downstream === DEFAULT_SM_START_DEPTH, 'resolveDepthIntent: per-side null defaults only that side to 3, preserving the stated side').toBe(true);
  const oneZero = resolveDepthIntent({ upstream: undefined, downstream: 0 });
  expect(oneZero.kind === 'asymmetric'
      && (oneZero as { upstream: number | 'all' }).upstream === DEFAULT_SM_START_DEPTH
      && (oneZero as { downstream: number | 'all' }).downstream === 0, 'resolveDepthIntent: an explicit 0 is preserved verbatim, never defaulted, distinct from omission').toBe(true);
});

  it("exactly like a hard-bordered single-direction session — growth into that side must never occur.", () => {
  const asymNodes: LineageNode[] = [
    makeNode({ id: 'grandparent', schema: 'dbo', name: 'grandparent', type: 'view' }),
    makeNode({ id: 'parent', schema: 'dbo', name: 'parent', type: 'view' }),
    makeNode({ id: 'origin2', schema: 'dbo', name: 'origin2', type: 'procedure' }),
    makeNode({ id: 'downstream_child', schema: 'dbo', name: 'downstream_child', type: 'view' }),
  ];
  const asymEdges: Array<[string, string]> = [
    ['grandparent', 'parent'],
    ['parent', 'origin2'],
    ['origin2', 'downstream_child'],
  ];
  const asymModel: DatabaseModel = makeModel(asymNodes, asymEdges, ['dbo']);
  const asymGraph = makeGraph(asymNodes, asymEdges);
  const engine = new NavigationEngine(asymModel, asymGraph, () => {}, {});
  const res = engine.init({
    origin: 'origin2',
    question: 'Trace upstream only, two levels',
    depthIntent: { kind: 'asymmetric', upstream: 2, downstream: 0 },
  });
  expect(!('error' in res), 'engine accepts {upstream:2,downstream:0} for the permanent-disable check').toBe(true);
  if (!('error' in res)) {
    engine.getHopContext();
    const findings = engine.submitFindings({
      focus_node_id: 'origin2',
      sections: [{ angle: 'business' as const, text: 'root' }],
      summary: 'ok',
      verdict: 'passthrough',
      route_requests: [
        { nodeId: 'parent', question: 'Continue upstream.' },
        { nodeId: 'downstream_child', question: 'Attempt to grow into the disabled downstream side.' },
      ],
    });
    expect(!('error' in findings), 'submitFindings succeeds despite one rejected route target').toBe(true);
    if (!('error' in findings)) {
      const outcomes = (findings as { route_outcomes?: Array<{ nodeId: string; accepted: boolean; reason?: string }> }).route_outcomes ?? [];
      const parentOutcome = outcomes.find(o => o.nodeId === 'parent');
      const downstreamOutcome = outcomes.find(o => o.nodeId === 'downstream_child');
      expect(parentOutcome?.accepted === true, 'route into the still-approved upstream side is accepted').toBe(true);
      expect(downstreamOutcome?.accepted === false && downstreamOutcome?.reason === 'out_of_direction', 'route into the permanently-disabled downstream side is rejected out_of_direction on a later hop, not just suppressed at the seed').toBe(true);
    }
  }
});

  it("Fully merged proposal validation rejects a partial BB→CT refine with no named columns.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const invalid = engine.init({
    origin: 'origin',
    question: 'Trace a column',
    direction: 'downstream',
    analysisMode: 'ct',
  });
  expect('error' in invalid, 'engine rejects CT after merge when targetColumns are absent').toBe(true);
  expect('error' in invalid && invalid.error === 'target_columns_required_for_ct', 'CT merge rejection has a stable error code').toBe(true);
});

  it("must never guess this from mission-brief prose (H2: replaced a regex keyword sniff).", () => {
  const ddlNodes: LineageNode[] = [
    makeNode({ id: 'spProcA', schema: 'dbo', name: 'spProcA', type: 'procedure', bodyScript: 'CREATE PROCEDURE spProcA AS CREATE CLUSTERED INDEX ix_a ON TableA(Col1)' }),
  ];
  const ddlModel: DatabaseModel = makeModel(ddlNodes, [], ['dbo']);
  const ddlGraph = makeGraph(ddlNodes, []);

  const businessLogs: string[] = [];
  const businessEngine = new NavigationEngine(ddlModel, ddlGraph, (_level, message) => businessLogs.push(message), {});
  businessEngine.classification = 'business';
  businessEngine.init({ origin: 'spProcA', question: 'test', direction: 'downstream' });
  const businessHop = businessEngine.getHopContext();
  const businessDdl = String((businessHop.focus_node)?.bb_ddl ?? '');
  expect(!/CLUSTERED/i.test(businessDdl), "classification 'business' minifies physical-storage detail (CLUSTERED stripped)").toBe(true);
  const minificationLog = businessLogs.find(line => line.includes('[DDL] Applying hop-by-hop minification')) ?? '';
  expect(!minificationLog.includes('aggressive'), 'per-hop minification log omits the old aggressive wording').toBe(true);
  expect(/reduced=\d+\.\d%/.test(minificationLog), 'per-hop minification log reports the character reduction percentage').toBe(true);

  const technicalEngine = new NavigationEngine(ddlModel, ddlGraph, () => {}, {});
  technicalEngine.classification = 'technical';
  technicalEngine.init({ origin: 'spProcA', question: 'test', direction: 'downstream' });
  const technicalHop = technicalEngine.getHopContext();
  const technicalDdl = String((technicalHop.focus_node)?.bb_ddl ?? '');
  expect(/CLUSTERED/i.test(technicalDdl), "classification 'technical' preserves physical-storage detail (CLUSTERED kept)").toBe(true);

  const bothEngine = new NavigationEngine(ddlModel, ddlGraph, () => {}, {});
  bothEngine.classification = 'both';
  bothEngine.init({ origin: 'spProcA', question: 'test', direction: 'downstream' });
  const bothHop = bothEngine.getHopContext();
  const bothDdl = String((bothHop.focus_node)?.bb_ddl ?? '');
  expect(/CLUSTERED/i.test(bothDdl), "classification 'both' preserves physical-storage detail (CLUSTERED kept)").toBe(true);

  // Unset classification is a defensive wiring-gap fallback, not an expected path — it must
  // still never guess from prose, so it preserves conservatively rather than risk stripping.
  const unsetEngine = new NavigationEngine(ddlModel, ddlGraph, () => {}, {});
  unsetEngine.init({ origin: 'spProcA', question: 'test', direction: 'downstream' });
  const unsetHop = unsetEngine.getHopContext();
  const unsetDdl = String((unsetHop.focus_node)?.bb_ddl ?? '');
  expect(/CLUSTERED/i.test(unsetDdl), 'unset classification (wiring gap) preserves conservatively rather than minify').toBe(true);
});

  // The neighbour list is where the model reads what a procedure does to its neighbours.
  // `LineageEdge.type` records provenance, not direction, so the verb has to come from the
  // edge's source node type: a procedure's out-edge is a write, an in-edge from a table is
  // a read. Reporting both as reads inverts the direction of the stated impact.
  it("a procedure's out-edge is presented as a write and its in-edge as a read", () => {
  const verbNodes: LineageNode[] = [
    makeNode({ id: 'sp', schema: 'dbo', name: 'sp', type: 'procedure' }),
    makeNode({ id: 'written', schema: 'dbo', name: 'written', type: 'table' }),
    makeNode({ id: 'read_from', schema: 'dbo', name: 'read_from', type: 'table' }),
  ];
  const verbEdges: Array<[string, string]> = [['sp', 'written'], ['read_from', 'sp']];
  const verbModel: DatabaseModel = makeModel(verbNodes, verbEdges, ['dbo']);
  const engine = new NavigationEngine(verbModel, makeGraph(verbNodes, verbEdges), () => {}, {});
  engine.init({ origin: 'sp', question: 'what does sp touch', direction: 'bidirectional', depthIntent: { kind: 'explicit', levels: 1 } });
  const hop = engine.getHopContext();
  const byId = new Map((hop.neighbors ?? []).map(n => [n.id, n]));

  expect(byId.get('written')?.edge_type === 'write', `the procedure's out-edge to a table is a write (got ${byId.get('written')?.edge_type})`).toBe(true);
  expect(byId.get('written')?.edge_direction === 'downstream', 'the written table is downstream of the procedure').toBe(true);
  expect(byId.get('read_from')?.edge_type === 'read', `a table feeding the procedure is a read (got ${byId.get('read_from')?.edge_type})`).toBe(true);
  expect(byId.get('read_from')?.edge_direction === 'upstream', 'the source table is upstream of the procedure').toBe(true);
});

});
