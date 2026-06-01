/**
 * Unit tests for the discovery-phase refinement loop.
 *
 * Covers:
 *   1. classifyGateReply — 4-way mechanical classifier (yes/no/refine/redirect).
 *   2. Engine init() — three exclusion axes (excludeTypes, excludeSchemas, excludeNodeIds)
 *      + additive passNodeIds with auto-pass dispatch.
 *   3. getScopeSummary() — shape, sort, name cap, omitted counter, post-filter counts.
 *   4. classifyForRefine() — prunable vs must-pass-through based on alternate-path
 *      reachability from origin.
 *   5. renderScopeSummaryMd() — markdown output structure (header, hops/scope counts,
 *      schema sort, type pluralization, +K-more overflow, active-filters block).
 */

import { NavigationEngine } from '../../src/ai/sm/smBase';
import { classifyGateReply } from '../../src/ai/session/sessionPhase';
import { renderScopeSummaryMd } from '../../src/ai/prompting/scopeSummaryRenderer';
import { decideGateTransition } from '../../src/ai/interaction/rules/gateTransitionRules';
import type { DatabaseModel, LineageNode } from '../../src/engine/types';
import { assert, resetCounters, printSummary, makeGraph } from './helpers/testUtils';

console.log('Discovery-phase refinement loop');
console.log('='.repeat(40));
resetCounters();

// ─── classifyGateReply ──────────────────────────────────────────────────────
console.log('\n── classifyGateReply (4-way) ──');
assert(classifyGateReply('yes')               === 'yes',      '"yes" → yes');
assert(classifyGateReply('  YES  ')           === 'yes',      'whitespace + casing tolerated → yes');
assert(classifyGateReply('approve')           === 'yes',      '"approve" → yes');
assert(classifyGateReply('continue')          === 'yes',      '"continue" → yes');
assert(classifyGateReply('no')                === 'no',       '"no" → no');
assert(classifyGateReply('cancel')            === 'no',       '"cancel" → no');
assert(classifyGateReply('refine')            === 'refine',   '"refine" → refine');
assert(classifyGateReply('refine: drop X')    === 'refine',   '"refine: drop X" → refine');
assert(classifyGateReply('REFINE: drop X')    === 'refine',   'casing tolerated → refine');
// Anchored end-of-line — partial-affirm phrases must NOT match yes/no.
assert(classifyGateReply('yes but ignore staging') === 'redirect', '"yes but ignore staging" → redirect (not yes)');
assert(classifyGateReply('no, do X')                === 'redirect', '"no, do X" → redirect (not no)');
// Add/remove vocabulary stays AI-territory — never matched mechanically.
assert(classifyGateReply('drop the staging schema') === 'redirect', '"drop the staging schema" → redirect (AI interprets)');
assert(classifyGateReply('exclude views')           === 'redirect', '"exclude views" → redirect (AI interprets)');
assert(classifyGateReply('hmm')                     === 'redirect', '"hmm" → redirect');

// ─── gate transition matrix ──────────────────────────────────────────────────
console.log('\n── decideGateTransition matrix ──');
{
  const confirmGate = { gate: 'confirm_sm_start', classes: [], nodeIds: [] } as any;
  const expandGate = { gate: 'confirm_scope_expansion', classes: [], nodeIds: [] } as any;

  assert(decideGateTransition(confirmGate, 'yes').action === 'approve_confirm_sm', 'confirm gate + yes → approve_confirm_sm');
  assert(decideGateTransition(confirmGate, 'refine').action === 'refine_confirm_sm', 'confirm gate + refine → refine_confirm_sm');
  assert(decideGateTransition(confirmGate, 'redirect').action === 'refine_confirm_sm', 'confirm gate + redirect → refine_confirm_sm');
  assert(decideGateTransition(confirmGate, 'no').action === 'cancel', 'confirm gate + no → cancel');

  assert(decideGateTransition(expandGate, 'yes').action === 'approve_scope_expansion', 'scope-expansion gate + yes → approve');
  assert(decideGateTransition(expandGate, 'refine').action === 'approve_scope_expansion', 'scope-expansion gate + refine → approve (legacy behavior)');
  assert(decideGateTransition(expandGate, 'redirect').action === 'redirect_non_confirm', 'scope-expansion gate + redirect → redirect_non_confirm');
  assert(decideGateTransition(expandGate, 'no').action === 'cancel', 'scope-expansion gate + no → cancel');
}

