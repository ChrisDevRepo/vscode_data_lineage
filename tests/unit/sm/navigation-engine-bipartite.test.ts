import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { SCRIPT_TYPES } from '../../../src/ai/tools/tools';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { assert, makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, it } from 'vitest';

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

  assert(scopeIds.includes('table'), 'scope contains the table (still routable / referenceable)');
  assert(!agendaIds.includes('table'), 'agenda does NOT contain the table (bipartite rule)');
  assert(tableState?.action === 'passthrough', 'table lifecycle is pass, not inferred from detail slot absence');
  assert(tableState?.source === 'engine', 'table pass state is engine-owned');
  assert(tableState?.reason === 'non_bodied_passthrough', 'table pass reason records non-bodied passthrough');
  assert(agendaIds.includes('viewA'), 'agenda contains viewA (forwarded from table seed)');
  assert(agendaIds.includes('viewB'), 'agenda contains viewB (forwarded from table seed)');
  assert(
    agendaIds.every(id => SCRIPT_TYPES.has(nodes.find(n => n.id === id)!.type)),
    'every agenda entry is bodied',
  );
});

  it("Test 2: route_requests forwarding — proc routes to table, question propagates to viewA/viewB", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });

  // Hop 1 — sp is focus
  const ctx1 = engine.getHopContext();
  assert(ctx1.focus_node?.id === 'sp', 'Hop 1 focus is sp');

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

  assert(!!entryA, 'viewA is on agenda after sp routes to table');
  assert(!!entryB, 'viewB is on agenda after sp routes to table');
  assert(entryA!.taskIds.some(taskId => taskById.get(taskId)?.question.includes(SP_QUESTION)) === true, 'viewA inherits sp\'s authored question verbatim');
  assert(entryB!.taskIds.some(taskId => taskById.get(taskId)?.question.includes(SP_QUESTION)) === true, 'viewB inherits sp\'s authored question verbatim');
  assert(!state.agenda.some(e => e.nodeId === 'table'), 'table is NOT on agenda after route forwarding');
  assert(tableState?.action === 'passthrough', 'routed table keeps pass lifecycle state');
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

  assert(!focusIds.includes('table'), 'table never appears as hop focus across the whole session');
  assert(
    focusIds.every(id => SCRIPT_TYPES.has(nodes.find(n => n.id === id)!.type)),
    'every hop focus was bodied',
  );
  const final = engine.getResult();
  // Lifecycle state (node_states.action) is the single source of truth — the vestigial
  // ResultNode.role vocabulary (origin/noted/bridge) was removed as write-only dead metadata.
  assert(final.node_states.some(s => s.nodeId === 'table' && s.action === 'passthrough'), 'final result exposes table passthrough lifecycle state');
  assert(!final.detail_slots.some(s => s.nodeId === 'table'), 'contracted table does not need a detail slot');
});

  it("\"Hop X of Y\" drift where X could exceed Y because out-of-scope route growth never bumped total).", () => {
  // sp -> table -> viewA -> viewD, init at depthIntent: { kind: 'explicit', levels: 2 } so {sp, table, viewA} are the initial BFS scope
  // (viewA already agenda'd via table's bipartite contraction) and viewD starts genuinely out-of-scope.
  const n4: LineageNode[] = [
    makeNode({ id: 'sp4',    schema: 'dbo', name: 'sp4',    type: 'procedure' }),
    makeNode({ id: 'table4', schema: 'dbo', name: 'table4', type: 'table' }),
    makeNode({ id: 'viewA4', schema: 'dbo', name: 'viewA4', type: 'view' }),
    makeNode({ id: 'viewD4', schema: 'dbo', name: 'viewD4', type: 'view' }),
  ];
  const e4: Array<[string, string]> = [
    ['sp4', 'table4'],
    ['table4', 'viewA4'],
    ['viewA4', 'viewD4'],
  ];
  const model4: DatabaseModel = makeModel(n4, e4, ['dbo']);
  const graph4 = makeGraph(n4, e4);

  const engine = new NavigationEngine(model4, graph4, () => {}, {});
  engine.init({ origin: 'sp4', question: 'test, 2 levels down', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 2 } });

  const recordInvariant = (label: string) => {
    const p = engine.hopProgress;
    assert(p.current <= p.total, `${label}: current (${p.current}) <= total (${p.total})`);
    assert(p.total >= p.current + p.open, `${label}: total (${p.total}) covers current + open (${p.current} + ${p.open})`);
  };

  // bodiedScopeSize = sp4 (procedure) + viewA4 (view); table4 doesn't count (non-bodied); viewD4 is
  // out of the depthIntent: { kind: 'explicit', levels: 2 } BFS scope entirely.
  assert(engine.hopProgress.total === 2, `initial total is bodiedScopeSize (sp4 + viewA4) — got ${engine.hopProgress.total}`);

  // Hop 1: sp4 routes only its direct table4 neighbor. Direct-neighbor action policy forbids
  // skip-level routes to viewA4/viewD4 from this focus.
  let ctx = engine.getHopContext();
  recordInvariant('after hop1 dispatch (sp4)');
  assert(ctx.focus_node?.id === 'sp4', 'Hop 1 focus is sp4');

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
  assert(ctx.focus_node?.id === 'viewA4', 'Hop 2 focus is viewA4');
  const totalBeforeRoute = engine.hopProgress.total;
  engine.submitFindings({
    focus_node_id: 'viewA4',
    sections: [{ angle: 'business' as const, text: 'viewA4 routes to viewD4' }],
    summary: 'viewA4 routes downstream',
    verdict: 'analyze',
    route_requests: [
      { nodeId: 'viewD4', question: 'trace viewD4 (first)' },
      { nodeId: 'viewD4', question: 'trace viewD4 (duplicate in same hop)' },
    ],
  });
  recordInvariant('after hop2 submit (routed viewD4 x2)');
  assert(
    engine.hopProgress.total === totalBeforeRoute + 1,
    `net +1: one fresh direct expansion (viewD4), duplicate uncredited — expected ${totalBeforeRoute + 1}, got ${engine.hopProgress.total}`,
  );

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

  assert(ctx.done === true, 'engine drains to completion');
  const finalProgress = engine.hopProgress;
  assert(finalProgress.current === finalProgress.total, `final current === total (X/Y equal at completion) — got ${finalProgress.current}/${finalProgress.total}`);
});

  it("exceed Y, and Y must still include queued work so equality cannot imply completion while agenda is open.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'sp', question: 'test', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });

  const ctx = engine.getHopContext();
  assert(ctx.focus_node?.id === 'sp', 'Hop progress regression setup: first focus is sp');
  engine.submitFindings({
    focus_node_id: 'sp',
    sections: [{ angle: 'business' as const, text: 'sp analysis' }],
    summary: 'sp analysis',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'table', question: 'route through table' }],
  });

  const snap = engine.toJSON();
  assert(snap.agenda.length >= 2, 'Hop progress regression setup: agenda has queued work');
  snap.engineInternals!.totalNodes = snap.hopCount;

  const restored = NavigationEngine.fromJSON(snap, model, graph, () => {}, {});
  const progress = restored.hopProgress;
  assert(progress.current <= progress.total, `stale raw total is clamped for display — got ${progress.current}/${progress.total}`);
  assert(
    progress.total >= progress.current + progress.open,
    `live denominator includes queued work — got total=${progress.total}, current=${progress.current}, open=${progress.open}`,
  );
});

  it("bodied contraction target beyond the initial BFS seed, retaining the route task's intent.", () => {
  const n6: LineageNode[] = [
    makeNode({ id: 'writer6', schema: 'dbo', name: 'writer6', type: 'procedure' }),
    makeNode({ id: 'excludednodewriter6', schema: 'dbo', name: 'excludednodewriter6', type: 'procedure' }),
    makeNode({ id: 'excludedschemawriter6', schema: 'audit', name: 'excludedschemawriter6', type: 'procedure' }),
    makeNode({ id: 'excludedtypewriter6', schema: 'dbo', name: 'excludedtypewriter6', type: 'function' }),
    makeNode({ id: 'carrier6', schema: 'dbo', name: 'carrier6', type: 'table', columns: [{ name: 'OrderQty', type: 'int', nullable: 'NOT NULL', extra: '' }] }),
    makeNode({ id: 'origin6', schema: 'dbo', name: 'origin6', type: 'view', columns: [{ name: 'ResultQty', type: 'int', nullable: 'NOT NULL', extra: '' }] }),
    makeNode({ id: 'downstream6', schema: 'dbo', name: 'downstream6', type: 'view' }),
    makeNode({ id: 'unrelatedcarrier6', schema: 'dbo', name: 'unrelatedcarrier6', type: 'table' }),
    makeNode({ id: 'unrelatedwriter6', schema: 'dbo', name: 'unrelatedwriter6', type: 'procedure' }),
  ];
  const e6: Array<[string, string]> = [
    ['writer6', 'carrier6'],
    ['excludednodewriter6', 'carrier6'],
    ['excludedschemawriter6', 'carrier6'],
    ['excludedtypewriter6', 'carrier6'],
    ['carrier6', 'origin6'],
    ['carrier6', 'downstream6'],
    ['unrelatedwriter6', 'unrelatedcarrier6'],
  ];
  const model6: DatabaseModel = makeModel(n6, e6, ['dbo', 'audit']);
  const engine = new NavigationEngine(model6, makeGraph(n6, e6), () => {}, {});
  const init = engine.init({
    origin: 'origin6',
    question: 'trace ResultQty to its raw source',
    analysisMode: 'ct',
    targetColumns: ['ResultQty'],
    direction: 'upstream',
    depthIntent: { kind: 'explicit', levels: 1 },
    excludeNodeIds: ['excludednodewriter6'],
    excludeSchemas: ['audit'],
    excludeTypes: ['function'],
  });
  assert('ok' in init, 'CT contraction setup initializes');
  assert(!engine.toJSON().scopeNodeIds.includes('writer6'), 'writer starts beyond the initial BFS seed');

  const hop = engine.getHopContext();
  assert(hop.focus_node?.id === 'origin6', 'CT contraction setup focuses the origin');
  const bodiedScopeSizeBeforeAdmission = engine.bodiedScopeSize;
  const ROUTE_QUESTION = 'Trace the authored OrderQty route through carrier6.';
  const submitted = engine.submitFindings({
    focus_node_id: 'origin6',
    sections: [{ angle: 'technical', text: 'ResultQty is sourced from carrier6.OrderQty.' }],
    summary: 'ResultQty continues through carrier6.',
    verdict: 'analyze',
    column_flow: [{ out_col: 'ResultQty', upstream_columns: [{ node: 'carrier6', col: 'OrderQty' }] }],
    route_requests: [{ nodeId: 'carrier6', question: ROUTE_QUESTION }],
  });
  assert('ok' in submitted, 'accepted CT carrier route commits');

  const state = engine.toJSON();
  const writerEntry = state.agenda.find(entry => entry.nodeId === 'writer6');
  const tasks = new Map(state.engineInternals.investigationTasks.map(task => [task.id, task]));
  assert(state.scopeNodeIds.includes('writer6'), 'eligible writer is admitted beyond the initial seed');
  assert(!!writerEntry, 'eligible writer is queued as the contracted CT hop');
  assert(writerEntry?.activeColumns?.includes('OrderQty') === true, 'contracted writer retains the tracked carrier column');
  assert(writerEntry?.taskIds.some(taskId => tasks.get(taskId)?.question.includes(ROUTE_QUESTION)) === true, 'contracted writer retains the authored route question');
  assert(!state.scopeNodeIds.includes('excludednodewriter6'), 'node-excluded writer remains excluded');
  assert(!state.scopeNodeIds.includes('excludedschemawriter6'), 'schema-excluded writer remains excluded');
  assert(!state.scopeNodeIds.includes('excludedtypewriter6'), 'type-excluded writer remains excluded');
  assert(!state.scopeNodeIds.includes('downstream6'), 'opposite-direction sibling is not admitted');
  assert(!state.scopeNodeIds.includes('unrelatedwriter6'), 'unrelated writer sibling is not admitted');
  assert(
    engine.bodiedScopeSize === bodiedScopeSizeBeforeAdmission + 1,
    `bodiedScopeSize grows by exactly 1 for the single CT-admitted bodied writer — got ${engine.bodiedScopeSize}, expected ${bodiedScopeSizeBeforeAdmission + 1}`,
  );
});

});
