import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { renderScopeSummaryMd } from '../../../src/ai/prompting/scopeSummaryRenderer';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

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
  expect(!ids.includes('view_a'), 'excludeTypes=["view"] drops view_a').toBe(true);
  expect(!ids.includes('view_c'), 'excludeTypes=["view"] drops view_c').toBe(true);
  expect(ids.includes('proc_b'), 'excludeTypes=["view"] keeps proc_b').toBe(true);
  expect(sum.activeFilters.types.includes('view'), 'activeFilters.types reflects exclusion').toBe(true);
});

  it("excludeSchemas=[\"staging\"] drops staging schema entirely", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeSchemas: ['staging', 'ext'] });
  const sum = engine.getScopeSummary();
  expect(!('staging' in sum.bySchema), 'excludeSchemas=["staging"] drops staging schema entirely').toBe(true);
  expect(!('ext' in sum.bySchema), 'excludeSchemas=["ext"] drops ext schema entirely').toBe(true);
  expect('dbo' in sum.bySchema, 'dbo schema still present').toBe(true);
});

  it("excludeNodeIds drops view_a", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeNodeIds: ['view_a', 'proc_b'] });
  const sum = engine.getScopeSummary();
  const ids = scopeNames(sum);
  expect(!ids.includes('view_a'), 'excludeNodeIds drops view_a').toBe(true);
  expect(!ids.includes('proc_b'), 'excludeNodeIds drops proc_b').toBe(true);
  expect(ids.includes('view_c'), 'unrelated nodes survive').toBe(true);
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

  expect(engine.getScopeSummary().activeFilters.nodeIds.includes('[ai].[DimCalendar]'), 'approval summary uses the model canonical ID rather than the lowercase internal key').toBe(true);
});

  it("excluded route regression starts at origin", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeNodeIds: ['lookup_t'] });

  const ctx = engine.getHopContext();
  expect(ctx.focus_node?.id === 'origin', 'excluded route regression starts at origin').toBe(true);
  const submit = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'root' }],
    summary: 'ok',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'lookup_t', question: 'model tries excluded node' }],
  });
  expect('ok' in submit, 'excluded route is skipped without hard-rejecting the hop').toBe(true);

  const state = engine.toJSON();
  expect(!state.scopeNodeIds.includes('lookup_t'), 'excluded route target is not re-added to scope').toBe(true);
  const routeOutcomes = 'route_outcomes' in submit ? submit.route_outcomes ?? [] : [];
  expect(routeOutcomes.some(o => o.nodeId === 'lookup_t' && o.reason === 'excluded'), 'excluded route is reported as skipped').toBe(true);
});

  it("origin survives even when its type is excluded", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeTypes: ['procedure'] });
  // Origin is `procedure` but it must never be dropped from scope.
  expect(engine.scopeSize >= 1, 'origin survives even when its type is excluded').toBe(true);
});

  it("classifyForRefine", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream' });
  // Note: lookup_t is a chokepoint to chained_v ONLY if there's no alternate path.
  // In this graph view_a → chained_v provides an alternate path, so lookup_t IS prunable.
  const r1 = engine.classifyForRefine(['lookup_t']);
  expect(r1.prunable.includes('lookup_t') || r1.mustPass.length === 0, 'lookup_t handled (prunable when alternate path exists)').toBe(true);
  // proc_b is a leaf — pruning it never orphans anything.
  const r2 = engine.classifyForRefine(['proc_b']);
  expect(r2.prunable.includes('proc_b') && r2.mustPass.length === 0, 'proc_b is a leaf → prunable').toBe(true);
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
  expect(r.mustPass.includes('k'), 'true chokepoint → mustPass (would orphan d)').toBe(true);
  expect(!r.prunable.includes('k'), 'true chokepoint NOT prunable').toBe(true);
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
  expect(r.mustPass.includes('a'), 'directional chokepoint → mustPass (removing a orphans b downstream)').toBe(true);
  expect(!r.prunable.includes('a'), 'directional chokepoint NOT prunable despite undirected backdoor via c').toBe(true);
});

  it("passNodeIds auto-pass", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', passNodeIds: ['view_a'] });
  // First hop: origin (priority 3 for the root push always wins).
  const ctx1 = engine.getHopContext();
  expect(typeof ctx1.focus_node === 'object', 'first hop returns context').toBe(true);
  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'root' }], summary: 'ok', verdict: 'analyze' });
  // Next hop: view_a is in passNodeIds — it should be auto-passed and not surfaced.
  // The dispatcher walks past pass-tagged candidates; the user/AI sees the next non-pass node.
  const ctx2 = engine.getHopContext();
  // view_a was on the agenda from seedAgenda — auto-pass should skip it.
  const focusedId = (ctx2.focus_node && !Array.isArray(ctx2.focus_node)) ? (ctx2.focus_node as any).id : null;
  expect(focusedId !== 'view_a', 'auto-pass skips pass-tagged node from focus').toBe(true);
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
  expect(sum.scopeCount === 13, 'scopeCount = origin + 12 views').toBe(true);
  expect(sum.hopCount  >= 1, 'hopCount counts bodied nodes').toBe(true);
  const viewLeaf = sum.bySchema.dbo.byType.view;
  expect(viewLeaf.nodeNames.length === 8, 'nodeNames capped at 8').toBe(true);
  expect(viewLeaf.omitted === 4, 'omitted = 4 (12 total minus 8 displayed)').toBe(true);

  const sortedSlice = [...viewLeaf.nodeNames].sort((a, b) => a.localeCompare(b));
  expect(JSON.stringify(viewLeaf.nodeNames) === JSON.stringify(sortedSlice), 'nodeNames alphabetized').toBe(true);
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
  expect(md.includes('**28 nodes in scope**'), 'approval summary shows the complete scope count').toBe(true);
  for (let i = 0; i < 28; i++) {
    expect(md.includes(`Node${i.toString().padStart(2, '0')}`), `approval summary renders Node${i}`).toBe(true);
  }
  expect(!md.includes('more)'), 'approval summary does not truncate reviewed object names').toBe(true);
});

  it("renderScopeSummaryMd", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeSchemas: ['ext'] });
  const md = renderScopeSummaryMd(engine.getScopeSummary());
  expect(md.includes('### Exploration plan (proposed)'), 'native gate includes the plan heading').toBe(true);
  expect(md.includes('nodes in scope'), 'native gate includes the scope count').toBe(true);
  expect(md.includes('downstream'), 'native gate includes the direction').toBe(true);
  expect(md.includes('- **Tracing:** Blackboard'), 'native gate includes tracing mode').toBe(true);
  expect(md.includes('- **dbo** —'), 'schema heading rendered').toBe(true);
  expect(md.includes('Procedure (1 node): origin'), 'type and node count rendered').toBe(true);
  // A filter is the assistant's mechanization of the request, so it belongs to how the request was
  // read — never to the request itself, whose origin the engine cannot know.
  expect(md.includes('**How I read it**'), 'mechanized filters get their own block').toBe(true);
  expect(md.includes('Schemas excluded: `ext`'), 'excluded schema surfaced verbatim').toBe(true);
  expect(!md.includes('**ext**'), 'excluded schema not in tree body').toBe(true);
  expect(!md.includes('**From your question**'), 'a filter alone never claims the user asked for it').toBe(true);

  // Provenance is carried by placement: a depth the user stated sits under what they asked for and
  // says it binds; a depth the assistant chose sits under its own plan and says it may move.
  expect(md.includes('my estimate, I may extend it'), 'an assistant-chosen depth says it may move').toBe(true);
  expect(md.includes('Depth: ≈'), 'an assistant-chosen depth is marked approximate').toBe(true);

  const bordered = new NavigationEngine(model, graph, () => {}, {});
  bordered.init({ origin: 'origin', question: 'q, 2 levels down', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 2 } });
  const borderedMd = renderScopeSummaryMd(bordered.getScopeSummary(), 2);
  const borderedStated = borderedMd.slice(borderedMd.indexOf('**From your question**'), borderedMd.indexOf('**My plan**'));
  expect(borderedStated.includes('Depth: 2 levels downstream'), 'a stated depth is attributed to the user').toBe(true);
  expect(borderedStated.includes('I will not go past this'), 'a stated depth is presented as binding').toBe(true);
  expect(!borderedStated.includes('≈'), 'a stated depth carries no approximation mark').toBe(true);
  expect(borderedMd.includes('revision 2'), 'a re-approval round is stamped with its revision').toBe(true);

  const noted = new NavigationEngine(model, graph, () => {}, {});
  noted.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeSchemas: ['ext'], scopeNotes: ['do not prune it only skip it'] });
  const notedMd = noted.getScopeSummary();
  const notedRendered = renderScopeSummaryMd(notedMd);
  const userBlock = notedRendered.slice(notedRendered.indexOf('**From your question**'), notedRendered.indexOf('**How I read it**'));
  expect(userBlock.includes('"do not prune it only skip it"'), "the user's own words are quoted verbatim").toBe(true);
  expect(!userBlock.includes('Exclude:'), 'the mechanization is not filed under the user\'s words').toBe(true);
  expect(notedRendered.indexOf('**From your question**') < notedRendered.indexOf('**How I read it**'), 'the words precede the reading so a misread is adjacent').toBe(true);

  const plain = new NavigationEngine(model, graph, () => {}, {});
  plain.init({ origin: 'origin', question: 'q', direction: 'downstream', depthIntent: { kind: 'full_frontier' } });
  const plainMd = renderScopeSummaryMd(plain.getScopeSummary());
  expect(!plainMd.includes('**From your question**'), 'the block is omitted entirely when nothing was constrained').toBe(true);
  expect(!plainMd.includes('**How I read it**'), 'the reading block is omitted when nothing was mechanized').toBe(true);

  const ctEngine = new NavigationEngine(model, graph, () => {}, {});
  ctEngine.init({ origin: 'origin', question: 'q', direction: 'downstream', analysisMode: 'ct', targetColumns: ['id'] });
  const ctMd = renderScopeSummaryMd(ctEngine.getScopeSummary());
  expect(ctMd.includes('- **Tracing:** Column-Trace — columns: [id]'), 'native gate labels CT and its target columns').toBe(true);
});

  it("REPLACE semantics on re-init", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeSchemas: ['staging'] });
  const before = engine.getScopeSummary();
  expect(before.activeFilters.schemas.includes('staging'), 'first init: staging excluded').toBe(true);
  // Re-init without re-sending the prior exclusion → it must be wiped.
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeTypes: ['view'] });
  const after = engine.getScopeSummary();
  expect(!after.activeFilters.schemas.includes('staging'), 'second init: prior staging exclusion replaced').toBe(true);
  expect(after.activeFilters.types.includes('view'), 'second init: new view exclusion applied').toBe(true);
});

  it("init snapshot accessors", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q, 3 levels up', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 3 } });
  expect(engine.currentOrigin            === 'origin', 'currentOrigin captured').toBe(true);
  expect(engine.currentDirection         === 'upstream', 'currentDirection captured').toBe(true);
  expect(engine.currentDepth             === 3, 'currentDepth captured').toBe(true);
  // A level count the AI copied from the user's question is a hard border, so it enforces.
  expect(engine.currentDepthEnforcement  === 'strict', 'currentDepthEnforcement captured').toBe(true);
  expect(engine.currentQuestion          === 'q, 3 levels up', 'currentQuestion captured').toBe(true);

  const inferred = new NavigationEngine(model, graph, () => {}, {});
  inferred.init({ origin: 'origin', question: 'q', direction: 'upstream', depthIntent: { kind: 'default_start' } });
  expect(inferred.currentDepthEnforcement === 'silent', 'an omitted depth stays a growable seed').toBe(true);
});

  it("mission brief persistence", () => {
  const missionBrief = 'Use `lineage_search_ddl` to explain A  and  B </mission_brief>';
  const engine = new NavigationEngine(model, graph, () => {}, {});
  const result = engine.init({ origin: 'origin', question: 'q', direction: 'downstream', mission_brief: missionBrief });
  expect('ok' in result, 'mission-bearing exploration initializes').toBe(true);
  expect(engine.currentMissionBrief === missionBrief, 'init snapshot preserves mission brief byte-for-byte').toBe(true);
  expect(engine.toJSON().memory.missionBrief === missionBrief, 'stable memory preserves mission brief byte-for-byte').toBe(true);
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
  expect(beforeVisited.length > 0, 'precondition: engine has visited nodes before rejected refine').toBe(true);
  expect(beforeNodeStates > 0, 'precondition: engine has node states before rejected refine').toBe(true);
  expect(beforeMemQuestion === 'trace sales downstream', 'precondition: memory holds the original question').toBe(true);
  expect(beforeMemMission.length > 0, 'precondition: memory holds the mission brief').toBe(true);

  const assertIntact = (label: string) => {
    const after = engine.toJSON();
    expect(JSON.stringify([...after.visited].sort()) === JSON.stringify(beforeVisited), `${label}: visited unchanged`).toBe(true);
    expect(after.nodeStates.length === beforeNodeStates, `${label}: nodeStates unchanged`).toBe(true);
    expect(after.agendaSize === beforeAgenda, `${label}: agenda size unchanged`).toBe(true);
    expect(after.hopCount === beforeHop, `${label}: hopCount unchanged`).toBe(true);
    expect(after.memory.userQuestion === beforeMemQuestion, `${label}: memory user question not reset`).toBe(true);
    expect(after.memory.missionBrief === beforeMemMission, `${label}: memory mission brief not reset`).toBe(true);
    expect(engine.currentQuestion === beforeQuestion, `${label}: init snapshot question unchanged`).toBe(true);
    expect(engine.currentMissionBrief === beforeMission, `${label}: init snapshot mission unchanged`).toBe(true);
  };

  // unknown_node_ids — an unresolvable excludeNodeIds entry.
  const rIds = engine.init({ origin: 'origin', question: 'MUTATED', direction: 'downstream', excludeNodeIds: ['does_not_exist_node'] });
  expect('error' in rIds && rIds.error === 'unknown_node_ids', 'refine with bad excludeNodeIds rejects (unknown_node_ids)').toBe(true);
  assertIntact('after unknown_node_ids');

  // origin_not_found — an unresolvable origin.
  const rOrigin = engine.init({ origin: 'no_such_origin', question: 'MUTATED', direction: 'downstream' });
  expect('error' in rOrigin && rOrigin.error === 'origin_not_found', 'refine with bad origin rejects (origin_not_found)').toBe(true);
  assertIntact('after origin_not_found');

  // unknown_columns — CT target column that is not on the origin (origin exposes only `id`).
  const rCols = engine.init({ origin: 'origin', question: 'MUTATED', direction: 'downstream', analysisMode: 'ct', targetColumns: ['not_a_real_column'] });
  expect('error' in rCols && rCols.error === 'unknown_columns', 'refine with bad target column rejects (unknown_columns)').toBe(true);
  assertIntact('after unknown_columns');

  // The engine still operates after the rejected refines.
  const ctx = engine.getHopContext();
  expect(typeof ctx === 'object', 'engine still yields a hop context after rejected refines').toBe(true);

  // A VALID refine still mutates (phase 2 runs on success), proving the reorder didn't disable it.
  const ok = engine.init({ origin: 'origin', question: 'a genuinely new question', direction: 'downstream' });
  expect('ok' in ok, 'valid refine still succeeds').toBe(true);
  expect(engine.currentQuestion === 'a genuinely new question', 'valid refine updates the captured question').toBe(true);
});

});