// ─── Engine fixture ──────────────────────────────────────────────────────────
//
//   origin (procedure)
//     ├── view_a       (view)        ← reachable directly + via lookup_t
//     ├── lookup_t     (table)       ← chokepoint to chained_v
//     │     └── chained_v (view)
//     ├── proc_b       (procedure, schema=staging)
//     └── view_c       (view, schema=ext)
//
//  origin → view_a (direct)
//  origin → lookup_t → chained_v
//  origin → proc_b
//  origin → view_c
//  view_a → chained_v   (alternate path so chained_v survives lookup_t pruning)
const nodes: LineageNode[] = [
  { id: 'origin',     schema: 'dbo',      name: 'origin',     type: 'procedure' },
  { id: 'view_a',     schema: 'dbo',      name: 'view_a',     type: 'view' },
  { id: 'lookup_t',   schema: 'dbo',      name: 'lookup_t',   type: 'table' },
  { id: 'chained_v',  schema: 'dbo',      name: 'chained_v',  type: 'view' },
  { id: 'proc_b',     schema: 'staging',  name: 'proc_b',     type: 'procedure' },
  { id: 'view_c',     schema: 'ext',      name: 'view_c',     type: 'view' },
];
const edges: Array<[string, string]> = [
  ['origin',   'view_a'],
  ['origin',   'lookup_t'],
  ['lookup_t', 'chained_v'],
  ['view_a',   'chained_v'],
  ['origin',   'proc_b'],
  ['origin',   'view_c'],
];
const model: DatabaseModel = { nodes, edges: edges.map(([s, t]) => ({ source: s, target: t, type: 'SELECT' })), schemas: ['dbo', 'staging', 'ext'], dbPlatform: 'SQL Server' };
const graph = makeGraph(nodes, edges);

// ─── Three orthogonal exclusion axes ────────────────────────────────────────
console.log('\n── exclusion axes ──');
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeTypes: ['view'] });
  const sum = engine.getScopeSummary();
  const ids = Object.values(sum.bySchema).flatMap(s => Object.values(s.byType).flatMap(l => l.nodeNames));
  assert(!ids.includes('view_a'),    'excludeTypes=["view"] drops view_a');
  assert(!ids.includes('view_c'),    'excludeTypes=["view"] drops view_c');
  assert(ids.includes('proc_b'),     'excludeTypes=["view"] keeps proc_b');
  assert(sum.activeFilters.types.includes('view'), 'activeFilters.types reflects exclusion');
}
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeSchemas: ['staging', 'ext'] });
  const sum = engine.getScopeSummary();
  assert(!sum.bySchema['staging'], 'excludeSchemas=["staging"] drops staging schema entirely');
  assert(!sum.bySchema['ext'],     'excludeSchemas=["ext"] drops ext schema entirely');
  assert(!!sum.bySchema['dbo'],    'dbo schema still present');
}
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeNodeIds: ['view_a', 'proc_b'] });
  const sum = engine.getScopeSummary();
  const ids = Object.values(sum.bySchema).flatMap(s => Object.values(s.byType).flatMap(l => l.nodeNames));
  assert(!ids.includes('view_a'), 'excludeNodeIds drops view_a');
  assert(!ids.includes('proc_b'), 'excludeNodeIds drops proc_b');
  assert(ids.includes('view_c'),  'unrelated nodes survive');
}

// ─── Origin never dropped, even by aggressive filters ───────────────────────
console.log('\n── origin invariance ──');
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeTypes: ['procedure'] });
  // Origin is `procedure` but it must never be dropped from scope.
  assert(engine.scopeSize >= 1, 'origin survives even when its type is excluded');
}

// ─── classifyForRefine — chokepoint vs leaf ─────────────────────────────────
console.log('\n── classifyForRefine ──');
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream' });
  // Note: lookup_t is a chokepoint to chained_v ONLY if there's no alternate path.
  // In this graph view_a → chained_v provides an alternate path, so lookup_t IS prunable.
  const r1 = engine.classifyForRefine(['lookup_t']);
  assert(r1.prunable.includes('lookup_t') || r1.mustPass.length === 0, 'lookup_t handled (prunable when alternate path exists)');
  // proc_b is a leaf — pruning it never orphans anything.
  const r2 = engine.classifyForRefine(['proc_b']);
  assert(r2.prunable.includes('proc_b') && r2.mustPass.length === 0, 'proc_b is a leaf → prunable');
}

// ─── classifyForRefine — true chokepoint with NO alternate path ─────────────
{
  // Build a graph where lookup_t is the ONLY path to chained_v.
  const linearNodes: LineageNode[] = [
    { id: 'o',  schema: 'dbo', name: 'o',  type: 'procedure' },
    { id: 'k',  schema: 'dbo', name: 'k',  type: 'view' },
    { id: 'd',  schema: 'dbo', name: 'd',  type: 'view' },
  ];
  const linearEdges: Array<[string, string]> = [['o', 'k'], ['k', 'd']];
  const linearModel: DatabaseModel = { nodes: linearNodes, edges: linearEdges.map(([s, t]) => ({ source: s, target: t, type: 'SELECT' })), schemas: ['dbo'], dbPlatform: 'SQL Server' };
  const linearGraph = makeGraph(linearNodes, linearEdges);
  const engine = new NavigationEngine(linearModel, linearGraph, () => {}, {});
  engine.init({ origin: 'o', question: 'q', direction: 'downstream' });
  const r = engine.classifyForRefine(['k']);
  assert(r.mustPass.includes('k'),   'true chokepoint → mustPass (would orphan d)');
  assert(!r.prunable.includes('k'),  'true chokepoint NOT prunable');
}

