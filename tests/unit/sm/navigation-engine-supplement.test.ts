import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { driveEngine, makeActiveFilter, makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe("Supplement Agenda", () => {
  const nodes: LineageNode[] = [
    makeNode({ id: 'sp',    schema: 'dbo', name: 'sp',    type: 'procedure' }),
    makeNode({ id: 'ta',    schema: 'dbo', name: 'ta',    type: 'table' }),
    makeNode({ id: 'tb',    schema: 'dbo', name: 'tb',    type: 'table' }),
    makeNode({ id: 'viewa', schema: 'dbo', name: 'viewa', type: 'view' }),
    makeNode({ id: 'viewb', schema: 'dbo', name: 'viewb', type: 'view' }),
    makeNode({ id: 'viewc', schema: 'dbo', name: 'viewc', type: 'view' }),
  ];
  const edges: Array<[string, string]> = [
    ['sp', 'ta'],
    ['sp', 'tb'],
    ['ta', 'viewa'],
    ['tb', 'viewb'],
    ['sp', 'viewc'],
  ];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);
  function drain(engine: NavigationEngine, tag: string): void {
    driveEngine(engine, { tag, limit: 20 });
  }
  it("Test 1: rejects when engine has not completed yet", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });
  const res = engine.supplementAgenda(['viewc']);
  expect('error' in res, 'supplementAgenda rejects while engine is not complete').toBe(true);
  if ('error' in res) {
    expect(res.error === 'supplement_requires_complete_engine', 'error code is supplement_requires_complete_engine').toBe(true);
  }
});

  it("Test 2: after completion, supplement with an unknown id is reported as skipped", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });
  drain(engine, 'initial');
  expect(engine.status === 'complete', 'engine reaches complete after initial drain').toBe(true);

  const slotsBefore = (engine.toJSON() as { slotCount?: number }).slotCount ?? -1;
  const res = engine.supplementAgenda(['[dbo].[doesNotExist]']);
  expect('ok' in res && (res as any).ok === true, 'supplementAgenda returns ok even when all ids are unknown').toBe(true);
  if ('ok' in res) {
    expect(res.skipped === 1, 'unknown id counted in skipped').toBe(true);
    expect(res.agendaed === 0, 'nothing agendaed').toBe(true);
    expect(res.contracted === 0, 'nothing contracted').toBe(true);
    expect(res.skippedDetails.length === 1, 'skippedDetails has exactly one entry').toBe(true);
    expect(res.skippedDetails[0]?.nodeId === '[dbo].[doesNotExist]', 'skippedDetails names the raw unresolved id').toBe(true);
    expect(res.skippedDetails[0]?.reason === 'unresolved', 'skippedDetails reason is unresolved for an unknown id').toBe(true);
  }
  // After an all-skipped supplement we still flip status back because the caller
  // expected to resume; the next getHopContext will re-drain immediately to 'complete'.
  drain(engine, 'no-op-supplement');
  expect(engine.status === 'complete', 'engine returns to complete after empty-supplement drain').toBe(true);
  const slotsAfter = (engine.toJSON() as { slotCount?: number }).slotCount ?? -1;
  expect(slotsAfter === slotsBefore, 'archive is unchanged when supplement ids are all skipped').toBe(true);
});

  it("Test 3: supplement a bodied id that was deferred in the initial narrow scope", () => {
  // Use upstream direction from viewa (depth 1) so only {viewa, ta, sp} are in scope —
  // viewc is reachable only via sp's downstream neighbors, which the upstream BFS misses.
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'viewa', question: 'test', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 2 } });
  drain(engine, 'narrow');
  expect(engine.status === 'complete', 'narrow engine complete').toBe(true);
  const narrowSlots = engine.getResult().detail_slots.map(s => s.nodeId);
  expect(!narrowSlots.includes('viewc'), 'viewc not yet in narrow archive').toBe(true);

  const totalBeforeSupplement = engine.hopProgress.total;
  const r = engine.supplementAgenda(['viewc']);
  expect('ok' in r && (r as any).ok === true, 'supplementAgenda ok on bodied id').toBe(true);
  if ('ok' in r) {
    expect(r.agendaed >= 1, `at least one id agendaed (got ${r.agendaed})`).toBe(true);
    expect(r.skipped === 0, 'no ids skipped for valid bodied id').toBe(true);
  }
  expect(engine.status === 'awaiting_findings', 'status returns to awaiting_findings after supplement').toBe(true);
  // Regression for the "Hop X of Y" drift: a genuinely new-to-scope bodied supplement id must
  // credit hopProgress.total, or the walk consumes a hop nobody counted (X can exceed Y).
  expect(engine.hopProgress.total === totalBeforeSupplement + 1, `supplementing a new bodied id credits total by 1 — expected ${totalBeforeSupplement + 1}, got ${engine.hopProgress.total}`).toBe(true);

  drain(engine, 'supplement');
  expect(engine.status === 'complete', 'engine completes again after supplement drain').toBe(true);
  expect(engine.hopProgress.current === engine.hopProgress.total, `final current === total after supplement drain — got ${engine.hopProgress.current}/${engine.hopProgress.total}`).toBe(true);

  const after = engine.getResult().detail_slots;
  const afterIds = new Set(after.map(s => s.nodeId));
  expect(afterIds.has('viewc'), 'viewc slot present in archive after supplement').toBe(true);
  for (const originalId of narrowSlots) {
    expect(afterIds.has(originalId), `prior slot ${originalId} survived supplement merge`).toBe(true);
  }
});

  it("consume a hop just like a bodied node once it gets the special origin/supplement direct push.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'viewa', question: 'test', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 2 } });
  drain(engine, 'setup');
  expect(engine.status === 'complete', 'setup engine complete').toBe(true);

  const totalBefore = engine.hopProgress.total;
  const r = engine.supplementAgenda(['ta']);
  expect('ok' in r && (r as any).ok === true, 'supplementAgenda ok on already-in-scope non-bodied id').toBe(true);
  expect(engine.hopProgress.total === totalBefore + 1, `supplementing an already-in-scope non-bodied id still credits total by 1 — expected ${totalBefore + 1}, got ${engine.hopProgress.total}`).toBe(true);

  drain(engine, 'ta-supplement');
  expect(engine.status === 'complete', 'engine completes again after non-bodied supplement drain').toBe(true);
  expect(engine.hopProgress.current === engine.hopProgress.total, `final current === total after non-bodied supplement drain — got ${engine.hopProgress.current}/${engine.hopProgress.total}`).toBe(true);
});

  it("so it consumes a brand-new hop) must credit total on reactivation, even though it's already in scope.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'viewa', question: 'test', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 2 } });
  drain(engine, 'setup');
  expect(engine.status === 'complete', 'setup engine complete').toBe(true);
  expect(engine.hopProgress.current === engine.hopProgress.total, `setup drains to current === total — got ${engine.hopProgress.current}/${engine.hopProgress.total}`).toBe(true);

  const totalBefore = engine.hopProgress.total;
  const r = engine.supplementAgenda(['viewa']);
  expect('ok' in r && (r as any).ok === true, 'supplementAgenda ok re-analyzing already-visited bodied id').toBe(true);
  expect(engine.hopProgress.total === totalBefore + 1, `reactivating an already-visited bodied id credits total by 1 — expected ${totalBefore + 1}, got ${engine.hopProgress.total}`).toBe(true);

  drain(engine, 'viewa-reactivation');
  expect(engine.status === 'complete', 'engine completes again after reactivation drain').toBe(true);
  expect(engine.hopProgress.current === engine.hopProgress.total, `final current === total after reactivation drain — got ${engine.hopProgress.current}/${engine.hopProgress.total}`).toBe(true);
});

  it("push (agenda-membership-based credit, not the bodied SCRIPT_TYPES branch).", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'viewa', question: 'test', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 2 } });
  drain(engine, 'setup');
  expect(engine.status === 'complete', 'setup engine complete').toBe(true);

  // First supplement dispatches+visits the non-bodied 'ta' (Test 4's scenario); drain to completion.
  engine.supplementAgenda(['ta']);
  drain(engine, 'ta-first-pass');
  expect(engine.status === 'complete', 'engine completes after first ta supplement').toBe(true);

  const totalBefore = engine.hopProgress.total;
  const r = engine.supplementAgenda(['ta']);
  expect('ok' in r && (r as any).ok === true, 'supplementAgenda ok re-analyzing already-visited non-bodied id').toBe(true);
  expect(engine.hopProgress.total === totalBefore + 1, `reactivating an already-visited non-bodied id credits total by 1 — expected ${totalBefore + 1}, got ${engine.hopProgress.total}`).toBe(true);

  drain(engine, 'ta-reactivation');
  expect(engine.status === 'complete', 'engine completes again after non-bodied reactivation drain').toBe(true);
  expect(engine.hopProgress.current === engine.hopProgress.total, `final current === total after non-bodied reactivation drain — got ${engine.hopProgress.current}/${engine.hopProgress.total}`).toBe(true);
});

  it("(mirrors Test 5 of navigation-engine-scope-extend.test.ts, but asserting the per-node detail).", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({
    origin: 'viewa',
    question: 'test',
    direction: 'upstream',
    depthIntent: { kind: 'explicit', levels: 2 },
    excludeNodeIds: ['ta'],
  });
  drain(engine, 'excluded-setup');
  expect(engine.status === 'complete', 'excluded-setup engine completes').toBe(true);

  const res = engine.supplementAgenda(['ta']) as any;
  expect('ok' in res && res.ok === true, 'supplementAgenda returns ok for an excluded id').toBe(true);
  if ('ok' in res) {
    expect(res.skipped === 1, 'excluded id ta is refused (skipped)').toBe(true);
    expect(res.agendaed === 0, 'excluded id is not agendaed').toBe(true);
    expect(res.skippedDetails.length === 1, 'skippedDetails has exactly one entry').toBe(true);
    expect(res.skippedDetails[0]?.nodeId === 'ta', 'skippedDetails names the excluded id').toBe(true);
    expect(res.skippedDetails[0]?.reason === 'excluded', 'skippedDetails reason is excluded for a user-excluded id').toBe(true);
  }
});

  const extNodes: LineageNode[] = [
    makeNode({ id: 'o',    schema: 'dbo', name: 'o',    type: 'view' }),
    makeNode({ id: 'mid',  schema: 'dbo', name: 'mid',  type: 'view' }),
    makeNode({ id: 'ext1', schema: 'ext', name: 'ext1', type: 'view' }),
  ];
  const extEdges: Array<[string, string]> = [['o', 'mid'], ['mid', 'ext1']];
  const extModel: DatabaseModel = makeModel(extNodes, extEdges, ['dbo', 'ext']);
  const extGraph = makeGraph(extNodes, extEdges);
  function drainExt(engine: NavigationEngine): void {
    driveEngine(engine, { succ: { o: 'mid', mid: 'ext1' }, limit: 20 });
  }
  function makeCompletedExtEngine(): { engine: NavigationEngine; leadId: string } {
    const engine = new NavigationEngine(extModel, extGraph, () => {}, { activeFilter: makeActiveFilter({ schemas: ['dbo'] }) });
    engine.init({ origin: 'o', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });
    drainExt(engine);
    expect(engine.status === 'complete', 'ext engine completes').toBe(true);
    const lead = engine.pendingLeads.find(l => l.nodeId.toLowerCase() === 'ext1');
    expect(!!lead, 'ext1 recorded as a pending schema-boundary lead').toBe(true);
    return { engine, leadId: lead!.id };
  }
  // The approve gate authorizes one hop-by-hop run and is spent when its result is presented, so a
  // follow-up naming an object is the user's own consent to add it. The session allowlist is no
  // longer a refusal axis for a named id — it still bounds everything the user did NOT name, which
  // the sibling case below pins.
  it("a follow-up target outside the session allowlist is admitted because the user named it.", () => {
  const { engine } = makeCompletedExtEngine();
  const scopeBefore = engine.scopeSize;
  expect(engine.toJSON().scopeNodeIds.includes('ext1') === false, 'ext1 was outside the approved scope').toBe(true);
  const res = engine.supplementAgenda(['ext1']) as any;
  expect('ok' in res && res.ok === true, 'supplementAgenda accepts the named out-of-allowlist id').toBe(true);
  expect(res.agendaed === 1, `the named target is agendaed (got ${JSON.stringify(res)})`).toBe(true);
  expect(res.skipped === 0 && res.skippedDetails.length === 0, 'nothing is refused').toBe(true);
  expect(engine.toJSON().scopeNodeIds.includes('ext1'), 'the named target joined the existing graph').toBe(true);
  expect(engine.scopeSize === scopeBefore + 1, 'exactly the one named id joined the scope').toBe(true);
});

  // Admission lives inside `supplementAgenda`, past its last reject, so a refused call never leaves
  // a widened allowlist behind for the next one to trip over.
  it("a rejected supplement admits nothing (side-effect-free reject).", () => {
  const { engine } = makeCompletedExtEngine();
  const allowedBefore = (engine.toJSON().engineInternals?.sessionAllowedNodeIds ?? []).length;
  const res = engine.supplementAgenda(['ext1'], ['no-such-lead']);
  expect('error' in res && res.error === 'invalid_pending_lead', 'the bad lead id rejects the whole call').toBe(true);
  expect((engine.toJSON().engineInternals?.sessionAllowedNodeIds ?? []).length === allowedBefore, 'the refused call admitted nothing').toBe(true);
  expect(engine.toJSON().scopeNodeIds.includes('ext1') === false, 'ext1 never merged into scope').toBe(true);
  expect(engine.status === 'complete', 'the refused call leaves engine status unchanged').toBe(true);
});

  it("a host-selected pending lead supplements, and the hop total increments.", () => {
  const { engine, leadId } = makeCompletedExtEngine();
  const totalBefore = engine.hopProgress.total;
  const res = engine.supplementAgenda([], [leadId]) as any;
  expect('ok' in res && res.ok === true, 'supplement succeeds for a host-selected lead').toBe(true);
  expect(res.agendaed === 1, 'the approved ext1 lead is agendaed').toBe(true);
  expect(res.skipped === 0, 'the lead target is admitted by the call itself').toBe(true);
  expect(engine.hopProgress.total === totalBefore + 1, 'hop total increments for the newly-approved node').toBe(true);
  expect(engine.toJSON().scopeNodeIds.includes('ext1'), 'ext1 is now in scope').toBe(true);
});

  it("(exclusion is checked before the allowlist; excluded wins).", () => {
  const engine = new NavigationEngine(extModel, extGraph, () => {}, {
    activeFilter: makeActiveFilter({ schemas: ['dbo'] }),
  });
  engine.init({ origin: 'o', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 }, excludeNodeIds: ['mid'] });
  drainExt(engine);
  expect(engine.status === 'complete', 'excluded-mid ext engine completes').toBe(true);
  const res = engine.supplementAgenda(['mid']) as any;
  expect('ok' in res && res.ok === true, 'supplementAgenda returns ok for an excluded in-allowlist id').toBe(true);
  expect(res.skipped === 1, 'excluded id mid is refused despite being in the allowlist').toBe(true);
  expect(res.skippedDetails[0]?.reason === 'excluded', 'exclusion takes priority over the allowlist axis').toBe(true);
});

  // A target that breaches BOTH the allowlist and the stated depth defers as 'schema_and_depth'.
  // That used to be reported as a pure depth boundary, telling the user to approve a depth the
  // allowlist would still have blocked.
  it("a schema-and-depth deferral is reported as a schema boundary, keeping the breaching depth.", () => {
  // dbo chain to depth 2, then an ext node at depth 3; the stated cap is 2, so the last hop
  // breaches the allowlist and the depth border together.
  const bothNodes: LineageNode[] = [
    makeNode({ id: 'b0', schema: 'dbo', name: 'b0', type: 'view' }),
    makeNode({ id: 'b1', schema: 'dbo', name: 'b1', type: 'view' }),
    makeNode({ id: 'b2', schema: 'dbo', name: 'b2', type: 'view' }),
    makeNode({ id: 'bx', schema: 'ext', name: 'bx', type: 'view' }),
  ];
  const bothEdges: Array<[string, string]> = [['b0', 'b1'], ['b1', 'b2'], ['b2', 'bx']];
  const engine = new NavigationEngine(
    makeModel(bothNodes, bothEdges, ['dbo', 'ext']),
    makeGraph(bothNodes, bothEdges),
    () => {},
    { activeFilter: makeActiveFilter({ schemas: ['dbo'] }) },
  );
  engine.init({ origin: 'b0', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 2 } });
  driveEngine(engine, { succ: { b0: 'b1', b1: 'b2', b2: 'bx' }, limit: 20 });

  // The lead is the persisted record; `deferredQuestions` is a lossy projection back out of it,
  // so the composite reason is only ever observable through which boundary the lead names.
  const lead = engine.pendingLeads.find(l => l.nodeId.toLowerCase() === 'bx');
  expect(lead?.reason === 'schema_boundary', `the lead names the stricter gate (got ${lead?.reason})`).toBe(true);
  expect(lead?.depth === 3, `the breaching depth is not lost (got ${lead?.depth})`).toBe(true);
  expect(lead?.schema === 'ext', 'the blocked schema is carried too').toBe(true);

  // A depth-only breach is untouched by the mapping and still reports as a depth boundary.
  const dboOnly = engine.pendingLeads.find(l => l.reason === 'depth_boundary');
  expect(dboOnly === undefined, 'the composite breach produced no separate depth-boundary lead').toBe(true);
});

  it("a follow-up never reopens an exclusion, and ignores unresolvable ids.", () => {
  const engine = new NavigationEngine(extModel, extGraph, () => {}, {
    activeFilter: makeActiveFilter({ schemas: ['dbo'] }),
  });
  engine.init({ origin: 'o', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 }, excludeNodeIds: ['mid'] });
  drainExt(engine);
  const res = engine.supplementAgenda(['mid', '[dbo].[doesNotExist]']) as any;
  expect(res.skipped === 2, 'naming them does not reopen a node the user excluded, nor invent one').toBe(true);
  expect(res.skippedDetails.find((d: { nodeId: string }) => d.nodeId === 'mid')?.reason === 'excluded', 'the exclusion axis still refuses it').toBe(true);
  expect(res.skippedDetails.find((d: { nodeId: string }) => d.nodeId === '[dbo].[doesNotExist]')?.reason === 'unresolved', 'an id that resolves to nothing is reported as unresolved').toBe(true);
});

  // An excluded id is refused AND never admitted, so naming it cannot open the border on its
  // behalf. Its sibling is added only because the user named the sibling itself.
  it("an excluded id is refused on a follow-up and admits nothing in its place.", () => {
  const siblingNodes: LineageNode[] = [
    makeNode({ id: 'o',    schema: 'dbo', name: 'o',    type: 'view' }),
    makeNode({ id: 'mid',  schema: 'dbo', name: 'mid',  type: 'view' }),
    makeNode({ id: 'ext1', schema: 'ext', name: 'ext1', type: 'view' }),
    makeNode({ id: 'ext2', schema: 'ext', name: 'ext2', type: 'view' }),
  ];
  const siblingEdges: Array<[string, string]> = [['o', 'mid'], ['mid', 'ext1'], ['mid', 'ext2']];
  const engine = new NavigationEngine(
    makeModel(siblingNodes, siblingEdges, ['dbo', 'ext']),
    makeGraph(siblingNodes, siblingEdges),
    () => {},
    { activeFilter: makeActiveFilter({ schemas: ['dbo'] }) },
  );
  engine.init({ origin: 'o', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 }, excludeNodeIds: ['ext1'] });
  drainExt(engine);
  expect(engine.status === 'complete', 'sibling engine completes').toBe(true);

  const res = engine.supplementAgenda(['ext1', 'ext2']) as any;
  expect(res.skipped === 1, 'the excluded id is refused (got ' + JSON.stringify(res) + ')').toBe(true);
  expect(res.skippedDetails[0]?.nodeId === 'ext1' && res.skippedDetails[0]?.reason === 'excluded', 'the refusal names the excluded id on the exclusion axis').toBe(true);
  expect(res.agendaed === 1, 'the sibling the user named in the same call is still added').toBe(true);
  expect((engine.toJSON().engineInternals?.sessionAllowedNodeIds ?? []).includes('ext1') === false, 'the excluded id was never admitted').toBe(true);
  expect(engine.toJSON().scopeNodeIds.includes('ext1') === false, 'the excluded id stays out of scope').toBe(true);
});

  // The id list is the bound: adding one object adds that object, never a sibling riding along
  // behind it. The unnamed sibling stays a lead the user can ask for on its own.
  it('a supplement adds the ids it names, and nothing that rides along behind them.', () => {
  const siblingNodes: LineageNode[] = [
    makeNode({ id: 'o',    schema: 'dbo', name: 'o',    type: 'view' }),
    makeNode({ id: 'mid',  schema: 'dbo', name: 'mid',  type: 'view' }),
    makeNode({ id: 'ext1', schema: 'ext', name: 'ext1', type: 'view' }),
    makeNode({ id: 'ext2', schema: 'ext', name: 'ext2', type: 'view' }),
  ];
  const siblingEdges: Array<[string, string]> = [['o', 'mid'], ['mid', 'ext1'], ['mid', 'ext2']];
  function completedSiblingEngine(): NavigationEngine {
    const engine = new NavigationEngine(
      makeModel(siblingNodes, siblingEdges, ['dbo', 'ext']),
      makeGraph(siblingNodes, siblingEdges),
      () => {},
      { activeFilter: makeActiveFilter({ schemas: ['dbo'] }) },
    );
    engine.init({ origin: 'o', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });
    driveEngine(engine, { routes: { o: ['mid'], mid: ['ext1', 'ext2'] }, limit: 20 });
    expect(engine.status === 'complete', 'sibling engine completes').toBe(true);
    expect(engine.pendingLeads.some(l => l.nodeId.toLowerCase() === 'ext2'), 'the unnamed sibling is already a pending schema-boundary lead').toBe(true);
    return engine;
  }

  const named = completedSiblingEngine();
  const namedRes = named.supplementAgenda(['ext1']) as any;
  expect(namedRes.agendaed === 1, `the named target is added (got ${JSON.stringify(namedRes)})`).toBe(true);
  expect(named.toJSON().scopeNodeIds.includes('ext1'), 'the named target joined the scope').toBe(true);
  expect(named.toJSON().scopeNodeIds.includes('ext2') === false, 'the sibling the user never named did not ride along').toBe(true);
  expect((named.toJSON().engineInternals?.sessionAllowedNodeIds ?? []).includes('ext2') === false, 'admission is id-scoped, never schema-scoped').toBe(true);
  expect(named.pendingLeads.some(l => l.nodeId.toLowerCase() === 'ext2'), 'the sibling remains a lead the user can ask for on its own').toBe(true);
});

  // The object the user asks about is often one the completed run never deferred — found afterwards
  // by searching DDL. Requiring a pending lead behind every supplement target refused exactly that
  // case, which is the one the user asked for, so the lead list is not the bound; the id list is.
  it('a follow-up target no pending lead offered is added and analysed.', () => {
  // 'far' sits in the ext schema off the traced route, so the run never defers it and it never
  // becomes a lead — the shape of an id found after the fact rather than read off the answer.
  const farNodes: LineageNode[] = [
    makeNode({ id: 'o',    schema: 'dbo', name: 'o',    type: 'view' }),
    makeNode({ id: 'mid',  schema: 'dbo', name: 'mid',  type: 'view' }),
    makeNode({ id: 'ext1', schema: 'ext', name: 'ext1', type: 'view' }),
    makeNode({ id: 'far',  schema: 'ext', name: 'far',  type: 'view' }),
  ];
  const farEdges: Array<[string, string]> = [['o', 'mid'], ['mid', 'ext1']];
  const engine = new NavigationEngine(
    makeModel(farNodes, farEdges, ['dbo', 'ext']),
    makeGraph(farNodes, farEdges),
    () => {},
    { activeFilter: makeActiveFilter({ schemas: ['dbo'] }) },
  );
  engine.init({ origin: 'o', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });
  driveEngine(engine, { succ: { o: 'mid', mid: 'ext1' }, limit: 20 });
  expect(engine.status === 'complete', 'far-fixture engine completes').toBe(true);
  expect(engine.pendingLeads.some(l => l.nodeId.toLowerCase() === 'far') === false, "'far' was never deferred, so no lead offers it").toBe(true);

  const res = engine.supplementAgenda(['far']) as any;
  expect(res.agendaed === 1, `the unoffered id is added (got ${JSON.stringify(res)})`).toBe(true);
  expect(res.skipped === 0, 'having no lead behind it is not a refusal').toBe(true);
  expect(engine.toJSON().scopeNodeIds.includes('far'), 'it joined the existing scope').toBe(true);
  expect(engine.status === 'awaiting_findings', 'the engine re-enters analysis for it, in the same graph').toBe(true);
});

  it("supplement_empty names the input the model owns, and the exit for having no node to name", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });
  drain(engine, 'initial');
  expect(engine.status === 'complete', 'engine reaches complete before the empty supplement').toBe(true);
  const res = engine.supplementAgenda([]);
  expect('error' in res && res.error === 'supplement_empty', 'an empty supplement rejects').toBe(true);
  const hint = 'error' in res && typeof res.hint === 'string' ? res.hint : '';
  expect(hint.includes('supplement.nodeIds'), 'the hint names the field the model actually fills').toBe(true);
  expect(hint.includes('host-selected'), 'the lead id is named as unavailable, not offered as a repair').toBe(true);
  expect(hint.includes('do not resend an empty supplement'), 'the hint says what to do with no node to extend').toBe(true);
  expect(hint !== 'supplementAgenda requires at least one node id or pending lead id.', 'the lead id is no longer offered as an alternative input').toBe(true);
});

  // A prune records what the AI took out of the current picture; it is not a standing veto on a
  // later addition, which is the user's decision to make. Asking for a pruned object back adds it.
  it("a pruned target named in a follow-up is added back, not refused", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });
  driveEngine(engine, { prune: new Set(['viewa', 'viewb']), limit: 20 });
  expect(engine.status === 'complete', 'engine completes with both leaf views pruned').toBe(true);
  expect(engine.toJSON().removedSet.includes('viewa') && engine.toJSON().removedSet.includes('viewb'), 'both pruned ids start out removed').toBe(true);
  const totalBefore = engine.hopProgress.total;

  const res = engine.supplementAgenda(['viewa', 'viewb']) as any;
  expect('ok' in res && res.ok === true, 'an all-pruned supplement is accepted').toBe(true);
  expect(res.agendaed === 2, `both pruned targets are agendaed (got ${JSON.stringify(res)})`).toBe(true);
  expect(res.skipped === 0, 'a prune is not a refusal axis').toBe(true);
  const after = engine.toJSON();
  expect(after.removedSet.includes('viewa') === false && after.removedSet.includes('viewb') === false, 'both are out of removedSet, so enqueueHop no longer drops them').toBe(true);
  expect(after.nodeStates.some(s => s.nodeId === 'viewa' && s.action === 'prune') === false, "the stale prune state is dropped, so it cannot outrank the coming hop's verdict").toBe(true);
  // Each added node buys exactly one hop, credited once. Both were pruned as their own focus, so
  // they were visited and never debited; `enqueueHop`'s reactivation credit is the only one that
  // fires, and `unprune`'s own credit — which mirrors the neighbour-prune debit — must not fire
  // on top of it.
  expect(engine.hopProgress.total === totalBefore + 2, `the two hops about to run are counted once each (got ${engine.hopProgress.total} from ${totalBefore})`).toBe(true);
});

});
