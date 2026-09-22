/**
 * A `bidirectional` session's route border must stay inside the origin's directed closure
 * (upstream ancestors ∪ downstream descendants) — the same definition {@link computeBfsScope}
 * seeds the approved scope with. A downstream consumer's *other* inputs (a co-parent, reached
 * only by crossing sideways, never by a directed walk from the origin) must never be offered as
 * `requiredNeighborIds` or admitted through `route_requests`: `co_parent` feeds `consumer`
 * (downstream of `origin`) but is neither upstream nor downstream of `origin` itself.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

interface RouteOutcome { nodeId: string; accepted: boolean; deferred?: boolean; reason?: string }
interface SubmitOk { error?: string; route_outcomes?: RouteOutcome[] }

describe('bidirectional route border — a downstream consumer\'s off-closure co-parent is refused, in-closure nodes on both sides stay admitted', () => {
  // up1 → origin → consumer → sink ; co_parent → consumer (co_parent is consumer's *other* input,
  // reached only sideways — neither an ancestor nor a descendant of `origin`).
  const nodes: LineageNode[] = [
    makeNode({ id: 'up1', schema: 'ai', name: 'up1', type: 'view' }),
    makeNode({ id: 'origin', schema: 'ai', name: 'origin', type: 'procedure' }),
    makeNode({ id: 'consumer', schema: 'ai', name: 'consumer', type: 'procedure' }),
    makeNode({ id: 'co_parent', schema: 'ai', name: 'co_parent', type: 'view' }),
    // Bodied (view), not a plain table — a childless non-bodied route target reports
    // `accepted:false, reason:'depth_contracted_beyond_budget'` for having nothing to contract
    // through to, an unrelated engine convention this suite must not trip over.
    makeNode({ id: 'sink', schema: 'ai', name: 'sink', type: 'view' }),
  ];
  const edges: Array<[string, string]> = [
    ['up1', 'origin'],
    ['origin', 'consumer'],
    ['co_parent', 'consumer'],
    ['consumer', 'sink'],
  ];
  const model: DatabaseModel = makeModel(nodes, edges, ['ai']);
  const graph = makeGraph(nodes, edges);

  function driveToConsumer(engine: NavigationEngine): void {
    // Hop 1: origin. Route its required neighbors (up1, consumer — co_parent is not adjacent to
    // origin at all, so it never appears here).
    const originCtx = engine.getHopContext() as { focus_node?: { id: string } };
    expect(originCtx.focus_node?.id, 'first dispatched hop is origin').toBe('origin');
    const originRoutes = engine.requiredNeighborIds('origin').map(id => ({ nodeId: id, question: `trace ${id}` }));
    engine.submitFindings({
      focus_node_id: 'origin',
      sections: [{ angle: 'business' as const, text: 'origin' }],
      summary: 'origin',
      verdict: 'analyze',
      route_requests: originRoutes,
    });
    // Hop 2: up1 dequeues (or consumer, order-independent) — terminal-submit anything that is not
    // consumer, so the walk always lands on consumer next.
    for (let i = 0; i < 5; i++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (ctx.done || !ctx.focus_node) throw new Error('walk completed before reaching consumer');
      if (ctx.focus_node.id === 'consumer') return;
      engine.submitFindings({
        focus_node_id: ctx.focus_node.id,
        sections: [{ angle: 'business' as const, text: ctx.focus_node.id }],
        summary: ctx.focus_node.id,
        verdict: 'analyze',
        route_requests: engine.requiredNeighborIds(ctx.focus_node.id).map(id => ({ nodeId: id, question: `trace ${id}` })),
      });
    }
    throw new Error('consumer not reached within bound');
  }

  it('co_parent (outside the directed closure) is not in requiredNeighborIds and is refused out_of_direction when routed anyway; sink (inside the closure) is required and admitted', () => {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const res = engine.init({ origin: 'origin', question: 'trace', direction: 'bidirectional' });
    expect(!('error' in res), 'engine accepts a plain bidirectional init').toBe(true);
    driveToConsumer(engine);

    const required = engine.requiredNeighborIds('consumer');
    expect(required.includes('sink'), 'sink (downstream of origin via consumer) is required').toBe(true);
    expect(required.includes('co_parent'), 'co_parent (neither upstream nor downstream of origin) is not required').toBe(false);

    // The model asks for co_parent anyway (it read the edge off consumer's own dependencies) —
    // the router must refuse it, not silently admit it.
    const outcome = engine.submitFindings({
      focus_node_id: 'consumer',
      sections: [{ angle: 'business' as const, text: 'consumer' }],
      summary: 'consumer',
      verdict: 'analyze',
      route_requests: [
        ...required.map(id => ({ nodeId: id, question: `trace ${id}` })),
        { nodeId: 'co_parent', question: 'what does co_parent feed into consumer?' },
      ],
    }) as SubmitOk;
    expect(outcome.error, 'consumer hop commits despite the one refused route').toBeUndefined();
    const outcomes = outcome.route_outcomes ?? [];
    const coParentOutcome = outcomes.find(o => o.nodeId === 'co_parent');
    const sinkOutcome = outcomes.find(o => o.nodeId === 'sink');
    expect(coParentOutcome?.accepted === false && coParentOutcome?.reason === 'out_of_direction', `co_parent is refused out_of_direction (got ${JSON.stringify(coParentOutcome)})`).toBe(true);
    expect(sinkOutcome?.accepted === true, `sink is admitted (got ${JSON.stringify(sinkOutcome)})`).toBe(true);

    // Nodes inside the closure on both sides stay admitted through to the render; co_parent never
    // enters scope and never renders.
    const rendered = new Set(engine.getResult().fullNodes.map(n => n.id));
    expect(rendered.has('up1'), 'upstream-side node stays admitted and renders').toBe(true);
    expect(rendered.has('origin'), 'origin renders').toBe(true);
    expect(rendered.has('consumer'), 'downstream-side node stays admitted and renders').toBe(true);
    expect(rendered.has('sink'), 'downstream-side node beyond consumer stays admitted and renders').toBe(true);
    expect(rendered.has('co_parent'), 'the off-closure co-parent never renders').toBe(false);
  });

  it('upstream-only direction is unchanged: a node reachable only downstream is still refused out_of_direction the same way it was before this fix', () => {
    // Mirrors the existing pin in navigation-engine.test.ts — kept here so this suite documents
    // that the bidirectional fix (isReachableInApprovedDirection) leaves the non-bidirectional
    // branch (the directional BFS walk below it) untouched.
    const upNodes: LineageNode[] = [
      makeNode({ id: 'grandparent', schema: 'ai', name: 'grandparent', type: 'view' }),
      makeNode({ id: 'origin_up', schema: 'ai', name: 'origin_up', type: 'procedure' }),
      makeNode({ id: 'downstream_child', schema: 'ai', name: 'downstream_child', type: 'view' }),
    ];
    const upEdges: Array<[string, string]> = [
      ['grandparent', 'origin_up'],
      ['origin_up', 'downstream_child'],
    ];
    const upModel: DatabaseModel = makeModel(upNodes, upEdges, ['ai']);
    const upGraph = makeGraph(upNodes, upEdges);
    const engine = new NavigationEngine(upModel, upGraph, () => {}, {});
    engine.init({ origin: 'origin_up', question: 'trace upstream only', direction: 'upstream' });
    engine.getHopContext();
    // `grandparent` is seeded onto the agenda at init time (seedAgenda), so it is already queued
    // and correctly absent from `requiredNeighborIds` (the guard demands an account only for a
    // neighbor not already on the way in) — this asserts only the direction axis this suite
    // exists to pin: the wrong-direction node is excluded from what a route may ever admit.
    const required = engine.requiredNeighborIds('origin_up');
    expect(required.includes('downstream_child'), 'the downstream neighbor is not required in an upstream-only session').toBe(false);

    const outcome = engine.submitFindings({
      focus_node_id: 'origin_up',
      sections: [{ angle: 'business' as const, text: 'origin_up' }],
      summary: 'origin_up',
      verdict: 'analyze',
      route_requests: [
        { nodeId: 'grandparent', question: 'trace grandparent' },
        { nodeId: 'downstream_child', question: 'attempt to route the wrong direction' },
      ],
    }) as SubmitOk;
    const outcomes = outcome.route_outcomes ?? [];
    expect(outcomes.find(o => o.nodeId === 'grandparent')?.accepted, 'upstream route still admitted').toBe(true);
    const downstreamOutcome = outcomes.find(o => o.nodeId === 'downstream_child');
    expect(downstreamOutcome?.accepted === false && downstreamOutcome?.reason === 'out_of_direction', `downstream route still refused out_of_direction (got ${JSON.stringify(downstreamOutcome)})`).toBe(true);
  });
});
