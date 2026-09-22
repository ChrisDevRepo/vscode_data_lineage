/**
 * A route declaration the bipartite rule contracted away must still refuse a later
 * `prune_neighbors` targeting it directly — in BB exactly as in CT.
 *
 * @remarks
 * The bipartite agenda rule contracts a non-bodied route target on admission (`enqueueHop`),
 * so an accepted route to a table gets no agenda entry and no detail slot. Nothing in
 * `committedConnectedIds()` (noted ∪ agenda) then has a handle on it, so an unrelated later hop's
 * `prune_neighbors` naming it directly is wrongly admitted.
 *
 * `joinTable` is a dead-end non-bodied node (no further bodied neighbor to contract to) whose
 * disappearance orphans nothing else, so the `firstDisconnectedAfterPrune` reachability walk can
 * never catch it on its own — and that walk is undirected, so even a carrier with descendants is
 * cleared by any second path to the origin. The direct, declaration-membership check is what a
 * graph-connectivity walk cannot express.
 *
 * The declaration is a routing decision, not a column fact, so it is mode-independent: when this
 * protection was CT-only, BB deleted a routed carrier that CT kept on the identical question —
 * the divergence `CT is BB plus columns` forbids, and the measured cause of a lost upstream
 * source in a real BB run.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

/**
 * origin --(upstream)--> { joinTable (table, dead end), other (view, supplies Total), neverRouted
 * (table, dead end) }. `joinTable` mirrors CustomerMaster: a non-bodied join/filter source with no
 * further neighbor to contract to. `neverRouted` is pruned at hop 1 (never declared) to prove the
 * fix does not blanket-freeze the graph.
 */
function buildWorld(): { model: DatabaseModel; graph: ReturnType<typeof makeGraph> } {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'ct', name: 'origin', type: 'procedure', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'joinTable', schema: 'ct', name: 'joinTable', type: 'table', columns: [{ name: 'Tier', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'other', schema: 'ct', name: 'other', type: 'view', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'neverRouted', schema: 'ct', name: 'neverRouted', type: 'table', columns: [{ name: 'Foo', type: 'int', nullable: 'NULL', extra: '' }] }),
  ];
  const edges: Array<[string, string]> = [
    ['joinTable', 'origin'],
    ['other', 'origin'],
    ['neverRouted', 'origin'],
  ];
  return { model: makeModel(nodes, edges, ['ct']), graph: makeGraph(nodes, edges) };
}

