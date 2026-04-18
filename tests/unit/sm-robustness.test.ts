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

  test('SM sliding-memory mode: complete=true is rejected until all direct neighbors of origin are visited', () => {
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
      complete: true,
    } as any);

    assert.ok('error' in res, 'submit rejected with error');
    assert.strictEqual((res as any).error, 'complete_rejected', 'complete=true rejected while direct neighbors unvisited');
    const detail = (res as any).detail;
    assert.ok(Array.isArray(detail.unvisited_direct_neighbors), 'detail lists unvisited_direct_neighbors');
    assert.ok(detail.unvisited_direct_neighbors.length > 0, 'at least one unvisited direct neighbor reported');
    assert.ok(typeof detail.hint === 'string' && detail.hint.length > 0, 'detail includes hint text');
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