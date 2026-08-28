import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import { buildCurrentTaskBlock } from '../../../src/ai/prompting/prompts';
import { activeModeOf } from '../../../src/ai/tools/toolPolicy';
import type { LogFn } from '../../../src/engine/graphGuards';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { assert, assertEq, makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, it } from 'vitest';

describe("Column Flow Validation", () => {
  const originNode: LineageNode = makeNode({
    id: 'origin',
    schema: 'dbo',
    name: 'origin_view',
    type: 'view',
    columns: [
      { name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' },
      { name: 'region', type: 'nvarchar(50)', nullable: 'NULL', extra: '' },
    ],
  });
  const baseTable: LineageNode = makeNode({
    id: 'base_table',
    schema: 'dbo',
    name: 'base_table',
    type: 'table',
    columns: [
      { name: 'raw_amount', type: 'int', nullable: 'NOT NULL', extra: '' },
    ],
  });
  const nodes: LineageNode[] = [originNode, baseTable];
  const edgePairs: Array<[string, string]> = [['base_table', 'origin']];
  const model: DatabaseModel = makeModel(nodes, edgePairs, ['dbo']);
  const graph = makeGraph(nodes, edgePairs);
  function ctEngine(targetColumns = ['amount']) {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'test', direction: 'upstream', targetColumns });
    engine.getHopContext();
    return engine;
  }
  function durableCtSnapshot(engine: NavigationEngine): string {
    const state = JSON.parse(JSON.stringify(engine.toJSON())) as {
      memory: { recentRejections: unknown[] };
      engineInternals?: { lastRoutedRejected?: number };
    };
    state.memory.recentRejections = [];
    if (state.engineInternals) delete state.engineInternals.lastRoutedRejected;
    return JSON.stringify({ state, pendingLineageQuestions: engine.pendingLineageQuestions });
  }
  it("Test 3: no self-prune — empty column_flow with active columns is rejected (escape closed)", () => {
  const engine = ctEngine();
  // origin tracks 'amount' (an active column). An empty flow cannot account for it, so the engine
  // rejects rather than letting the node drop itself. column_flow:[] is off-trace ONLY when the node
  // has no active columns. (Self-prune is gone — termination is engine-owned.)
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'x' }],
    summary: 'x',
    verdict: 'passthrough',
    column_flow: [],
  });
  assert('error' in result && result.error === 'column_chain_incomplete', 'CT: empty column_flow with active columns → column_chain_incomplete (no self-prune)');
});

  it("Test 3b: qualified target columns resolve to the declared bare name (2026-07-03 P3 stall)", () => {
  // Models qualify freely ("dbo.origin_view.amount", "[origin_view].[amount]") — the active spine
  // must still seed, in the DECLARED spelling, or every legitimate column_flow gets rejected as
  // "not an active tracked column" and the session collapses to a zero-trace.
  for (const requested of ['dbo.origin_view.amount', 'origin_view.amount', '[origin_view].[AMOUNT]']) {
    const engine = ctEngine([requested]);
    assertEq(
      engine.columnAspect?.active_columns.join(','),
      'amount',
      `CT: qualified target "${requested}" resolves to the declared column name`,
    );
  }
});

  it("one-node result; init rejects so the model names a real column or omits targetColumns for BB.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const result = engine.init({ origin: 'origin', question: 'test', direction: 'upstream', targetColumns: ['missing_col'] });
  assert('error' in result && result.error === 'unknown_columns', 'CT: target column not on origin → init rejects unknown_columns (no zero-trace)');
  assert('error' in result && typeof result.hint === 'string' && result.hint.length > 0, 'CT: unknown_columns reject carries a corrective hint');
});

  it("Test 3b: explicit BB mode rejects any targetColumns property before mutation", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const result = engine.init({ origin: 'origin', question: 'test', direction: 'upstream', analysisMode: 'bb', targetColumns: ['amount'] });
  assert('error' in result && result.error === 'ct_field_forbidden_in_bb', 'BB with named targetColumns rejects');
  assert(engine.status === 'created' && !engine.columnAspect, 'named-target rejection leaves engine untouched');
  const emptyResult = engine.init({ origin: 'origin', question: 'test', direction: 'upstream', analysisMode: 'bb', targetColumns: [] });
  assert('error' in emptyResult && emptyResult.error === 'ct_field_forbidden_in_bb', 'direct engine BB with empty target property also rejects');
  assert(engine.status === 'created', 'empty-target rejection leaves engine untouched');
});

  it("Test 3c: rejected BB refine is atomic; successful CT→BB clears CT state", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const initial = engine.init({ origin: 'origin', question: 'trace amount', direction: 'upstream', analysisMode: 'ct', targetColumns: ['amount'] });
  assert('ok' in initial, 'CT session initializes before transition checks');
  const ctSnapshot = engine.toJSON();
  const restoredCt = NavigationEngine.fromJSON(JSON.parse(JSON.stringify(ctSnapshot)), model, graph, () => {});
  assert(JSON.stringify(restoredCt.toJSON()) === JSON.stringify(ctSnapshot), 'current CT checkpoint round-trips without loss');
  const ctWithoutTargets = JSON.parse(JSON.stringify(ctSnapshot));
  ctWithoutTargets.columnAspect.target_columns = [];
  let missingTargetsRejected = false;
  try {
    NavigationEngine.fromJSON(ctWithoutTargets, model, graph, () => {});
  } catch {
    missingTargetsRejected = true;
  }
  assert(missingTargetsRejected, 'CT snapshot without target columns rejects');
  const ctTaskIds = new Set(ctSnapshot.engineInternals?.investigationTasks?.map(task => task.id) ?? []);
  const beforeReject = JSON.stringify(engine.getScopeSummary());
  const rejected = engine.init({ origin: 'origin', question: 'switch badly', direction: 'upstream', analysisMode: 'bb', targetColumns: ['amount'] });
  assert('error' in rejected && rejected.error === 'ct_field_forbidden_in_bb', 'inherited/live engine BB conflict rejects');
  assert(JSON.stringify(engine.getScopeSummary()) === beforeReject, 'rejected BB refine preserves the complete engine snapshot');
  const switched = engine.init({ origin: 'origin', question: 'switch cleanly', direction: 'upstream', analysisMode: 'bb' });
  assert('ok' in switched, 'valid explicit CT→BB transition succeeds');
  const summary = engine.getScopeSummary();
  assert(summary.analysisMode === 'bb' && summary.targetColumns === undefined && !engine.columnAspect, 'successful CT→BB transition clears prior CT columns');
  const bbSnapshot = engine.toJSON();
  const bbTasks = bbSnapshot.engineInternals?.investigationTasks ?? [];
  const bbTaskIds = new Set(bbTasks.map(task => task.id));
  assert(bbTasks.every(task => task.kind !== 'column_lineage' && task.activeColumns === undefined), 'successful CT→BB transition purges CT task shape');
  assert(bbTasks.every(task => !ctTaskIds.has(task.id)), 'successful CT→BB transition purges all prior ledger identities');
  assert(bbTasks.every(task => task.parentTaskId === undefined || bbTaskIds.has(task.parentTaskId)), 'replacement BB tasks have no dangling parent task ids');
  const bbRoot = bbTasks.find(task => task.kind === 'root');
  assert(!!bbRoot && bbTasks.filter(task => task.id !== bbRoot.id).every(task => task.parentTaskId === bbRoot.id), 'replacement seed tasks are explicitly parented to the new BB root');
});

  it("Test 3d: an absent upstream node is dropped with a notice and stages no edge", () => {
  const engine = ctEngine();
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'interaction' }],
    summary: 'interaction',
    verdict: 'analyze',
    column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 't_raw', col: 'raw_amount' }] }],
  });
  assert('ok' in result, 'CT: absent upstream node is nonfatal');
  assertEq(engine.columnAspect?.edges.length ?? -1, 0, 'CT: absent upstream stages zero column edges');
  assert(engine.toJSON().memory.recentRejections.some((r) => r.nodeId === 't_raw'), 'CT: absent upstream notice is recorded');
});

  it("Test 4: out_col not in active_columns → out_col_not_on_node (guided order + valid set)", () => {
  const engine = ctEngine(['amount']); // active = ['amount']
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{ out_col: 'wrong_col', upstream_columns: [] }],
  });
  assert('error' in result && result.error === 'out_col_not_on_node', 'out_col not active → out_col_not_on_node');
  if ('error' in result) {
    const hint = result.hint ?? '';
    assert(/declare column_flow only for an active tracked column/i.test(hint), 'hint is a verb-led order');
    assert(!/\bdo not\b|\bnever\b|\bdon't\b/i.test(hint), 'hint avoids negative framing');
    const detail = JSON.stringify('detail' in result ? result.detail : '');
    assert(detail.includes('wrong_col'), 'detail names the offending out_col');
    assert(detail.includes('amount'), 'detail lists the valid active column as data');
  }
});

  it("Test 6: upstream node absent from model → drop-with-notice", () => {
  const engine = ctEngine(['amount']);
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{
      out_col: 'amount',
      upstream_columns: [{ node: 'nonexistent_table', col: 'any_col' }],
    }],
  });
  assert('ok' in result, 'absent upstream node does not consume the retry budget');
  const edges = engine.columnAspect?.edges ?? [];
  assert(edges.length === 0, 'no dangling edge staged for the unresolved upstream node');
  assert(engine.toJSON().memory.recentRejections.some((r) => r.nodeId === 'nonexistent_table'), 'absent upstream notice remains visible');
});

  it("Test 7: upstream column not on source → contributor_col_not_on_source (lists columns)", () => {
  const engine = ctEngine(['amount']);
  // base_table only has 'raw_amount' — 'wrong_col' does not exist
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{
      out_col: 'amount',
      upstream_columns: [{ node: 'base_table', col: 'wrong_col' }],
    }],
  });
  assert('error' in result && result.error === 'contributor_col_not_on_source', 'upstream column not on source → contributor_col_not_on_source');
  if ('error' in result) {
    const hint = result.hint ?? '';
    assert(/set upstream_columns\[\]\.col to a real upstream column/i.test(hint), 'hint is a verb-led order');
    assert(/Do not use literals, NULLs, parameters, generated values, or filter-only columns/i.test(hint), 'hint keeps non-column semantics in sections');
    const detail = JSON.stringify('detail' in result ? result.detail : '');
    assert(detail.includes('raw_amount'), 'detail lists the valid source column as data');
  }
});

  it("a rejected upstream column stages no edge — an invalid contributor never reaches stagedEdges", () => {
    // `stagedEdges` is documented as the valid set. Rejecting the contributor and then staging the
    // edge built from it would commit a column that does not exist as soon as any caller merges
    // stagedEdges under a non-fatal disposition.
    const tracer = new ColumnTracer(['amount']);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const { invalidRoutes, stagedEdges } = tracer.validateColumnFlow(
      'origin',
      {
        focus_node_id: 'origin',
        sections: [{ angle: 'business' as const, text: 'ok' }],
        summary: 'ok',
        verdict: 'analyze',
        column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'base_table', col: 'wrong_col' }] }],
      } as never,
      nodeMap,
      model,
      null,
    );
    assert(invalidRoutes.some(r => r.kind === 'bad_contributor_col'), 'the invalid contributor is reported');
    assertEq(stagedEdges.length, 0, 'no edge is staged for a rejected upstream column');
  });

  it("an out_col that differs only by padding or quoting is accounted for, not reported incomplete", () => {
    // The completeness guard and validateColumnFlow must normalize identically; a value one admits
    // can never be reported unaccounted by the other, which would retry the identical payload until
    // the semantic breaker ends the turn.
    const tracer = new ColumnTracer(['amount']);
    assertEq(
      tracer.unaccountedActiveColumns([{ out_col: ' "Amount" ', upstream_columns: [] }] as never).length,
      0,
      'a padded/quoted out_col accounts for its active column',
    );
  });

  it("Test 8: valid column_flow accumulates edge and marks table pass-through", () => {
  const engine = ctEngine(['amount']);
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{
      out_col: 'amount',
      upstream_columns: [{ node: 'base_table', col: 'raw_amount' }],
    }],
  });
  assert('ok' in result && result.ok, 'valid column_flow accepted');
  const edges = engine.columnAspect?.edges ?? [];
  assert(edges.length === 1, 'one upstream column edge accumulated');
  assert(edges[0]?.from_node === 'base_table', 'accumulated edge from_node is base_table');
  assert(edges[0]?.to_col === 'amount', 'accumulated edge to_col is amount');
  const state = engine.toJSON() as { nodeStates: Array<{ nodeId: string; action: string; reason: string; columns?: string[] }> };
  const baseState = state.nodeStates.find(s => s.nodeId === 'base_table');
  assert(baseState?.action === 'passthrough', 'CT upstream table gets pass lifecycle state');
  assert(baseState?.reason === 'non_bodied_passthrough', 'CT upstream table reason is non-bodied passthrough');
  assert(baseState?.columns?.includes('raw_amount') ?? false, 'CT upstream table lifecycle carries source column');
});

  it("Test 8a: a partially valid CT flow rejects atomically, then commits exactly once", () => {
  const engine = ctEngine(['amount', 'region']);
  const beforeReject = durableCtSnapshot(engine);
  const rejected = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'mixed flow' }],
    summary: 'mixed flow',
    verdict: 'analyze',
    column_flow: [
      { out_col: 'amount', upstream_columns: [{ node: 'base_table', col: 'raw_amount' }] },
      { out_col: 'region', upstream_columns: [{ node: 'base_table', col: 'wrong_col' }] },
    ],
  });
  assert('error' in rejected && rejected.error === 'contributor_col_not_on_source', 'CT partial invalid flow rejects');
  if ('error' in rejected) {
    const detail = 'detail' in rejected ? rejected.detail : undefined;
    const invalidContributor = Array.isArray(detail) ? detail[0] as { path?: string } : undefined;
    assertEq(invalidContributor?.path, 'column_flow.1.upstream_columns.0.col', 'CT rejection preserves the exact invalid column_flow path');
    assertEq(
      rejected.hint,
      'Set upstream_columns[].col to a real upstream column. Do not use literals, NULLs, parameters, generated values, or filter-only columns here; explain those in sections[].text, remove that upstream column, or use upstream_columns: [] when the active column terminates here.',
      'CT rejection preserves the existing corrective hint verbatim',
    );
    assert(!JSON.stringify(rejected).includes('mixed flow'), 'CT rejection excludes authored sections and summary');
  }
  assertEq(durableCtSnapshot(engine), beforeReject, 'CT rejection preserves all durable engine state');
  assert(engine.getHopDiagnostics().routedRejected > 0, 'CT rejection may update routed-rejection diagnostics');

  const accepted = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'corrected flow' }],
    summary: 'corrected flow',
    verdict: 'analyze',
    column_flow: [
      { out_col: 'amount', upstream_columns: [{ node: 'base_table', col: 'raw_amount' }] },
      { out_col: 'region', upstream_columns: [] },
    ],
  });
  assert('ok' in accepted && accepted.ok, 'corrected CT flow commits');
  const committed = engine.toJSON();
  assertEq(committed.columnAspect?.edges.length ?? -1, 1, 'corrected CT flow commits its edge once');
  assertEq(Object.keys(committed.memory.detailSlots).length, 1, 'corrected CT flow stores one detail slot');
  assertEq(committed.memory.verdictCounts.analyze, 1, 'corrected CT flow increments the verdict tally once');
  assertEq(committed.engineInternals?.lastHopColumnFlowEntries ?? -1, 2, 'corrected CT flow commits its entry count once');
  assertEq(committed.nodeStates.filter(state => state.nodeId === 'base_table').length, 1, 'corrected CT flow commits one source node state');
});

  it("tool set in toolPolicy.", () => {
  assert(activeModeOf(true) === 'sm_ct', 'activeModeOf(hasColumnAspect=true) === sm_ct');
  assert(activeModeOf(false) === 'sm_bb', 'activeModeOf(hasColumnAspect=false) === sm_bb');
});

  it("Test 10: supplementAgenda with CT — supplemented node inherits target_columns", () => {
  // Graph: origin_view (view) upstream of another view
  const secondView: LineageNode = makeNode({
    id: 'second_view',
    schema: 'dbo',
    name: 'second_view',
    type: 'view',
    columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }],
  });
  const n2: LineageNode[] = [originNode, baseTable, secondView];
  const e2: Array<[string, string]> = [['base_table', 'origin'], ['base_table', 'second_view']];
  const m2: DatabaseModel = makeModel(n2, e2, ['dbo']);
  const g2 = makeGraph(n2, e2);

  const engine = new NavigationEngine(m2, g2, () => {}, {});
  engine.init({ origin: 'origin', question: 'trace amount', direction: 'upstream', targetColumns: ['amount'] });

  // Drain the single hop (origin only — second_view is not upstream of origin in a strict BFS)
  engine.getHopContext();
  engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{
      out_col: 'amount',
      upstream_columns: [{ node: 'base_table', col: 'raw_amount' }],
    }],
  });
  // SM mode signals completion via getHopContext() draining the empty agenda
  const doneCtx = engine.getHopContext();
  assert(doneCtx.done === true, 'exploration completed (done=true)');

  // Supplement with second_view
  const suppResult = engine.supplementAgenda(['second_view']);
  assert('ok' in suppResult && suppResult.ok, 'supplementAgenda ok');

  // Advance to second_view hop and verify active_columns = target_columns
  engine.getHopContext();
  const r2 = engine.submitFindings({
    focus_node_id: 'second_view',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{
      out_col: 'amount',
      upstream_columns: [{ node: 'base_table', col: 'raw_amount' }],
    }],
  });
  // column_flow accepted confirms active_columns was set to ['amount'] from supplement
  assert(!('error' in r2 && r2.error === 'column_flow_required'), 'supplement node has column context (no column_flow_required)');
  const diag = engine.getHopDiagnostics();
  assert(diag.activeColumnCount === 1, 'supplemented node has activeColumnCount=1');
});

  it("are skipped by design.", () => {
  // validateColumnFlow() only ever reads model.neighborIndex (and only for 'procedure'-typed
  // upstream contributors, none of which appear in this test), so an empty makeModel() is a
  // sufficient fixture.
  const ctModel: DatabaseModel = makeModel([], [], ['dbo']);
  const tracer = new ColumnTracer(['TotalRevenue']);
  const nodeMap = new Map<string, any>([
    ['spwriter', { id: 'spwriter', type: 'procedure' }],
    ['facttable', { id: 'facttable', type: 'table', columns: [{ name: 'TotalRevenue' }] }],
    ['srcnode', { id: 'srcnode', type: 'table' }],
  ]);
  const writeTo = (col: string, node = 'facttable') => ({
    verdict: 'analyze' as const, summary: 's', sections: [],
    column_flow: [{
      out_col: 'TotalRevenue',
      writes_to: { node, col },
      upstream_columns: [{ node: 'srcnode', col: 'Rev' }],
    }],
  });

  const ok = tracer.validateColumnFlow('spwriter', writeTo('TotalRevenue') as any, nodeMap, ctModel, null);
  assertEq(ok.invalidRoutes.length, 0, 'WS2 valid writes_to.col: no rejection');
  assertEq(ok.stagedEdges.length, 1, 'WS2 valid writes_to.col: edge staged');
  assertEq(ok.stagedEdges[0].to_col, 'TotalRevenue', 'WS2 valid writes_to.col: to_col carried through');

  const empty = tracer.validateColumnFlow('spwriter', writeTo('') as any, nodeMap, ctModel, null);
  assert(empty.invalidRoutes.some(r => r.kind === 'bad_out_col'), 'WS2 empty writes_to.col → bad_out_col (no .min(1) needed)');
  assertEq(empty.stagedEdges.length, 0, 'WS2 empty writes_to.col: no empty edge staged');

  const wrong = tracer.validateColumnFlow('spwriter', writeTo('Nonexistent') as any, nodeMap, ctModel, null);
  assert(wrong.invalidRoutes.some(r => r.kind === 'bad_out_col'), 'WS2 wrong writes_to.col → bad_out_col');
  assertEq(wrong.stagedEdges.length, 0, 'WS2 wrong writes_to.col: no edge staged');

  const unknown = tracer.validateColumnFlow('spwriter', writeTo('TotalRevenue', 'ghosttable') as any, nodeMap, ctModel, null);
  assert(unknown.invalidRoutes.some(r => r.kind === 'absent_contributor'), 'WS2 unknown writes_to.node → absent_contributor');
  assertEq(unknown.stagedEdges.length, 0, 'WS2 unknown writes_to.node: no edge staged');
});

  it("from-node+col) is a content error (`self_loop_column`), never a valid rename/passthrough edge.", () => {
  // validateColumnFlow() only ever reads model.neighborIndex (and only for 'procedure'-typed
  // upstream contributors, none of which appear in this test), so an empty makeModel() is a
  // sufficient fixture.
  const ctModel: DatabaseModel = makeModel([], [], ['dbo']);
  const tracer = new ColumnTracer(['TotalRevenue']);
  const nodeMap = new Map<string, any>([
    ['spwriter', { id: 'spwriter', type: 'procedure' }],
    ['facttable', { id: 'facttable', type: 'table', columns: [{ name: 'TotalRevenue' }] }],
    ['srcnode', { id: 'srcnode', type: 'table' }],
  ]);

  // writes_to redirects to facttable.TotalRevenue, and one upstream contributor is ALSO
  // facttable.TotalRevenue — a self-loop alongside one legitimate contributor.
  const mixed = tracer.validateColumnFlow('spwriter', {
    verdict: 'analyze' as const, summary: 's', sections: [],
    column_flow: [{
      out_col: 'TotalRevenue',
      writes_to: { node: 'facttable', col: 'TotalRevenue' },
      upstream_columns: [
        { node: 'facttable', col: 'TotalRevenue' },
        { node: 'srcnode', col: 'Rev' },
      ],
    }],
  } as any, nodeMap, ctModel, null);
  assert(mixed.invalidRoutes.some(r => r.kind === 'self_loop_column'), 'WS5: self-loop upstream contributor rejected');
  assertEq(mixed.stagedEdges.length, 1, 'WS5: only the legitimate srcnode contributor is staged');
  assertEq(mixed.stagedEdges[0]?.from_node, 'srcnode', 'WS5: staged edge is the legitimate one, not the self-loop');
  const loopRoute = mixed.invalidRoutes.find(r => r.kind === 'self_loop_column');
  assert(!!loopRoute && loopRoute.reason.includes('facttable.TotalRevenue'), 'WS5: reason names the offending node.col');

  // A legitimate writes_to redirect (writer proc → a DIFFERENT target table) still stages cleanly
  // (regression guard — the new check must not false-positive on real writer-proc edges).
  const legit = tracer.validateColumnFlow('spwriter', {
    verdict: 'analyze' as const, summary: 's', sections: [],
    column_flow: [{
      out_col: 'TotalRevenue',
      writes_to: { node: 'facttable', col: 'TotalRevenue' },
      upstream_columns: [{ node: 'srcnode', col: 'Rev' }],
    }],
  } as any, nodeMap, ctModel, null);
  assertEq(legit.invalidRoutes.filter(r => r.kind === 'self_loop_column').length, 0, 'WS5: legitimate writes_to redirect is not flagged as self-loop');
  assertEq(legit.stagedEdges.length, 1, 'WS5: legitimate writes_to redirect still stages its edge');

  // writes_to omitted (defaults to focus) with an upstream contributor equal to the focus itself —
  // a node can't be its own upstream for the same column either; the same check catches it.
  const selfFocus = tracer.validateColumnFlow('facttable', {
    verdict: 'analyze' as const, summary: 's', sections: [],
    column_flow: [{
      out_col: 'TotalRevenue',
      upstream_columns: [{ node: 'facttable', col: 'TotalRevenue' }],
    }],
  } as any, nodeMap, ctModel, null);
  assert(selfFocus.invalidRoutes.some(r => r.kind === 'self_loop_column'), 'WS5: upstream == focus with same column (writes_to omitted) is also a self-loop');
  assertEq(selfFocus.stagedEdges.length, 0, 'WS5: no edge staged for the focus self-loop');
});

  it("WS6: self-loop rejected through the full engine submit path — session left unmutated", () => {
  const engine = ctEngine(['amount']);
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'origin', col: 'amount' }] }],
  });
  assert('error' in result && result.error === 'column_self_loop', 'engine: self-loop column_flow rejected as column_self_loop');
  if ('error' in result) {
    const hint = result.hint ?? '';
    assert(/writes_to/i.test(hint) && /identical/i.test(hint), 'engine: hint names the corrective action (writes_to / omit)');
    assert(!/prune_neighbors/i.test(hint), 'engine: hint is CT-only, no BB prune vocabulary leaks in');
    const detail = JSON.stringify('detail' in result ? result.detail : '');
    assert(detail.includes('origin'), 'engine: detail names the offending node');
  }
  assertEq(engine.columnAspect?.edges.length ?? -1, 0, 'engine: no edge staged for the rejected self-loop submission — session left unmutated');
});

  it("SQL mechanics live in sections[].text; every upstream real column edge is eligible for continuation.", () => {
  // validateColumnFlow() only ever reads model.neighborIndex (and only for 'procedure'-typed
  // upstream contributors, none of which appear in this test), so an empty makeModel() is a
  // sufficient fixture.
  const ctModel: DatabaseModel = makeModel([], [], ['dbo']);
  const tracer = new ColumnTracer(['TargetCol']);
  const nodeMap = new Map<string, any>([
    ['focusview', { id: 'focusview', type: 'view' }],
    ['valuesrc', { id: 'valuesrc', type: 'table' }],
    ['filtersrc', { id: 'filtersrc', type: 'table' }],
  ]);
  const finding = {
    verdict: 'analyze' as const, summary: 's', sections: [],
    column_flow: [{
      out_col: 'TargetCol',
      upstream_columns: [
        { node: 'valuesrc', col: 'RealInput' },
        { node: 'filtersrc', col: 'FilterCol' },
      ],
    }],
  };
  const res = tracer.validateColumnFlow('focusview', finding as any, nodeMap, ctModel, null);
  assertEq(res.stagedEdges.length, 2, 'WS4a: both real upstream column edges are staged');
  for (const e of res.stagedEdges) e.hop = 1;
  tracer.state.edges.push(...res.stagedEdges);

  const questions = Array.from(tracer.getColumnLineageQuestionsByNode('focusview', 1).values()).flat();
  assertEq(questions.length, 2, 'WS4a: every real upstream column edge spawns a continuation question');
  assert(questions.some(q => q.includes('valuesrc')) && questions.some(q => q.includes('filtersrc')), 'WS4a: both upstream nodes are represented');
});

  it("false-reject as bad_out_col. Strictly additive: unbracketed names behaved identically before.", () => {
  const ctModel: DatabaseModel = {
    schemas: new Set(['dbo']), objectMap: new Map(), nodes: [], edges: [], neighborIndex: {}, dbPlatform: 'SQL Server',
  } as any;
  const tracer = new ColumnTracer(['amount']); // active = ['amount']
  const nodeMap = new Map<string, any>([
    ['origin', { id: 'origin', type: 'view', columns: [{ name: 'amount' }] }],
    ['src', { id: 'src', type: 'table', columns: [{ name: 'raw' }] }],
  ]);
  const finding = {
    verdict: 'analyze' as const, summary: 's', sections: [],
    column_flow: [{ out_col: '[amount]', upstream_columns: [{ node: 'src', col: '[raw]' }] }],
  };
  const res = tracer.validateColumnFlow('origin', finding as any, nodeMap, ctModel, null);
  assertEq(res.invalidRoutes.length, 0, 'Part A: bracketed [amount]/[raw] match DDL via normalizeColName (no false bad_out_col)');
  assertEq(res.stagedEdges.length, 1, 'Part A: bracketed names still stage the edge');
});

  it("through a non-bodied passthrough, so siblings can't leak downstream.", () => {
  const tracer = new ColumnTracer(['TotalRevenue']);
  // A prior bodied hop declared UnitPrice ← pricemaster.ListPrice → edge with from_node=pricemaster.
  tracer.state.edges.push({ hop: 1, hop_node: 'vwpricelist', to_node: 'vwpricelist', to_col: 'UnitPrice', from_node: 'pricemaster', from_col: 'ListPrice' });
  // The model over-declared pricemaster's route columns; only ListPrice is on the tracked spine.
  const bounded = tracer.determineActiveColumnsForCandidate('pricemaster', ['ListPrice', 'EffectiveFrom', 'RegionCode']);
  assertEq(bounded.length, 1, 'Part B: over-declared siblings dropped to the on-trace spine');
  assert(bounded[0]?.toLowerCase() === 'listprice', 'Part B: the on-trace ListPrice is kept');
  // Bracketed entry still intersects (Part A normalization inside the bound).
  const boundedBr = tracer.determineActiveColumnsForCandidate('pricemaster', ['[ListPrice]', 'RegionCode']);
  assertEq(boundedBr.length, 1, 'Part B+A: bracketed [ListPrice] matches the unbracketed spine');
});

  const ctForwardNodes: LineageNode[] = [
    makeNode({ id: 'ct_origin', schema: 'dbo', name: 'ct_origin', type: 'view', columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }] }),
    makeNode({ id: 'ct_down', schema: 'dbo', name: 'ct_down', type: 'view', columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }] }),
  ];
  const ctForwardEdges: Array<[string, string]> = [['ct_origin', 'ct_down']];
  const ctForwardModel: DatabaseModel = makeModel(ctForwardNodes, ctForwardEdges, ['dbo']);
  const ctForwardGraph = makeGraph(ctForwardNodes, ctForwardEdges);
  function ctForwardRoutedEngine(log: LogFn = () => {}) {
    const engine = new NavigationEngine(ctForwardModel, ctForwardGraph, log, {});
    const init = engine.init({ origin: 'ct_origin', question: 'trace amount downstream', direction: 'downstream', analysisMode: 'ct', targetColumns: ['amount'] });
    assert('ok' in init, 'Defect B: downstream CT session initializes');
    engine.getHopContext();
    const result = engine.submitFindings({
      focus_node_id: 'ct_origin',
      sections: [{ angle: 'business' as const, text: 'origin analysis' }],
      summary: 'ok',
      verdict: 'analyze',
      column_flow: [{ out_col: 'amount', upstream_columns: [] }],
      route_requests: [{ nodeId: 'ct_down', question: 'Does ct_down forward amount unchanged?' }],
    });
    assert(!('error' in result), 'Defect B: route to a bodied downstream neighbor with no column_flow back-reference is accepted');
    return engine;
  }
  it("Test 1: toJSON() succeeds; the routed agenda entry's activeColumns == tracer targetColumns", () => {
  const engine = ctForwardRoutedEngine();
  let snapshot: ReturnType<NavigationEngine['toJSON']> | undefined;
  let threw = false;
  try {
    snapshot = engine.toJSON();
  } catch {
    threw = true;
  }
  assert(!threw, 'Defect B: toJSON() succeeds after routing a CT neighbor with columns omitted (was issuePaths=[agenda.0.activeColumns])');
  const downEntry = snapshot?.agenda.find(e => e.nodeId === 'ct_down');
  assert(!!downEntry, 'Defect B: ct_down was enqueued');
  assert(!!downEntry?.activeColumns?.length, 'Defect B: ct_down agenda entry carries a non-empty activeColumns projection');
  assertEq(
    JSON.stringify(downEntry?.activeColumns),
    JSON.stringify(engine.columnAspect?.target_columns),
    'Defect B: the projected activeColumns equal the tracer targetColumns fallback',
  );
});

  it("a BB snapshot with any agenda activeColumns still REJECTS (regression pin, mirrors Test 3c)", () => {
  const engine = ctForwardRoutedEngine();
  const ctSnapshot = engine.toJSON();
  const restored = NavigationEngine.fromJSON(JSON.parse(JSON.stringify(ctSnapshot)), ctForwardModel, ctForwardGraph, () => {});
  assert(JSON.stringify(restored.toJSON()) === JSON.stringify(ctSnapshot), 'Defect B: CT checkpoint with a fallback-projected agenda entry round-trips without loss');

  const bbEngine = new NavigationEngine(ctForwardModel, ctForwardGraph, () => {}, {});
  bbEngine.init({ origin: 'ct_origin', question: 'bb baseline', direction: 'downstream' });
  const bbSnapshot = JSON.parse(JSON.stringify(bbEngine.toJSON())) as { agenda: Array<{ activeColumns?: string[] }> };
  assert(bbSnapshot.agenda.length > 0, 'Defect B: BB baseline seeds at least one agenda entry to corrupt');
  bbSnapshot.agenda[0].activeColumns = ['not_allowed_in_bb'];
  let bbRejected = false;
  try {
    NavigationEngine.fromJSON(bbSnapshot, ctForwardModel, ctForwardGraph, () => {});
  } catch {
    bbRejected = true;
  }
  assert(bbRejected, 'Defect B: a BB snapshot carrying agenda activeColumns still rejects (BB superRefine untouched)');
});

  it("throw path (toJSON()'s own catch) logs the issuePaths diagnostic, not just the generic message", () => {
  const logs: string[] = [];
  const engine = ctForwardRoutedEngine((_level, message) => logs.push(message));
  // Directly corrupt the live agenda entry the fix just protected, bypassing enqueueHop entirely —
  // proves the checkpoint boundary (not just the enqueue-time fallback) still enforces the CT
  // invariant, and exercises toJSON()'s own catch/log path for any future write that reintroduces it.
  const rawEntries = (engine as unknown as { _agenda: { entries: Array<{ nodeId: string; activeColumns?: string[] }> } })._agenda.entries;
  const downEntry = rawEntries.find(e => e.nodeId === 'ct_down');
  assert(!!downEntry, 'Defect B: ct_down agenda entry exists to corrupt');

  if (downEntry) downEntry.activeColumns = undefined;
  let threwUndefined = false;
  try { engine.toJSON(); } catch { threwUndefined = true; }
  assert(threwUndefined, 'Defect B: CT agenda entry with activeColumns=undefined still rejects at toJSON()');

  if (downEntry) downEntry.activeColumns = [];
  let threwEmpty = false;
  try { engine.toJSON(); } catch { threwEmpty = true; }
  assert(threwEmpty, 'Defect B: CT agenda entry with activeColumns=[] still rejects at toJSON() (NonEmptyStrings.min(1))');

  assert(
    logs.some(m => m.includes('[Checkpoint] serialize rejected') && m.includes('agenda') && m.includes('activeColumns')),
    'Defect B: toJSON() rejection logs the issuePaths diagnostic (not just the generic InvalidEngineCheckpointError message)',
  );
});

  // J16-1: <lineage_questions> must reach the AgendaEntry they were opened for, never whichever
  // node happens to dequeue next, and must be labelled by the column active at that node.
  const lqNodes: LineageNode[] = [
    makeNode({ id: 'lq_origin', schema: 'dbo', name: 'lq_origin', type: 'view', columns: [{ name: 'TargetCol', type: 'int', nullable: 'NOT NULL', extra: '' }] }),
    makeNode({ id: 'lq_node_a', schema: 'dbo', name: 'lq_node_a', type: 'view', columns: [{ name: 'ColA', type: 'int', nullable: 'NOT NULL', extra: '' }] }),
    makeNode({ id: 'lq_node_b', schema: 'dbo', name: 'lq_node_b', type: 'view', columns: [{ name: 'ColB', type: 'int', nullable: 'NOT NULL', extra: '' }] }),
  ];
  const lqEdges: Array<[string, string]> = [['lq_node_a', 'lq_origin'], ['lq_node_b', 'lq_origin']];
  const lqModel: DatabaseModel = makeModel(lqNodes, lqEdges, ['dbo']);
  const lqGraph = makeGraph(lqNodes, lqEdges);
  function lqRoutedEngine() {
    const engine = new NavigationEngine(lqModel, lqGraph, () => {}, {});
    const init = engine.init({ origin: 'lq_origin', question: 'trace TargetCol upstream', direction: 'upstream', analysisMode: 'ct', targetColumns: ['TargetCol'] });
    assert('ok' in init, 'J16-1: upstream CT session initializes');
    engine.getHopContext();
    const result = engine.submitFindings({
      focus_node_id: 'lq_origin',
      sections: [{ angle: 'business' as const, text: 'origin analysis' }],
      summary: 'ok',
      verdict: 'analyze',
      column_flow: [{
        out_col: 'TargetCol',
        upstream_columns: [
          { node: 'lq_node_a', col: 'ColA' },
          { node: 'lq_node_b', col: 'ColB' },
        ],
      }],
      route_requests: [
        { nodeId: 'lq_node_a', question: 'Does lq_node_a compute ColA directly?' },
        { nodeId: 'lq_node_b', question: 'Does lq_node_b compute ColB directly?' },
      ],
    });
    assert(!('error' in result), 'J16-1: routing two real upstream column contributors is accepted');
    return engine;
  }

  it("J16-1: lineage questions reach the hop for the node they were routed to, not the next dequeued node", () => {
  const engine = lqRoutedEngine();

  const firstHop = engine.getHopContext() as { done?: boolean };
  assert(!firstHop.done, 'J16-1: a second hop is dispatched');
  const firstFocus = engine.currentFocus;
  assert(firstFocus === 'lq_node_a' || firstFocus === 'lq_node_b', 'J16-1: dispatch lands on one of the two routed nodes');
  const otherNode = firstFocus === 'lq_node_a' ? 'lq_node_b' : 'lq_node_a';
  const ownCol = firstFocus === 'lq_node_a' ? 'ColA' : 'ColB';
  const otherCol = firstFocus === 'lq_node_a' ? 'ColB' : 'ColA';

  const firstQuestions = engine.pendingLineageQuestions;
  assertEq(firstQuestions.length, 1, `J16-1: ${firstFocus} sees exactly its own continuation, not both`);
  assert(firstQuestions[0].includes(ownCol), `J16-1: ${firstFocus}'s question names its own column ${ownCol}`);
  assert(!firstQuestions[0].includes(otherCol), `J16-1: ${firstFocus}'s question does not name the other node's column ${otherCol}`);
  assert(firstQuestions[0].includes('TargetCol'), 'J16-1: question names the column it continues the trace into (label uses the traced column)');

  // Terminal submission at the first-dequeued node — accounts for its sole active column.
  const firstResult = engine.submitFindings({
    focus_node_id: firstFocus!,
    sections: [{ angle: 'business' as const, text: 'terminal' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{ out_col: ownCol, upstream_columns: [] }],
  });
  assert(!('error' in firstResult), `J16-1: terminal submission at ${firstFocus} is accepted`);

  const secondHop = engine.getHopContext() as { done?: boolean };
  assert(!secondHop.done, 'J16-1: the second routed node still dispatches');
  assertEq(engine.currentFocus, otherNode, 'J16-1: the remaining routed node dequeues next');

  const secondQuestions = engine.pendingLineageQuestions;
  assertEq(secondQuestions.length, 1, `J16-1: ${otherNode} sees exactly its own continuation`);
  assert(secondQuestions[0].includes(otherCol), `J16-1: ${otherNode}'s question names its own column ${otherCol}`);
  assert(!secondQuestions[0].includes(ownCol), `J16-1: ${otherNode}'s question does not carry over ${firstFocus}'s column`);
});

  it("J16-1: no pending lineage questions renders no <lineage_questions> block", () => {
  const withQuestions = buildCurrentTaskBlock(
    [{ kind: 'root', question: 'Trace TargetCol' }],
    ['TargetCol'],
    ['Column `ColA` at `lq_node_a`: continues the trace into `TargetCol` at `lq_origin` — determine its origin here.'],
  );
  assert(withQuestions.includes('<lineage_questions>'), 'J16-1: a non-empty list renders the block');

  const noneUndefined = buildCurrentTaskBlock([{ kind: 'root', question: 'Trace TargetCol' }], ['TargetCol'], undefined);
  assert(!noneUndefined.includes('<lineage_questions>'), 'J16-1: an omitted list renders no block');

  const noneEmpty = buildCurrentTaskBlock([{ kind: 'root', question: 'Trace TargetCol' }], ['TargetCol'], []);
  assert(!noneEmpty.includes('<lineage_questions>'), 'J16-1: an empty list renders no block');
});
});