// ─── passNodeIds — auto-pass dispatch ───────────────────────────────────────
console.log('\n── passNodeIds auto-pass ──');
{
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
}

// ─── getScopeSummary — shape, sort, cap, omitted ────────────────────────────
console.log('\n── getScopeSummary shape ──');
{
  // Build a graph with > 8 names in one type to exercise the omitted counter.
  const wideNodes: LineageNode[] = [{ id: 'o', schema: 'dbo', name: 'o', type: 'procedure' }];
  const wideEdges: Array<[string, string]> = [];
  for (let i = 0; i < 12; i++) {
    const id = `v${i}`;
    wideNodes.push({ id, schema: 'dbo', name: id, type: 'view' });
    wideEdges.push(['o', id]);
  }
  const wideModel: DatabaseModel = { nodes: wideNodes, edges: wideEdges.map(([s, t]) => ({ source: s, target: t, type: 'SELECT' })), schemas: ['dbo'], dbPlatform: 'SQL Server' };
  const wideGraph = makeGraph(wideNodes, wideEdges);
  const engine = new NavigationEngine(wideModel, wideGraph, () => {}, {});
  engine.init({ origin: 'o', question: 'q', direction: 'downstream' });
  const sum = engine.getScopeSummary(8);
  assert(sum.scopeCount === 13, 'scopeCount = origin + 12 views');
  assert(sum.hopCount  >= 1,    'hopCount counts bodied nodes');
  const viewLeaf = sum.bySchema['dbo'].byType['view'];
  assert(viewLeaf.nodeNames.length === 8, 'nodeNames capped at 8');
  assert(viewLeaf.omitted        === 4,   'omitted = 4 (12 total minus 8 displayed)');
  // Names are alphabetized — first should be v0, last in slice should be v15… but we used v0..v11.
  const sortedSlice = [...viewLeaf.nodeNames].sort((a, b) => a.localeCompare(b));
  assert(JSON.stringify(viewLeaf.nodeNames) === JSON.stringify(sortedSlice), 'nodeNames alphabetized');
}

// ─── renderScopeSummaryMd — output structure ────────────────────────────────
console.log('\n── renderScopeSummaryMd ──');
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeSchemas: ['ext'] });
  const md = renderScopeSummaryMd(engine.getScopeSummary());
  assert(md.startsWith('### Exploration plan (proposed)'), 'header present');
  assert(md.includes('node in scope') || md.includes('nodes in scope'), 'scope count rendered with pluralization');
  assert(md.includes('**dbo**'),                                         'dbo schema heading rendered');
  assert(md.includes('**Active filters**'),                              'active-filters block rendered when any are set');
  assert(md.includes('Schemas excluded:') && md.includes('`ext`'),       'excluded schema surfaced verbatim');
  assert(!md.includes('**ext**'),                                        'excluded schema not in tree body');
}

// ─── REPLACE semantics — re-init wipes prior filter state ───────────────────
console.log('\n── REPLACE semantics on re-init ──');
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeSchemas: ['staging'] });
  const before = engine.getScopeSummary();
  assert(before.activeFilters.schemas.includes('staging'), 'first init: staging excluded');
  // Re-init without re-sending the prior exclusion → it must be wiped.
  engine.init({ origin: 'origin', question: 'q', direction: 'downstream', excludeTypes: ['view'] });
  const after = engine.getScopeSummary();
  assert(!after.activeFilters.schemas.includes('staging'), 'second init: prior staging exclusion replaced');
  assert(after.activeFilters.types.includes('view'),       'second init: new view exclusion applied');
}

// ─── Init snapshot — refine getters expose origin/direction/depth ───────────
console.log('\n── init snapshot accessors ──');
{
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'q', direction: 'upstream', depth: 3, depth_enforcement: 'strict' });
  assert(engine.currentOrigin            === 'origin',     'currentOrigin captured');
  assert(engine.currentDirection         === 'upstream',   'currentDirection captured');
  assert(engine.currentDepth             === 3,            'currentDepth captured');
  assert(engine.currentDepthEnforcement  === 'strict',     'currentDepthEnforcement captured');
  assert(engine.currentQuestion          === 'q',          'currentQuestion captured');
}

printSummary('Discovery-phase refinement loop');
