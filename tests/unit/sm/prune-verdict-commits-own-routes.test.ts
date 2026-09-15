/**
 * A `verdict='prune'` submission's own `route_requests` (and `prune_neighbors`) commit through the
 * same admission/enqueue path as every other verdict, before the focus itself is pruned.
 *
 * @remarks
 * Two shapes:
 * (1) a route requested from a prune hop, structurally reachable from the origin through an
 *     independent branch, is admitted and enqueued — same turn, not two hops later from a
 *     different focus.
 * (2) a route requested from a prune hop whose only path to the origin runs through the very
 *     focus being pruned is refused — `firstDisconnectedAfterPrune` now reads the payload's own
 *     staged route before deciding, so the refusal is a named `prune_would_orphan_noted` instead
 *     of a silent `ok: true` that drops the route and leaves the node stranded with no state.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe("submitFindings — a prune verdict's own route_requests commit before the focus is pruned", () => {
  it('(1) a route requested from the prune hop, reachable via an independent branch, is admitted and enqueued', () => {
    // origin depends directly on both `mid` (pruned this hop) and `anchor` (kept); `keeper`
    // feeds both `mid` and `anchor`, so it stays reachable through `anchor` once `mid` is gone —
    // the route to it, requested FROM `mid`'s own prune submission, must still commit.
    const nodes: LineageNode[] = [
      makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
      makeNode({ id: 'mid', schema: 'dbo', name: 'mid', type: 'view' }),
      makeNode({ id: 'anchor', schema: 'dbo', name: 'anchor', type: 'view' }),
      makeNode({ id: 'keeper', schema: 'dbo', name: 'keeper', type: 'view' }),
    ];
    const edges: Array<[string, string]> = [
      ['mid', 'origin'],
      ['anchor', 'origin'],
      ['keeper', 'mid'],
      ['keeper', 'anchor'],
    ];
    const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
    const graph = makeGraph(nodes, edges);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'test', direction: 'upstream' });

    engine.getHopContext();
    const originResult = engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin body' }],
      summary: 'origin body',
      verdict: 'passthrough',
      route_requests: [
        { nodeId: 'mid', question: 'what does mid contribute?' },
        { nodeId: 'anchor', question: 'what does anchor contribute?' },
      ],
    });
    expect('ok' in originResult, `origin hop commits: ${JSON.stringify(originResult)}`).toBe(true);

    const focus = engine.getHopContext() as { focus_node?: { id: string } };
    expect(focus.focus_node?.id, 'mid is dispatched next').toBe('mid');

    const pruneResult = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: 'off the trace' }],
      summary: 'off the trace',
      verdict: 'prune',
      route_requests: [{ nodeId: 'keeper', question: 'what feeds this?' }],
    });
    expect('ok' in pruneResult, `prune hop commits, routes intact: ${JSON.stringify(pruneResult)}`).toBe(true);

    const state = engine.toJSON();
    expect(state.removedSet.includes('mid'), 'mid is pruned').toBe(true);
    expect(state.agenda.some((e) => e.nodeId === 'keeper'), 'keeper was enqueued by the prune hop\'s own route_requests, not silently dropped').toBe(true);
  });

  it('(2) a route requested from the prune hop whose only path to origin runs through the pruned focus is refused, not silently dropped', () => {
    // `leaf` is reachable from origin only through `mid`. Requesting a route to `leaf` in the
    // same submission that prunes `mid` cannot be honored — pruning `mid` would strand it. Before
    // the fix, `route_requests` on a prune payload was never read at all, so this returned
    // `ok: true` and `leaf` was silently lost. After the fix, the payload's own route is what the
    // topology check reads, and the refusal names it.
    const nodes: LineageNode[] = [
      makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' }),
      makeNode({ id: 'mid', schema: 'dbo', name: 'mid', type: 'view' }),
      makeNode({ id: 'leaf', schema: 'dbo', name: 'leaf', type: 'view' }),
    ];
    const edges: Array<[string, string]> = [['mid', 'origin'], ['leaf', 'mid']];
    const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
    const graph = makeGraph(nodes, edges);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'test', direction: 'upstream' });

    engine.getHopContext();
    const originResult = engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin body' }],
      summary: 'origin body',
      verdict: 'passthrough',
      route_requests: [{ nodeId: 'mid', question: 'what does mid contribute?' }],
    });
    expect('ok' in originResult, `origin hop commits: ${JSON.stringify(originResult)}`).toBe(true);

    const focus = engine.getHopContext() as { focus_node?: { id: string } };
    expect(focus.focus_node?.id, 'mid is dispatched next').toBe('mid');

    const pruneResult = engine.submitFindings({
      focus_node_id: 'mid',
      sections: [{ angle: 'business' as const, text: 'off the trace' }],
      summary: 'off the trace',
      verdict: 'prune',
      route_requests: [{ nodeId: 'leaf', question: 'what feeds this?' }],
    }) as { error?: string; hint?: string };
    expect(pruneResult.error, `pruning mid is refused, not silently accepted: ${JSON.stringify(pruneResult)}`).toBe('prune_would_orphan_noted');
    expect(pruneResult.hint?.includes('[leaf]'), 'the refusal names the node the route would have orphaned').toBe(true);
    expect(pruneResult.hint?.includes("verdict='passthrough'"), 'the hint offers the same repair as every other prune_would_orphan_noted refusal').toBe(true);

    const state = engine.toJSON();
    expect(state.removedSet.includes('mid'), 'the refused prune leaves mid unremoved').toBe(false);
    expect(state.agenda.some((e) => e.nodeId === 'leaf'), 'the refused route is not enqueued either — the whole payload is refused, nothing partially committed').toBe(false);
  });
});