describe('declared-route prune guard', () => {
  it('(1) CT: a non-bodied node named in an accepted route_request is refused when later prune_neighbors targets it, and survives in the result', () => {
    const { model, graph } = buildWorld();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const init = engine.init({
      origin: 'origin', question: 'trace Total', direction: 'upstream',
      analysisMode: 'ct', targetColumns: ['Total'],
      depthIntent: { kind: 'explicit', levels: 5 },
    });
    expect('ok' in init, 'CT init succeeds').toBe(true);

    const focus1 = engine.getHopContext();
    expect('focus_node' in focus1 && focus1.focus_node?.id === 'origin', 'first focus is origin').toBe(true);
    const hop1 = engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin joins joinTable and reads Total from other' }],
      summary: 'origin computes Total',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Total', upstream_columns: [{ node: 'other', col: 'Total' }] }],
      route_requests: [
        { nodeId: 'joinTable', question: 'is this a join/filter source? route it' },
        { nodeId: 'other', question: 'what supplies Total?' },
      ],
      prune_neighbors: ['neverRouted'],
    }) as any;
    expect('ok' in hop1, `hop1 commits: ${JSON.stringify(hop1)}`).toBe(true);

    // (3) never declared, so still prunable — the fix does not blanket-freeze the graph.
    const afterHop1 = engine.toJSON();
    expect(afterHop1.removedSet.includes('neverRouted'), 'the never-declared dead end is pruned normally').toBe(true);
    expect(!afterHop1.removedSet.includes('joinTable'), 'joinTable is not removed by hop1').toBe(true);
    expect(!afterHop1.agenda.some((e) => e.nodeId === 'joinTable'), 'joinTable (non-bodied) never gets an agenda entry').toBe(true);

    const focus2 = engine.getHopContext();
    expect('focus_node' in focus2 && focus2.focus_node?.id === 'other', 'second focus is other').toBe(true);
    const hop2 = engine.submitFindings({
      focus_node_id: 'other',
      sections: [{ angle: 'business' as const, text: 'other supplies Total directly' }],
      summary: 'other supplies Total',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Total', upstream_columns: [] }],
      prune_neighbors: ['joinTable'],
    }) as any;

    expect('error' in hop2, 'the prune of the declared node joinTable is refused').toBe(true);
    expect(/orphan/i.test(hop2.hint ?? ''), 'the refusal reuses the existing prune_would_orphan hint').toBe(true);

    const state = engine.toJSON();
    expect(!state.removedSet.includes('joinTable'), 'the refused prune leaves joinTable unremoved').toBe(true);

    // Drive the walk to completion and confirm the declared node survives in the delivered result.
    for (let hop = 0; hop < 10; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      engine.submitFindings({
        focus_node_id: ctx.focus_node.id,
        sections: [{ angle: 'business' as const, text: 'noop' }],
        summary: 'noop',
        verdict: 'passthrough',
      });
    }
    const result = engine.getResult();
    const rendered = new Set(result.fullNodes.map((n) => n.id));
    expect(rendered.has('joinTable'), 'the declared node survives into the delivered result').toBe(true);
  });

  it('(2) BB: the identical question keeps the identical node — the declared carrier is refused and survives, as in CT', () => {
    const { model, graph } = buildWorld();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const init = engine.init({
      origin: 'origin', question: 'BB counterpart', direction: 'upstream',
      depthIntent: { kind: 'explicit', levels: 5 },
    });
    expect('ok' in init, 'BB init succeeds').toBe(true);

    engine.getHopContext();
    const hop1 = engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin routes joinTable and other' }],
      summary: 'origin',
      verdict: 'analyze',
      route_requests: [
        { nodeId: 'joinTable', question: 'route it' },
        { nodeId: 'other', question: 'route it' },
      ],
      prune_neighbors: ['neverRouted'],
    }) as any;
    expect('ok' in hop1, `BB hop1 commits: ${JSON.stringify(hop1)}`).toBe(true);

    const focus2 = engine.getHopContext();
    expect('focus_node' in focus2 && focus2.focus_node?.id === 'other', 'BB second focus is other').toBe(true);
    const hop2 = engine.submitFindings({
      focus_node_id: 'other',
      sections: [{ angle: 'business' as const, text: 'other' }],
      summary: 'other',
      verdict: 'analyze',
      prune_neighbors: ['joinTable'],
    }) as any;

    expect('error' in hop2, 'BB: the prune of the declared node joinTable is refused, exactly as in CT').toBe(true);
    expect(/orphan/i.test(hop2.hint ?? ''), 'the refusal reuses the existing prune_would_orphan hint').toBe(true);

    const state = engine.toJSON();
    expect(!state.removedSet.includes('joinTable'), 'the refused prune leaves joinTable unremoved').toBe(true);
    expect(state.removedSet.includes('neverRouted'), 'a never-declared dead end still prunes — no blanket freeze').toBe(true);
    expect(state.ctDeclaredRouteIds?.includes('joinTable'), 'a BB checkpoint carries the declaration too').toBe(true);

    // Same-graph parity: drive both modes to completion over one topology and compare node sets.
    for (let hop = 0; hop < 10; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) break;
      engine.submitFindings({
        focus_node_id: ctx.focus_node.id,
        sections: [{ angle: 'business' as const, text: 'noop' }],
        summary: 'noop',
        verdict: 'passthrough',
      });
    }
    const rendered = new Set(engine.getResult().fullNodes.map((n) => n.id));
    expect(rendered.has('joinTable'), 'the declared node survives into the delivered BB result').toBe(true);
    expect(!rendered.has('neverRouted'), 'the pruned node is gone from the delivered BB result').toBe(true);
  });

  it('(3) CT: a toJSON/fromJSON restore still refuses prune of the declared contracted node', () => {
    const { model, graph } = buildWorld();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const init = engine.init({
      origin: 'origin', question: 'trace Total', direction: 'upstream',
      analysisMode: 'ct', targetColumns: ['Total'],
      depthIntent: { kind: 'explicit', levels: 5 },
    });
    expect('ok' in init, 'CT init succeeds').toBe(true);

    engine.getHopContext();
    const hop1 = engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin joins joinTable and reads Total from other' }],
      summary: 'origin computes Total',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Total', upstream_columns: [{ node: 'other', col: 'Total' }] }],
      route_requests: [
        { nodeId: 'joinTable', question: 'is this a join/filter source? route it' },
        { nodeId: 'other', question: 'what supplies Total?' },
      ],
      prune_neighbors: ['neverRouted'],
    }) as { ok?: unknown; error?: string };
    expect('ok' in hop1, `hop1 commits: ${JSON.stringify(hop1)}`).toBe(true);

    const snapshot = engine.toJSON();
    expect(snapshot.ctDeclaredRouteIds?.includes('joinTable'), 'declared id is on the checkpoint').toBe(true);

    const restored = NavigationEngine.fromJSON(snapshot, model, graph, () => {}, {});
    const focus2 = restored.getHopContext();
    expect('focus_node' in focus2 && focus2.focus_node?.id === 'other', 'restored second focus is other').toBe(true);
    const hop2 = restored.submitFindings({
      focus_node_id: 'other',
      sections: [{ angle: 'business' as const, text: 'other supplies Total directly' }],
      summary: 'other supplies Total',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Total', upstream_columns: [] }],
      prune_neighbors: ['joinTable'],
    }) as { error?: string; hint?: string };

    expect('error' in hop2, 'the prune of the declared node joinTable is refused after restore').toBe(true);
    expect(/orphan/i.test(hop2.hint ?? ''), 'the refusal reuses the existing prune_would_orphan hint').toBe(true);
    expect(!restored.toJSON().removedSet.includes('joinTable'), 'the refused prune leaves joinTable unremoved').toBe(true);
  });
});

