import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { evaluateCurrentHopActionPolicy } from '../../../src/ai/sm/currentHopActionPolicy';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

describe('current-hop action policy', () => {
  it('classifies a repeated prune as already pruned rather than already analyzed', () => {
    const result = evaluateCurrentHopActionPolicy({
      originId: 'origin',
      routeTargets: [],
      pruneTargets: [{ raw: 'removed', resolved: 'removed', path: 'prune_neighbors.0' }],
      scopeNodeIds: new Set(),
      visitedIds: new Set(),
      removedIds: new Set(['removed']),
      notedIds: new Set(),
      agendaIds: new Set(),
    });

    expect(result.acceptedPruneIds).toEqual([]);
    expect(result.notices).toEqual([expect.objectContaining({
      kind: 'prune_noop_removed',
      id: 'removed',
      reason: expect.stringContaining('already pruned'),
    })]);
  });

  it('accepts the hop-level prune of an untouched in-scope neighbour (D-020)', () => {
    const result = evaluateCurrentHopActionPolicy({
      originId: 'origin',
      routeTargets: [],
      pruneTargets: [{ raw: 'in-scope', resolved: 'in-scope', path: 'prune_neighbors.0' }],
      scopeNodeIds: new Set(['in-scope']),
      visitedIds: new Set(),
      removedIds: new Set(),
      notedIds: new Set(),
      agendaIds: new Set(),
    });

    // In scope, not yet visited/queued/noted/removed: the prune executes and the don't-orphan
    // topology check (wired in NavigationEngine) governs it — the required-neighbour guard is
    // satisfied by the executed prune, not only by a route.
    expect(result.acceptedPruneIds).toEqual(['in-scope']);
    expect(result.fatalErrors).toEqual([]);
    expect(result.notices).toEqual([]);
  });

  it('protects a queued neighbour from the prune — the notice, never the queue', () => {
    const result = evaluateCurrentHopActionPolicy({
      originId: 'origin',
      routeTargets: [],
      pruneTargets: [{ raw: 'queued', resolved: 'queued', path: 'prune_neighbors.0' }],
      scopeNodeIds: new Set(['queued']),
      visitedIds: new Set(),
      removedIds: new Set(),
      notedIds: new Set(),
      agendaIds: new Set(['queued']),
    });

    // An already-queued neighbour owns a hop of its own; prune_neighbors must not pull queued
    // work. The prune is a notice, never a fatal and never an accepted prune.
    expect(result.acceptedPruneIds).toEqual([]);
    expect(result.fatalErrors).toEqual([]);
    expect(result.notices).toEqual([expect.objectContaining({
      kind: 'prune_noop_queued',
      id: 'queued',
      reason: expect.stringContaining('already queued'),
    })]);
  });
});

describe('current-hop prune accounting — the refused-prune hint reads the resolved id', () => {
  // Canonical model ids are bracketed and lowercase (`normalizeName`), and a model that spells the
  // same neighbour unbracketed still resolves to that id. The required-neighbour verdict must be
  // read against the resolved id, so a refused prune reports the prune it received rather than an
  // id the model never omitted.
  const nodes: LineageNode[] = [
    makeNode({ id: '[dbo].[origin]', schema: 'dbo', name: 'origin', type: 'procedure' }),
    makeNode({ id: '[dbo].[a]',      schema: 'dbo', name: 'a',      type: 'view' }),
    makeNode({ id: '[dbo].[b]',      schema: 'dbo', name: 'b',      type: 'table' }),
    makeNode({ id: '[dbo].[c]',      schema: 'dbo', name: 'c',      type: 'view' }),
  ];
  const edges: Array<[string, string]> = [
    ['[dbo].[origin]', '[dbo].[a]'],
    ['[dbo].[a]', '[dbo].[b]'],
    ['[dbo].[b]', '[dbo].[c]'],
  ];

  it('names the refused prune when prune_neighbors spells the required neighbour unbracketed', () => {
    const model: DatabaseModel = makeModel(nodes, edges, ['dbo']);
    const graph = makeGraph(nodes, edges);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: '[dbo].[origin]', question: 'refused prune hint', direction: 'downstream', depthIntent: { kind: 'explicit', levels: 3 } });

    const focus1 = engine.getHopContext();
    expect('focus_node' in focus1 && focus1.focus_node?.id === '[dbo].[origin]', 'first focus is origin').toBe(true);
    engine.submitFindings({
      focus_node_id: '[dbo].[origin]',
      sections: [{ angle: 'business' as const, text: 'o' }],
      summary: 'o',
      verdict: 'analyze',
      route_requests: [{ nodeId: '[dbo].[a]', question: '?' }],
    });
    const focus2 = engine.getHopContext();
    expect('focus_node' in focus2 && focus2.focus_node?.id === '[dbo].[a]', 'second focus is a').toBe(true);
    engine.submitFindings({
      focus_node_id: '[dbo].[a]',
      sections: [{ angle: 'business' as const, text: 'a' }],
      summary: 'a',
      verdict: 'analyze',
      route_requests: [{ nodeId: '[dbo].[b]', question: 'trace through b' }],
    });
    const focus3 = engine.getHopContext();
    expect('focus_node' in focus3 && focus3.focus_node?.id === '[dbo].[c]', 'passive b contracts to c').toBe(true);
    engine.submitFindings({ focus_node_id: '[dbo].[c]', sections: [{ angle: 'business' as const, text: 'c' }], summary: 'c', verdict: 'analyze' });
    expect(engine.getHopContext().done === true, 'the setup completes before a reactivation').toBe(true);
    const supplemented = engine.supplementAgenda(['[dbo].[a]']);
    expect('ok' in supplemented && supplemented.agendaed === 1, 'a is reactivated for the prune probe').toBe(true);
    const reactivated = engine.getHopContext();
    expect('focus_node' in reactivated && reactivated.focus_node?.id === '[dbo].[a]', 'reactivated focus is a').toBe(true);

    const rejection = engine.submitFindings({
      focus_node_id: '[dbo].[a]',
      sections: [{ angle: 'business' as const, text: 'attempted a analysis' }],
      summary: 'a summary',
      verdict: 'analyze',
      prune_neighbors: ['dbo.B'],
    }) as { error?: string; hint?: string; detail?: unknown };

    expect(rejection.error === 'route_validation_failed', 'the orphaning prune is rejected').toBe(true);
    expect(/submitted in prune_neighbors were refused/.test(rejection.hint ?? ''), 'the hint reports the refused prune, not an unaccounted neighbour').toBe(true);
    expect(/not accounted for/.test(rejection.hint ?? ''), 'the neighbour the model did submit is never reported as omitted').toBe(false);
    const missing = (rejection.detail as Array<Record<string, unknown>>).find(e => /was submitted in prune_neighbors/.test(String(e.reason)));
    expect(missing?.id, 'the refusal is attributed to the canonical neighbour id').toBe('[dbo].[b]');
  });
});
