/**
 * A `column_flow` endpoint declared but never scope-admitted must not refuse later, unrelated
 * neighbor prunes.
 *
 * @remarks
 * The orphan check's reachability walk is scope-bounded, so an out-of-scope declared id reads as
 * disconnected after any prune. Test (2) is the negative control: an in-scope, agenda-queued node
 * reachable only through the pruned neighbor still refuses the prune. Test (3): a direct prune of
 * the declared node itself stays refused.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

/**
 * origin --(upstream, depth 1)-- source --(upstream, depth 2)-- { other, writeTarget }
 *
 * Depth budget is 1, so `other` and `writeTarget` sit one hop past the border. `writeTarget` is
 * named only via `column_flow.writes_to` (never routed); `other` is an unrelated border neighbor
 * of `source` with no edge to `writeTarget` at all.
 */
function buildWorld(): { model: DatabaseModel; graph: ReturnType<typeof makeGraph> } {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'ct', name: 'origin', type: 'procedure', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'source', schema: 'ct', name: 'source', type: 'view', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'other', schema: 'ct', name: 'other', type: 'table', columns: [{ name: 'Foo', type: 'int', nullable: 'NULL', extra: '' }] }),
    makeNode({ id: 'writeTarget', schema: 'ct', name: 'writeTarget', type: 'table', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
  ];
  const edges: Array<[string, string]> = [
    ['source', 'origin'],
    ['other', 'source'],
    ['writeTarget', 'source'],
  ];
  return { model: makeModel(nodes, edges, ['ct']), graph: makeGraph(nodes, edges) };
}

