import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { bfsReachable, firstDisconnectedRequiredNode } from '../../../src/engine/graphGuards';
import { assert, makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, it } from 'vitest';

describe("Navigation Engine — node conservation", () => {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
    makeNode({ id: 'a',      schema: 'dbo', name: 'a',      type: 'view' }),
    makeNode({ id: 'b',      schema: 'dbo', name: 'b',      type: 'view' }),
    makeNode({ id: 'c',      schema: 'dbo', name: 'c',      type: 'view' }),
  ];
  const edges: Array<[string, string]> = [
    ['origin', 'a'],
    ['a', 'b'],
    ['b', 'c'],
  ];
  const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
  const graph = makeGraph(nodes, edges);
  function driveWalk(engine: NavigationEngine): void {
    let ctx = engine.getHopContext();
    let guard = 0;
    while (!('done' in ctx && ctx.done) && 'focus_node' in ctx && ctx.focus_node && guard++ < 50) {
      const nid = ctx.focus_node.id as string;
      const route_requests = (ctx.neighbors ?? [])
        .filter((n) => n.edge_direction === 'downstream')
        .map((n) => ({ nodeId: n.id, question: 'trace' }));
      engine.submitFindings({
        focus_node_id: nid,
        sections: [{ angle: 'business' as const, text: nid }],
        summary: nid,
        verdict: 'analyze',
        route_requests,
      });
      ctx = engine.getHopContext();
    }
  }
  it("The render set equals origin-reachable, and no committed detail slot is dropped.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'conservation', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 5 } });
  driveWalk(engine);

  const result = engine.getResult();
  const rendered = new Set(result.fullNodes.map((n) => n.id));
  const state = engine.toJSON();
  const reachable = bfsReachable(graph, 'origin', new Set(state.removedSet), undefined, new Set(state.scopeNodeIds));
  reachable.add('origin');

  for (const id of reachable) assert(rendered.has(id), `reachable node ${id} is in the render set`);
  for (const id of rendered) assert(reachable.has(id), `rendered node ${id} is origin-reachable (no phantom)`);

  // Every committed detail slot resolves to a rendered node — zero silent slot loss.
  for (const slot of result.detail_slots) {
    assert(rendered.has(slot.nodeId), `detail slot for ${slot.nodeId} survives into the render (no silent loss)`);
  }
  assert(rendered.has('c'), 'the deepest analyzed node survives (full-chain conservation)');
});

  it("required-connected, so nothing on the live path is lost between the ledger and the render.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'committed-set conservation', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 5 } });

  // Dispatch then analyze origin (routes a), then dispatch then analyze a (routes b). A focus must be
  // dispatched via getHopContext() before submitFindings will commit against it. Stop before b is
  // dispatched, so b stays queued-unvisited (committed via the agenda, never analyzed).
  const focus1 = engine.getHopContext();
  assert('focus_node' in focus1 && focus1.focus_node?.id === 'origin', 'first dispatched focus is origin');
  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'o' }], summary: 'o', verdict: 'analyze', route_requests: [{ nodeId: 'a', question: '?' }] });
  const focus2 = engine.getHopContext();
  assert('focus_node' in focus2 && focus2.focus_node?.id === 'a', 'second dispatched focus is a');
  engine.submitFindings({ focus_node_id: 'a', sections: [{ angle: 'business' as const, text: 'a' }], summary: 'a', verdict: 'analyze', route_requests: [{ nodeId: 'b', question: '?' }] });

  // b is now committed (queued, unvisited). The render must still carry origin, a, and b.
  const result = engine.getResult();
  const rendered = new Set(result.fullNodes.map((n) => n.id));
  for (const id of ['origin', 'a', 'b']) assert(rendered.has(id), `${id} kept in the render (committed-set conservation)`);

  // Widened-guard mechanism: reconstruct the engine's committed set K exactly as `committedConnectedIds()` does
  // (noted ∪ agenda) from the observable snapshot, and show it makes b visible to the orphan guard.
  const snap = engine.toJSON();
  const noted = new Set<string>(Object.keys(snap.memory.detailSlots));
  const committed = new Set<string>([...noted, ...snap.agenda.map((e) => e.nodeId)]);
  const scope = new Set<string>(snap.scopeNodeIds);
  assert(committed.has('b') && !noted.has('b'), 'b is committed via the agenda, not via noted (the widening is what admits it)');

  // Removing a's connectivity orphans the queued b. The widened committed set flags b as disconnected
  // (→ prune_would_orphan_noted); a noted-only set would return null and wave the prune through,
  // silently dropping b's detail slot — the exact regression the widened guard prevents.
  const removedIfAPruned = new Set<string>([...snap.removedSet, 'a']);
  assert(
    firstDisconnectedRequiredNode(graph, 'origin', removedIfAPruned, committed, scope) === 'b',
    'committed-set guard flags queued b as orphaned when its connector is pruned',
  );
  assert(
    firstDisconnectedRequiredNode(graph, 'origin', removedIfAPruned, noted, scope) === null,
    'noted-only set would MISS the queued orphan (documents the pre-widening silent-loss gap)',
  );
});

  it("reactivate articulation node b and attempt to prune it.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'self-prune orphan', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 5 } });

  const focus1 = engine.getHopContext();
  assert('focus_node' in focus1 && focus1.focus_node?.id === 'origin', 'first focus is origin');
  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'o' }], summary: 'o', verdict: 'analyze', route_requests: [{ nodeId: 'a', question: '?' }] });

  const focus2 = engine.getHopContext();
  assert('focus_node' in focus2 && focus2.focus_node?.id === 'a', 'second focus is a');
  engine.submitFindings({ focus_node_id: 'a', sections: [{ angle: 'business' as const, text: 'a' }], summary: 'a', verdict: 'analyze', route_requests: [{ nodeId: 'b', question: '?' }] });

  const focus3 = engine.getHopContext();
  assert('focus_node' in focus3 && focus3.focus_node?.id === 'b', 'third focus is b');
  engine.submitFindings({ focus_node_id: 'b', sections: [{ angle: 'business' as const, text: 'b' }], summary: 'b', verdict: 'analyze', route_requests: [{ nodeId: 'c', question: '?' }] });
  const focus4 = engine.getHopContext();
  assert('focus_node' in focus4 && focus4.focus_node?.id === 'c', 'fourth focus is c');
  engine.submitFindings({ focus_node_id: 'c', sections: [{ angle: 'business' as const, text: 'c' }], summary: 'c', verdict: 'analyze' });
  assert(engine.getHopContext().done === true, 'chain completes before articulation reactivation');
  const supplemented = engine.supplementAgenda(['b']);
  assert('ok' in supplemented && supplemented.agendaed === 1, 'b is reactivated for the self-prune probe');
  const reactivated = engine.getHopContext();
  assert('focus_node' in reactivated && reactivated.focus_node?.id === 'b', 'reactivated focus is b');
  const beforeReject = JSON.stringify(engine.toJSON());

  // b is c's only connector in this graph. A real self-prune of b must be rejected because the
  // already-analyzed c would be orphaned from origin.
  const result = engine.submitFindings({ focus_node_id: 'b', sections: [{ angle: 'business' as const, text: 'b' }], summary: 'b', verdict: 'prune' });
  assert('error' in result && result.error === 'prune_would_orphan_noted', 'a real submitFindings self-prune of b is rejected end-to-end');
  const state = engine.toJSON();
  assert(!state.removedSet.includes('b'), 'the rejected self-prune leaves b unremoved');
  assert(JSON.stringify(state) === beforeReject, 'rejected self-prune commits zero engine state');
});

  it("observable nonfatal notices and preserves both targets.", () => {
  const localNodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
    makeNode({ id: 'a',      schema: 'dbo', name: 'a',      type: 'view' }),
    makeNode({ id: 'b',      schema: 'dbo', name: 'b',      type: 'view' }),
    makeNode({ id: 'd',      schema: 'dbo', name: 'd',      type: 'view' }),
  ];
  const localEdges: Array<[string, string]> = [['origin', 'a'], ['a', 'b'], ['origin', 'd']];
  const localModel: DatabaseModel = makeModel(localNodes, localEdges, ['dbo']);
  const localGraph = makeGraph(localNodes, localEdges);

  const engine = new NavigationEngine(localModel, localGraph, () => {}, {});
  engine.init({ origin: 'origin', question: 'prune_neighbors protects a committed node', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 5 } });

  engine.getHopContext();
  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'o' }], summary: 'o', verdict: 'analyze', route_requests: [{ nodeId: 'a', question: '?' }, { nodeId: 'd', question: '?' }] });
  engine.getHopContext();
  engine.submitFindings({ focus_node_id: 'a', sections: [{ angle: 'business' as const, text: 'a' }], summary: 'a', verdict: 'analyze', route_requests: [{ nodeId: 'b', question: '?' }] });
  // d was explicitly routed one hop earlier than b, so routed-priority FIFO dispatches it first.
  const focusD = engine.getHopContext();
  assert('focus_node' in focusD && focusD.focus_node?.id === 'd', 'earlier promoted route d dispatches before later promoted b');
  engine.submitFindings({ focus_node_id: 'd', sections: [{ angle: 'business' as const, text: 'd' }], summary: 'd', verdict: 'analyze', route_requests: [] });
  const focusB = engine.getHopContext();
  assert('focus_node' in focusB && focusB.focus_node?.id === 'b', 'b dispatches after the earlier routed sibling');
  engine.submitFindings({ focus_node_id: 'b', sections: [{ angle: 'business' as const, text: 'b' }], summary: 'b', verdict: 'analyze', route_requests: [] });
  assert(engine.getHopContext().done === true, 'initial exploration completes before the committed-node prune probe');

  // Reactivate d after b is committed so the real prune_neighbors path still exercises its guard.
  const supplement = engine.supplementAgenda(['d']);
  assert('ok' in supplement, 'd can be reactivated for the committed-node prune probe');
  const reactivatedD = engine.getHopContext();
  assert('focus_node' in reactivatedD && reactivatedD.focus_node?.id === 'd', 'reactivated d is the supplement focus');

  const result = engine.submitFindings({ focus_node_id: 'd', sections: [{ angle: 'business' as const, text: 'd' }], summary: 'd', verdict: 'analyze', route_requests: [], prune_neighbors: ['b', 'ghost_node'] }) as any;
  assert('ok' in result, 'committed and unknown prune targets are nonfatal notices');
  const state = engine.toJSON();
  assert(!state.removedSet.includes('b'), 'a committed node is never removed via prune_neighbors');
  assert(state.memory.recentRejections.some((r) => r.nodeId === 'b'), 'committed-node prune notice is visible');
  assert(state.memory.recentRejections.some((r) => r.nodeId === 'ghost_node'), 'unknown prune notice is visible');
});

  it("accepts a safe multi-target prune batch in one submit (batched conservation fast path).", () => {
  // Star topology: origin → hub → {keep, x1, x2, x3}, approved depth 1 so the leaves sit OUTSIDE
  // the approved scope — the only class the prune policy accepts (in-scope neighbors must be
  // routed instead). Pruning the three out-of-scope siblings in one submit_findings must accept
  // all of them via the batched single-BFS fast path while the routed sibling stays connected —
  // identical outcome to the previous per-candidate walks.
  const localNodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
    makeNode({ id: 'hub',    schema: 'dbo', name: 'hub',    type: 'view' }),
    makeNode({ id: 'keep',   schema: 'dbo', name: 'keep',   type: 'view' }),
    makeNode({ id: 'x1',     schema: 'dbo', name: 'x1',     type: 'view' }),
    makeNode({ id: 'x2',     schema: 'dbo', name: 'x2',     type: 'view' }),
    makeNode({ id: 'x3',     schema: 'dbo', name: 'x3',     type: 'view' }),
  ];
  const localEdges: Array<[string, string]> = [
    ['origin', 'hub'], ['hub', 'keep'], ['hub', 'x1'], ['hub', 'x2'], ['hub', 'x3'],
  ];
  const localModel: DatabaseModel = makeModel(localNodes, localEdges, ['dbo']);
  const localGraph = makeGraph(localNodes, localEdges);

  const engine = new NavigationEngine(localModel, localGraph, () => {}, {});
  engine.init({ origin: 'origin', question: 'batched prune', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });

  engine.getHopContext();
  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'o' }], summary: 'o', verdict: 'analyze', route_requests: [{ nodeId: 'hub', question: '?' }] });
  const focusHub = engine.getHopContext();
  assert('focus_node' in focusHub && focusHub.focus_node?.id === 'hub', 'hub is the second focus');
  const result = engine.submitFindings({
    focus_node_id: 'hub',
    sections: [{ angle: 'business' as const, text: 'h' }],
    summary: 'h',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'keep', question: '?' }],
    prune_neighbors: ['x1', 'x2', 'x3'],
  }) as any;
  assert('ok' in result, 'the safe batch prune commits');

  const state = engine.toJSON();
  for (const id of ['x1', 'x2', 'x3']) assert(state.removedSet.includes(id), `${id} pruned by the batch fast path`);
  assert(!state.removedSet.includes('keep'), 'the routed sibling survives the batch');
  assert(!state.memory.recentRejections.some((r) => ['x1', 'x2', 'x3'].includes(r.nodeId)), 'no orphan rejections for the safe batch');
});

  it("and no detail, route, or lifecycle state from the rejected hop commits.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'origin prune notice', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 5 } });

  const focus = engine.getHopContext();
  assert('focus_node' in focus && focus.focus_node?.id === 'origin', 'first focus is origin');
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'root' }],
    summary: 'root',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: '?' }],
    prune_neighbors: ['origin'],
  }) as any;
  assert('error' in result && result.error === 'prune_origin_forbidden', 'origin prune retains its fatal code');
  const state = engine.toJSON();
  assert(!state.removedSet.includes('origin'), 'origin is never removed');
  assert(state.memory.detailSlots['origin'] === undefined, 'origin detail does not commit on rejection');
  assert(state.status === 'awaiting_findings', 'origin prune rejection keeps the current hop active');
});

  it("would disconnect the already-analyzed c.", () => {
  const orphanNodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
    makeNode({ id: 'a',      schema: 'dbo', name: 'a',      type: 'view' }),
    makeNode({ id: 'b',      schema: 'dbo', name: 'b',      type: 'table' }),
    makeNode({ id: 'c',      schema: 'dbo', name: 'c',      type: 'view' }),
  ];
  const orphanEdges: Array<[string, string]> = [['origin', 'a'], ['a', 'b'], ['b', 'c']];
  const orphanModel: DatabaseModel = makeModel(orphanNodes, orphanEdges, ['dbo']);
  const orphanGraph = makeGraph(orphanNodes, orphanEdges);

  const engine = new NavigationEngine(orphanModel, orphanGraph, () => {}, {});
  engine.init({ origin: 'origin', question: 'orphan probe', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });

  const focus1 = engine.getHopContext();
  assert('focus_node' in focus1 && focus1.focus_node?.id === 'origin', 'first focus is origin');
  engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'o' }],
    summary: 'o',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: '?' }],
  });

  const focus2 = engine.getHopContext();
  assert('focus_node' in focus2 && focus2.focus_node?.id === 'a', 'second focus is a');
  engine.submitFindings({
    focus_node_id: 'a',
    sections: [{ angle: 'business' as const, text: 'a' }],
    summary: 'a',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'b', question: 'trace through b' }],
  });
  const focus3 = engine.getHopContext();
  assert('focus_node' in focus3 && focus3.focus_node?.id === 'c', 'passive b contracts to c');
  engine.submitFindings({ focus_node_id: 'c', sections: [{ angle: 'business' as const, text: 'c' }], summary: 'c', verdict: 'analyze' });
  assert(engine.getHopContext().done === true, 'orphan setup completes before a reactivation');
  const supplemented = engine.supplementAgenda(['a']);
  assert('ok' in supplemented && supplemented.agendaed === 1, 'a is reactivated for the neighbor-prune probe');
  const reactivated = engine.getHopContext();
  assert('focus_node' in reactivated && reactivated.focus_node?.id === 'a', 'reactivated focus is a');
  const detailBefore = JSON.stringify(engine.toJSON().memory.detailSlots.a);

  const rej = engine.submitFindings({
    focus_node_id: 'a',
    sections: [{ angle: 'business' as const, text: 'attempted a analysis' }],
    summary: 'a summary',
    verdict: 'analyze',
    prune_neighbors: ['b'],
  }) as any;
  assert('error' in rej && rej.error === 'missing_required_route', 'required in-scope b must be routed');
  const state = engine.toJSON();
  assert(!state.removedSet.includes('b'), 'the rejected prune leaves b unremoved');
  assert(JSON.stringify(state.memory.detailSlots.a) === detailBefore, 'required-neighbor rejection does not replace committed detail');
});

  it("A genuinely out-of-scope neighbor retains the prior topology-safe prune behavior.", () => {
  const localNodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
    makeNode({ id: 'a',      schema: 'dbo', name: 'a',      type: 'view' }),
    makeNode({ id: 'b',      schema: 'dbo', name: 'b',      type: 'view' }),
  ];
  const localEdges: Array<[string, string]> = [['origin', 'a'], ['a', 'b']];
  const localModel: DatabaseModel = makeModel(localNodes, localEdges, ['dbo']);
  const localGraph = makeGraph(localNodes, localEdges);

  const engine = new NavigationEngine(localModel, localGraph, () => {}, {});
  engine.init({ origin: 'origin', question: 'out-of-scope prune drops with a notice', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 1 } });

  engine.getHopContext();
  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'o' }], summary: 'o', verdict: 'analyze', route_requests: [{ nodeId: 'a', question: '?' }] });
  const focusA = engine.getHopContext();
  assert('focus_node' in focusA && focusA.focus_node?.id === 'a', 'second focus is a — b was never added to scope (beyond depth 1, never routed)');

  const result = engine.submitFindings({ focus_node_id: 'a', sections: [{ angle: 'business' as const, text: 'a' }], summary: 'a', verdict: 'analyze', prune_neighbors: ['b'] }) as any;
  assert('ok' in result, 'topology-safe out-of-scope prune is accepted');
  const state = engine.toJSON();
  assert(state.removedSet.includes('b'), 'out-of-scope neighbor is recorded as removed');
});

});
