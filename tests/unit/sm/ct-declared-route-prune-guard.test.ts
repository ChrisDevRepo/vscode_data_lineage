/**
 * D-074 — a CT route declaration the bipartite rule contracted away must still refuse a later
 * `prune_neighbors` targeting it directly.
 *
 * @remarks
 * Real-world shape (m0-13 run-T8, `[ai].[vwDiscountCalc].Discount`): at the origin hop the model
 * accepted a route to `[ai].[customermaster]` (a table — non-bodied). The bipartite agenda rule
 * contracts a non-bodied route target on admission (`enqueueHop`, `smBase.ts:3048+`), so
 * CustomerMaster got no agenda entry and no detail slot. Ten hops later, from an unrelated focus
 * (`spCleanOrders`), the model submitted `prune_neighbors: ["customermaster"]`; nothing in
 * `committedConnectedIds()` (noted ∪ agenda) had a handle on it, so the prune was admitted and the
 * join-key dependency silently vanished from the delivered answer — `errors.missing_required_data`
 * FAILed the HARD row.
 *
 * `[ct].[joinTable]` here is the same shape deliberately: a dead-end non-bodied node (no further
 * bodied neighbor to contract to) whose disappearance orphans nothing else, so the pre-existing
 * `firstDisconnectedAfterPrune` reachability walk can never catch it on its own — the direct,
 * declaration-membership check this fix adds is what a graph-connectivity walk cannot express.
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

describe('D-074 — CT declared-route prune guard', () => {
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

  it('(2) BB: the same topology is unaffected — no new protection, the neighbor prunes as before', () => {
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

    expect('ok' in hop2, 'BB: the same route-then-prune shape is accepted — no CT-only protection leaks in').toBe(true);
    const state = engine.toJSON();
    expect(state.removedSet.includes('joinTable'), 'BB behavior is unchanged: joinTable is pruned').toBe(true);
    expect(state.ctDeclaredRouteIds, 'BB snapshot does not persist a CT-only declaration set').toBeUndefined();
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
