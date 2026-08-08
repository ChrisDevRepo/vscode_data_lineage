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
    });

    expect(result.acceptedPruneIds).toEqual([]);
    expect(result.notices).toEqual([expect.objectContaining({
      kind: 'prune_noop_removed',
      id: 'removed',
      reason: expect.stringContaining('already pruned'),
    })]);
  });
});