describe("J23 — CT active columns through contracted tables (red reproductions)", () => {
  // T8-shaped fixture: a view (origin_view) fed by a table (staging, contracted — non-bodied) and a
  // second table (rules). staging has both an upstream WRITER (writer_proc, the true source of
  // staging.OrderAmount) and an unrelated downstream READER (reader_proc, which consumes staging and
  // writes archive). Because `directionalNeighbors` under `direction: 'bidirectional'` returns
  // `graph.neighbors()` — every adjacent node regardless of edge direction — `enqueueHop`'s non-bodied
  // contraction branch (smBase.ts `enqueueHop`, the `directionalNeighbors(targetId, this._direction)`
  // loop) forwards staging's active columns to writer_proc AND reader_proc alike, with no data-flow
  // direction test. The reproductions below pin that leak at three observation points: the dispatched
  // hop's live active columns (RC1/RC2), the durable `toJSON()` agenda snapshot (RC3), the resulting
  // `column_chain_incomplete` hint (RC4), and the isolated `ColumnTracer` unit (RC5).
  const j23Nodes: LineageNode[] = [
    makeNode({
      id: 'origin_view', schema: 'ai', name: 'origin_view', type: 'view',
      columns: [
        { name: 'Discount', type: 'decimal(5,2)', nullable: 'NOT NULL', extra: '' },
        { name: 'BaseAmt', type: 'decimal(18,2)', nullable: 'NOT NULL', extra: '' },
      ],
    }),
    makeNode({
      id: 'staging', schema: 'ai', name: 'staging', type: 'table',
      columns: [
        { name: 'OrderAmount', type: 'decimal(18,2)', nullable: 'NOT NULL', extra: '' },
        { name: 'OrderDate', type: 'date', nullable: 'NOT NULL', extra: '' },
      ],
    }),
    makeNode({ id: 'writer_proc', schema: 'ai', name: 'writer_proc', type: 'procedure', columns: [] }),
    makeNode({ id: 'reader_proc', schema: 'ai', name: 'reader_proc', type: 'procedure', columns: [] }),
    makeNode({
      id: 'archive', schema: 'ai', name: 'archive', type: 'table',
      columns: [{ name: 'OrderAmount', type: 'decimal(18,2)', nullable: 'NOT NULL', extra: '' }],
    }),
    makeNode({
      id: 'rules', schema: 'ai', name: 'rules', type: 'table',
      columns: [{ name: 'DiscountPct', type: 'decimal(5,2)', nullable: 'NOT NULL', extra: '' }],
    }),
    makeNode({ id: 'consumer_proc', schema: 'ai', name: 'consumer_proc', type: 'procedure', columns: [] }),
  ];
  const j23Edges: Array<[string, string]> = [
    ['staging', 'origin_view'],
    ['rules', 'origin_view'],
    ['writer_proc', 'staging'],
    ['staging', 'reader_proc'],
    ['reader_proc', 'archive'],
    ['origin_view', 'consumer_proc'],
  ];
  const j23Model: DatabaseModel = makeModel(j23Nodes, j23Edges, ['ai']);
  const j23Graph = makeGraph(j23Nodes, j23Edges);

  /**
   * Builds a fresh engine, dispatches origin_view, and commits its column_flow (Discount ←
   * staging.OrderAmount + rules.DiscountPct) with route_requests to all three direct neighbors.
   * Fresh per test — no cross-test state coupling.
   */
  function j23OriginCommittedEngine(): NavigationEngine {
    const engine = new NavigationEngine(j23Model, j23Graph, () => {}, {});
    const init = engine.init({ origin: 'origin_view', question: 'trace', direction: 'bidirectional', targetColumns: ['Discount'] });
    assert('ok' in init, 'J23: CT session initializes at origin_view');
    const hop = engine.getHopContext() as { done?: boolean };
    assert(!hop.done && engine.currentFocus === 'origin_view', 'J23: first dispatched hop is origin_view');
    const result = engine.submitFindings({
      focus_node_id: 'origin_view',
      sections: [{ angle: 'business' as const, text: 'Discount is computed from staging.OrderAmount and rules.DiscountPct' }],
      summary: 'ok',
      verdict: 'analyze',
      column_flow: [{
        out_col: 'Discount',
        upstream_columns: [
          { node: 'staging', col: 'OrderAmount' },
          { node: 'rules', col: 'DiscountPct' },
        ],
      }],
      route_requests: [
        { nodeId: 'staging', question: 'Trace OrderAmount as upstream input for Discount.' },
        { nodeId: 'rules', question: 'Trace DiscountPct as upstream input for Discount.' },
        { nodeId: 'consumer_proc', question: 'Does consumer_proc consume Discount unchanged?' },
      ],
    });
    assert(!('error' in result), `J23: origin_view commit accepted (${'error' in result ? result.error : ''})`);
    return engine;
  }

  /** Terminal submission covering every column the engine reports active at the current focus. */
  function j23TerminalSubmit(engine: NavigationEngine, focusId: string) {
    const cols = engine.columnAspect?.active_columns ?? [];
    return engine.submitFindings({
      focus_node_id: focusId,
      sections: [{ angle: 'business' as const, text: 'terminal' }],
      summary: 'ok',
      verdict: 'passthrough',
      column_flow: cols.map((c) => ({ out_col: c, upstream_columns: [] })),
    });
  }

  /** Drives `getHopContext()` forward, terminal-submitting any hop that is not `targetId`. */
  function j23DispatchUntil(engine: NavigationEngine, targetId: string, maxHops = 6): void {
    for (let i = 0; i < maxHops; i++) {
      const hop = engine.getHopContext() as { done?: boolean };
      assert(!hop.done, `J23: exploration completed before reaching ${targetId}`);
      if (engine.currentFocus === targetId) return;
      const focusId = engine.currentFocus!;
      const submitted = j23TerminalSubmit(engine, focusId);
      assert(!('error' in submitted), `J23: terminal submission at ${focusId} accepted while routing to ${targetId} (${'error' in submitted ? submitted.error : ''})`);
    }
    throw new Error(`J23: ${targetId} not reached within ${maxHops} hops`);
  }

  it("RC1: writer_proc — the true upstream producer of staging.OrderAmount — must dispatch with exactly ['OrderAmount'], not the seed target plus the routed column", () => {
    const engine = j23OriginCommittedEngine();
    j23DispatchUntil(engine, 'writer_proc');
    const active = [...(engine.columnAspect?.active_columns ?? [])].sort();
    assertEq(
      active.join(','),
      'OrderAmount',
      `J23 RC1: writer_proc's dispatched active_columns must equal exactly ['OrderAmount'] — today it also carries 'Discount', forwarded at seed time (init()'s seedAgenda walks origin_view's bidirectional neighbors before any column_flow exists) through staging's non-bodied contraction, then merged (AgendaManager.push unions activeColumns) with the later real 'OrderAmount' route`,
    );
  });

  /**
   * Contract: the `enqueueHop` non-bodied contraction bound ({@link NavigationEngine.resolveActiveColumnsForNode})
   * stops a seed-time or route-admission contraction at any carrier that does not declare the
   * routed column, so neither `writer_proc` nor `reader_proc` inherits `Discount` en route to
   * their own `OrderAmount` agenda entry.
   */
  it("RC2: the origin-resolved target column no longer leaks through the carrier's SEED-time contraction (writer_proc, pure-inbound chain) — symmetric with its later route-admission (reader_proc, contraction-extension)", () => {
    // Stage 1 — immediately after init()+one getHopContext() (origin_view dispatched), BEFORE any
    // column_flow has run: staging (the carrier) never declares 'Discount', so the seed-time
    // contraction stops at staging and neither sibling gets an entry yet.
    const engine = new NavigationEngine(j23Model, j23Graph, () => {}, {});
    const init = engine.init({ origin: 'origin_view', question: 'trace', direction: 'bidirectional', targetColumns: ['Discount'] });
    assert('ok' in init, 'J23 RC2: CT session initializes at origin_view');
    const firstHop = engine.getHopContext() as { done?: boolean };
    assert(!firstHop.done && engine.currentFocus === 'origin_view', 'J23 RC2: first dispatched hop is origin_view');

    const seedSnap = engine.toJSON() as { agenda: Array<{ nodeId: string; activeColumns?: string[] }> };
    const seedWriter = seedSnap.agenda.find((e) => e.nodeId === 'writer_proc');
    const seedReader = seedSnap.agenda.find((e) => e.nodeId === 'reader_proc');
    // GREEN: writer_proc is on the pure-inbound BFS chain, but the carrier-bounded contraction at
    // staging (which never declares 'Discount') stops before recursing to any bodied neighbour —
    // no seed-time entry, the same outcome as reader_proc below, not a leaked one.
    assert(
      seedWriter === undefined,
      `J23 RC2 stage 1: writer_proc has no seed-time agenda entry (found: ${JSON.stringify(seedWriter)}) — the carrier-bounded contraction at 'staging' stops before it, since 'staging' never declares 'Discount'`,
    );
    // GREEN (documentary): reader_proc sits on a mixed in-then-out path relative to
    // origin_view, so computeBfsScope's inbound/outbound split never reaches it — it has no
    // seed-time entry to leak into at all, confirmed here rather than assumed.
    assert(
      seedReader === undefined,
      `J23 RC2 stage 1 (documented, green): reader_proc has no seed-time agenda entry (found: ${JSON.stringify(seedReader)}) — it is outside the initial bidirectional BFS scope until routed`,
    );

    // Stage 2 — commit origin_view's column_flow naming staging.OrderAmount as the sole real
    // upstream contributor to Discount (route_requests omitted: routeQuestionsByNode auto-adds
    // staging from the upstream_columns reference, which contracts through to both writer_proc and
    // reader_proc, both newly admitted).
    const commit = engine.submitFindings({
      focus_node_id: 'origin_view',
      sections: [{ angle: 'business' as const, text: 'Discount is computed from staging.OrderAmount' }],
      summary: 'ok',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Discount', upstream_columns: [{ node: 'staging', col: 'OrderAmount' }] }],
    });
    assert(!('error' in commit), `J23 RC2 stage 2: origin_view commit accepted (${'error' in commit ? commit.error : ''})`);

    const routedSnap = engine.toJSON() as { agenda: Array<{ nodeId: string; activeColumns?: string[] }> };
    const routedWriter = routedSnap.agenda.find((e) => e.nodeId === 'writer_proc');
    const routedReader = routedSnap.agenda.find((e) => e.nodeId === 'reader_proc');
    assertEq(
      [...(routedWriter?.activeColumns ?? [])].sort().join(','),
      'OrderAmount',
      `J23 RC2 stage 2b (GREEN, mirrors 2c): writer_proc's activeColumns after the staging.OrderAmount route must deep-equal ['OrderAmount'] — actual: [${(routedWriter?.activeColumns ?? []).join(',')}]`,
    );
    assertEq(
      [...(routedReader?.activeColumns ?? [])].sort().join(','),
      'OrderAmount',
      `J23 RC2 stage 2c (GREEN control, pins the asymmetry): reader_proc's freshly route-admitted activeColumns already deep-equal ['OrderAmount'] — no prior seed entry existed to merge a leaked 'Discount' into; actual: [${(routedReader?.activeColumns ?? []).join(',')}]`,
    );

    // Stage 3 — dispatch reader_proc (terminal-submitting writer_proc first if it dequeues ahead,
    // since both tie at priority=2) and submit its sole legitimate column, OrderAmount. GREEN
    // control: reader_proc's clean active-column set (stage 2c) fully accounts for the hop.
    j23DispatchUntil(engine, 'reader_proc');
    const readerResult = engine.submitFindings({
      focus_node_id: 'reader_proc',
      sections: [{ angle: 'business' as const, text: 'reader_proc forwards staging.OrderAmount into archive' }],
      summary: 'ok',
      verdict: 'passthrough',
      column_flow: [{ out_col: 'OrderAmount', upstream_columns: [] }],
    });
    assert(
      !('error' in readerResult),
      `J23 RC2 stage 3 (GREEN control): reader_proc submitting only its legitimate OrderAmount contribution is accepted, not rejected — actual: ${'error' in readerResult ? `${readerResult.error}: ${readerResult.hint ?? ''}` : 'ok'}`,
    );
  });

  it("green pin: a carrier-adjacent node with no declared columns array forwards the candidate active-column set unchanged (existence exemption preserved, not itself a defect)", () => {
    const engine = new NavigationEngine(j23Model, j23Graph, () => {}, {});
    engine.init({ origin: 'origin_view', question: 'trace', direction: 'bidirectional', targetColumns: ['Discount'] });
    // resolveActiveColumnsForNode has no public accessor; this test exercises it directly, not through a dispatched hop.
    const resolved = (engine as unknown as {
      resolveActiveColumnsForNode(nodeId: string, columns?: string[]): string[] | undefined;
    }).resolveActiveColumnsForNode('writer_proc', ['Discount', 'OrderAmount']);
    assertEq(
      [...(resolved ?? [])].sort().join(','),
      ['Discount', 'OrderAmount'].sort().join(','),
      "J23 green pin: writer_proc declares no columns (columns: []), so resolveActiveColumnsForNode's existence exemption ('if (nodeColumns.length === 0) return columns' — smBase.ts) must forward the candidate set unchanged rather than filtering it to empty. This is deliberate (a procedure may write columns elsewhere with no local column surface to filter against) and must survive any fix to the RC2 seed-time Discount leak — the fix belongs in what gets forwarded (seedAgenda/enqueueHop), not in this exemption.",
    );
  });

  it("RC4: writer_proc rejects with column_chain_incomplete when a routed column is left unaccounted, and rejects again on resubmission of the same escape", () => {
    // A1a's dispatch-scope fix pins writer_proc to exactly its routed contributor columns
    // (RC1/RC2), so the single-target 'Discount' commit j23OriginCommittedEngine() performs no
    // longer leaves anything unaccounted at writer_proc — that premise moved elsewhere. Re-based on
    // a second origin target column: Discount routes through staging.OrderAmount and BaseAmt routes
    // through staging.OrderDate, so `routeColumnsByNode` (smBase.ts) forwards both staging columns
    // through the contraction, and writer_proc — declaring no columns of its own, forwarded
    // unfiltered by the existence exemption (green pin) — dispatches with both. Submitting only one
    // reproduces a genuine column_chain_incomplete here, independent of the RC1/RC2 leak.
    const engine = new NavigationEngine(j23Model, j23Graph, () => {}, {});
    const init = engine.init({ origin: 'origin_view', question: 'trace', direction: 'bidirectional', targetColumns: ['Discount', 'BaseAmt'] });
    assert('ok' in init, 'J23 RC4: CT session initializes at origin_view');
    const hop = engine.getHopContext() as { done?: boolean };
    assert(!hop.done && engine.currentFocus === 'origin_view', 'J23 RC4: first dispatched hop is origin_view');
    const originCommit = engine.submitFindings({
      focus_node_id: 'origin_view',
      sections: [{ angle: 'business' as const, text: 'Discount and BaseAmt both derive from staging' }],
      summary: 'ok',
      verdict: 'analyze',
      column_flow: [
        { out_col: 'Discount', upstream_columns: [{ node: 'staging', col: 'OrderAmount' }] },
        { out_col: 'BaseAmt', upstream_columns: [{ node: 'staging', col: 'OrderDate' }] },
      ],
    });
    assert(!('error' in originCommit), `J23 RC4: origin_view commit accepted (${'error' in originCommit ? originCommit.error : ''})`);
    j23DispatchUntil(engine, 'writer_proc');
    assertEq(
      [...(engine.columnAspect?.active_columns ?? [])].sort().join(','),
      ['OrderAmount', 'OrderDate'].sort().join(','),
      'J23 RC4: writer_proc dispatches with both routed columns (OrderAmount, OrderDate) — the genuine premise for this rejection',
    );

    const result = engine.submitFindings({
      focus_node_id: 'writer_proc',
      sections: [{ angle: 'business' as const, text: 'writer_proc produces staging.OrderAmount' }],
      summary: 'ok',
      verdict: 'passthrough',
      column_flow: [{ out_col: 'OrderAmount', upstream_columns: [] }],
    });
    assert('error' in result && result.error === 'column_chain_incomplete', 'J23 RC4: OrderDate left unaccounted at writer_proc → column_chain_incomplete (genuine premise)');

    // Loop proof (NOT red — documents the resulting stall, not a fixed contract): resubmitting the
    // hint's own literal suggestion returns the identical rejection.
    const again = engine.submitFindings({
      focus_node_id: 'writer_proc',
      sections: [],
      summary: 'ok',
      verdict: 'passthrough',
      column_flow: [],
    });
    assert(
      'error' in again && again.error === 'column_chain_incomplete',
      "J23 RC4 (loop proof, passes today): resubmitting verdict:'passthrough', column_flow:[] at writer_proc returns column_chain_incomplete again — the hint's literal suggested escape does not resolve the hop",
    );
  });

  /** Held: the column_chain_incomplete hint at writer_proc must name pruning the leaked column, not repeat the rejected escape. */
  it.skip("RC4: the column_chain_incomplete hint at writer_proc must name pruning the leaked column, not repeat the escape it just rejected — held: hint rewrite pending replay (OPEN-ISSUES row 2)", () => {
    const engine = new NavigationEngine(j23Model, j23Graph, () => {}, {});
    const init = engine.init({ origin: 'origin_view', question: 'trace', direction: 'bidirectional', targetColumns: ['Discount', 'BaseAmt'] });
    assert('ok' in init, 'J23 RC4: CT session initializes at origin_view');
    const hop = engine.getHopContext() as { done?: boolean };
    assert(!hop.done && engine.currentFocus === 'origin_view', 'J23 RC4: first dispatched hop is origin_view');
    const originCommit = engine.submitFindings({
      focus_node_id: 'origin_view',
      sections: [{ angle: 'business' as const, text: 'Discount and BaseAmt both derive from staging' }],
      summary: 'ok',
      verdict: 'analyze',
      column_flow: [
        { out_col: 'Discount', upstream_columns: [{ node: 'staging', col: 'OrderAmount' }] },
        { out_col: 'BaseAmt', upstream_columns: [{ node: 'staging', col: 'OrderDate' }] },
      ],
    });
    assert(!('error' in originCommit), `J23 RC4: origin_view commit accepted (${'error' in originCommit ? originCommit.error : ''})`);
    j23DispatchUntil(engine, 'writer_proc');

    const result = engine.submitFindings({
      focus_node_id: 'writer_proc',
      sections: [{ angle: 'business' as const, text: 'writer_proc produces staging.OrderAmount' }],
      summary: 'ok',
      verdict: 'passthrough',
      column_flow: [{ out_col: 'OrderAmount', upstream_columns: [] }],
    });
    assert('error' in result && result.error === 'column_chain_incomplete', 'J23 RC4: OrderDate left unaccounted at writer_proc → column_chain_incomplete (genuine premise)');
    if ('error' in result) {
      const hint = result.hint ?? '';
      assert(
        /prune/i.test(hint),
        `J23 RC4: the hint must name pruning the spurious leaked 'OrderDate' as the corrective action — actual hint: "${hint}"`,
      );
      assert(
        !/column_flow:\s*\[\]/.test(hint),
        `J23 RC4: the hint must not re-suggest 'column_flow:[]' — that exact retry was already submitted this hop (Test 3's own "no self-prune" contract) and would reject again with the identical error, looping — actual hint: "${hint}"`,
      );
    }
  });

  it("RC5: ColumnTracer.determineActiveColumnsForCandidate cannot tell a genuine upstream producer from an unrelated contracted neighbor when neither has a recorded edge of its own — inert by design, the enqueueHop contraction bound never lets its unfiltered output reach an agenda entry unbounded", () => {
    const tracer = new ColumnTracer(['Discount']);
    tracer.edges.push({
      hop: 1, hop_node: 'origin_view', to_node: 'origin_view', to_col: 'Discount',
      from_node: 'staging', from_col: 'OrderAmount',
    });

    // Contract: a candidate with no edge of its own falls through to the unfiltered entryColumns by design; bounding that output is `resolveActiveColumnsForNode`'s job at the enqueueHop/contractThroughPassNode call sites, not this function's.
    const writerCols = tracer.determineActiveColumnsForCandidate('writer_proc', ['Discount', 'OrderAmount']);
    assertEq(
      [...writerCols].sort().join(','),
      ['Discount', 'OrderAmount'].sort().join(','),
      `J23 RC5 (documented, not red): writer_proc resolves to the unfiltered entryColumns here — actual: [${writerCols.join(',')}]`,
    );
  });

  // A non-bodied carrier that declares none of the forwarded columns ends the contraction. That is
  // correct — a bodied neighbour cannot be dispatched with a column the carrier cannot carry — but
  // the trace then stops short, and with no lead the truncation was invisible: the user saw a chain
  // that simply ended, with no record of which carrier broke it.
  it("a carrier declaring none of the forwarded columns leaves a contracted-scope lead", () => {
    // amount flows origin ← carrier (a table carrying only unrelated_col) ← deep_view.
    const originNode: LineageNode = makeNode({
      id: 'origin', schema: 'dbo', name: 'origin_view', type: 'view',
      columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }],
    });
    const carrier: LineageNode = makeNode({
      id: 'carrier', schema: 'dbo', name: 'carrier', type: 'table',
      columns: [{ name: 'unrelated_col', type: 'int', nullable: 'NULL', extra: '' }],
    });
    const deepView: LineageNode = makeNode({
      id: 'deep_view', schema: 'dbo', name: 'deep_view', type: 'view',
      columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }],
    });
    const n: LineageNode[] = [originNode, carrier, deepView];
    const e: Array<[string, string]> = [['carrier', 'origin'], ['deep_view', 'carrier']];
    const engine = new NavigationEngine(makeModel(n, e, ['dbo']), makeGraph(n, e), () => {}, {});
    engine.init({ origin: 'origin', question: 'trace amount', direction: 'upstream', targetColumns: ['amount'] });

    engine.getHopContext();
    engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'ok' }],
      summary: 'ok',
      verdict: 'analyze',
      column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'carrier', col: 'unrelated_col' }] }],
    });

    const leads = engine.pendingLeads.filter(l => l.nodeId.toLowerCase() === 'carrier');
    assert(
      leads.some(l => l.reason === 'contracted_scope'),
      `the broken carrier is recorded as a contracted-scope lead (got ${JSON.stringify(engine.pendingLeads.map(l => [l.nodeId, l.reason]))})`,
    );
  });
});