/**
 * The carrier shape the undirected orphan walk cannot catch, in BB.
 *
 * `carrier` is not a dead end — `builder` hangs off it and is the only thing that writes it — but
 * `builder` also reads `source`, which `loader` reads too. `bfsReachable` is undirected, so after
 * removing `carrier` every committed node is still reachable (target–loader–source–builder) and
 * the don't-orphan walk clears the prune, however central `carrier` is to the traced path.
 * Only the declaration refuses it.
 */
function buildCarrierWorld(): { model: DatabaseModel; graph: ReturnType<typeof makeGraph> } {
  const nodes: LineageNode[] = [
    makeNode({ id: 'target',  schema: 'app', name: 'target',  type: 'table' }),
    makeNode({ id: 'loader',  schema: 'app', name: 'loader',  type: 'procedure' }),
    makeNode({ id: 'carrier', schema: 'app', name: 'carrier', type: 'table' }),
    makeNode({ id: 'builder', schema: 'app', name: 'builder', type: 'procedure' }),
    makeNode({ id: 'source',  schema: 'app', name: 'source',  type: 'table' }),
  ];
  const edges: Array<[string, string]> = [
    ['loader', 'target'],
    ['carrier', 'loader'],
    ['builder', 'carrier'],
    ['source', 'loader'],
    ['source', 'builder'],
  ];
  return { model: makeModel(nodes, edges, ['app']), graph: makeGraph(nodes, edges) };
}

describe('declared-route prune guard — the contracted carrier the topology walk clears', () => {
  it('BB: a routed carrier with a second undirected path to the origin is still refused and stays in the graph', () => {
    const { model, graph } = buildCarrierWorld();
    const logLines: string[] = [];
    const engine = new NavigationEngine(model, graph, (_lvl, line) => { logLines.push(line); }, {});
    expect('ok' in engine.init({
      origin: 'target', question: 'explain every upstream source', direction: 'upstream',
      depthIntent: { kind: 'explicit', levels: 5 },
    }), 'BB init succeeds').toBe(true);

    const f1 = engine.getHopContext() as { focus_node?: { id: string } };
    expect(f1.focus_node?.id === 'target', 'first focus is the origin table').toBe(true);
    expect('ok' in engine.submitFindings({
      focus_node_id: 'target',
      sections: [{ angle: 'business' as const, text: 'target is written by loader' }],
      summary: 'target', verdict: 'analyze',
      route_requests: [{ nodeId: 'loader', question: 'what builds target?' }],
    }), 'hop 1 commits').toBe(true);

    const f2 = engine.getHopContext() as { focus_node?: { id: string } };
    expect(f2.focus_node?.id === 'loader', 'second focus is loader').toBe(true);
    const hop2 = engine.submitFindings({
      focus_node_id: 'loader',
      sections: [{ angle: 'business' as const, text: 'loader joins carrier and reads source' }],
      summary: 'loader', verdict: 'analyze',
      route_requests: [
        { nodeId: 'carrier', question: 'what does carrier contribute?' },
        { nodeId: 'source', question: 'what does source contribute?' },
      ],
    }) as { ok?: unknown; error?: string; hint?: string };
    expect('ok' in hop2, `hop 2 commits: ${JSON.stringify(hop2)}`).toBe(true);

    const mid = engine.toJSON();
    expect(mid.scopeNodeIds.includes('carrier'), 'the routed carrier is in scope').toBe(true);
    expect(!mid.agenda.some((e) => e.nodeId === 'carrier'), 'the bipartite rule leaves it no agenda entry of its own').toBe(true);
    expect(!mid.visited.includes('carrier'), 'and it is never visited — the four no-op oracles are all blind to it').toBe(true);
    expect(mid.agenda.some((e) => e.nodeId === 'builder'), 'its work was contracted onto the bodied writer behind it').toBe(true);

    const f3 = engine.getHopContext() as { focus_node?: { id: string } };
    expect(f3.focus_node?.id === 'builder', 'third focus is the writer behind the carrier').toBe(true);
    const hop3 = engine.submitFindings({
      focus_node_id: 'builder',
      sections: [{ angle: 'business' as const, text: 'builder rebuilds carrier from source' }],
      summary: 'builder', verdict: 'analyze',
      prune_neighbors: ['carrier'],
    }) as { ok?: unknown; error?: string; hint?: string };

    expect('error' in hop3, `the prune of the routed carrier is refused: ${JSON.stringify(hop3)}`).toBe(true);
    expect(!engine.toJSON().removedSet.includes('carrier'), 'the carrier stays in the graph').toBe(true);
    expect(logLines.some((l) => l.includes('[Prune] prune_neighbor refused') && l.includes('reason=declared_route_protected') && l.includes('id=carrier')), 'the refusal is attributed to the declaration, not to topology').toBe(true);
  });
});
