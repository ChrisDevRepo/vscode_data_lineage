import { suite, test } from 'node:test';
import * as assert from 'assert';
import Graph from 'graphology';
import { NavigationEngine } from '../../src/ai/smBase';
import { prunePreserveOnly } from '../../src/ai/viewPrune';

suite('State Machine Robustness', () => {

  function createMockModelAndGraph() {
    const model = {
      nodes: [
        { id: 'a', name: 'A', schema: 'dbo', type: 'table' },
        { id: 'b', name: 'B', schema: 'dbo', type: 'table' },
        { id: 'c', name: 'C', schema: 'dbo', type: 'table' },
        { id: 'd', name: 'D', schema: 'dbo', type: 'table' }
      ],
      edges: [
        { source: 'a', target: 'b', type: 'read' },
        { source: 'b', target: 'c', type: 'read' },
        { source: 'c', target: 'd', type: 'read' }
      ],
      schemas: [{ name: 'dbo', n: 4, t: 4, v: 0, p: 0 }]
    };

    const graph = new Graph({ directed: true });
    model.nodes.forEach(n => graph.addNode(n.id, n));
    model.edges.forEach(e => graph.addEdge(e.source, e.target, { type: e.type }));

    return { model, graph };
  }

  test('BFS Scope should not collapse and properly calculate bidirectional scope', () => {
    const { model, graph } = createMockModelAndGraph();
    const log = () => {};
    log.debug = () => {}; log.info = () => {}; log.warn = () => {}; log.error = () => {};

    const engine = new NavigationEngine(model as any, graph, log as any, 'blackboard', { qualityGuards: false });
    
    // Test A downstream (A -> B -> C -> D)
    const resA = engine.init({ question: 'trace A', origin: 'a', direction: 'downstream', depth: 3 });
    assert.strictEqual(resA.scopeSize, 4, 'Downstream from A should find all 4 nodes');

    // Test C upstream (A -> B -> C)
    const resC = engine.init({ question: 'trace C', origin: 'c', direction: 'upstream', depth: 2 });
    assert.strictEqual(resC.scopeSize, 3, 'Upstream from C should find A, B, C');
    
    // Test B bidirectional (A -> B -> C)
    const resB = engine.init({ question: 'trace B', origin: 'b', direction: 'bidirectional', depth: 1 });
    assert.strictEqual(resB.scopeSize, 3, 'Bidirectional from B depth 1 should find A, B, C');
  });

  // SM cascade-prune behavior is covered by tests/unit/navigation-engine-cascade.test.ts
  // against a fan-out graph where cascade is observable. The linear A→B→C→D fixture here
  // cannot produce a non-zero `cascaded_count` because `seedAgenda` only admits direct
  // neighbors of the origin — C and D never reach the agenda before B is popped.

  test('SM sliding-memory mode: complete=true is silently ignored (engine owns termination via agenda drain)', () => {
    const { model, graph } = createMockModelAndGraph();
    const log = () => {};
    log.debug = () => {}; log.info = () => {}; log.warn = () => {}; log.error = () => {};

    const engine = new NavigationEngine(model as any, graph, log as any, 'blackboard', { qualityGuards: false });
    // Leave _inlineMode at its default (false) → sliding-memory mode.
    engine.init({ question: 'trace A', origin: 'a', direction: 'downstream', depth: 3 });

    // First hop is the origin (priority 3). 'a' has direct neighbor 'b' still unvisited.
    engine.getHopContext();
    const res = engine.submitFindings({
      focus_node_id: 'a',
      detail_analysis: 'ok',
      summary: 'ok',
      verdict: 'relevant',
      complete: true, // ignored in SM mode — the engine owns termination
    } as any);

    // In SM mode, complete:true is silently ignored. The submit processes normally;
    // termination happens later when getHopContext finds an empty agenda.
    assert.ok(!('error' in res), 'complete=true in SM mode does NOT return an error');
    assert.ok('ok' in res && (res as any).ok === true, 'submit is accepted');
    assert.ok(!(res as any).done, 'done:true is NOT emitted from complete=true in SM mode (engine owns it)');
  });

  test('Inline mode: complete=true returns { done: true, result }', () => {
    const { model, graph } = createMockModelAndGraph();
    const log = () => {};
    log.debug = () => {}; log.info = () => {}; log.warn = () => {}; log.error = () => {};

    const engine = new NavigationEngine(model as any, graph, log as any, 'blackboard', { qualityGuards: false });
    engine.init({ question: 'trace A', origin: 'a', direction: 'downstream', depth: 3 });
    engine.setInlineMode(true);

    engine.getHopContext();
    const res = engine.submitFindings({
      focus_node_id: 'a',
      detail_analysis: 'ok',
      summary: 'ok',
      verdict: 'relevant',
      complete: true,   // ← honored in inline mode
    } as any);

    assert.ok('ok' in res && res.ok === true, 'submit accepted');
    assert.strictEqual((res as any).done, true, 'inline mode honors complete=true');
    assert.ok((res as any).result, 'result payload present when done');
  });

  // ── Scope-budget + consent-gate coverage (plan §A.2, §B, §C) ─────────────────

  function mkFanoutModel() {
    // origin → b (dbo), origin → c (dbo), c → d_ext (ext schema)
    const model = {
      nodes: [
        { id: 'origin', name: 'Origin', schema: 'dbo', type: 'table' },
        { id: 'b', name: 'B', schema: 'dbo', type: 'table' },
        { id: 'c', name: 'C', schema: 'dbo', type: 'table' },
        { id: 'd_ext', name: 'D', schema: 'ext', type: 'table' },
      ],
      edges: [
        { source: 'origin', target: 'b', type: 'read' },
        { source: 'origin', target: 'c', type: 'read' },
        { source: 'c', target: 'd_ext', type: 'read' },
      ],
      schemas: [
        { name: 'dbo', n: 3, t: 3, v: 0, p: 0 },
        { name: 'ext', n: 1, t: 1, v: 0, p: 0 },
      ],
    };
    const graph = new Graph({ directed: true });
    model.nodes.forEach(n => graph.addNode(n.id, n));
    model.edges.forEach(e => graph.addEdge(e.source, e.target, { type: e.type }));
    return { model, graph };
  }

  const nopLog: any = Object.assign(() => {}, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });

  test('A.2 strict mode: route beyond depth cap is rejected via action_required', () => {
    const { model, graph } = mkFanoutModel();
    const engine = new NavigationEngine(model as any, graph, nopLog, 'blackboard', { qualityGuards: false });
    engine.init({ question: 'q', origin: 'origin', direction: 'downstream', depth: 1, depth_enforcement: 'strict' });
    engine.getHopContext();

    const res = engine.submitFindings({
      focus_node_id: 'origin',
      detail_analysis: 'ok',
      summary: 'ok',
      verdict: 'relevant',
      route_requests: [{ nodeId: 'd_ext', question: 'why' }],
    } as any);

    assert.ok('error' in res && (res as any).error === 'action_required', 'strict depth violation raises action_required');
    assert.ok((res as any).classes.some((c: string) => c.startsWith('depth:')), 'classes include depth');
  });

  test('A.2 soft mode: +1 depth auto-expands silently; +2 triggers action_required', () => {
    const { model, graph } = mkFanoutModel();
    const engine = new NavigationEngine(model as any, graph, nopLog, 'blackboard', { qualityGuards: false });
    engine.init({ question: 'q', origin: 'origin', direction: 'downstream', depth: 1, depth_enforcement: 'soft' });
    engine.getHopContext();

    // d_ext is at depth 2 (origin→c→d_ext) — within soft cap (1+1=2), should be accepted silently.
    const res1 = engine.submitFindings({
      focus_node_id: 'origin',
      detail_analysis: 'ok',
      summary: 'ok',
      verdict: 'relevant',
      route_requests: [{ nodeId: 'd_ext', question: 'why' }],
    } as any);
    assert.ok('ok' in res1 && (res1 as any).ok === true, 'soft +1 expansion accepted silently');
  });

  test('B schema gate: out-of-filter route triggers action_required; extendAllowedSchemas re-opens the route', () => {
    const { model, graph } = mkFanoutModel();
    const activeFilter = { schemas: ['dbo'], types: [], searchTerm: '', hideIsolated: false, focusSchemas: [], showExternalRefs: false, externalRefTypes: [], exclusionPatterns: [] } as any;
    const engine = new NavigationEngine(model as any, graph, nopLog, 'blackboard', { qualityGuards: false, activeFilter });
    engine.init({ question: 'q', origin: 'origin', direction: 'downstream', depth: 3, depth_enforcement: 'silent' });
    engine.getHopContext();

    const res1 = engine.submitFindings({
      focus_node_id: 'origin',
      detail_analysis: 'ok', summary: 'ok', verdict: 'relevant',
      route_requests: [{ nodeId: 'd_ext', question: 'why' }],
    } as any);
    assert.ok('error' in res1 && (res1 as any).error === 'action_required', 'schema violation raises action_required');
    assert.ok((res1 as any).classes.includes('schema:ext'), 'classes include schema:ext');

    engine.extendAllowedSchemas('ext');
    const res2 = engine.submitFindings({
      focus_node_id: 'origin',
      detail_analysis: 'ok', summary: 'ok', verdict: 'relevant',
      route_requests: [{ nodeId: 'd_ext', question: 'why' }],
    } as any);
    assert.ok('ok' in res2 && (res2 as any).ok === true, 'after extending allowlist the route passes');
  });

  test('C diagnostics: getHopDiagnostics tracks verdict tally and archive growth across hops', () => {
    const { model, graph } = mkFanoutModel();
    const engine = new NavigationEngine(model as any, graph, nopLog, 'blackboard', { qualityGuards: false });
    engine.init({ question: 'q', origin: 'origin', direction: 'downstream', depth: 2, depth_enforcement: 'silent' });
    engine.getHopContext(); // hop 1 — origin

    engine.submitFindings({ focus_node_id: 'origin', detail_analysis: 'a'.repeat(100), summary: 's'.repeat(10), verdict: 'relevant' } as any);
    const d1 = engine.getHopDiagnostics();
    assert.strictEqual(d1.tally.relevant, 1, 'one relevant recorded');
    assert.strictEqual(d1.archiveChars, 110, 'archive = detail + summary');

    engine.getHopContext(); // hop 2 — b or c
    engine.submitFindings({ focus_node_id: engine.getHopDiagnostics().focus, detail_analysis: 'x'.repeat(50), summary: 'y'.repeat(5), verdict: 'pass' } as any);
    const d2 = engine.getHopDiagnostics();
    assert.strictEqual(d2.tally.relevant, 1);
    assert.strictEqual(d2.tally.pass, 1);
    assert.strictEqual(d2.archiveChars, 110 + 50 + 5, 'archive accumulates across hops');
  });

  suite('prunePreserveOnly (enrich_view prune)', () => {
    test('simple leaf prune drops node and incident edges only', () => {
      const nodeIds = ['A', 'B', 'C'];
      const edges: [string, string, string][] = [['A', 'B', 'read'], ['B', 'C', 'read']];
      const out = prunePreserveOnly(nodeIds, edges, ['C']);
      assert.deepStrictEqual(out.nodeIds, ['A', 'B']);
      assert.deepStrictEqual(out.edges, [['A', 'B', 'read']]);
    });

    test('pruning a shared hub must NOT create phantom edges between siblings', () => {
      // Regression guard: earlier passthrough rewrite walked P as a hub and emitted
      // A→D and C→B — edges that never existed in the original graph.
      const nodeIds = ['A', 'B', 'C', 'D', 'P'];
      const edges: [string, string, string][] = [
        ['A', 'P', 'read'],
        ['C', 'P', 'read'],
        ['P', 'B', 'read'],
        ['P', 'D', 'read'],
      ];
      const out = prunePreserveOnly(nodeIds, edges, ['P']);
      assert.deepStrictEqual(out.nodeIds.sort(), ['A', 'B', 'C', 'D']);
      assert.strictEqual(out.edges.length, 0, 'pruning hub P must drop all its incident edges; no phantoms');
    });

    test('pruning nothing returns the inputs unchanged (shape-equivalent)', () => {
      const nodeIds = ['A', 'B'];
      const edges: [string, string, string][] = [['A', 'B', 'write']];
      const out = prunePreserveOnly(nodeIds, edges, []);
      assert.deepStrictEqual(out.nodeIds, nodeIds);
      assert.deepStrictEqual(out.edges, edges);
    });

    test('pruning a node not present is a no-op on nodeIds and edges', () => {
      const nodeIds = ['A', 'B'];
      const edges: [string, string, string][] = [['A', 'B', 'read']];
      const out = prunePreserveOnly(nodeIds, edges, ['Z']);
      assert.deepStrictEqual(out.nodeIds, ['A', 'B']);
      assert.deepStrictEqual(out.edges, edges);
    });
  });
});