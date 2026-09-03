import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { SCRIPT_TYPES } from '../../../src/ai/tools/tools';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe("Bipartite Agenda Rule", () => {
  const nodes: LineageNode[] = [
    makeNode({ id: 'sp',     schema: 'dbo', name: 'sp',     type: 'procedure' }),
    makeNode({ id: 'table',  schema: 'dbo', name: 'table',  type: 'table' }),
    makeNode({ id: 'viewA',  schema: 'dbo', name: 'viewA',  type: 'view' }),
    makeNode({ id: 'viewB',  schema: 'dbo', name: 'viewB',  type: 'view' }),
  ];
  const edges: Array<[string, string]> = [
    ['sp',    'table'],
    ['table', 'viewA'],
    ['table', 'viewB'],
  ];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);
  it("Test 1: seeded agenda after init contains only bodied nodes", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });

  const state = engine.toJSON() as { agenda: Array<{ nodeId: string }>; scopeNodeIds: string[]; nodeStates: Array<{ nodeId: string; action: string; reason: string; source: string }> };
  const agendaIds = state.agenda.map(e => e.nodeId);
  const scopeIds = state.scopeNodeIds;
  const tableState = state.nodeStates.find(s => s.nodeId === 'table');

  expect(scopeIds.includes('table'), 'scope contains the table (still routable / referenceable)').toBe(true);
  expect(!agendaIds.includes('table'), 'agenda does NOT contain the table (bipartite rule)').toBe(true);
  expect(tableState?.action === 'passthrough', 'table lifecycle is pass, not inferred from detail slot absence').toBe(true);
  expect(tableState?.source === 'engine', 'table pass state is engine-owned').toBe(true);
  expect(tableState?.reason === 'non_bodied_passthrough', 'table pass reason records non-bodied passthrough').toBe(true);
  expect(agendaIds.includes('viewA'), 'agenda contains viewA (forwarded from table seed)').toBe(true);
  expect(agendaIds.includes('viewB'), 'agenda contains viewB (forwarded from table seed)').toBe(true);
  expect(agendaIds.every(id => SCRIPT_TYPES.has(nodes.find(n => n.id === id)!.type)), 'every agenda entry is bodied').toBe(true);
});

  it("Test 2: route_requests forwarding — proc routes to table, question propagates to viewA/viewB", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });

  // Hop 1 — sp is focus
  const ctx1 = engine.getHopContext();
  expect(ctx1.focus_node?.id === 'sp', 'Hop 1 focus is sp').toBe(true);

  const SP_QUESTION = 'how are col1/col2 consumed downstream?';
  engine.submitFindings({
    focus_node_id: 'sp',
    sections: [{ angle: 'business' as const, text: 'sp writes col1 and col2 to the table' }],
    summary: 'sp writes col1, col2',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'table', question: SP_QUESTION }],
  });

  // After submit, agenda should have viewA and viewB with sp's verbatim question merged in.
  const state = engine.toJSON();
  const entryA = state.agenda.find(e => e.nodeId === 'viewA');
  const entryB = state.agenda.find(e => e.nodeId === 'viewB');
  const tableState = state.nodeStates.find(s => s.nodeId === 'table');
  const taskById = new Map(state.engineInternals.investigationTasks.map(task => [task.id, task]));

  expect(!!entryA, 'viewA is on agenda after sp routes to table').toBe(true);
  expect(!!entryB, 'viewB is on agenda after sp routes to table').toBe(true);
  expect(entryA!.taskIds.some(taskId => taskById.get(taskId)?.question.includes(SP_QUESTION)), 'viewA inherits sp\'s authored question verbatim').toBe(true);
  expect(entryB!.taskIds.some(taskId => taskById.get(taskId)?.question.includes(SP_QUESTION)), 'viewB inherits sp\'s authored question verbatim').toBe(true);
  expect(!state.agenda.some(e => e.nodeId === 'table'), 'table is NOT on agenda after route forwarding').toBe(true);
  expect(tableState?.action === 'passthrough', 'routed table keeps pass lifecycle state').toBe(true);
});

  it("Test 3: no non-bodied node ever becomes focus", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });

  const focusIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const ctx = engine.getHopContext();
    if (ctx.done || !ctx.focus_node) break;
    const focusId = ctx.focus_node.id as string;
    focusIds.push(focusId);
    engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: 'noop' }],
      summary: 'noop',
      verdict: 'analyze',
    });
  }

  expect(!focusIds.includes('table'), 'table never appears as hop focus across the whole session').toBe(true);
  expect(focusIds.every(id => SCRIPT_TYPES.has(nodes.find(n => n.id === id)!.type)), 'every hop focus was bodied').toBe(true);
  const final = engine.getResult();
  // Lifecycle state (node_states.action) is the single source of truth — the vestigial
  // ResultNode.role vocabulary (origin/noted/bridge) was removed as write-only dead metadata.
  expect(final.node_states.some(s => s.nodeId === 'table' && s.action === 'passthrough'), 'final result exposes table passthrough lifecycle state').toBe(true);
  expect(!final.detail_slots.some(s => s.nodeId === 'table'), 'contracted table does not need a detail slot').toBe(true);
});

  it("\"Hop X of Y\" drift where X could exceed Y because out-of-scope route growth never bumped total).", () => {
  // sp -> table -> viewA -> tableC -> viewD. The depth intent is deliberately `default_start`:
  // this test is about the hop-progress denominator, so the depth border must stay non-binding
  // or the growth route would be deferred and the accounting under test would never happen.
  // The default seed (depth 3) is {sp4, table4, viewA4, tableC4}, leaving viewD4 (depth 4)
  // genuinely out-of-scope while bipartite contraction still makes it a direct neighbour of viewA4.
  const n4: LineageNode[] = [
    makeNode({ id: 'sp4',    schema: 'dbo', name: 'sp4',    type: 'procedure' }),
    makeNode({ id: 'table4', schema: 'dbo', name: 'table4', type: 'table' }),
    makeNode({ id: 'viewA4', schema: 'dbo', name: 'viewA4', type: 'view' }),
    makeNode({ id: 'tableC4', schema: 'dbo', name: 'tableC4', type: 'table' }),
    makeNode({ id: 'viewD4', schema: 'dbo', name: 'viewD4', type: 'view' }),
  ];
  const e4: Array<[string, string]> = [
    ['sp4', 'table4'],
    ['table4', 'viewA4'],
    ['viewA4', 'tableC4'],
    ['tableC4', 'viewD4'],
  ];
  const model4: DatabaseModel = makeModel(n4, e4, ['dbo']);
  const graph4 = makeGraph(n4, e4);

  const engine = new NavigationEngine(model4, graph4, () => {}, {});
  engine.init({ origin: 'sp4', question: 'test', direction: 'downstream', depthIntent: { kind: 'default_start' } });

  const recordInvariant = (label: string) => {
    const p = engine.hopProgress;
    expect(p.current <= p.total, `${label}: current (${p.current}) <= total (${p.total})`).toBe(true);
    expect(p.total >= p.current + p.open, `${label}: total (${p.total}) covers current + open (${p.current} + ${p.open})`).toBe(true);
  };

  // bodiedScopeSize = sp4 (procedure) + viewA4 (view); table4/tableC4 don't count (non-bodied);
  // viewD4 is out of the default BFS seed entirely.
  expect(engine.hopProgress.total === 2, `initial total is bodiedScopeSize (sp4 + viewA4) — got ${engine.hopProgress.total}`).toBe(true);

  // Hop 1: sp4 routes only its direct table4 neighbor. Direct-neighbor action policy forbids
  // skip-level routes to viewA4/viewD4 from this focus.
  let ctx = engine.getHopContext();
  recordInvariant('after hop1 dispatch (sp4)');
  expect(ctx.focus_node?.id === 'sp4', 'Hop 1 focus is sp4').toBe(true);

  engine.submitFindings({
    focus_node_id: 'sp4',
    sections: [{ angle: 'business' as const, text: 'sp4 routes downstream' }],
    summary: 'sp4 routes downstream',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'table4', question: 'required direct neighbor' }],
  });
  recordInvariant('after hop1 submit (routed table4)');

  // Hop 2: viewA4 is the contracted seeded focus and viewD4 is now a direct neighbor. Duplicate
  // route requests for the same fresh node must grow the progress denominator exactly once.
  ctx = engine.getHopContext();
  recordInvariant('after hop2 dispatch (viewA4)');
  expect(ctx.focus_node?.id === 'viewA4', 'Hop 2 focus is viewA4').toBe(true);
  const totalBeforeRoute = engine.hopProgress.total;
  engine.submitFindings({
    focus_node_id: 'viewA4',
    sections: [{ angle: 'business' as const, text: 'viewA4 routes to viewD4' }],
    summary: 'viewA4 routes downstream',
    verdict: 'analyze',
    route_requests: [
      // tableC4 is an approved in-scope continuation neighbour, so it must be accounted for;
      // being non-bodied it contracts through to viewD4 rather than adding to the denominator.
      { nodeId: 'tableC4', question: 'required direct neighbor' },
      { nodeId: 'viewD4', question: 'trace viewD4 (first)' },
      { nodeId: 'viewD4', question: 'trace viewD4 (duplicate in same hop)' },
    ],
  });
  recordInvariant('after hop2 submit (routed viewD4 x2)');
  expect(engine.hopProgress.total === totalBeforeRoute + 1, `net +1: one fresh direct expansion (viewD4), duplicate uncredited — expected ${totalBeforeRoute + 1}, got ${engine.hopProgress.total}`).toBe(true);

  // Drain the rest (viewD4 then viewA4, or vice versa per agenda priority); assert the invariant at
  // every remaining step — critically BEFORE the completion clamp (smBase.ts getHopContext) would
  // otherwise mask a mid-session current > total violation by forcing total := current on drain.
  let safety = 20;
  while (safety-- > 0) {
    ctx = engine.getHopContext();
    recordInvariant('drain: after getHopContext');
    if (ctx.done) break;
    if (!ctx.focus_node) break;
    engine.submitFindings({
      focus_node_id: ctx.focus_node.id as string,
      sections: [{ angle: 'business' as const, text: 'drain' }],
      summary: 'drain',
      verdict: 'analyze',
    });
    recordInvariant('drain: after submitFindings');
  }

  expect(ctx.done === true, 'engine drains to completion').toBe(true);
  const finalProgress = engine.hopProgress;
  expect(finalProgress.current === finalProgress.total, `final current === total (X/Y equal at completion) — got ${finalProgress.current}/${finalProgress.total}`).toBe(true);
});

  it("exceed Y, and Y must still include queued work so equality cannot imply completion while agenda is open.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });

  const ctx = engine.getHopContext();
  expect(ctx.focus_node?.id === 'sp', 'Hop progress regression setup: first focus is sp').toBe(true);
  engine.submitFindings({
    focus_node_id: 'sp',
    sections: [{ angle: 'business' as const, text: 'sp analysis' }],
    summary: 'sp analysis',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'table', question: 'route through table' }],
  });

  const snap = engine.toJSON();
  expect(snap.agenda.length >= 2, 'Hop progress regression setup: agenda has queued work').toBe(true);
  snap.engineInternals.totalNodes = snap.hopCount;

  const restored = NavigationEngine.fromJSON(snap, model, graph, () => {}, {});
  const progress = restored.hopProgress;
  expect(progress.current <= progress.total, `stale raw total is clamped for display — got ${progress.current}/${progress.total}`).toBe(true);
  expect(progress.total >= progress.current + progress.open, `live denominator includes queued work — got total=${progress.total}, current=${progress.current}, open=${progress.open}`).toBe(true);
});

  // One CT world for both halves of the contraction contract. The traced column reaches the origin
  // through a chain of carriers, so a single authored route contracts across all of them to the
  // writer behind. `default_start` seeds three levels, leaving the writer (four levels up) outside
  // the seed — the only shape that reaches the contraction-admission branch, since an unbounded
  // seed would already contain it.
  const CARRIER_COLUMN = { name: 'OrderQty', type: 'int', nullable: 'NOT NULL', extra: '' };
  const n6: LineageNode[] = [
    makeNode({ id: 'writer6', schema: 'dbo', name: 'writer6', type: 'procedure' }),
    makeNode({ id: 'excludednodewriter6', schema: 'dbo', name: 'excludednodewriter6', type: 'procedure' }),
    makeNode({ id: 'excludedschemawriter6', schema: 'audit', name: 'excludedschemawriter6', type: 'procedure' }),
    makeNode({ id: 'excludedtypewriter6', schema: 'dbo', name: 'excludedtypewriter6', type: 'function' }),
    makeNode({ id: 'carrier6', schema: 'dbo', name: 'carrier6', type: 'table', columns: [CARRIER_COLUMN] }),
    makeNode({ id: 'carrier6b', schema: 'dbo', name: 'carrier6b', type: 'table', columns: [CARRIER_COLUMN] }),
    makeNode({ id: 'carrier6c', schema: 'dbo', name: 'carrier6c', type: 'table', columns: [CARRIER_COLUMN] }),
    makeNode({ id: 'origin6', schema: 'dbo', name: 'origin6', type: 'view', columns: [{ name: 'ResultQty', type: 'int', nullable: 'NOT NULL', extra: '' }] }),
    makeNode({ id: 'downstream6', schema: 'dbo', name: 'downstream6', type: 'view' }),
    makeNode({ id: 'unrelatedcarrier6', schema: 'dbo', name: 'unrelatedcarrier6', type: 'table' }),
    makeNode({ id: 'unrelatedwriter6', schema: 'dbo', name: 'unrelatedwriter6', type: 'procedure' }),
  ];
  const e6: Array<[string, string]> = [
    ['writer6', 'carrier6c'],
    ['excludednodewriter6', 'carrier6c'],
    ['excludedschemawriter6', 'carrier6c'],
    ['excludedtypewriter6', 'carrier6c'],
    ['carrier6c', 'carrier6b'],
    ['carrier6b', 'carrier6'],
    ['carrier6', 'origin6'],
    ['carrier6', 'downstream6'],
    ['unrelatedwriter6', 'unrelatedcarrier6'],
  ];
  const model6: DatabaseModel = makeModel(n6, e6, ['dbo', 'audit']);
  const ROUTE_QUESTION = 'Trace the authored OrderQty route through carrier6.';

  /** Initializes the CT world at the given depth and commits the one authored carrier route. */
  function driveCtContraction(depthIntent: { kind: 'default_start' } | { kind: 'explicit'; levels: number }): NavigationEngine {
    const engine = new NavigationEngine(model6, makeGraph(n6, e6), () => {}, {});
    const init = engine.init({
      origin: 'origin6',
      question: 'trace ResultQty to its raw source',
      analysisMode: 'ct',
      targetColumns: ['ResultQty'],
      direction: 'upstream',
      depthIntent,
      excludeNodeIds: ['excludednodewriter6'],
      excludeSchemas: ['audit'],
      excludeTypes: ['function'],
    });
    expect('ok' in init, 'CT contraction setup initializes').toBe(true);
    expect(!engine.toJSON().scopeNodeIds.includes('writer6'), 'writer starts beyond the initial BFS seed').toBe(true);

    const hop = engine.getHopContext();
    expect(hop.focus_node?.id === 'origin6', 'CT contraction setup focuses the origin').toBe(true);
    const submitted = engine.submitFindings({
      focus_node_id: 'origin6',
      sections: [{ angle: 'technical', text: 'ResultQty is sourced from carrier6.OrderQty.' }],
      summary: 'ResultQty continues through carrier6.',
      verdict: 'analyze',
      column_flow: [{ out_col: 'ResultQty', upstream_columns: [{ node: 'carrier6', col: 'OrderQty' }] }],
      route_requests: [{ nodeId: 'carrier6', question: ROUTE_QUESTION }],
    });
    expect('ok' in submitted, 'accepted CT carrier route commits').toBe(true);
    return engine;
  }

  it("bodied contraction target beyond the initial BFS seed, retaining the route task's intent.", () => {
  const engine = driveCtContraction({ kind: 'default_start' });
  const state = engine.toJSON();
  const writerEntry = state.agenda.find(entry => entry.nodeId === 'writer6');
  const tasks = new Map(state.engineInternals.investigationTasks.map(task => [task.id, task]));
  expect(state.scopeNodeIds.includes('writer6'), 'eligible writer is admitted beyond the initial seed').toBe(true);
  expect(!!writerEntry, 'eligible writer is queued as the contracted CT hop').toBe(true);
  expect(writerEntry?.activeColumns?.includes('OrderQty') === true, 'contracted writer retains the tracked carrier column').toBe(true);
  expect(writerEntry?.taskIds.some(taskId => tasks.get(taskId)?.question.includes(ROUTE_QUESTION)) === true, 'contracted writer retains the authored route question').toBe(true);
  expect(!state.scopeNodeIds.includes('excludednodewriter6'), 'node-excluded writer remains excluded').toBe(true);
  expect(!state.scopeNodeIds.includes('excludedschemawriter6'), 'schema-excluded writer remains excluded').toBe(true);
  expect(!state.scopeNodeIds.includes('excludedtypewriter6'), 'type-excluded writer remains excluded').toBe(true);
  expect(!state.scopeNodeIds.includes('downstream6'), 'opposite-direction sibling is not admitted').toBe(true);
  expect(!state.scopeNodeIds.includes('unrelatedwriter6'), 'unrelated writer sibling is not admitted').toBe(true);
});

  // A carrier chain is not a way around a border the user stated: the admission that runs freely
  // under an assistant-chosen depth stops at a stated one, and the chain stops with it. (The lead
  // a refused bodied contraction records is pinned in depth-border-contract.test.ts, where the
  // carrier itself sits at the border rather than past it.)
  it("a contraction past a user-stated depth admits nothing beyond the border.", () => {
  const engine = driveCtContraction({ kind: 'explicit', levels: 1 });
  const state = engine.toJSON();
  expect(!state.scopeNodeIds.includes('writer6'), 'the writer beyond the stated border is not admitted').toBe(true);
  expect(!state.agenda.some(entry => entry.nodeId === 'writer6'), 'nothing beyond the border is queued').toBe(true);
  expect(!state.scopeNodeIds.includes('carrier6b'), 'the carrier past the border is not admitted either').toBe(true);
  expect(state.scopeNodeIds.includes('carrier6'), 'the carrier at the border stays in scope').toBe(true);
});

});
