import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { SubmitFindingsBbInputSchema } from '../../../src/ai/tools/toolSchemas';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { driveEngine, makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe("Scope Extension + Hold-and-Amend", () => {
  const chainNodes: LineageNode[] = [
    makeNode({ id: 'n0', schema: 'dbo', name: 'n0', type: 'view' }),
    makeNode({ id: 'n1', schema: 'dbo', name: 'n1', type: 'view' }),
    makeNode({ id: 'n2', schema: 'dbo', name: 'n2', type: 'view' }),
    makeNode({ id: 'n3', schema: 'dbo', name: 'n3', type: 'view' }),
    makeNode({ id: 'n4', schema: 'dbo', name: 'n4', type: 'view' }),
    makeNode({ id: 'n5', schema: 'dbo', name: 'n5', type: 'view' }),
  ];
  const chainEdges: Array<[string, string]> = [
    ['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3'], ['n3', 'n4'], ['n4', 'n5'],
  ];
  const chainModel: DatabaseModel = makeModel(chainNodes, chainEdges, ['dbo']);
  const chainGraph = makeGraph(chainNodes, chainEdges);
  const succ: Record<string, string | undefined> = { n0: 'n1', n1: 'n2', n2: 'n3', n3: 'n4', n4: 'n5' };
  function drainChain(engine: NavigationEngine): void {
    driveEngine(engine, { succ, limit: 30 });
  }
  it("Test 1: WITH a schema filter, a route beyond an explicit level count is still stopped by depth.", () => {
  // A schema filter is a separate axis: passing it does not license crossing a depth border the
  // user fixed. n5 (depth 5) is in-filter and still refused at a stated 2 levels.
  const engine = new NavigationEngine(chainModel, chainGraph, () => {}, { activeFilter: { schemas: ['dbo'] } as any });
  engine.init({ origin: 'n0', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 2 } });
  drainChain(engine);
  expect(engine.status === 'complete', 'chain engine completes').toBe(true);
  const slotIds = new Set(engine.getResult().detail_slots.map(s => s.nodeId));
  expect(slotIds.has('n2'), 'n2 sits on the border and is analyzed').toBe(true);
  expect(!slotIds.has('n5'), 'n5 (depth 5) is beyond the stated 2 levels and is not analyzed').toBe(true);
  const deferredIds = engine.deferredQuestions.map(d => d.nodeId.toLowerCase());
  expect(deferredIds.includes('n3'), 'the first node past the border becomes a follow-up lead').toBe(true);
});

  it("Test 2: WITHOUT a schema filter, an unstated depth still lets explicit AI routes grow the seed.", () => {
  // The soft path is the one that grows: with no level count from the user, the seed remains a
  // starting point and explicit routes carry the trace past it.
  const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
  engine.init({ origin: 'n0', question: 'trace', direction: 'downstream', depthIntent: { kind: 'default_start' } });
  drainChain(engine);
  expect(engine.status === 'complete', 'no-filter chain engine completes').toBe(true);
  const slotIds = new Set(engine.getResult().detail_slots.map(s => s.nodeId));
  expect(slotIds.has('n5'), 'n5 analyzed after explicit routes grow beyond the initial seed').toBe(true);
  const deferredIds = engine.deferredQuestions.map(d => d.nodeId.toLowerCase());
  expect(!deferredIds.includes('n5'), 'an unstated depth never converts growth into a boundary lead').toBe(true);
});

  const fanNodes: LineageNode[] = [
    makeNode({ id: 'p',  schema: 'dbo', name: 'p',  type: 'view' }),
    makeNode({ id: 'm',  schema: 'dbo', name: 'm',  type: 'view' }),
    makeNode({ id: 'a',  schema: 'dbo', name: 'a',  type: 'view' }),
    makeNode({ id: 'b',  schema: 'dbo', name: 'b',  type: 'view' }),
  ];
  const fanEdges: Array<[string, string]> = [['p', 'm'], ['m', 'a'], ['m', 'b']];
  const fanModel: DatabaseModel = makeModel(fanNodes, fanEdges, ['dbo']);
  const fanGraph = makeGraph(fanNodes, fanEdges);
  function advanceToM(engine: NavigationEngine): void {
    const first = engine.getHopContext() as any;
    expect(first.focus_node?.id === 'p', 'first focus is origin p').toBe(true);
    engine.submitFindings({ focus_node_id: 'p', sections: [{ angle: 'business' as const, text: 'p' }], summary: 'p', verdict: 'analyze' });
    const second = engine.getHopContext() as any;
    expect(second.focus_node?.id === 'm', 'second focus is m').toBe(true);
  }
  it("Test 3: hold-and-amend — forgetting one required neighbor holds the finding; the amend restores prose.", () => {
  const engine = new NavigationEngine(fanModel, fanGraph, () => {}, {});
  engine.init({ origin: 'p', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 2 } });
  advanceToM(engine);

  // Submit for m with only ONE of the two required neighbors → missing_required_route.
  const rej = engine.submitFindings({
    focus_node_id: 'm',
    sections: [{ angle: 'business' as const, text: 'the authored analysis of m — expensive prose' }],
    summary: 'm summary',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: 'trace a' }],
  }) as any;
  expect('error' in rej, 'forgetting neighbor b is rejected').toBe(true);
  expect(engine.heldFindingFocus === 'm', 'finding for m is held after incompleteness reject').toBe(true);

  const merged = engine.applyHeldContent({
    focus_node_id: 'm',
    sections: [],
    summary: '',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: 'trace a' }, { nodeId: 'b', question: 'trace b' }],
  });
  const retry = SubmitFindingsBbInputSchema.parse(merged);
  expect(retry.sections.length === 1, 'held sections restored on empty-sections retry').toBe(true);
  expect(retry.sections[0].text === 'the authored analysis of m — expensive prose', 'held prose is verbatim, not re-authored').toBe(true);
  expect(retry.summary === 'm summary', 'held summary restored').toBe(true);

  const ok = engine.submitFindings(retry) as any;
  expect(!('error' in ok), 'amend commits once both neighbors are accounted').toBe(true);
  expect(engine.heldFindingFocus === null, 'hold cleared after a committed submit').toBe(true);
});

  it("Test 3b: an approved required neighbor remains retain-protected and must be routed.", () => {
  const engine = new NavigationEngine(fanModel, fanGraph, () => {}, {});
  engine.init({ origin: 'p', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 2 } });
  advanceToM(engine);

  // Account for both required neighbors of m: route `a`, prune the (topology-safe) `b`.
  const rejected = engine.submitFindings({
    focus_node_id: 'm',
    sections: [{ angle: 'business' as const, text: 'analysis for m' }],
    summary: 'm summary',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: 'trace a' }],
    prune_neighbors: ['b'],
  }) as any;
  expect('error' in rejected && rejected.error === 'missing_required_route', 'pruning a required neighbor is rejected as missing routing').toBe(true);
  expect(engine.heldFindingFocus === 'm', 'incompleteness-only rejection holds authored prose').toBe(true);
  const state = engine.toJSON();
  expect(!state.removedSet.includes('b'), 'required b is not removed').toBe(true);
  const resultIds = new Set(engine.getResult().detail_slots.map(s => s.nodeId));
  expect(!resultIds.has('m'), 'rejected required-neighbor prune commits no m detail').toBe(true);
});

  it("Test 3c: a non-required in-scope prune is refused with a notice, without rejecting the hop.", () => {
  const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
  engine.init({ origin: 'n0', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 2 } });

  const focus1 = engine.getHopContext() as any;
  expect(focus1.focus_node?.id === 'n0', 'first focus is n0').toBe(true);
  const before = engine.toJSON();
  expect(before.scopeNodeIds.includes('n2'), 'n2 is in the approved seed scope').toBe(true);

  const result = engine.submitFindings({
    focus_node_id: 'n0',
    sections: [{ angle: 'business' as const, text: 'n0' }],
    summary: 'n0',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'n1', question: 'trace n1' }],
    prune_neighbors: ['n2'],
  });
  expect('ok' in result, 'non-required in-scope prune does not create a repair loop').toBe(true);
  const after = engine.toJSON();
  expect(!after.removedSet.includes('n2'), 'the protected in-scope n2 is not removed').toBe(true);
  expect(after.memory.recentRejections.some((r) => r.nodeId === 'n2'), 'the refused prune is visible as a notice').toBe(true);
});

  it("Test 3d: an out-of-scope prune retains the prior topology-safe behavior.", () => {
  const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
  engine.init({ origin: 'n0', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });

  const f1 = engine.getHopContext() as any;
  expect(f1.focus_node?.id === 'n0', 'first focus is n0').toBe(true);
  engine.submitFindings({
    focus_node_id: 'n0',
    sections: [{ angle: 'business' as const, text: 'n0' }],
    summary: 'n0',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'n1', question: 'trace n1' }],
  });
  const f2 = engine.getHopContext() as any;
  expect(f2.focus_node?.id === 'n1', 'second focus is n1').toBe(true);
  const before = engine.toJSON();
  expect(!before.scopeNodeIds.includes('n2'), 'n2 is beyond the depth-1 seed — out of scope at focus n1').toBe(true);

  const result = engine.submitFindings({
    focus_node_id: 'n1',
    sections: [{ angle: 'business' as const, text: 'n1' }],
    summary: 'n1 summary',
    verdict: 'analyze',
    prune_neighbors: ['n2'],
  });
  expect('ok' in result, 'topology-safe out-of-scope prune is accepted').toBe(true);
  const after = engine.toJSON();
  expect(after.removedSet.includes('n2'), 'out-of-scope n2 is recorded as removed').toBe(true);
});

  it("pruning adjacent rb from that focus would disconnect the committed rc detail.", () => {
  const reqNodes: LineageNode[] = [
    makeNode({ id: 'o2', schema: 'dbo', name: 'o2', type: 'procedure' }),
    makeNode({ id: 'ra', schema: 'dbo', name: 'ra', type: 'view' }),
    makeNode({ id: 'rb', schema: 'dbo', name: 'rb', type: 'table' }),
    makeNode({ id: 'rc', schema: 'dbo', name: 'rc', type: 'view' }),
  ];
  const reqEdges: Array<[string, string]> = [['o2', 'ra'], ['ra', 'rb'], ['rb', 'rc']];
  const reqModel: DatabaseModel = makeModel(reqNodes, reqEdges, ['dbo']);
  const reqGraph = makeGraph(reqNodes, reqEdges);

  const engine = new NavigationEngine(reqModel, reqGraph, () => {}, {});
  engine.init({ origin: 'o2', question: 'req orphan probe', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });
  const f1 = engine.getHopContext() as any;
  expect(f1.focus_node?.id === 'o2', 'first focus is o2').toBe(true);
  engine.submitFindings({
    focus_node_id: 'o2',
    sections: [{ angle: 'business' as const, text: 'o2' }],
    summary: 'o2',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'ra', question: '?' }],
  });
  const f2 = engine.getHopContext() as any;
  expect(f2.focus_node?.id === 'ra', 'second focus is ra').toBe(true);

  engine.submitFindings({
    focus_node_id: 'ra',
    sections: [{ angle: 'business' as const, text: 'ra' }],
    summary: 'ra',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'rb', question: 'trace rb' }],
  });
  const f3 = engine.getHopContext() as any;
  expect(f3.focus_node?.id === 'rc', 'passive rb contracts to rc as the third focus').toBe(true);
  engine.submitFindings({ focus_node_id: 'rc', sections: [{ angle: 'business' as const, text: 'rc' }], summary: 'rc', verdict: 'analyze' });
  expect(engine.getHopContext().done === true, 'orphan setup completes before ra reactivation').toBe(true);
  const supplemented = engine.supplementAgenda(['ra']) as any;
  expect('ok' in supplemented && supplemented.agendaed === 1, 'ra is reactivated for the neighbor-prune probe').toBe(true);
  const reactivated = engine.getHopContext() as any;
  expect(reactivated.focus_node?.id === 'ra', 'reactivated focus is ra').toBe(true);
  const detailBefore = JSON.stringify(engine.toJSON().memory.detailSlots.ra);
  const rej = engine.submitFindings({
    focus_node_id: 'ra',
    sections: [{ angle: 'business' as const, text: 'attempted ra analysis' }],
    summary: 'ra summary',
    verdict: 'analyze',
    prune_neighbors: ['rb'],
  }) as any;
  expect('error' in rej && rej.error === 'missing_required_route', 'required rb must be routed rather than pruned').toBe(true);
  expect(!engine.toJSON().removedSet.includes('rb'), 'rb is not removed by the refused prune').toBe(true);
  expect(/route_requests/i.test(rej.hint ?? ''), 'hint restores the established required-route correction').toBe(true);
  expect(JSON.stringify(engine.toJSON().memory.detailSlots.ra) === detailBefore, 'required-neighbor rejection does not replace authored detail').toBe(true);
});

  it("guard clears it — the prune commits.", () => {
  const nrNodes: LineageNode[] = [
    makeNode({ id: 'h',   schema: 'dbo', name: 'h',   type: 'procedure' }),
    makeNode({ id: 'tbl', schema: 'dbo', name: 'tbl', type: 'table' }),
    makeNode({ id: 'v',   schema: 'dbo', name: 'v',   type: 'view' }),
  ];
  const nrEdges: Array<[string, string]> = [['h', 'tbl'], ['tbl', 'v'], ['h', 'v']];
  const nrModel: DatabaseModel = makeModel(nrNodes, nrEdges, ['dbo']);
  const nrGraph = makeGraph(nrNodes, nrEdges);

  const engine = new NavigationEngine(nrModel, nrGraph, () => {}, {});
  engine.init({ origin: 'h', question: 'non-required prune', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 2 } });

  const f1 = engine.getHopContext() as any;
  expect(f1.focus_node?.id === 'h', 'first focus is h').toBe(true);
  // Account for tbl (a required table neighbor of h) by routing it; v is already seeded.
  engine.submitFindings({
    focus_node_id: 'h',
    sections: [{ angle: 'business' as const, text: 'h' }],
    summary: 'h',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'tbl', question: 'trace tbl' }],
  });
  const f2 = engine.getHopContext() as any;
  expect(f2.focus_node?.id === 'v', 'second focus is v (the only bodied downstream node)').toBe(true);

  const ok = engine.submitFindings({
    focus_node_id: 'v',
    sections: [{ angle: 'business' as const, text: 'v' }],
    summary: 'v',
    verdict: 'analyze',
    prune_neighbors: ['tbl'],
  }) as any;
  expect(!('error' in ok), 'refusing a non-required in-scope prune does not reject the hop').toBe(true);
  const after = engine.toJSON();
  expect(!after.removedSet.includes('tbl'), 'approved in-scope tbl remains retained').toBe(true);
  expect(after.memory.recentRejections.some((r) => r.nodeId === 'tbl'), 'refused in-scope prune is visible as a notice').toBe(true);
});

  it("Test 4: a complete full resend is deliberate re-authoring; held prose does not overwrite it.", () => {
  const engine = new NavigationEngine(fanModel, fanGraph, () => {}, {});
  engine.init({ origin: 'p', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 2 } });
  advanceToM(engine);
  engine.submitFindings({
    focus_node_id: 'm',
    sections: [{ angle: 'business' as const, text: 'first draft' }],
    summary: 'first',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: 'trace a' }],
  });
  expect(engine.heldFindingFocus === 'm', 'held after first incompleteness reject').toBe(true);
  const reauthored = engine.applyHeldContent({
    focus_node_id: 'm',
    sections: [{ angle: 'business' as const, text: 'revised draft' }],
    summary: 'revised',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: 'trace a' }, { nodeId: 'b', question: 'trace b' }],
  });
  expect(reauthored.sections[0].text === 'revised draft', 'non-empty retry keeps the AI re-authored prose').toBe(true);
});

  it("fatal conflict — the node is neither routed nor removed, and nothing else on the hop commits.", () => {
  const engine = new NavigationEngine(fanModel, fanGraph, () => {}, {});
  engine.init({ origin: 'p', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 2 } });
  advanceToM(engine);

  const rej = engine.submitFindings({
    focus_node_id: 'm',
    sections: [{ angle: 'business' as const, text: 'm conflict analysis' }],
    summary: 'm summary',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: 'trace a' }, { nodeId: 'b', question: 'trace b' }],
    prune_neighbors: ['a'],
  }) as any;
  expect('error' in rej && rej.error === 'prune_route_conflict', 'routing and pruning the same id is a fatal conflict').toBe(true);
  const state = engine.toJSON();
  expect(!state.removedSet.includes('a'), 'the conflicting id is not removed').toBe(true);
  expect(state.memory.detailSlots.m === undefined, 'the conflicting submit commits nothing for m — atomicity').toBe(true);
});

  it("it into both scope AND removedSet by the same commit.", () => {
  const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
  engine.init({ origin: 'n0', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });

  const focus1 = engine.getHopContext() as any;
  expect(focus1.focus_node?.id === 'n0', 'first focus is n0').toBe(true);
  engine.submitFindings({ focus_node_id: 'n0', sections: [{ angle: 'business' as const, text: 'n0' }], summary: 'n0', verdict: 'analyze', route_requests: [{ nodeId: 'n1', question: 'trace' }] });
  const focus2 = engine.getHopContext() as any;
  expect(focus2.focus_node?.id === 'n1', 'second focus is n1').toBe(true);

  const before = engine.toJSON();
  expect(!before.scopeNodeIds.includes('n2'), 'n2 is not yet in scope before the conflicting submit').toBe(true);

  const rej = engine.submitFindings({
    focus_node_id: 'n1',
    sections: [{ angle: 'business' as const, text: 'n1 conflict analysis' }],
    summary: 'n1 summary',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'n2', question: 'trace n2' }],
    prune_neighbors: ['n2'],
  }) as any;
  expect('error' in rej && rej.error === 'prune_route_conflict', 'fresh route/prune conflict retains its stable fatal code').toBe(true);
  const after = engine.toJSON();
  expect(!after.scopeNodeIds.includes('n2'), 'n2 was never merged into scope by the rejected submit — the timing hole is closed').toBe(true);
  expect(!after.removedSet.includes('n2'), 'n2 was never removed by the rejected submit — no dual scope+removed state').toBe(true);
});

  it("resolves. An unknown id cannot evade the stable fatal conflict merely because it is absent.", () => {
  const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
  engine.init({ origin: 'n0', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });
  const focus = engine.getHopContext() as any;
  expect(focus.focus_node?.id === 'n0', 'unknown conflict probe starts at n0').toBe(true);

  const rej = engine.submitFindings({
    focus_node_id: 'n0',
    sections: [{ angle: 'business' as const, text: 'unknown conflict analysis' }],
    summary: 'unknown conflict summary',
    verdict: 'analyze',
    route_requests: [{ nodeId: '[dbo].[GhostNode]', question: 'trace ghost' }],
    prune_neighbors: ['[DBO].[GHOSTNODE]'],
  }) as any;
  expect('error' in rej && rej.error === 'prune_route_conflict', 'unknown same-id route/prune remains a fatal conflict').toBe(true);
  const state = engine.toJSON();
  expect(state.memory.detailSlots.n0 === undefined, 'unknown route/prune conflict commits no authored detail').toBe(true);
  expect(!state.removedSet.some(id => id.toLowerCase().includes('ghostnode')), 'unknown conflicting target is not removed').toBe(true);
});

  it("Test 5: supplementAgenda refuses a user-excluded id (exclude is a hard wall on every write path).", () => {
  const engine = new NavigationEngine(chainModel, chainGraph, () => {}, {});
  engine.init({ origin: 'n0', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 2 }, excludeNodeIds: ['n5'] });
  drainChain(engine);
  expect(engine.status === 'complete', 'excluded-chain engine completes').toBe(true);
  const res = engine.supplementAgenda(['n5']) as any;
  expect('ok' in res && res.ok === true, 'supplementAgenda returns ok').toBe(true);
  expect(res.skipped === 1, 'excluded id n5 is refused (skipped)').toBe(true);
  expect(res.agendaed === 0, 'excluded id is not agendaed').toBe(true);
});

});
