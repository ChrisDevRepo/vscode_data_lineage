import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { assert, makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, it } from 'vitest';

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
    let safety = 20;
    while (safety-- > 0) {
      const ctx = engine.getHopContext() as any;
      if (ctx.done) break;
      if (!ctx.focus_node) break;
      engine.submitFindings({
        focus_node_id: ctx.focus_node.id,
        sections: [{ angle: 'business' as const, text: `${tag}: analysis for ${ctx.focus_node.id}` }],
        summary: `${tag}: ${ctx.focus_node.id}`,
        verdict: 'analyze',
      });
    }
  }
  it("Test 1: rejects when engine has not completed yet", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });
  const res = engine.supplementAgenda(['viewc']);
  assert('error' in res, 'supplementAgenda rejects while engine is not complete');
  if ('error' in res) {
    assert(res.error === 'supplement_requires_complete_engine', 'error code is supplement_requires_complete_engine');
  }
});

  it("Test 2: after completion, supplement with an unknown id is reported as skipped", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });
  drain(engine, 'initial');
  assert(engine.status === 'complete', 'engine reaches complete after initial drain');

  const slotsBefore = (engine.toJSON() as { slotCount?: number }).slotCount ?? -1;
  const res = engine.supplementAgenda(['[dbo].[doesNotExist]']);
  assert('ok' in res && (res as any).ok === true, 'supplementAgenda returns ok even when all ids are unknown');
  if ('ok' in res) {
    assert(res.skipped === 1, 'unknown id counted in skipped');
    assert(res.agendaed === 0, 'nothing agendaed');
    assert(res.contracted === 0, 'nothing contracted');
    assert(res.skippedDetails.length === 1, 'skippedDetails has exactly one entry');
    assert(res.skippedDetails[0]?.nodeId === '[dbo].[doesNotExist]', 'skippedDetails names the raw unresolved id');
    assert(res.skippedDetails[0]?.reason === 'unresolved', 'skippedDetails reason is unresolved for an unknown id');
  }
  // After an all-skipped supplement we still flip status back because the caller
  // expected to resume; the next getHopContext will re-drain immediately to 'complete'.
  drain(engine, 'no-op-supplement');
  assert(engine.status === 'complete', 'engine returns to complete after empty-supplement drain');
  const slotsAfter = (engine.toJSON() as { slotCount?: number }).slotCount ?? -1;
  assert(slotsAfter === slotsBefore, 'archive is unchanged when supplement ids are all skipped');
});

  it("Test 3: supplement a bodied id that was deferred in the initial narrow scope", () => {
  // Use upstream direction from viewa (depth 1) so only {viewa, ta, sp} are in scope —
  // viewc is reachable only via sp's downstream neighbors, which the upstream BFS misses.
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'viewa', question: 'test', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 2 } });
  drain(engine, 'narrow');
  assert(engine.status === 'complete', 'narrow engine complete');
  const narrowSlots = engine.getResult().detail_slots.map(s => s.nodeId);
  assert(!narrowSlots.includes('viewc'), 'viewc not yet in narrow archive');

  const totalBeforeSupplement = engine.hopProgress.total;
  const r = engine.supplementAgenda(['viewc']);
  assert('ok' in r && (r as any).ok === true, 'supplementAgenda ok on bodied id');
  if ('ok' in r) {
    assert(r.agendaed >= 1, `at least one id agendaed (got ${r.agendaed})`);
    assert(r.skipped === 0, 'no ids skipped for valid bodied id');
  }
  assert(engine.status === 'awaiting_findings', 'status returns to awaiting_findings after supplement');
  // Regression for the "Hop X of Y" drift: a genuinely new-to-scope bodied supplement id must
  // credit hopProgress.total, or the walk consumes a hop nobody counted (X can exceed Y).
  assert(
    engine.hopProgress.total === totalBeforeSupplement + 1,
    `supplementing a new bodied id credits total by 1 — expected ${totalBeforeSupplement + 1}, got ${engine.hopProgress.total}`,
  );

  drain(engine, 'supplement');
  assert(engine.status === 'complete', 'engine completes again after supplement drain');
  assert(
    engine.hopProgress.current === engine.hopProgress.total,
    `final current === total after supplement drain — got ${engine.hopProgress.current}/${engine.hopProgress.total}`,
  );

  const after = engine.getResult().detail_slots;
  const afterIds = new Set(after.map(s => s.nodeId));
  assert(afterIds.has('viewc'), 'viewc slot present in archive after supplement');
  for (const originalId of narrowSlots) {
    assert(afterIds.has(originalId), `prior slot ${originalId} survived supplement merge`);
  }
});

  it("consume a hop just like a bodied node once it gets the special origin/supplement direct push.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'viewa', question: 'test', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 2 } });
  drain(engine, 'setup');
  assert(engine.status === 'complete', 'setup engine complete');

  const totalBefore = engine.hopProgress.total;
  const r = engine.supplementAgenda(['ta']);
  assert('ok' in r && (r as any).ok === true, 'supplementAgenda ok on already-in-scope non-bodied id');
  assert(
    engine.hopProgress.total === totalBefore + 1,
    `supplementing an already-in-scope non-bodied id still credits total by 1 — expected ${totalBefore + 1}, got ${engine.hopProgress.total}`,
  );

  drain(engine, 'ta-supplement');
  assert(engine.status === 'complete', 'engine completes again after non-bodied supplement drain');
  assert(
    engine.hopProgress.current === engine.hopProgress.total,
    `final current === total after non-bodied supplement drain — got ${engine.hopProgress.current}/${engine.hopProgress.total}`,
  );
});

  it("so it consumes a brand-new hop) must credit total on reactivation, even though it's already in scope.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'viewa', question: 'test', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 2 } });
  drain(engine, 'setup');
  assert(engine.status === 'complete', 'setup engine complete');
  assert(
    engine.hopProgress.current === engine.hopProgress.total,
    `setup drains to current === total — got ${engine.hopProgress.current}/${engine.hopProgress.total}`,
  );

  const totalBefore = engine.hopProgress.total;
  const r = engine.supplementAgenda(['viewa']);
  assert('ok' in r && (r as any).ok === true, 'supplementAgenda ok re-analyzing already-visited bodied id');
  assert(
    engine.hopProgress.total === totalBefore + 1,
    `reactivating an already-visited bodied id credits total by 1 — expected ${totalBefore + 1}, got ${engine.hopProgress.total}`,
  );

  drain(engine, 'viewa-reactivation');
  assert(engine.status === 'complete', 'engine completes again after reactivation drain');
  assert(
    engine.hopProgress.current === engine.hopProgress.total,
    `final current === total after reactivation drain — got ${engine.hopProgress.current}/${engine.hopProgress.total}`,
  );
});

  it("push (agenda-membership-based credit, not the bodied SCRIPT_TYPES branch).", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'viewa', question: 'test', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 2 } });
  drain(engine, 'setup');
  assert(engine.status === 'complete', 'setup engine complete');

  // First supplement dispatches+visits the non-bodied 'ta' (Test 4's scenario); drain to completion.
  engine.supplementAgenda(['ta']);
  drain(engine, 'ta-first-pass');
  assert(engine.status === 'complete', 'engine completes after first ta supplement');

  const totalBefore = engine.hopProgress.total;
  const r = engine.supplementAgenda(['ta']);
  assert('ok' in r && (r as any).ok === true, 'supplementAgenda ok re-analyzing already-visited non-bodied id');
  assert(
    engine.hopProgress.total === totalBefore + 1,
    `reactivating an already-visited non-bodied id credits total by 1 — expected ${totalBefore + 1}, got ${engine.hopProgress.total}`,
  );

  drain(engine, 'ta-reactivation');
  assert(engine.status === 'complete', 'engine completes again after non-bodied reactivation drain');
  assert(
    engine.hopProgress.current === engine.hopProgress.total,
    `final current === total after non-bodied reactivation drain — got ${engine.hopProgress.current}/${engine.hopProgress.total}`,
  );
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
  assert(engine.status === 'complete', 'excluded-setup engine completes');

  const res = engine.supplementAgenda(['ta']) as any;
  assert('ok' in res && res.ok === true, 'supplementAgenda returns ok for an excluded id');
  if ('ok' in res) {
    assert(res.skipped === 1, 'excluded id ta is refused (skipped)');
    assert(res.agendaed === 0, 'excluded id is not agendaed');
    assert(res.skippedDetails.length === 1, 'skippedDetails has exactly one entry');
    assert(res.skippedDetails[0]?.nodeId === 'ta', 'skippedDetails names the excluded id');
    assert(res.skippedDetails[0]?.reason === 'excluded', 'skippedDetails reason is excluded for a user-excluded id');
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
    const succ: Record<string, string | undefined> = { o: 'mid', mid: 'ext1' };
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
  }
  function makeCompletedExtEngine(): { engine: NavigationEngine; leadId: string } {
    const engine = new NavigationEngine(extModel, extGraph, () => {}, { activeFilter: { schemas: ['dbo'] } as any });
    engine.init({ origin: 'o', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });
    drainExt(engine);
    assert(engine.status === 'complete', 'ext engine completes');
    const lead = engine.pendingLeads.find(l => l.nodeId.toLowerCase() === 'ext1');
    assert(!!lead, 'ext1 recorded as a pending schema-boundary lead');
    return { engine, leadId: lead!.id };
  }
  it("(skippedDetails reason=out_of_allowlist) and leaves session state unchanged (side-effect-free).", () => {
  const { engine } = makeCompletedExtEngine();
  const scopeBefore = engine.scopeSize;
  const inScopeBefore = engine.toJSON().scopeNodeIds.includes('ext1');
  const res = engine.supplementAgenda(['ext1']) as any;
  assert('ok' in res && res.ok === true, 'supplementAgenda returns ok for an out-of-allowlist id');
  assert(res.skipped === 1, 'out-of-allowlist id ext1 is refused (skipped)');
  assert(res.agendaed === 0, 'out-of-allowlist id is not agendaed');
  assert(res.skippedDetails.length === 1, 'skippedDetails has exactly one entry');
  assert(res.skippedDetails[0]?.nodeId === 'ext1', 'skippedDetails names the refused id');
  assert(res.skippedDetails[0]?.reason === 'out_of_allowlist', 'skippedDetails reason is out_of_allowlist');
  assert(engine.scopeSize === scopeBefore, 'scope size unchanged by the rejected supplement');
  assert(engine.toJSON().scopeNodeIds.includes('ext1') === inScopeBefore, 'ext1 never merged into scope (side-effect-free reject)');
  assert(!inScopeBefore, 'ext1 was never in scope to begin with');
});

  it("Test 9: resolveLeadSchemas derives the target schema from the resolved node (not string parsing).", () => {
  const { engine, leadId } = makeCompletedExtEngine();
  const schemas = engine.resolveLeadSchemas([leadId]);
  assert(schemas.length === 1 && schemas[0] === 'ext', 'resolveLeadSchemas returns the lead target node schema');
  assert(engine.resolveLeadSchemas(['no_such_lead']).length === 0, 'unknown lead ids resolve to no schema');
});

  it("succeeds and the hop total increments (mirrors followUpNode's extend-then-supplement ordering).", () => {
  const { engine, leadId } = makeCompletedExtEngine();
  const totalBefore = engine.hopProgress.total;
  for (const schema of engine.resolveLeadSchemas([leadId])) engine.extendAllowedSchemas(schema);
  const res = engine.supplementAgenda([], [leadId]) as any;
  assert('ok' in res && res.ok === true, 'supplement succeeds after pill-approved allowlist extension');
  assert(res.agendaed === 1, 'the approved ext1 lead is agendaed');
  assert(res.skipped === 0, 'nothing skipped once the schema is approved');
  assert(engine.hopProgress.total === totalBefore + 1, 'hop total increments for the newly-approved node');
  assert(engine.toJSON().scopeNodeIds.includes('ext1'), 'ext1 is now in scope');
});

  it("(exclusion is checked before the allowlist; excluded wins).", () => {
  const engine = new NavigationEngine(extModel, extGraph, () => {}, {
    activeFilter: { schemas: ['dbo'] } as any,
  });
  engine.init({ origin: 'o', question: 'trace', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 }, excludeNodeIds: ['mid'] });
  drainExt(engine);
  assert(engine.status === 'complete', 'excluded-mid ext engine completes');
  const res = engine.supplementAgenda(['mid']) as any;
  assert('ok' in res && res.ok === true, 'supplementAgenda returns ok for an excluded in-allowlist id');
  assert(res.skipped === 1, 'excluded id mid is refused despite being in the allowlist');
  assert(res.skippedDetails[0]?.reason === 'excluded', 'exclusion takes priority over the allowlist axis');
});

});
