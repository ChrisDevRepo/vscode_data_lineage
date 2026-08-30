import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { bfsReachable, firstDisconnectedRequiredNode } from '../../../src/engine/graphGuards';
import { makeGraph } from '../helpers/testUtils';
import { driveEngine, makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

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
    driveEngine(engine, { followDownstream: true });
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

  for (const id of reachable) expect(rendered.has(id), `reachable node ${id} is in the render set`).toBe(true);
  for (const id of rendered) expect(reachable.has(id), `rendered node ${id} is origin-reachable (no phantom)`).toBe(true);

  // Every committed detail slot resolves to a rendered node — zero silent slot loss.
  for (const slot of result.detail_slots) {
    expect(rendered.has(slot.nodeId), `detail slot for ${slot.nodeId} survives into the render (no silent loss)`).toBe(true);
  }
  expect(rendered.has('c'), 'the deepest analyzed node survives (full-chain conservation)').toBe(true);
});

  it("required-connected, so nothing on the live path is lost between the ledger and the render.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'committed-set conservation', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 5 } });

  // Dispatch then analyze origin (routes a), then dispatch then analyze a (routes b). A focus must be
  // dispatched via getHopContext() before submitFindings will commit against it. Stop before b is
  // dispatched, so b stays queued-unvisited (committed via the agenda, never analyzed).
  const focus1 = engine.getHopContext();
  expect('focus_node' in focus1 && focus1.focus_node?.id === 'origin', 'first dispatched focus is origin').toBe(true);
  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'o' }], summary: 'o', verdict: 'analyze', route_requests: [{ nodeId: 'a', question: '?' }] });
  const focus2 = engine.getHopContext();
  expect('focus_node' in focus2 && focus2.focus_node?.id === 'a', 'second dispatched focus is a').toBe(true);
  engine.submitFindings({ focus_node_id: 'a', sections: [{ angle: 'business' as const, text: 'a' }], summary: 'a', verdict: 'analyze', route_requests: [{ nodeId: 'b', question: '?' }] });

  // b is now committed (queued, unvisited). The render must still carry origin, a, and b.
  const result = engine.getResult();
  const rendered = new Set(result.fullNodes.map((n) => n.id));
  for (const id of ['origin', 'a', 'b']) expect(rendered.has(id), `${id} kept in the render (committed-set conservation)`).toBe(true);

  // Widened-guard mechanism: reconstruct the engine's committed set K exactly as `committedConnectedIds()` does
  // (noted ∪ agenda) from the observable snapshot, and show it makes b visible to the orphan guard.
  const snap = engine.toJSON();
  const noted = new Set<string>(Object.keys(snap.memory.detailSlots));
  const committed = new Set<string>([...noted, ...snap.agenda.map((e) => e.nodeId)]);
  const scope = new Set<string>(snap.scopeNodeIds);
  expect(committed.has('b') && !noted.has('b'), 'b is committed via the agenda, not via noted (the widening is what admits it)').toBe(true);

  // Removing a's connectivity orphans the queued b. The widened committed set flags b as disconnected
  // (→ prune_would_orphan_noted); a noted-only set would return null and wave the prune through,
  // silently dropping b's detail slot — the exact regression the widened guard prevents.
  const removedIfAPruned = new Set<string>([...snap.removedSet, 'a']);
  expect(firstDisconnectedRequiredNode(graph, 'origin', removedIfAPruned, committed, scope) === 'b', 'committed-set guard flags queued b as orphaned when its connector is pruned').toBe(true);
  expect(firstDisconnectedRequiredNode(graph, 'origin', removedIfAPruned, noted, scope) === null, 'noted-only set would MISS the queued orphan (documents the pre-widening silent-loss gap)').toBe(true);
});

  it("reactivate articulation node b and attempt to prune it.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'self-prune orphan', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 5 } });

  const focus1 = engine.getHopContext();
  expect('focus_node' in focus1 && focus1.focus_node?.id === 'origin', 'first focus is origin').toBe(true);
  engine.submitFindings({ focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'o' }], summary: 'o', verdict: 'analyze', route_requests: [{ nodeId: 'a', question: '?' }] });

  const focus2 = engine.getHopContext();
  expect('focus_node' in focus2 && focus2.focus_node?.id === 'a', 'second focus is a').toBe(true);
  engine.submitFindings({ focus_node_id: 'a', sections: [{ angle: 'business' as const, text: 'a' }], summary: 'a', verdict: 'analyze', route_requests: [{ nodeId: 'b', question: '?' }] });

  const focus3 = engine.getHopContext();
  expect('focus_node' in focus3 && focus3.focus_node?.id === 'b', 'third focus is b').toBe(true);
  engine.submitFindings({ focus_node_id: 'b', sections: [{ angle: 'business' as const, text: 'b' }], summary: 'b', verdict: 'analyze', route_requests: [{ nodeId: 'c', question: '?' }] });
  const focus4 = engine.getHopContext();
  expect('focus_node' in focus4 && focus4.focus_node?.id === 'c', 'fourth focus is c').toBe(true);
  engine.submitFindings({ focus_node_id: 'c', sections: [{ angle: 'business' as const, text: 'c' }], summary: 'c', verdict: 'analyze' });
  expect(engine.getHopContext().done === true, 'chain completes before articulation reactivation').toBe(true);
  const supplemented = engine.supplementAgenda(['b']);
  expect('ok' in supplemented && supplemented.agendaed === 1, 'b is reactivated for the self-prune probe').toBe(true);
  const reactivated = engine.getHopContext();
  expect('focus_node' in reactivated && reactivated.focus_node?.id === 'b', 'reactivated focus is b').toBe(true);
  const beforeReject = JSON.stringify(engine.toJSON());

  // b is c's only connector in this graph. A real self-prune of b must be rejected because the
  // already-analyzed c would be orphaned from origin.
  const result = engine.submitFindings({ focus_node_id: 'b', sections: [{ angle: 'business' as const, text: 'b' }], summary: 'b', verdict: 'prune' });
  expect('error' in result && result.error === 'prune_would_orphan_noted', 'a real submitFindings self-prune of b is rejected end-to-end').toBe(true);
  const state = engine.toJSON();
  expect(!state.removedSet.includes('b'), 'the rejected self-prune leaves b unremoved').toBe(true);
  expect(JSON.stringify(state) === beforeReject, 'rejected self-prune commits zero engine state').toBe(true);
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
  expect('focus_node' in focusD && focusD.focus_node?.id === 'd', 'earlier promoted route d dispatches before later promoted b').toBe(true);
  engine.submitFindings({ focus_node_id: 'd', sections: [{ angle: 'business' as const, text: 'd' }], summary: 'd', verdict: 'analyze', route_requests: [] });
  const focusB = engine.getHopContext();
  expect('focus_node' in focusB && focusB.focus_node?.id === 'b', 'b dispatches after the earlier routed sibling').toBe(true);
  engine.submitFindings({ focus_node_id: 'b', sections: [{ angle: 'business' as const, text: 'b' }], summary: 'b', verdict: 'analyze', route_requests: [] });
  expect(engine.getHopContext().done === true, 'initial exploration completes before the committed-node prune probe').toBe(true);

  // Reactivate d after b is committed so the real prune_neighbors path still exercises its guard.
  const supplement = engine.supplementAgenda(['d']);
  expect('ok' in supplement, 'd can be reactivated for the committed-node prune probe').toBe(true);
  const reactivatedD = engine.getHopContext();
  expect('focus_node' in reactivatedD && reactivatedD.focus_node?.id === 'd', 'reactivated d is the supplement focus').toBe(true);

  const result = engine.submitFindings({ focus_node_id: 'd', sections: [{ angle: 'business' as const, text: 'd' }], summary: 'd', verdict: 'analyze', route_requests: [], prune_neighbors: ['b', 'ghost_node'] }) as any;
  expect('ok' in result, 'committed and unknown prune targets are nonfatal notices').toBe(true);
  const state = engine.toJSON();
  expect(!state.removedSet.includes('b'), 'a committed node is never removed via prune_neighbors').toBe(true);
  expect(state.memory.recentRejections.some((r) => r.nodeId === 'b'), 'committed-node prune notice is visible').toBe(true);
  expect(state.memory.recentRejections.some((r) => r.nodeId === 'ghost_node'), 'unknown prune notice is visible').toBe(true);
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
  expect('focus_node' in focusHub && focusHub.focus_node?.id === 'hub', 'hub is the second focus').toBe(true);
  const result = engine.submitFindings({
    focus_node_id: 'hub',
    sections: [{ angle: 'business' as const, text: 'h' }],
    summary: 'h',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'keep', question: '?' }],
    prune_neighbors: ['x1', 'x2', 'x3'],
  }) as any;
  expect('ok' in result, 'the safe batch prune commits').toBe(true);

  const state = engine.toJSON();
  for (const id of ['x1', 'x2', 'x3']) expect(state.removedSet.includes(id), `${id} pruned by the batch fast path`).toBe(true);
  expect(!state.removedSet.includes('keep'), 'the routed sibling survives the batch').toBe(true);
  expect(!state.memory.recentRejections.some((r) => ['x1', 'x2', 'x3'].includes(r.nodeId)), 'no orphan rejections for the safe batch').toBe(true);
});

  it("and no detail, route, or lifecycle state from the rejected hop commits.", () => {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'origin prune notice', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 5 } });

  const focus = engine.getHopContext();
  expect('focus_node' in focus && focus.focus_node?.id === 'origin', 'first focus is origin').toBe(true);
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'root' }],
    summary: 'root',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: '?' }],
    prune_neighbors: ['origin'],
  }) as any;
  expect('error' in result && result.error === 'prune_origin_forbidden', 'origin prune retains its fatal code').toBe(true);
  const state = engine.toJSON();
  expect(!state.removedSet.includes('origin'), 'origin is never removed').toBe(true);
  expect(state.memory.detailSlots.origin === undefined, 'origin detail does not commit on rejection').toBe(true);
  expect(state.status === 'awaiting_findings', 'origin prune rejection keeps the current hop active').toBe(true);
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
  expect('focus_node' in focus1 && focus1.focus_node?.id === 'origin', 'first focus is origin').toBe(true);
  engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'o' }],
    summary: 'o',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'a', question: '?' }],
  });

  const focus2 = engine.getHopContext();
  expect('focus_node' in focus2 && focus2.focus_node?.id === 'a', 'second focus is a').toBe(true);
  engine.submitFindings({
    focus_node_id: 'a',
    sections: [{ angle: 'business' as const, text: 'a' }],
    summary: 'a',
    verdict: 'analyze',
    route_requests: [{ nodeId: 'b', question: 'trace through b' }],
  });
  const focus3 = engine.getHopContext();
  expect('focus_node' in focus3 && focus3.focus_node?.id === 'c', 'passive b contracts to c').toBe(true);
  engine.submitFindings({ focus_node_id: 'c', sections: [{ angle: 'business' as const, text: 'c' }], summary: 'c', verdict: 'analyze' });
  expect(engine.getHopContext().done === true, 'orphan setup completes before a reactivation').toBe(true);
  const supplemented = engine.supplementAgenda(['a']);
  expect('ok' in supplemented && supplemented.agendaed === 1, 'a is reactivated for the neighbor-prune probe').toBe(true);
  const reactivated = engine.getHopContext();
  expect('focus_node' in reactivated && reactivated.focus_node?.id === 'a', 'reactivated focus is a').toBe(true);
  const detailBefore = JSON.stringify(engine.toJSON().memory.detailSlots.a);

  const rej = engine.submitFindings({
    focus_node_id: 'a',
    sections: [{ angle: 'business' as const, text: 'attempted a analysis' }],
    summary: 'a summary',
    verdict: 'analyze',
    prune_neighbors: ['b'],
  }) as any;
  expect('error' in rej && rej.error === 'missing_required_route', 'required in-scope b must be routed').toBe(true);
  const state = engine.toJSON();
  expect(!state.removedSet.includes('b'), 'the rejected prune leaves b unremoved').toBe(true);
  expect(JSON.stringify(state.memory.detailSlots.a) === detailBefore, 'required-neighbor rejection does not replace committed detail').toBe(true);
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
  expect('focus_node' in focusA && focusA.focus_node?.id === 'a', 'second focus is a — b was never added to scope (beyond depth 1, never routed)').toBe(true);

  const result = engine.submitFindings({ focus_node_id: 'a', sections: [{ angle: 'business' as const, text: 'a' }], summary: 'a', verdict: 'analyze', prune_neighbors: ['b'] }) as any;
  expect('ok' in result, 'topology-safe out-of-scope prune is accepted').toBe(true);
  const state = engine.toJSON();
  expect(state.removedSet.includes('b'), 'out-of-scope neighbor is recorded as removed').toBe(true);
});

  it("An unprunable id — already analyzed, or unknown — becomes a visible notice, not a rejection.", () => {
  // Ported from navigation-engine-synthesis-regression.test.ts, which duplicated this file's
  // origin-prune, node-retention and detail-slot coverage. The unknown-id half was its only
  // claim not asserted elsewhere: navigation-engine.test.ts covers an unknown *route* target,
  // never an unknown *prune* target.
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'prune notice', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 4 } });

  // Walk origin → a → b by hand rather than with driveWalk, which runs to completion and
  // would leave no open hop to submit the prune on. `a` must already be analyzed by then.
  engine.getHopContext();
  engine.submitFindings({
    focus_node_id: 'origin', sections: [{ angle: 'business' as const, text: 'origin' }],
    summary: 'origin', verdict: 'analyze', route_requests: [{ nodeId: 'a', question: 'analyze a' }],
  });
  const focusA = engine.getHopContext();
  expect('focus_node' in focusA && focusA.focus_node?.id === 'a', 'second focus is a').toBe(true);
  engine.submitFindings({
    focus_node_id: 'a', sections: [{ angle: 'business' as const, text: 'a' }],
    summary: 'a', verdict: 'analyze', route_requests: [{ nodeId: 'b', question: 'analyze b' }],
  });
  const focusB = engine.getHopContext();
  expect('focus_node' in focusB && focusB.focus_node?.id === 'b', 'third focus is b').toBe(true);

  const result = engine.submitFindings({
    focus_node_id: 'b',
    sections: [{ angle: 'business' as const, text: 'b' }],
    summary: 'b done',
    verdict: 'analyze',
    // c is a required in-scope neighbour and must still be routed; the prune list below
    // carries only ids the engine cannot act on.
    route_requests: [{ nodeId: 'c', question: 'analyze c' }],
    prune_neighbors: ['a', '[dbo].[doesNotExist]'],
  }) as any;

  expect('ok' in result, 'a refused no-op prune does not reject the hop').toBe(true);
  const rejections = engine.toJSON().memory.recentRejections;
  expect(rejections.some((r) => r.nodeId === 'a'), 'the already-analyzed prune is visible as a notice').toBe(true);
  expect(rejections.some((r) => r.nodeId === '[dbo].[doesNotExist]'), 'the unknown prune id is visible as a notice').toBe(true);
  expect(!engine.toJSON().removedSet.includes('a'), 'the already-analyzed node is not removed').toBe(true);
});

});
