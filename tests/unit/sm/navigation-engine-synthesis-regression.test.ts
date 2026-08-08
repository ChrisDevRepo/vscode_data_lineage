import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { assert, makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, it } from 'vitest';

describe("Navigation Engine Synthesis Regression", () => {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
    makeNode({ id: 'a', schema: 'dbo', name: 'a', type: 'procedure' }),
    makeNode({ id: 'b', schema: 'dbo', name: 'b', type: 'procedure' }),
  ];
  const edges: Array<[string, string]> = [
    ['origin', 'a'],
    ['a', 'b'],
  ];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'regression check', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 4 } });
  // NOTE (conversion fix): the donor script read a single reassigned `let ctx` at three points
  // in one top-to-bottom pass. Native vitest runs describe-body setup once during collection and
  // defers every it() callback to a later run phase, so all three it()s would have observed only
  // the FINAL value of a shared `let` — silently making "Hop 1"/"Hop 2" check hop 3's context
  // instead of their own. Each checkpoint is snapshotted into its own const immediately after the
  // engine call that produces it, preserving the exact sequential engine mutations and exactly
  // which snapshot each assertion checks.
  const hop1Ctx = engine.getHopContext() as any;
  it("Hop 1 focus is origin", () => { assert(hop1Ctx.focus_node?.id === 'origin', 'Hop 1 focus is origin'); });

  engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'origin' }],
    summary: 'origin done',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: 'analyze a' }],
  });
  const hop2Ctx = engine.getHopContext() as any;
  it("Hop 2 focus is a", () => { assert(hop2Ctx.focus_node?.id === 'a', 'Hop 2 focus is a'); });

  engine.submitFindings({
    focus_node_id: 'a',
    sections: [{ angle: 'business' as const, text: 'a' }],
    summary: 'a done',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'b', question: 'analyze b' }],
  });
  const hop3Ctx = engine.getHopContext() as any;
  it("Hop 3 focus is b", () => { assert(hop3Ctx.focus_node?.id === 'b', 'Hop 3 focus is b'); });

  const invalidPrune = engine.submitFindings({
    focus_node_id: 'b',
    sections: [{ angle: 'business' as const, text: 'b' }],
    summary: 'b done',
    verdict: 'analyze',
    prune_neighbors: ['a', '[dbo].[doesNotExist]'],
  }) as any;
  it("refused no-op prunes do not reject the hop", () => { assert('ok' in invalidPrune, 'refused no-op prunes do not reject the hop'); });

  it("already analyzed prune notice is visible", () => { assert(engine.toJSON().memory.recentRejections.some((r) => r.nodeId === 'a'), 'already analyzed prune notice is visible'); });

  it("unknown prune notice is visible", () => { assert(engine.toJSON().memory.recentRejections.some((r) => r.nodeId === '[dbo].[doesNotExist]'), 'unknown prune notice is visible'); });

  const result = engine.getResult();
  const nodeIds = new Set(result.fullNodes.map(n => n.id));
  it("Previously analyzed node \"a\" is retained in final result graph", () => { assert(nodeIds.has('a'), 'Previously analyzed node "a" is retained in final result graph'); });

  it("Origin is retained in final result graph", () => { assert(nodeIds.has('origin'), 'Origin is retained in final result graph'); });

  it("Terminal analyzed node is retained in final result graph", () => { assert(nodeIds.has('b'), 'Terminal analyzed node is retained in final result graph'); });

  const slotIds = result.detail_slots.map(s => s.nodeId);
  it("every detail slot is grounded in result fullNodes", () => {
    for (const id of slotIds) {
      assert(nodeIds.has(id), `Detail slot ${id} is grounded in result fullNodes`);
    }
  });

  it("Dedicated origin-prune probe: the immutable origin rejects atomically with a stable field code.", () => {
  const originEngine = new NavigationEngine(model, graph, () => {}, {});
  originEngine.init({ origin: 'origin', question: 'origin prune regression', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 4 } });
  const originCtx = originEngine.getHopContext() as any;
  assert(originCtx.focus_node?.id === 'origin', 'origin-prune probe: first focus is origin');
  const result = originEngine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'origin' }],
    summary: 'origin done',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: 'analyze a' }],
    prune_neighbors: ['origin'],
  }) as any;
  assert('error' in result && result.error === 'prune_origin_forbidden', 'origin prune retains its fatal code');
  assert(!originEngine.toJSON().removedSet.includes('origin'), 'origin is never removed');
  assert(originEngine.toJSON().memory.detailSlots.origin === undefined, 'origin prune rejection commits no detail');
});

});
