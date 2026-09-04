import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { driveEngine, makeModel, makeNode } from './helpers/fixtures';
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
    const engine = new NavigationEngine(extModel, extGraph, () => {}, { activeFilter: { schemas: ['dbo'] } as any });
    engine.init({ origin: 'o', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });
    drainExt(engine);
    expect(engine.status === 'complete', 'ext engine completes').toBe(true);
    const lead = engine.pendingLeads.find(l => l.nodeId.toLowerCase() === 'ext1');
    expect(!!lead, 'ext1 recorded as a pending schema-boundary lead').toBe(true);
    return { engine, leadId: lead!.id };
  }
  it("(skippedDetails reason=out_of_allowlist) and leaves session state unchanged (side-effect-free).", () => {
  const { engine } = makeCompletedExtEngine();
  const scopeBefore = engine.scopeSize;
  const inScopeBefore = engine.toJSON().scopeNodeIds.includes('ext1');
  const res = engine.supplementAgenda(['ext1']) as any;
  expect('ok' in res && res.ok === true, 'supplementAgenda returns ok for an out-of-allowlist id').toBe(true);
  expect(res.skipped === 1, 'out-of-allowlist id ext1 is refused (skipped)').toBe(true);
  expect(res.agendaed === 0, 'out-of-allowlist id is not agendaed').toBe(true);
  expect(res.skippedDetails.length === 1, 'skippedDetails has exactly one entry').toBe(true);
  expect(res.skippedDetails[0]?.nodeId === 'ext1', 'skippedDetails names the refused id').toBe(true);
  expect(res.skippedDetails[0]?.reason === 'out_of_allowlist', 'skippedDetails reason is out_of_allowlist').toBe(true);
  expect(engine.scopeSize === scopeBefore, 'scope size unchanged by the rejected supplement').toBe(true);
  expect(engine.toJSON().scopeNodeIds.includes('ext1') === inScopeBefore, 'ext1 never merged into scope (side-effect-free reject)').toBe(true);
  expect(!inScopeBefore, 'ext1 was never in scope to begin with').toBe(true);
});

  it("succeeds and the hop total increments (mirrors followUpNode's admit-then-supplement ordering).", () => {
  const { engine, leadId } = makeCompletedExtEngine();
  const totalBefore = engine.hopProgress.total;
  const lead = engine.pendingLeads.find(l => l.id === leadId)!;
  expect(engine.admitSupplementTargets([lead.nodeId]).length === 1, 'the clicked lead target is admitted by id').toBe(true);
  const res = engine.supplementAgenda([], [leadId]) as any;
  expect('ok' in res && res.ok === true, 'supplement succeeds after pill-approved allowlist extension').toBe(true);
  expect(res.agendaed === 1, 'the approved ext1 lead is agendaed').toBe(true);
  expect(res.skipped === 0, 'nothing skipped once the schema is approved').toBe(true);
  expect(engine.hopProgress.total === totalBefore + 1, 'hop total increments for the newly-approved node').toBe(true);
  expect(engine.toJSON().scopeNodeIds.includes('ext1'), 'ext1 is now in scope').toBe(true);
});

  it("(exclusion is checked before the allowlist; excluded wins).", () => {
  const engine = new NavigationEngine(extModel, extGraph, () => {}, {
    activeFilter: { schemas: ['dbo'] } as any,
  });
  engine.init({ origin: 'o', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 }, excludeNodeIds: ['mid'] });
  drainExt(engine);
  expect(engine.status === 'complete', 'excluded-mid ext engine completes').toBe(true);
  const res = engine.supplementAgenda(['mid']) as any;
  expect('ok' in res && res.ok === true, 'supplementAgenda returns ok for an excluded in-allowlist id').toBe(true);
  expect(res.skipped === 1, 'excluded id mid is refused despite being in the allowlist').toBe(true);
  expect(res.skippedDetails[0]?.reason === 'excluded', 'exclusion takes priority over the allowlist axis').toBe(true);
});

  // Regression: nothing on the production supplement path ever widened the allowlist, so a
  // schema-boundary lead was a dead end — the follow-up target came straight back as
  // out_of_allowlist. `admitSupplementTargets` is the consent step the host now runs first,
  // mirroring the approve gate's extend-then-supplement ordering.
  it("admitSupplementTargets admits an out-of-allowlist follow-up target.", () => {
  // A supplement flips the engine out of 'complete', so the with/without comparison needs two.
  const before = makeCompletedExtEngine().engine.supplementAgenda(['ext1']) as any;
  expect(before.skipped === 1, 'without consent the target is still refused').toBe(true);

  const { engine } = makeCompletedExtEngine();
  engine.admitSupplementTargets(['ext1']);
  const after = engine.supplementAgenda(['ext1']) as any;
  expect(after.ok === true, 'supplement succeeds once the target has been admitted').toBe(true);
  expect(after.agendaed === 1, `the admitted target is agendaed (got ${JSON.stringify(after)})`).toBe(true);
  expect(after.skipped === 0, 'nothing is skipped once the schema is admitted').toBe(true);
  expect(engine.toJSON().scopeNodeIds.includes('ext1'), 'ext1 is now in scope').toBe(true);
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
    { activeFilter: { schemas: ['dbo'] } as any },
  );
  engine.init({ origin: 'b0', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 2 } });
  const succ: Record<string, string | undefined> = { b0: 'b1', b1: 'b2', b2: 'bx' };
  let safety = 20;
  while (safety-- > 0) {
    const ctx = engine.getHopContext() as any;
    if (ctx.done || !ctx.focus_node) break;
    const next = succ[ctx.focus_node.id];
    engine.submitFindings({
      focus_node_id: ctx.focus_node.id,
      sections: [{ angle: 'business' as const, text: `analysis for ${ctx.focus_node.id}` }],
      summary: ctx.focus_node.id,
      verdict: 'analyze',
      route_requests: next ? [{ nodeId: next, question: 'trace downstream' }] : [],
    });
  }

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

  it("admitSupplementTargets never overrides an exclusion, and ignores unresolvable ids.", () => {
  const engine = new NavigationEngine(extModel, extGraph, () => {}, {
    activeFilter: { schemas: ['dbo'] } as any,
  });
  engine.init({ origin: 'o', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 }, excludeNodeIds: ['mid'] });
  drainExt(engine);
  engine.admitSupplementTargets(['mid', '[dbo].[doesNotExist]']);
  const res = engine.supplementAgenda(['mid']) as any;
  expect(res.skipped === 1, 'consent does not reopen a node the user excluded').toBe(true);
  expect(res.skippedDetails[0]?.reason === 'excluded', 'the exclusion axis still refuses it').toBe(true);
});

  // Regression: admitSupplementTargets read every resolvable id's schema, so naming an excluded
  // node widened sessionAllowedSchemas on its behalf and let a sibling in that schema through a
  // border the user never opened. Consent is read only from ids the exclusion set still allows.
  it("admitSupplementTargets does not widen the allowlist on behalf of an excluded id.", () => {
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
    { activeFilter: { schemas: ['dbo'] } as any },
  );
  engine.init({ origin: 'o', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 }, excludeNodeIds: ['ext1'] });
  drainExt(engine);
  expect(engine.status === 'complete', 'sibling engine completes').toBe(true);

  engine.admitSupplementTargets(['ext1']);
  const res = engine.supplementAgenda(['ext2']) as any;
  expect(res.skipped === 1, 'the sibling is still refused (got ' + JSON.stringify(res) + ')').toBe(true);
  expect(res.agendaed === 0, 'the sibling is not agendaed').toBe(true);
  expect(res.skippedDetails[0]?.reason === 'out_of_allowlist', 'the ext schema was never admitted').toBe(true);
});

  // Consent is per node: naming one follow-up target admits that target, never its schema
  // siblings. A sibling the user never named stays behind the border and remains a lead the
  // user can approve on its own.
  it('admitSupplementTargets admits the named ids only, never their schema siblings.', () => {
  const siblingNodes: LineageNode[] = [
    makeNode({ id: 'o',    schema: 'dbo', name: 'o',    type: 'view' }),
    makeNode({ id: 'mid',  schema: 'dbo', name: 'mid',  type: 'view' }),
    makeNode({ id: 'ext1', schema: 'ext', name: 'ext1', type: 'view' }),
    makeNode({ id: 'ext2', schema: 'ext', name: 'ext2', type: 'view' }),
  ];
  const siblingEdges: Array<[string, string]> = [['o', 'mid'], ['mid', 'ext1'], ['mid', 'ext2']];
  // A supplement flips the engine out of 'complete', so naming one target and then probing the
  // sibling takes two engines — the same with/without pattern the consent case above uses.
  function completedSiblingEngine(): NavigationEngine {
    const engine = new NavigationEngine(
      makeModel(siblingNodes, siblingEdges, ['dbo', 'ext']),
      makeGraph(siblingNodes, siblingEdges),
      () => {},
      { activeFilter: { schemas: ['dbo'] } as any },
    );
    engine.init({ origin: 'o', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });
    driveEngine(engine, { routes: { o: ['mid'], mid: ['ext1', 'ext2'] }, limit: 20 });
    expect(engine.status === 'complete', 'sibling engine completes').toBe(true);
    expect(engine.pendingLeads.some(l => l.nodeId.toLowerCase() === 'ext2'), 'the unnamed sibling is already a pending schema-boundary lead').toBe(true);
    return engine;
  }

  const named = completedSiblingEngine();
  const admitted = named.admitSupplementTargets(['ext1']);
  expect(admitted.join(','), 'admission reports exactly the ids it opened').toBe('ext1');
  const namedRes = named.supplementAgenda(['ext1']) as any;
  expect(namedRes.agendaed === 1, `the named target is admitted (got ${JSON.stringify(namedRes)})`).toBe(true);

  const siblingEngine = completedSiblingEngine();
  siblingEngine.admitSupplementTargets(['ext1']);
  const sibling = siblingEngine.supplementAgenda(['ext2']) as any;
  expect(sibling.skipped === 1, `the sibling the user never named stays outside the border (got ${JSON.stringify(sibling)})`).toBe(true);
  expect(sibling.skippedDetails[0]?.reason === 'out_of_allowlist', 'the sibling is refused on the allowlist axis').toBe(true);
  expect(siblingEngine.pendingLeads.some(l => l.nodeId.toLowerCase() === 'ext2'), 'the sibling remains a lead the user can approve on its own').toBe(true);
});

  // The supplement nodeIds arrive in a model tool payload, so the admit step is not a blank cheque:
  // it opens only a route this run itself deferred and named in the answer. An out-of-allowlist id
  // the model produces with no lead behind it stays refused, exactly as it was before the admit
  // step existed — otherwise `out_of_allowlist` would be unreachable on the supplement path.
  it('admitSupplementTargets refuses an out-of-allowlist id that no pending lead offered.', () => {
  // 'far' sits in the ext schema but off the traced route, so the run never defers it and it
  // never becomes a lead — the shape of an id a model invented rather than read off the answer.
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
    { activeFilter: { schemas: ['dbo'] } as any },
  );
  engine.init({ origin: 'o', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });
  driveEngine(engine, { succ: { o: 'mid', mid: 'ext1' }, limit: 20 });
  expect(engine.status === 'complete', 'far-fixture engine completes').toBe(true);
  expect(engine.pendingLeads.some(l => l.nodeId.toLowerCase() === 'far') === false, "'far' was never deferred, so no lead offers it").toBe(true);

  expect(engine.admitSupplementTargets(['far']).length === 0, 'an id with no lead behind it is not admitted').toBe(true);
  const res = engine.supplementAgenda(['far']) as any;
  expect(res.skipped === 1, `the unoffered id is still refused (got ${JSON.stringify(res)})`).toBe(true);
  expect(res.skippedDetails[0]?.reason === 'out_of_allowlist', 'refused on the allowlist axis, the reason main reported').toBe(true);
  expect(engine.toJSON().scopeNodeIds.includes('far') === false, 'nothing merged into scope').toBe(true);

  // The lead-backed id in the same payload is unaffected — the refusal is per id, not per call.
  expect(engine.admitSupplementTargets(['far', 'ext1']).join(','), 'only the offered id is admitted').toBe('ext1');
});

});
