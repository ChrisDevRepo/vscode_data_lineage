import { describe, expect, it } from 'vitest';
import { evaluateCurrentHopActionPolicy } from '../../../src/ai/sm/currentHopActionPolicy';

describe('current-hop action policy', () => {
  it('classifies a repeated prune as already pruned rather than already analyzed', () => {
    const result = evaluateCurrentHopActionPolicy({
      originId: 'origin',
      routeTargets: [],
      pruneTargets: [{ raw: 'removed', resolved: 'removed', path: 'prune_neighbors.0' }],
      scopeNodeIds: new Set(),
      requiredNeighborIds: new Set(),
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
      requiredNeighborIds: new Set(['in-scope']),
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
      requiredNeighborIds: new Set(['queued']),
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
      kind: 'prune_noop_in_scope',
      id: 'queued',
      reason: expect.stringContaining('already queued'),
    })]);
  });
});
