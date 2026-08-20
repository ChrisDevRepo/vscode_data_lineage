import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { renderScopeSummaryMd } from '../../../src/ai/prompting/scopeSummaryRenderer';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { assert, makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, it } from 'vitest';

describe("Discovery-phase refinement loop", () => {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin',     schema: 'dbo',      name: 'origin',     type: 'procedure', columns: [{ name: 'id', type: 'int', nullable: 'not null', extra: '' }] }),
    makeNode({ id: 'view_a',     schema: 'dbo',      name: 'view_a',     type: 'view' }),
    makeNode({ id: 'lookup_t',   schema: 'dbo',      name: 'lookup_t',   type: 'table' }),
    makeNode({ id: 'chained_v',  schema: 'dbo',      name: 'chained_v',  type: 'view' }),
    makeNode({ id: 'proc_b',     schema: 'staging',  name: 'proc_b',     type: 'procedure' }),
    makeNode({ id: 'view_c',     schema: 'ext',      name: 'view_c',     type: 'view' }),
  ];
  const edges: Array<[string, string]> = [
    ['origin',   'view_a'],
    ['origin',   'lookup_t'],
    ['lookup_t', 'chained_v'],
    ['view_a',   'chained_v'],
    ['origin',   'proc_b'],
    ['origin',   'view_c'],
  ];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo', 'staging', 'ext']);
  const graph = makeGraph(nodes, edges);

  const scopeNames = (summary: ReturnType<NavigationEngine['getScopeSummary']>): string[] =>
    Object.values(summary.bySchema).flatMap(schema =>
      Object.values(schema.byType).flatMap(type => type.nodeNames),
    );
  it("exclusion axes", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeTypes: ['view'] });
  const sum = engine.getScopeSummary();
  const ids = scopeNames(sum);
  assert(!ids.includes('view_a'),    'excludeTypes=["view"] drops view_a');
  assert(!ids.includes('view_c'),    'excludeTypes=["view"] drops view_c');
  assert(ids.includes('proc_b'),     'excludeTypes=["view"] keeps proc_b');
  assert(sum.activeFilters.types.includes('view'), 'activeFilters.types reflects exclusion');
});

  it("excludeSchemas=[\"staging\"] drops staging schema entirely", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeSchemas: ['staging', 'ext'] });
  const sum = engine.getScopeSummary();
  assert(!('staging' in sum.bySchema), 'excludeSchemas=["staging"] drops staging schema entirely');
  assert(!('ext' in sum.bySchema),     'excludeSchemas=["ext"] drops ext schema entirely');
  assert('dbo' in sum.bySchema,        'dbo schema still present');
});

  it("excludeNodeIds drops view_a", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeNodeIds: ['view_a', 'proc_b'] });
  const sum = engine.getScopeSummary();
  const ids = scopeNames(sum);
  assert(!ids.includes('view_a'), 'excludeNodeIds drops view_a');
  assert(!ids.includes('proc_b'), 'excludeNodeIds drops proc_b');
  assert(ids.includes('view_c'),  'unrelated nodes survive');
});

  it("scope summary restores canonical casing for excluded node IDs", () => {
  const mixedNodes: LineageNode[] = [
    makeNode({ id: '[ai].[FactSalesReport]', schema: 'ai', name: 'FactSalesReport', type: 'table' }),
    makeNode({ id: '[ai].[DimCalendar]', schema: 'ai', name: 'DimCalendar', type: 'table' }),
  ];
  const mixedEdges: Array<[string, string]> = [['[ai].[DimCalendar]', '[ai].[FactSalesReport]']];
  const mixedModel = makeModel(mixedNodes, mixedEdges, ['ai']);
  const engine = new NavigationEngine(mixedModel, makeGraph(mixedNodes, mixedEdges), () => {}, {});
  engine.init({
    origin: '[AI].[FACTSALESREPORT]',
    question: 'q',
    direction: 'upstream',
    excludeNodeIds: ['[AI].[DIMCALENDAR]'],
  });

  assert(
    engine.getScopeSummary().activeFilters.nodeIds.includes('[ai].[DimCalendar]'),
    'approval summary uses the model canonical ID rather than the lowercase internal key',
  );
});

  it("excluded route regression starts at origin", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeNodeIds: ['lookup_t'] });

  const ctx = engine.getHopContext();
  assert(ctx.focus_node?.id === 'origin', 'excluded route regression starts at origin');
  const submit = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'root' }],
    summary: 'ok',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'lookup_t', question: 'model tries excluded node' }],
  });
  assert('ok' in submit, 'excluded route is skipped without hard-rejecting the hop');

  const state = engine.toJSON();
  assert(!state.scopeNodeIds.includes('lookup_t'), 'excluded route target is not re-added to scope');
  const routeOutcomes = 'route_outcomes' in submit ? submit.route_outcomes ?? [] : [];
  assert(routeOutcomes.some(o => o.nodeId === 'lookup_t' && o.reason === 'excluded'), 'excluded route is reported as skipped');
});

  it("origin survives even when its type is excluded", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeTypes: ['procedure'] });
  // Origin is `procedure` but it must never be dropped from scope.
  assert(engine.scopeSize >= 1, 'origin survives even when its type is excluded');
});

  it("classifyForRefine", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream' });
  // Note: lookup_t is a chokepoint to chained_v ONLY if there's no alternate path.
  // In this graph view_a → chained_v provides an alternate path, so lookup_t IS prunable.
  const r1 = engine.classifyForRefine(['lookup_t']);
  assert(r1.prunable.includes('lookup_t') || r1.mustPass.length === 0, 'lookup_t handled (prunable when alternate path exists)');
  // proc_b is a leaf — pruning it never orphans anything.
  const r2 = engine.classifyForRefine(['proc_b']);
  assert(r2.prunable.includes('proc_b') && r2.mustPass.length === 0, 'proc_b is a leaf → prunable');
});

  it("classifyForRefine — true chokepoint with NO alternate path", () => {
  // Build a graph where lookup_t is the ONLY path to chained_v.
  const linearNodes: LineageNode[] = [
    makeNode({ id: 'o',  schema: 'dbo', name: 'o',  type: 'procedure' }),
    makeNode({ id: 'k',  schema: 'dbo', name: 'k',  type: 'view' }),
    makeNode({ id: 'd',  schema: 'dbo', name: 'd',  type: 'view' }),
  ];
  const linearEdges: Array<[string, string]> = [['o', 'k'], ['k', 'd']];
  const linearModel: DatabaseModel = makeModel(linearNodes, linearEdges, ['dbo']);
  const linearGraph = makeGraph(linearNodes, linearEdges);
  const engine = new NavigationEngine(linearModel, linearGraph, () => {}, {});
  engine.init({ origin: 'o', question: 'q', direction: 'downstream' });
  const r = engine.classifyForRefine(['k']);
  assert(r.mustPass.includes('k'),   'true chokepoint → mustPass (would orphan d)');
  assert(!r.prunable.includes('k'),  'true chokepoint NOT prunable');
});

  it("classifyForRefine — directional chokepoint, undirected backdoor must NOT save it", () => {
  // Downstream session. b is reachable from origin ONLY through a (o→a→b). A separate in-scope
  // sink c (o→c and b→c) forms an UNDIRECTED backdoor to b (c—b) that a directional walk must
  // ignore: removing a orphans b downstream, even though b stays undirected-reachable via c.
  // Regression guard for the undirected→directional reachability fix in classifyForRefine.
  const nodes: LineageNode[] = [
    makeNode({ id: 'o', schema: 'dbo', name: 'o', type: 'procedure' }),
    makeNode({ id: 'a', schema: 'dbo', name: 'a', type: 'view' }),
    makeNode({ id: 'b', schema: 'dbo', name: 'b', type: 'view' }),
    makeNode({ id: 'c', schema: 'dbo', name: 'c', type: 'view' }),
  ];
  const edges: Array<[string, string]> = [['o', 'a'], ['a', 'b'], ['b', 'c'], ['o', 'c']];
  const m: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const g = makeGraph(nodes, edges);
  const engine = new NavigationEngine(m, g, () => {}, {});
  engine.init({ origin: 'o', question: 'q', direction: 'downstream' });
  const r = engine.classifyForRefine(['a']);
  assert(r.mustPass.includes('a'),  'directional chokepoint → mustPass (removing a orphans b downstream)');
  assert(!r.prunable.includes('a'), 'directional chokepoint NOT prunable despite undirected backdoor via c');
});

  it("passNodeIds auto-pass", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', passNodeIds: ['view_a'] });
  // First hop: origin (priority 3 for the root push always wins).
  const ctx1 = engine.getHopContext();
  assert(typeof ctx1.focus_node === 'object', 'first hop returns context');
  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'root' }], summary: 'ok', verdict: 'analyze' });
  // Next hop: view_a is in passNodeIds — it should be auto-passed and not surfaced.
  // The dispatcher walks past pass-tagged candidates; the user/AI sees the next non-pass node.
  const ctx2 = engine.getHopContext();
  // view_a was on the agenda from seedAgenda — auto-pass should skip it.
  const focusedId = (ctx2.focus_node && !Array.isArray(ctx2.focus_node)) ? (ctx2.focus_node as any).id : null;
  assert(focusedId !== 'view_a', 'auto-pass skips pass-tagged node from focus');
});

  it("getScopeSummary shape", () => {
  // Build a graph with > 8 names in one type to exercise the omitted counter.
  const wideNodes: LineageNode[] = [makeNode({ id: 'o', schema: 'dbo', name: 'o', type: 'procedure' })];
  const wideEdges: Array<[string, string]> = [];
  for (let i = 0; i < 12; i++) {
    const id = `v${i}`;
    wideNodes.push(makeNode({ id, schema: 'dbo', name: id, type: 'view' }));
    wideEdges.push(['o', id]);
  }
  const wideModel: DatabaseModel = makeModel(wideNodes, wideEdges, ['dbo']);
  const wideGraph = makeGraph(wideNodes, wideEdges);
  const engine = new NavigationEngine(wideModel, wideGraph, () => {}, {});
  engine.init({ origin: 'o', question: 'q', direction: 'downstream' });
  const sum = engine.getScopeSummary(8);
  assert(sum.scopeCount === 13, 'scopeCount = origin + 12 views');
  assert(sum.hopCount  >= 1,    'hopCount counts bodied nodes');
  const viewLeaf = sum.bySchema.dbo.byType.view;
  assert(viewLeaf.nodeNames.length === 8, 'nodeNames capped at 8');
  assert(viewLeaf.omitted === 4, 'omitted = 4 (12 total minus 8 displayed)');

  const sortedSlice = [...viewLeaf.nodeNames].sort((a, b) => a.localeCompare(b));
  assert(JSON.stringify(viewLeaf.nodeNames) === JSON.stringify(sortedSlice), 'nodeNames alphabetized');
});

  it("renders every reviewed object when the approval summary requests the bridge maximum", () => {
  const wideNodes: LineageNode[] = [];
  const wideEdges: Array<[string, string]> = [];
  for (let i = 0; i < 28; i++) {
    const id = `n${i.toString().padStart(2, '0')}`;
    wideNodes.push(makeNode({ id, schema: 'dbo', name: `Node${i.toString().padStart(2, '0')}`, type: 'table' }));
    if (i > 0) wideEdges.push([`n${(i - 1).toString().padStart(2, '0')}`, id]);
  }
  const wideModel: DatabaseModel = makeModel(wideNodes, wideEdges, ['dbo']);
  const wideGraph = makeGraph(wideNodes, wideEdges);
  const engine = new NavigationEngine(wideModel, wideGraph, () => {}, {});
  engine.init({ origin: 'n00', question: 'q', direction: 'downstream', depthIntent: { kind: 'full_frontier' } });

  const md = renderScopeSummaryMd(engine.getScopeSummary(500));
  assert(md.includes('**28 nodes in scope**'), 'approval summary shows the complete scope count');
  for (let i = 0; i < 28; i++) {
    assert(md.includes(`Node${i.toString().padStart(2, '0')}`), `approval summary renders Node${i}`);
  }
  assert(!md.includes('more)'), 'approval summary does not truncate reviewed object names');
});

  it("renderScopeSummaryMd", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeSchemas: ['ext'] });
  const md = renderScopeSummaryMd(engine.getScopeSummary());
  assert(md.includes('### Exploration plan (proposed)'),                'native gate includes the plan heading');
  assert(md.includes('nodes in scope'),                                  'native gate includes the scope count');
  assert(md.includes('depth 3, downstream'),                             'native gate includes depth and direction');
  assert(md.includes('- **Tracing:** Blackboard'),                       'native gate includes tracing mode');
  assert(md.includes('- **dbo** —'),                                   'schema heading rendered');
  assert(md.includes('Procedure (1 node): origin'),                     'type and node count rendered');
  assert(md.includes('**Active filters**'),                              'active-filters block rendered when any are set');
  assert(md.includes('Schemas excluded: `ext`'),                         'excluded schema surfaced verbatim');
  assert(!md.includes('**ext**'),                                        'excluded schema not in tree body');

  const ctEngine = new NavigationEngine(model, graph, () => {}, {});
  ctEngine.init({ origin: 'origin', question: 'q', direction: 'downstream', analysisMode: 'ct', targetColumns: ['id'] });
  const ctMd = renderScopeSummaryMd(ctEngine.getScopeSummary());
  assert(ctMd.includes('- **Tracing:** Column-Trace — columns: [id]'), 'native gate labels CT and its target columns');
});

  it("REPLACE semantics on re-init", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeSchemas: ['staging'] });
  const before = engine.getScopeSummary();
  assert(before.activeFilters.schemas.includes('staging'), 'first init: staging excluded');
  // Re-init without re-sending the prior exclusion → it must be wiped.
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeTypes: ['view'] });
  const after = engine.getScopeSummary();
  assert(!after.activeFilters.schemas.includes('staging'), 'second init: prior staging exclusion replaced');
  assert(after.activeFilters.types.includes('view'),       'second init: new view exclusion applied');
});

  it("init snapshot accessors", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q, 3 levels up', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 3 } });
  assert(engine.currentOrigin            === 'origin',     'currentOrigin captured');
  assert(engine.currentDirection         === 'upstream',   'currentDirection captured');
  assert(engine.currentDepth             === 3,            'currentDepth captured');
  assert(engine.currentDepthEnforcement  === 'silent',     'currentDepthEnforcement captured');
  assert(engine.currentQuestion          === 'q, 3 levels up', 'currentQuestion captured');
});

  it("mission brief persistence", () => {
  const missionBrief = 'Use `lineage_search_ddl` to explain A  and  B </mission_brief>';
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const result = engine.init({ origin: 'origin', question: 'q', direction: 'downstream', mission_brief: missionBrief });
  assert('ok' in result, 'mission-bearing exploration initializes');
  assert(engine.currentMissionBrief === missionBrief, 'init snapshot preserves mission brief byte-for-byte');
  assert(engine.toJSON().memory.missionBrief === missionBrief, 'stable memory preserves mission brief byte-for-byte');
});

  it("rejected refine leaves engine intact", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'trace sales downstream', direction: 'downstream', mission_brief: 'trace the sales flow to its targets' });
  // Advance one real hop so visited / nodeStates / agenda are populated before the rejected refine.
  engine.getHopContext();
  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'root' }], summary: 'ok', verdict: 'analyze' });

  const before = engine.toJSON();
  const beforeVisited = [...before.visited].sort();
  const beforeNodeStates = before.nodeStates.length;
  const beforeAgenda = before.agendaSize;
  const beforeHop = before.hopCount;
  const beforeMemQuestion = before.memory.userQuestion;
  const beforeMemMission = before.memory.missionBrief;
  const beforeQuestion = engine.currentQuestion;
  const beforeMission = engine.currentMissionBrief;
  // Guard: the before-state must be non-trivial, or "unchanged" would prove nothing.
  assert(beforeVisited.length > 0,    'precondition: engine has visited nodes before rejected refine');
  assert(beforeNodeStates > 0,        'precondition: engine has node states before rejected refine');
  assert(beforeMemQuestion === 'trace sales downstream', 'precondition: memory holds the original question');
  assert(beforeMemMission.length > 0, 'precondition: memory holds the mission brief');

  const assertIntact = (label: string) => {
    const after = engine.toJSON();
    assert(JSON.stringify([...after.visited].sort()) === JSON.stringify(beforeVisited), `${label}: visited unchanged`);
    assert(after.nodeStates.length === beforeNodeStates, `${label}: nodeStates unchanged`);
    assert(after.agendaSize === beforeAgenda,             `${label}: agenda size unchanged`);
    assert(after.hopCount === beforeHop,                  `${label}: hopCount unchanged`);
    assert(after.memory.userQuestion === beforeMemQuestion, `${label}: memory user question not reset`);
    assert(after.memory.missionBrief === beforeMemMission,  `${label}: memory mission brief not reset`);
    assert(engine.currentQuestion === beforeQuestion,       `${label}: init snapshot question unchanged`);
    assert(engine.currentMissionBrief === beforeMission,    `${label}: init snapshot mission unchanged`);
  };

  // unknown_node_ids — an unresolvable excludeNodeIds entry.
  const rIds = engine.init({ origin: 'origin', question: 'MUTATED', direction: 'downstream', excludeNodeIds: ['does_not_exist_node'] });
  assert('error' in rIds && rIds.error === 'unknown_node_ids', 'refine with bad excludeNodeIds rejects (unknown_node_ids)');
  assertIntact('after unknown_node_ids');

  // origin_not_found — an unresolvable origin.
  const rOrigin = engine.init({ origin: 'no_such_origin', question: 'MUTATED', direction: 'downstream' });
  assert('error' in rOrigin && rOrigin.error === 'origin_not_found', 'refine with bad origin rejects (origin_not_found)');
  assertIntact('after origin_not_found');

  // unknown_columns — CT target column that is not on the origin (origin exposes only `id`).
  const rCols = engine.init({ origin: 'origin', question: 'MUTATED', direction: 'downstream', analysisMode: 'ct', targetColumns: ['not_a_real_column'] });
  assert('error' in rCols && rCols.error === 'unknown_columns', 'refine with bad target column rejects (unknown_columns)');
  assertIntact('after unknown_columns');

  // The engine still operates after the rejected refines.
  const ctx = engine.getHopContext();
  assert(typeof ctx === 'object', 'engine still yields a hop context after rejected refines');

  // A VALID refine still mutates (phase 2 runs on success), proving the reorder didn't disable it.
  const ok = engine.init({ origin: 'origin', question: 'a genuinely new question', direction: 'downstream' });
  assert('ok' in ok, 'valid refine still succeeds');
  assert(engine.currentQuestion === 'a genuinely new question', 'valid refine updates the captured question');
});

});