describe('prune-would-orphan-endpoint: out-of-scope declared endpoint does not poison unrelated prunes', () => {
  it('(1) CT: pruning an unrelated border neighbor succeeds once an out-of-scope column_flow.writes_to endpoint has been declared', () => {
    const { model, graph } = buildWorld();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const init = engine.init({
      origin: 'origin', question: 'trace Total', direction: 'upstream',
      analysisMode: 'ct', targetColumns: ['Total'],
      depthIntent: { kind: 'explicit', levels: 1 },
    });
    expect('ok' in init, 'CT init succeeds').toBe(true);

    engine.getHopContext();
    const hop1 = engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin reads Total from source and writes it to writeTarget' }],
      summary: 'origin computes Total',
      verdict: 'analyze',
      // `writeTarget` is declared only as the writes_to target — never route_requests, never
      // upstream_columns, and past the depth-1 border.
      column_flow: [{
        out_col: 'Total',
        writes_to: { node: 'writeTarget', col: 'Total' },
        upstream_columns: [{ node: 'source', col: 'Total' }],
      }],
    }) as { ok?: unknown; error?: string };
    expect('ok' in hop1, `hop1 commits: ${JSON.stringify(hop1)}`).toBe(true);

    const afterHop1 = engine.toJSON();
    expect(afterHop1.ctDeclaredRouteIds?.includes('writeTarget'), 'writeTarget is declared').toBe(true);
    expect(!afterHop1.scopeNodeIds.includes('writeTarget'), 'writeTarget was never scope-admitted — past the border').toBe(true);
    expect(!afterHop1.agenda.some((e) => e.nodeId === 'writeTarget'), 'writeTarget never gets an agenda entry — never routed').toBe(true);

    const focus2 = engine.getHopContext();
    expect('focus_node' in focus2 && focus2.focus_node?.id === 'source', 'second focus is source').toBe(true);
    const hop2 = engine.submitFindings({
      focus_node_id: 'source',
      sections: [{ angle: 'business' as const, text: 'source supplies Total directly; other is an unrelated border neighbor, off the answer path' }],
      summary: 'source supplies Total',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Total', upstream_columns: [] }],
      // `other` sits past the same border, one hop from `source`, with no edge to `writeTarget` —
      // pruning it can never legitimately threaten writeTarget's connectivity.
      prune_neighbors: ['other'],
    }) as { ok?: unknown; error?: string; hint?: string };

    expect('ok' in hop2, `pruning the unrelated neighbor 'other' must succeed, not be refused citing writeTarget: ${JSON.stringify(hop2)}`).toBe(true);
    const state = engine.toJSON();
    expect(state.removedSet.includes('other'), 'other is pruned').toBe(true);
    expect(!state.removedSet.includes('writeTarget'), 'writeTarget itself stays unremoved (never a prune target here)').toBe(true);
  });

  it('(2) CT negative control, separate fixture: a genuinely in-scope, agenda-queued committed node reachable only through the pruned neighbor still refuses the prune', () => {
    const nodes: LineageNode[] = [
      makeNode({ id: 'origin', schema: 'ct', name: 'origin', type: 'procedure', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
      makeNode({ id: 'bridge', schema: 'ct', name: 'bridge', type: 'view', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
      makeNode({ id: 'viaNode', schema: 'ct', name: 'viaNode', type: 'table', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
      makeNode({ id: 'queued', schema: 'ct', name: 'queued', type: 'view', columns: [{ name: 'Total', type: 'int', nullable: 'NULL', extra: '' }] }),
    ];
    // `queued` (agenda-queued, so committed) is reachable from origin only through `viaNode` —
    // pruning `viaNode` must still be refused, unlike test (1)'s unrelated border neighbor.
    const edges: Array<[string, string]> = [
      ['bridge', 'origin'],
      ['viaNode', 'bridge'],
      ['queued', 'viaNode'],
    ];
    const model = makeModel(nodes, edges, ['ct']);
    const graph = makeGraph(nodes, edges);
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
      sections: [{ angle: 'business' as const, text: 'origin reads Total from bridge; queued is a lead worth routing directly' }],
      summary: 'origin computes Total',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Total', upstream_columns: [{ node: 'bridge', col: 'Total' }] }],
      route_requests: [
        { nodeId: 'bridge', question: 'what supplies Total?' },
        { nodeId: 'queued', question: 'is queued relevant too?' },
      ],
    }) as { ok?: unknown; error?: string };
    expect('ok' in hop1, `hop1 commits: ${JSON.stringify(hop1)}`).toBe(true);

    const afterHop1 = engine.toJSON();
    expect(afterHop1.agenda.some((e) => e.nodeId === 'queued'), 'queued is agenda-queued (genuinely in scope)').toBe(true);

    const focus2 = engine.getHopContext();
    expect('focus_node' in focus2 && focus2.focus_node?.id === 'bridge', 'second focus is bridge').toBe(true);
    const hop2 = engine.submitFindings({
      focus_node_id: 'bridge',
      sections: [{ angle: 'business' as const, text: 'attempting to drop viaNode, queued\'s only path to origin' }],
      summary: 'bridge',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Total', upstream_columns: [] }],
      prune_neighbors: ['viaNode'],
    }) as { ok?: unknown; error?: string; hint?: string };

    expect('error' in hop2, `pruning viaNode is refused — it is queued's only path to origin: ${JSON.stringify(hop2)}`).toBe(true);
    expect(/orphan/i.test(hop2.hint ?? ''), 'the refusal reuses the existing prune_would_orphan hint').toBe(true);
    expect(!engine.toJSON().removedSet.includes('viaNode'), 'the refused prune leaves viaNode unremoved').toBe(true);
  });

  it('(3) CT parity: a direct prune of the declared out-of-scope node itself stays refused', () => {
    const { model, graph } = buildWorld();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const init = engine.init({
      origin: 'origin', question: 'trace Total', direction: 'upstream',
      analysisMode: 'ct', targetColumns: ['Total'],
      depthIntent: { kind: 'explicit', levels: 1 },
    });
    expect('ok' in init, 'CT init succeeds').toBe(true);

    engine.getHopContext();
    const hop1 = engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin reads Total from source and writes it to writeTarget' }],
      summary: 'origin computes Total',
      verdict: 'analyze',
      column_flow: [{
        out_col: 'Total',
        writes_to: { node: 'writeTarget', col: 'Total' },
        upstream_columns: [{ node: 'source', col: 'Total' }],
      }],
    }) as { ok?: unknown; error?: string };
    expect('ok' in hop1, `hop1 commits: ${JSON.stringify(hop1)}`).toBe(true);

    const focus2 = engine.getHopContext();
    expect('focus_node' in focus2 && focus2.focus_node?.id === 'source', 'second focus is source').toBe(true);
    const hop2 = engine.submitFindings({
      focus_node_id: 'source',
      sections: [{ angle: 'business' as const, text: 'source supplies Total directly' }],
      summary: 'source supplies Total',
      verdict: 'analyze',
      column_flow: [{ out_col: 'Total', upstream_columns: [] }],
      // The direct-declared-node refusal (`declaredPruneIds`) fires ahead of any topology check.
      prune_neighbors: ['writeTarget'],
    }) as { ok?: unknown; error?: string; hint?: string };

    expect('error' in hop2, `direct prune of the declared node writeTarget is refused: ${JSON.stringify(hop2)}`).toBe(true);
    expect(!engine.toJSON().removedSet.includes('writeTarget'), 'writeTarget stays unremoved').toBe(true);
  });
});
