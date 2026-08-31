import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import { buildCurrentTaskBlock } from '../../../src/ai/prompting/prompts';
import { activeModeOf } from '../../../src/ai/tools/toolPolicy';
import type { LogFn } from '../../../src/engine/graphGuards';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

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
  expect('error' in result && result.error === 'column_chain_incomplete', 'CT: empty column_flow with active columns → column_chain_incomplete (no self-prune)').toBe(true);
});

  it("Test 3b: qualified target columns resolve to the declared bare name (2026-07-03 P3 stall)", () => {
  // Models qualify freely ("dbo.origin_view.amount", "[origin_view].[amount]") — the active spine
  // must still seed, in the DECLARED spelling, or every legitimate column_flow gets rejected as
  // "not an active tracked column" and the session collapses to a zero-trace.
  for (const requested of ['dbo.origin_view.amount', 'origin_view.amount', '[origin_view].[AMOUNT]']) {
    const engine = ctEngine([requested]);
    expect(engine.columnAspect?.active_columns.join(','), `CT: qualified target "${requested}" resolves to the declared column name`).toBe('amount');
  }
});

  it("one-node result; init rejects so the model names a real column or omits targetColumns for BB.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const result = engine.init({ origin: 'origin', question: 'test', direction: 'upstream', targetColumns: ['missing_col'] });
  expect('error' in result && result.error === 'unknown_columns', 'CT: target column not on origin → init rejects unknown_columns (no zero-trace)').toBe(true);
  expect('error' in result && typeof result.hint === 'string' && result.hint.length > 0, 'CT: unknown_columns reject carries a corrective hint').toBe(true);
});

  it("Test 3b: explicit BB mode rejects any targetColumns property before mutation", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const result = engine.init({ origin: 'origin', question: 'test', direction: 'upstream', analysisMode: 'bb', targetColumns: ['amount'] });
  expect('error' in result && result.error === 'ct_field_forbidden_in_bb', 'BB with named targetColumns rejects').toBe(true);
  expect(engine.status === 'created' && !engine.columnAspect, 'named-target rejection leaves engine untouched').toBe(true);
  const emptyResult = engine.init({ origin: 'origin', question: 'test', direction: 'upstream', analysisMode: 'bb', targetColumns: [] });
  expect('error' in emptyResult && emptyResult.error === 'ct_field_forbidden_in_bb', 'direct engine BB with empty target property also rejects').toBe(true);
  expect(engine.status === 'created', 'empty-target rejection leaves engine untouched').toBe(true);
});

  it("Test 3c: rejected BB refine is atomic; successful CT→BB clears CT state", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const initial = engine.init({ origin: 'origin', question: 'trace amount', direction: 'upstream', analysisMode: 'ct', targetColumns: ['amount'] });
  expect('ok' in initial, 'CT session initializes before transition checks').toBe(true);
  const ctSnapshot = engine.toJSON();
  const restoredCt = NavigationEngine.fromJSON(JSON.parse(JSON.stringify(ctSnapshot)), model, graph, () => {});
  expect(JSON.stringify(restoredCt.toJSON()) === JSON.stringify(ctSnapshot), 'current CT checkpoint round-trips without loss').toBe(true);
  const ctWithoutTargets = JSON.parse(JSON.stringify(ctSnapshot));
  ctWithoutTargets.columnAspect.target_columns = [];
  let missingTargetsRejected = false;
  try {
    NavigationEngine.fromJSON(ctWithoutTargets, model, graph, () => {});
  } catch {
    missingTargetsRejected = true;
  }
  expect(missingTargetsRejected, 'CT snapshot without target columns rejects').toBe(true);
  const ctTaskIds = new Set(ctSnapshot.engineInternals?.investigationTasks?.map(task => task.id) ?? []);
  const beforeReject = JSON.stringify(engine.getScopeSummary());
  const rejected = engine.init({ origin: 'origin', question: 'switch badly', direction: 'upstream', analysisMode: 'bb', targetColumns: ['amount'] });
  expect('error' in rejected && rejected.error === 'ct_field_forbidden_in_bb', 'inherited/live engine BB conflict rejects').toBe(true);
  expect(JSON.stringify(engine.getScopeSummary()) === beforeReject, 'rejected BB refine preserves the complete engine snapshot').toBe(true);
  const switched = engine.init({ origin: 'origin', question: 'switch cleanly', direction: 'upstream', analysisMode: 'bb' });
  expect('ok' in switched, 'valid explicit CT→BB transition succeeds').toBe(true);
  const summary = engine.getScopeSummary();
  expect(summary.analysisMode === 'bb' && summary.targetColumns === undefined && !engine.columnAspect, 'successful CT→BB transition clears prior CT columns').toBe(true);
  const bbSnapshot = engine.toJSON();
  const bbTasks = bbSnapshot.engineInternals?.investigationTasks ?? [];
  const bbTaskIds = new Set(bbTasks.map(task => task.id));
  expect(bbTasks.every(task => task.kind !== 'column_lineage' && task.activeColumns === undefined), 'successful CT→BB transition purges CT task shape').toBe(true);
  expect(bbTasks.every(task => !ctTaskIds.has(task.id)), 'successful CT→BB transition purges all prior ledger identities').toBe(true);
  expect(bbTasks.every(task => task.parentTaskId === undefined || bbTaskIds.has(task.parentTaskId)), 'replacement BB tasks have no dangling parent task ids').toBe(true);
  const bbRoot = bbTasks.find(task => task.kind === 'root');
  expect(!!bbRoot && bbTasks.filter(task => task.id !== bbRoot.id).every(task => task.parentTaskId === bbRoot.id), 'replacement seed tasks are explicitly parented to the new BB root').toBe(true);
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
  expect('ok' in result, 'CT: absent upstream node is nonfatal').toBe(true);
  expect(engine.columnAspect?.edges.length ?? -1, 'CT: absent upstream stages zero column edges').toBe(0);
  expect(engine.toJSON().memory.recentRejections.some((r) => r.nodeId === 't_raw'), 'CT: absent upstream notice is recorded').toBe(true);
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
  expect('error' in result && result.error === 'out_col_not_on_node', 'out_col not active → out_col_not_on_node').toBe(true);
  if ('error' in result) {
    const hint = result.hint ?? '';
    expect(/declare column_flow only for an active tracked column/i.test(hint), 'hint is a verb-led order').toBe(true);
    expect(!/\bdo not\b|\bnever\b|\bdon't\b/i.test(hint), 'hint avoids negative framing').toBe(true);
    const detail = JSON.stringify('detail' in result ? result.detail : '');
    expect(detail.includes('wrong_col'), 'detail names the offending out_col').toBe(true);
    expect(detail.includes('amount'), 'detail lists the valid active column as data').toBe(true);
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
  expect('ok' in result, 'absent upstream node does not consume the retry budget').toBe(true);
  const edges = engine.columnAspect?.edges ?? [];
  expect(edges.length === 0, 'no dangling edge staged for the unresolved upstream node').toBe(true);
  expect(engine.toJSON().memory.recentRejections.some((r) => r.nodeId === 'nonexistent_table'), 'absent upstream notice remains visible').toBe(true);
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
  expect('error' in result && result.error === 'contributor_col_not_on_source', 'upstream column not on source → contributor_col_not_on_source').toBe(true);
  if ('error' in result) {
    const hint = result.hint ?? '';
    expect(/set upstream_columns\[\]\.col to a real upstream column/i.test(hint), 'hint is a verb-led order').toBe(true);
    expect(/Do not use literals, NULLs, parameters, generated values, or filter-only columns/i.test(hint), 'hint keeps non-column semantics in sections').toBe(true);
    const detail = JSON.stringify('detail' in result ? result.detail : '');
    expect(detail.includes('raw_amount'), 'detail lists the valid source column as data').toBe(true);
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
    expect(invalidRoutes.some(r => r.kind === 'bad_contributor_col'), 'the invalid contributor is reported').toBe(true);
    expect(stagedEdges.length, 'no edge is staged for a rejected upstream column').toBe(0);
  });

  it("an out_col that differs only by padding or quoting is accounted for, not reported incomplete", () => {
    // The completeness guard and validateColumnFlow must normalize identically; a value one admits
    // can never be reported unaccounted by the other, which would retry the identical payload until
    // the semantic breaker ends the turn.
    const tracer = new ColumnTracer(['amount']);
    expect(tracer.unaccountedActiveColumns([{ out_col: ' "Amount" ', upstream_columns: [] }] as never).length, 'a padded/quoted out_col accounts for its active column').toBe(0);
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
  expect('ok' in result && result.ok, 'valid column_flow accepted').toBe(true);
  const edges = engine.columnAspect?.edges ?? [];
  expect(edges.length === 1, 'one upstream column edge accumulated').toBe(true);
  expect(edges[0]?.from_node === 'base_table', 'accumulated edge from_node is base_table').toBe(true);
  expect(edges[0]?.to_col === 'amount', 'accumulated edge to_col is amount').toBe(true);
  const state = engine.toJSON() as { nodeStates: Array<{ nodeId: string; action: string; reason: string; columns?: string[] }> };
  const baseState = state.nodeStates.find(s => s.nodeId === 'base_table');
  expect(baseState?.action === 'passthrough', 'CT upstream table gets pass lifecycle state').toBe(true);
  expect(baseState?.reason === 'non_bodied_passthrough', 'CT upstream table reason is non-bodied passthrough').toBe(true);
  expect(baseState?.columns?.includes('raw_amount') ?? false, 'CT upstream table lifecycle carries source column').toBe(true);
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
  expect('error' in rejected && rejected.error === 'contributor_col_not_on_source', 'CT partial invalid flow rejects').toBe(true);
  if ('error' in rejected) {
    const detail = 'detail' in rejected ? rejected.detail : undefined;
    const invalidContributor = Array.isArray(detail) ? detail[0] as { path?: string } : undefined;
    expect(invalidContributor?.path, 'CT rejection preserves the exact invalid column_flow path').toBe('column_flow.1.upstream_columns.0.col');
    expect(rejected.hint, 'CT rejection preserves the existing corrective hint verbatim').toBe('Set upstream_columns[].col to a real upstream column. Do not use literals, NULLs, parameters, generated values, or filter-only columns here; explain those in sections[].text, remove that upstream column, or use upstream_columns: [] when the active column terminates here.');
    expect(!JSON.stringify(rejected).includes('mixed flow'), 'CT rejection excludes authored sections and summary').toBe(true);
  }
  expect(durableCtSnapshot(engine), 'CT rejection preserves all durable engine state').toBe(beforeReject);
  expect(engine.getHopDiagnostics().routedRejected > 0, 'CT rejection may update routed-rejection diagnostics').toBe(true);

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
  expect('ok' in accepted && accepted.ok, 'corrected CT flow commits').toBe(true);
  const committed = engine.toJSON();
  expect(committed.columnAspect?.edges.length ?? -1, 'corrected CT flow commits its edge once').toBe(1);
  expect(Object.keys(committed.memory.detailSlots).length, 'corrected CT flow stores one detail slot').toBe(1);
  expect(committed.memory.verdictCounts.analyze, 'corrected CT flow increments the verdict tally once').toBe(1);
  expect(committed.engineInternals?.lastHopColumnFlowEntries ?? -1, 'corrected CT flow commits its entry count once').toBe(2);
  expect(committed.nodeStates.filter(state => state.nodeId === 'base_table').length, 'corrected CT flow commits one source node state').toBe(1);
});

  it("tool set in toolPolicy.", () => {
  expect(activeModeOf(true) === 'sm_ct', 'activeModeOf(hasColumnAspect=true) === sm_ct').toBe(true);
  expect(activeModeOf(false) === 'sm_bb', 'activeModeOf(hasColumnAspect=false) === sm_bb').toBe(true);
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
  expect(doneCtx.done === true, 'exploration completed (done=true)').toBe(true);

  // Supplement with second_view
  const suppResult = engine.supplementAgenda(['second_view']);
  expect('ok' in suppResult && suppResult.ok, 'supplementAgenda ok').toBe(true);

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
  expect(!('error' in r2 && r2.error === 'column_flow_required'), 'supplement node has column context (no column_flow_required)').toBe(true);
  const diag = engine.getHopDiagnostics();
  expect(diag.activeColumnCount === 1, 'supplemented node has activeColumnCount=1').toBe(true);
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
  expect(ok.invalidRoutes.length, 'WS2 valid writes_to.col: no rejection').toBe(0);
  expect(ok.stagedEdges.length, 'WS2 valid writes_to.col: edge staged').toBe(1);
  expect(ok.stagedEdges[0].to_col, 'WS2 valid writes_to.col: to_col carried through').toBe('TotalRevenue');

  const empty = tracer.validateColumnFlow('spwriter', writeTo('') as any, nodeMap, ctModel, null);
  expect(empty.invalidRoutes.some(r => r.kind === 'bad_out_col'), 'WS2 empty writes_to.col → bad_out_col (no .min(1) needed)').toBe(true);
  expect(empty.stagedEdges.length, 'WS2 empty writes_to.col: no empty edge staged').toBe(0);

  const wrong = tracer.validateColumnFlow('spwriter', writeTo('Nonexistent') as any, nodeMap, ctModel, null);
  expect(wrong.invalidRoutes.some(r => r.kind === 'bad_out_col'), 'WS2 wrong writes_to.col → bad_out_col').toBe(true);
  expect(wrong.stagedEdges.length, 'WS2 wrong writes_to.col: no edge staged').toBe(0);

  const unknown = tracer.validateColumnFlow('spwriter', writeTo('TotalRevenue', 'ghosttable') as any, nodeMap, ctModel, null);
  expect(unknown.invalidRoutes.some(r => r.kind === 'absent_contributor'), 'WS2 unknown writes_to.node → absent_contributor').toBe(true);
  expect(unknown.stagedEdges.length, 'WS2 unknown writes_to.node: no edge staged').toBe(0);
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
  expect(mixed.invalidRoutes.some(r => r.kind === 'self_loop_column'), 'WS5: self-loop upstream contributor rejected').toBe(true);
  expect(mixed.stagedEdges.length, 'WS5: only the legitimate srcnode contributor is staged').toBe(1);
  expect(mixed.stagedEdges[0]?.from_node, 'WS5: staged edge is the legitimate one, not the self-loop').toBe('srcnode');
  const loopRoute = mixed.invalidRoutes.find(r => r.kind === 'self_loop_column');
  expect(!!loopRoute && loopRoute.reason.includes('facttable.TotalRevenue'), 'WS5: reason names the offending node.col').toBe(true);

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
  expect(legit.invalidRoutes.filter(r => r.kind === 'self_loop_column').length, 'WS5: legitimate writes_to redirect is not flagged as self-loop').toBe(0);
  expect(legit.stagedEdges.length, 'WS5: legitimate writes_to redirect still stages its edge').toBe(1);

  // writes_to omitted (defaults to focus) with an upstream contributor equal to the focus itself —
  // a node can't be its own upstream for the same column either; the same check catches it.
  const selfFocus = tracer.validateColumnFlow('facttable', {
    verdict: 'analyze' as const, summary: 's', sections: [],
    column_flow: [{
      out_col: 'TotalRevenue',
      upstream_columns: [{ node: 'facttable', col: 'TotalRevenue' }],
    }],
  } as any, nodeMap, ctModel, null);
  expect(selfFocus.invalidRoutes.some(r => r.kind === 'self_loop_column'), 'WS5: upstream == focus with same column (writes_to omitted) is also a self-loop').toBe(true);
  expect(selfFocus.stagedEdges.length, 'WS5: no edge staged for the focus self-loop').toBe(0);
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
  expect('error' in result && result.error === 'column_self_loop', 'engine: self-loop column_flow rejected as column_self_loop').toBe(true);
  if ('error' in result) {
    const hint = result.hint ?? '';
    expect(/writes_to/i.test(hint) && /identical/i.test(hint), 'engine: hint names the corrective action (writes_to / omit)').toBe(true);
    expect(!/prune_neighbors/i.test(hint), 'engine: hint is CT-only, no BB prune vocabulary leaks in').toBe(true);
    const detail = JSON.stringify('detail' in result ? result.detail : '');
    expect(detail.includes('origin'), 'engine: detail names the offending node').toBe(true);
  }
  expect(engine.columnAspect?.edges.length ?? -1, 'engine: no edge staged for the rejected self-loop submission — session left unmutated').toBe(0);
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
  expect(res.stagedEdges.length, 'WS4a: both real upstream column edges are staged').toBe(2);
  for (const e of res.stagedEdges) e.hop = 1;
  tracer.state.edges.push(...res.stagedEdges);

  const questions = Array.from(tracer.getColumnLineageQuestionsByNode('focusview', 1).values()).flat();
  expect(questions.length, 'WS4a: every real upstream column edge spawns a continuation question').toBe(2);
  expect(questions.some(q => q.includes('valuesrc')) && questions.some(q => q.includes('filtersrc')), 'WS4a: both upstream nodes are represented').toBe(true);
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
  expect(res.invalidRoutes.length, 'Part A: bracketed [amount]/[raw] match DDL via normalizeColName (no false bad_out_col)').toBe(0);
  expect(res.stagedEdges.length, 'Part A: bracketed names still stage the edge').toBe(1);
});

  it("through a non-bodied passthrough, so siblings can't leak downstream.", () => {
  const tracer = new ColumnTracer(['TotalRevenue']);
  // A prior bodied hop declared UnitPrice ← pricemaster.ListPrice → edge with from_node=pricemaster.
  tracer.state.edges.push({ hop: 1, hop_node: 'vwpricelist', to_node: 'vwpricelist', to_col: 'UnitPrice', from_node: 'pricemaster', from_col: 'ListPrice' });
  // The model over-declared pricemaster's route columns; only ListPrice is on the tracked spine.
  const bounded = tracer.determineActiveColumnsForCandidate('pricemaster', ['ListPrice', 'EffectiveFrom', 'RegionCode']);
  expect(bounded.length, 'Part B: over-declared siblings dropped to the on-trace spine').toBe(1);
  expect(bounded[0]?.toLowerCase() === 'listprice', 'Part B: the on-trace ListPrice is kept').toBe(true);
  // Bracketed entry still intersects (Part A normalization inside the bound).
  const boundedBr = tracer.determineActiveColumnsForCandidate('pricemaster', ['[ListPrice]', 'RegionCode']);
  expect(boundedBr.length, 'Part B+A: bracketed [ListPrice] matches the unbracketed spine').toBe(1);
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
    expect('ok' in init, 'Defect B: downstream CT session initializes').toBe(true);
    engine.getHopContext();
    const result = engine.submitFindings({
      focus_node_id: 'ct_origin',
      sections: [{ angle: 'business' as const, text: 'origin analysis' }],
      summary: 'ok',
      verdict: 'analyze',
      column_flow: [{ out_col: 'amount', upstream_columns: [] }],
      route_requests: [{ nodeId: 'ct_down', question: 'Does ct_down forward amount unchanged?' }],
    });
    expect(!('error' in result), 'Defect B: route to a bodied downstream neighbor with no column_flow back-reference is accepted').toBe(true);
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
  expect(!threw, 'Defect B: toJSON() succeeds after routing a CT neighbor with columns omitted (was issuePaths=[agenda.0.activeColumns])').toBe(true);
  const downEntry = snapshot?.agenda.find(e => e.nodeId === 'ct_down');
  expect(!!downEntry, 'Defect B: ct_down was enqueued').toBe(true);
  expect(!!downEntry?.activeColumns?.length, 'Defect B: ct_down agenda entry carries a non-empty activeColumns projection').toBe(true);
  expect(JSON.stringify(downEntry?.activeColumns), 'Defect B: the projected activeColumns equal the tracer targetColumns fallback').toBe(JSON.stringify(engine.columnAspect?.target_columns));
});

  it("a BB snapshot with any agenda activeColumns still REJECTS (regression pin, mirrors Test 3c)", () => {
  const engine = ctForwardRoutedEngine();
  const ctSnapshot = engine.toJSON();
  const restored = NavigationEngine.fromJSON(JSON.parse(JSON.stringify(ctSnapshot)), ctForwardModel, ctForwardGraph, () => {});
  expect(JSON.stringify(restored.toJSON()) === JSON.stringify(ctSnapshot), 'Defect B: CT checkpoint with a fallback-projected agenda entry round-trips without loss').toBe(true);

  const bbEngine = new NavigationEngine(ctForwardModel, ctForwardGraph, () => {}, {});
  bbEngine.init({ origin: 'ct_origin', question: 'bb baseline', direction: 'downstream' });
  const bbSnapshot = JSON.parse(JSON.stringify(bbEngine.toJSON())) as { agenda: Array<{ activeColumns?: string[] }> };
  expect(bbSnapshot.agenda.length > 0, 'Defect B: BB baseline seeds at least one agenda entry to corrupt').toBe(true);
  bbSnapshot.agenda[0].activeColumns = ['not_allowed_in_bb'];
  let bbRejected = false;
  try {
    NavigationEngine.fromJSON(bbSnapshot, ctForwardModel, ctForwardGraph, () => {});
  } catch {
    bbRejected = true;
  }
  expect(bbRejected, 'Defect B: a BB snapshot carrying agenda activeColumns still rejects (BB superRefine untouched)').toBe(true);
});

  it("throw path (toJSON()'s own catch) logs the issuePaths diagnostic, not just the generic message", () => {
  const logs: string[] = [];
  const engine = ctForwardRoutedEngine((_level, message) => logs.push(message));
  // Directly corrupt the live agenda entry the fix just protected, bypassing enqueueHop entirely —
  // proves the checkpoint boundary (not just the enqueue-time fallback) still enforces the CT
  // invariant, and exercises toJSON()'s own catch/log path for any future write that reintroduces it.
  const rawEntries = (engine as unknown as { _agenda: { entries: Array<{ nodeId: string; activeColumns?: string[] }> } })._agenda.entries;
  const downEntry = rawEntries.find(e => e.nodeId === 'ct_down');
  expect(!!downEntry, 'Defect B: ct_down agenda entry exists to corrupt').toBe(true);

  if (downEntry) downEntry.activeColumns = undefined;
  let threwUndefined = false;
  try { engine.toJSON(); } catch { threwUndefined = true; }
  expect(threwUndefined, 'Defect B: CT agenda entry with activeColumns=undefined still rejects at toJSON()').toBe(true);

  if (downEntry) downEntry.activeColumns = [];
  let threwEmpty = false;
  try { engine.toJSON(); } catch { threwEmpty = true; }
  expect(threwEmpty, 'Defect B: CT agenda entry with activeColumns=[] still rejects at toJSON() (NonEmptyStrings.min(1))').toBe(true);

  expect(logs.some(m => m.includes('[Checkpoint] serialize rejected') && m.includes('agenda') && m.includes('activeColumns')), 'Defect B: toJSON() rejection logs the issuePaths diagnostic (not just the generic InvalidEngineCheckpointError message)').toBe(true);
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
    expect('ok' in init, 'J16-1: upstream CT session initializes').toBe(true);
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
    expect(!('error' in result), 'J16-1: routing two real upstream column contributors is accepted').toBe(true);
    return engine;
  }

  it("J16-1: lineage questions reach the hop for the node they were routed to, not the next dequeued node", () => {
  const engine = lqRoutedEngine();

  const firstHop = engine.getHopContext() as { done?: boolean };
  expect(!firstHop.done, 'J16-1: a second hop is dispatched').toBe(true);
  const firstFocus = engine.currentFocus;
  expect(firstFocus === 'lq_node_a' || firstFocus === 'lq_node_b', 'J16-1: dispatch lands on one of the two routed nodes').toBe(true);
  const otherNode = firstFocus === 'lq_node_a' ? 'lq_node_b' : 'lq_node_a';
  const ownCol = firstFocus === 'lq_node_a' ? 'ColA' : 'ColB';
  const otherCol = firstFocus === 'lq_node_a' ? 'ColB' : 'ColA';

  const firstQuestions = engine.pendingLineageQuestions;
  expect(firstQuestions.length, `J16-1: ${firstFocus} sees exactly its own continuation, not both`).toBe(1);
  expect(firstQuestions[0].includes(ownCol), `J16-1: ${firstFocus}'s question names its own column ${ownCol}`).toBe(true);
  expect(!firstQuestions[0].includes(otherCol), `J16-1: ${firstFocus}'s question does not name the other node's column ${otherCol}`).toBe(true);
  expect(firstQuestions[0].includes('TargetCol'), 'J16-1: question names the column it continues the trace into (label uses the traced column)').toBe(true);

  // Terminal submission at the first-dequeued node — accounts for its sole active column.
  const firstResult = engine.submitFindings({
    focus_node_id: firstFocus!,
    sections: [{ angle: 'business' as const, text: 'terminal' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{ out_col: ownCol, upstream_columns: [] }],
  });
  expect(!('error' in firstResult), `J16-1: terminal submission at ${firstFocus} is accepted`).toBe(true);

  const secondHop = engine.getHopContext() as { done?: boolean };
  expect(!secondHop.done, 'J16-1: the second routed node still dispatches').toBe(true);
  expect(engine.currentFocus, 'J16-1: the remaining routed node dequeues next').toBe(otherNode);

  const secondQuestions = engine.pendingLineageQuestions;
  expect(secondQuestions.length, `J16-1: ${otherNode} sees exactly its own continuation`).toBe(1);
  expect(secondQuestions[0].includes(otherCol), `J16-1: ${otherNode}'s question names its own column ${otherCol}`).toBe(true);
  expect(!secondQuestions[0].includes(ownCol), `J16-1: ${otherNode}'s question does not carry over ${firstFocus}'s column`).toBe(true);
});

  it("J16-1: no pending lineage questions renders no <lineage_questions> block", () => {
  const withQuestions = buildCurrentTaskBlock(
    [{ kind: 'root', question: 'Trace TargetCol' }],
    ['TargetCol'],
    ['Column `ColA` at `lq_node_a`: continues the trace into `TargetCol` at `lq_origin` — determine its origin here.'],
  );
  expect(withQuestions.includes('<lineage_questions>'), 'J16-1: a non-empty list renders the block').toBe(true);

  const noneUndefined = buildCurrentTaskBlock([{ kind: 'root', question: 'Trace TargetCol' }], ['TargetCol'], undefined);
  expect(!noneUndefined.includes('<lineage_questions>'), 'J16-1: an omitted list renders no block').toBe(true);

  const noneEmpty = buildCurrentTaskBlock([{ kind: 'root', question: 'Trace TargetCol' }], ['TargetCol'], []);
  expect(!noneEmpty.includes('<lineage_questions>'), 'J16-1: an empty list renders no block').toBe(true);
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
    expect('ok' in init, 'J23: CT session initializes at origin_view').toBe(true);
    const hop = engine.getHopContext() as { done?: boolean };
    expect(!hop.done && engine.currentFocus === 'origin_view', 'J23: first dispatched hop is origin_view').toBe(true);
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
    expect(!('error' in result), `J23: origin_view commit accepted (${'error' in result ? result.error : ''})`).toBe(true);
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
      expect(!hop.done, `J23: exploration completed before reaching ${targetId}`).toBe(true);
      if (engine.currentFocus === targetId) return;
      const focusId = engine.currentFocus!;
      const submitted = j23TerminalSubmit(engine, focusId);
      expect(!('error' in submitted), `J23: terminal submission at ${focusId} accepted while routing to ${targetId} (${'error' in submitted ? submitted.error : ''})`).toBe(true);
    }
    throw new Error(`J23: ${targetId} not reached within ${maxHops} hops`);
  }

  it("RC1: writer_proc — the true upstream producer of staging.OrderAmount — must dispatch with exactly ['OrderAmount'], not the seed target plus the routed column", () => {
    const engine = j23OriginCommittedEngine();
    j23DispatchUntil(engine, 'writer_proc');
    const active = [...(engine.columnAspect?.active_columns ?? [])].sort();
    expect(active.join(','), `J23 RC1: writer_proc's dispatched active_columns must equal exactly ['OrderAmount'] — today it also carries 'Discount', forwarded at seed time (init()'s seedAgenda walks origin_view's bidirectional neighbors before any column_flow exists) through staging's non-bodied contraction, then merged (AgendaManager.push unions activeColumns) with the later real 'OrderAmount' route`).toBe('OrderAmount');
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
    expect('ok' in init, 'J23 RC2: CT session initializes at origin_view').toBe(true);
    const firstHop = engine.getHopContext() as { done?: boolean };
    expect(!firstHop.done && engine.currentFocus === 'origin_view', 'J23 RC2: first dispatched hop is origin_view').toBe(true);

    const seedSnap = engine.toJSON() as { agenda: Array<{ nodeId: string; activeColumns?: string[] }> };
    const seedWriter = seedSnap.agenda.find((e) => e.nodeId === 'writer_proc');
    const seedReader = seedSnap.agenda.find((e) => e.nodeId === 'reader_proc');
    // GREEN: writer_proc is on the pure-inbound BFS chain, but the carrier-bounded contraction at
    // staging (which never declares 'Discount') stops before recursing to any bodied neighbour —
    // no seed-time entry, the same outcome as reader_proc below, not a leaked one.
    expect(seedWriter === undefined, `J23 RC2 stage 1: writer_proc has no seed-time agenda entry (found: ${JSON.stringify(seedWriter)}) — the carrier-bounded contraction at 'staging' stops before it, since 'staging' never declares 'Discount'`).toBe(true);
    // GREEN (documentary): reader_proc sits on a mixed in-then-out path relative to
    // origin_view, so computeBfsScope's inbound/outbound split never reaches it — it has no
    // seed-time entry to leak into at all, confirmed here rather than assumed.
    expect(seedReader === undefined, `J23 RC2 stage 1 (documented, green): reader_proc has no seed-time agenda entry (found: ${JSON.stringify(seedReader)}) — it is outside the initial bidirectional BFS scope until routed`).toBe(true);

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
    expect(!('error' in commit), `J23 RC2 stage 2: origin_view commit accepted (${'error' in commit ? commit.error : ''})`).toBe(true);

    const routedSnap = engine.toJSON() as { agenda: Array<{ nodeId: string; activeColumns?: string[] }> };
    const routedWriter = routedSnap.agenda.find((e) => e.nodeId === 'writer_proc');
    const routedReader = routedSnap.agenda.find((e) => e.nodeId === 'reader_proc');
    expect([...(routedWriter?.activeColumns ?? [])].sort().join(','), `J23 RC2 stage 2b (GREEN, mirrors 2c): writer_proc's activeColumns after the staging.OrderAmount route must deep-equal ['OrderAmount'] — actual: [${(routedWriter?.activeColumns ?? []).join(',')}]`).toBe('OrderAmount');
    expect([...(routedReader?.activeColumns ?? [])].sort().join(','), `J23 RC2 stage 2c (GREEN control, pins the asymmetry): reader_proc's freshly route-admitted activeColumns already deep-equal ['OrderAmount'] — no prior seed entry existed to merge a leaked 'Discount' into; actual: [${(routedReader?.activeColumns ?? []).join(',')}]`).toBe('OrderAmount');

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
    expect(!('error' in readerResult), `J23 RC2 stage 3 (GREEN control): reader_proc submitting only its legitimate OrderAmount contribution is accepted, not rejected — actual: ${'error' in readerResult ? `${readerResult.error}: ${readerResult.hint ?? ''}` : 'ok'}`).toBe(true);
  });

  it("green pin: a carrier-adjacent node with no declared columns array forwards the candidate active-column set unchanged (existence exemption preserved, not itself a defect)", () => {
    const engine = new NavigationEngine(j23Model, j23Graph, () => {}, {});
    engine.init({ origin: 'origin_view', question: 'trace', direction: 'bidirectional', targetColumns: ['Discount'] });
    // resolveActiveColumnsForNode has no public accessor; this test exercises it directly, not through a dispatched hop.
    const resolved = (engine as unknown as {
      resolveActiveColumnsForNode(nodeId: string, columns?: string[]): string[] | undefined;
    }).resolveActiveColumnsForNode('writer_proc', ['Discount', 'OrderAmount']);
    expect([...(resolved ?? [])].sort().join(','), "J23 green pin: writer_proc declares no columns (columns: []), so resolveActiveColumnsForNode's existence exemption ('if (nodeColumns.length === 0) return columns' — smBase.ts) must forward the candidate set unchanged rather than filtering it to empty. This is deliberate (a procedure may write columns elsewhere with no local column surface to filter against) and must survive any fix to the RC2 seed-time Discount leak — the fix belongs in what gets forwarded (seedAgenda/enqueueHop), not in this exemption.").toBe(['Discount', 'OrderAmount'].sort().join(','));
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
    expect('ok' in init, 'J23 RC4: CT session initializes at origin_view').toBe(true);
    const hop = engine.getHopContext() as { done?: boolean };
    expect(!hop.done && engine.currentFocus === 'origin_view', 'J23 RC4: first dispatched hop is origin_view').toBe(true);
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
    expect(!('error' in originCommit), `J23 RC4: origin_view commit accepted (${'error' in originCommit ? originCommit.error : ''})`).toBe(true);
    j23DispatchUntil(engine, 'writer_proc');
    expect([...(engine.columnAspect?.active_columns ?? [])].sort().join(','), 'J23 RC4: writer_proc dispatches with both routed columns (OrderAmount, OrderDate) — the genuine premise for this rejection').toBe(['OrderAmount', 'OrderDate'].sort().join(','));

    const result = engine.submitFindings({
      focus_node_id: 'writer_proc',
      sections: [{ angle: 'business' as const, text: 'writer_proc produces staging.OrderAmount' }],
      summary: 'ok',
      verdict: 'passthrough',
      column_flow: [{ out_col: 'OrderAmount', upstream_columns: [] }],
    });
    expect('error' in result && result.error === 'column_chain_incomplete', 'J23 RC4: OrderDate left unaccounted at writer_proc → column_chain_incomplete (genuine premise)').toBe(true);

    // Loop proof (NOT red — documents the resulting stall, not a fixed contract): resubmitting the
    // hint's own literal suggestion returns the identical rejection.
    const again = engine.submitFindings({
      focus_node_id: 'writer_proc',
      sections: [],
      summary: 'ok',
      verdict: 'passthrough',
      column_flow: [],
    });
    expect('error' in again && again.error === 'column_chain_incomplete', "J23 RC4 (loop proof, passes today): resubmitting verdict:'passthrough', column_flow:[] at writer_proc returns column_chain_incomplete again — the hint's literal suggested escape does not resolve the hop").toBe(true);
  });

  /** Held: the column_chain_incomplete hint at writer_proc must name pruning the leaked column, not repeat the rejected escape. */
  it.skip("RC4: the column_chain_incomplete hint at writer_proc must name pruning the leaked column, not repeat the escape it just rejected — held: hint rewrite pending replay (OPEN-ISSUES row 2)", () => {
    const engine = new NavigationEngine(j23Model, j23Graph, () => {}, {});
    const init = engine.init({ origin: 'origin_view', question: 'trace', direction: 'bidirectional', targetColumns: ['Discount', 'BaseAmt'] });
    expect('ok' in init, 'J23 RC4: CT session initializes at origin_view').toBe(true);
    const hop = engine.getHopContext() as { done?: boolean };
    expect(!hop.done && engine.currentFocus === 'origin_view', 'J23 RC4: first dispatched hop is origin_view').toBe(true);
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
    expect(!('error' in originCommit), `J23 RC4: origin_view commit accepted (${'error' in originCommit ? originCommit.error : ''})`).toBe(true);
    j23DispatchUntil(engine, 'writer_proc');

    const result = engine.submitFindings({
      focus_node_id: 'writer_proc',
      sections: [{ angle: 'business' as const, text: 'writer_proc produces staging.OrderAmount' }],
      summary: 'ok',
      verdict: 'passthrough',
      column_flow: [{ out_col: 'OrderAmount', upstream_columns: [] }],
    });
    expect('error' in result && result.error === 'column_chain_incomplete', 'J23 RC4: OrderDate left unaccounted at writer_proc → column_chain_incomplete (genuine premise)').toBe(true);
    if ('error' in result) {
      const hint = result.hint ?? '';
      expect(/prune/i.test(hint), `J23 RC4: the hint must name pruning the spurious leaked 'OrderDate' as the corrective action — actual hint: "${hint}"`).toBe(true);
      expect(!/column_flow:\s*\[\]/.test(hint), `J23 RC4: the hint must not re-suggest 'column_flow:[]' — that exact retry was already submitted this hop (Test 3's own "no self-prune" contract) and would reject again with the identical error, looping — actual hint: "${hint}"`).toBe(true);
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
    expect([...writerCols].sort().join(','), `J23 RC5 (documented, not red): writer_proc resolves to the unfiltered entryColumns here — actual: [${writerCols.join(',')}]`).toBe(['Discount', 'OrderAmount'].sort().join(','));
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
    expect(leads.some(l => l.reason === 'contracted_scope'), `the broken carrier is recorded as a contracted-scope lead (got ${JSON.stringify(engine.pendingLeads.map(l => [l.nodeId, l.reason]))})`).toBe(true);
  });
});

describe("CT target boundary: object references are never columns", () => {
  // Class: the model names an OBJECT (schema-qualified id) in targetColumns. The value passes the
  // Zod wildcard-only guard, and a column-less procedure origin (procedures may write columns
  // elsewhere, so absence of a local surface is not proof of anything) would otherwise adopt the
  // object id as its sole active tracked column — an unwinnable session: every real column the
  // model submits then rejects out_col_not_on_node. The boundary class is the Zod wildcard
  // reject's ("this value can never be a column"); the fix rejects at the CT adoption sites.
  const loadProc: LineageNode = makeNode({
    id: '[dbo].[load_proc]', schema: 'dbo', name: 'load_proc', type: 'procedure', columns: [],
  });
  const srcTable: LineageNode = makeNode({
    id: '[dbo].[src_table]', schema: 'dbo', name: 'src_table', type: 'table',
    columns: [{ name: 'order_id', type: 'int', nullable: 'NOT NULL', extra: '' }],
  });
  const nodes: LineageNode[] = [loadProc, srcTable];
  const edgePairs: Array<[string, string]> = [['[dbo].[src_table]', '[dbo].[load_proc]']];
  const model: DatabaseModel = makeModel(nodes, edgePairs, ['dbo']);
  const graph = makeGraph(nodes, edgePairs);

  it("init rejects a targetColumns entry that resolves to a node id, side-effect-free", () => {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const result = engine.init({ origin: '[dbo].[load_proc]', question: 'trace', direction: 'upstream', analysisMode: 'ct', targetColumns: ['[dbo].[load_proc]'] });
    expect('error' in result && result.error === 'target_columns_name_objects', 'CT: object id as target column → target_columns_name_objects').toBe(true);
    expect('error' in result && typeof result.hint === 'string' && result.hint.includes('"bb"'), 'CT: object-id reject points to the BB alternative').toBe(true);
    expect(engine.status === 'created' && !engine.columnAspect, 'rejected object-id start leaves the engine untouched').toBe(true);
  });

  it("init rejects an unbracketed object spelling as well (exact resolution, not a string match)", () => {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const result = engine.init({ origin: '[dbo].[load_proc]', question: 'trace', direction: 'upstream', analysisMode: 'ct', targetColumns: ['dbo.src_table'] });
    expect('error' in result && result.error === 'target_columns_name_objects', 'CT: unbracketed object spelling is rejected through canonical resolution').toBe(true);
  });

  it("a bare column name on a column-less procedure still passes (written-elsewhere bypass preserved)", () => {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const result = engine.init({ origin: '[dbo].[load_proc]', question: 'trace', direction: 'upstream', analysisMode: 'ct', targetColumns: ['order_id'] });
    expect('ok' in result, 'CT: bare column name on a procedure origin still seeds (no zero-trace fallback)').toBe(true);
    expect(engine.columnAspect?.active_columns.join(','), 'CT: bare column name adopted verbatim as the active column').toBe('order_id');
  });

  it("setColumnTargets refuses object references and still adopts real columns", () => {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const reject = engine.setColumnTargets(['[dbo].[src_table]']);
    expect(reject !== null && reject.error === 'target_columns_name_objects', 'setColumnTargets: object reference refused').toBe(true);
    expect(!engine.columnAspect, 'setColumnTargets: refused call adopts no column aspect').toBe(true);
    const ok = engine.setColumnTargets(['order_id']);
    expect(ok === null, 'setColumnTargets: real column accepted').toBe(true);
    expect(engine.columnAspect?.active_columns.join(','), 'setColumnTargets: real column adopted').toBe('order_id');
  });

  it("checkColumnTargets reports the same reject without adopting anything", () => {
    // The supplement path widens the allowlist and extends the agenda before it applies follow-up
    // context, so it screens the target list with this side-effect-free check first; a reject
    // raised only by `setColumnTargets` would land after those mutations.
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const reject = engine.checkColumnTargets(['[dbo].[src_table]']);
    expect(reject !== null && reject.error === 'target_columns_name_objects', 'checkColumnTargets: object reference reported').toBe(true);
    expect(reject?.hint, 'checkColumnTargets: hint is the single owned envelope').toBe(engine.setColumnTargets(['[dbo].[src_table]'])?.hint);
    expect(engine.checkColumnTargets(['order_id']), 'checkColumnTargets: real column reports no reject').toBeNull();
    expect(!engine.columnAspect, 'checkColumnTargets: neither call adopts a column aspect').toBe(true);
  });
});
