/**
 * A refused neighbor prune states the reason it was refused. A node outside the approved scope is not
 * removable and the notice says so; the disconnected-analysis wording is reserved for a removal that
 * disconnects visited analysis and always lists those nodes, never an empty list.
 */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const col = { name: 'Total', type: 'int', nullable: 'NULL' as const, extra: '' };

/* eslint-disable @typescript-eslint/no-explicit-any -- the ballot book is driven directly */
function engineWithPendingPrune(): any {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'ct', name: 'origin', type: 'procedure', columns: [col] }),
    makeNode({ id: 'source', schema: 'ct', name: 'source', type: 'view', columns: [col] }),
    makeNode({ id: 'writeTarget', schema: 'ct', name: 'writeTarget', type: 'table', columns: [col] }),
  ];
  const edges: Array<[string, string]> = [['source', 'origin'], ['origin', 'writeTarget']];
  const engine: any = new NavigationEngine(makeModel(nodes, edges, ['ct']), makeGraph(nodes, edges), () => {}, {});
  const init = engine.init({
    origin: 'origin', question: 'trace Total', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Total'],
    depthIntent: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
  });
  expect(init.ok).toBe(true);
  expect(engine.scopeNodeIds.has('writeTarget')).toBe(false);
  return engine;
}

describe('refused prune names its reason', () => {
  it('a prune vote on a node outside the approved scope is refused for that reason, not with an empty list', () => {
    const engine = engineWithPendingPrune();
    engine.pruneBallots.set('writeTarget', new Map([['origin', 'prune']]));
    engine.tryResolvePrunes(['writeTarget'], true);
    const notices: string[] = engine.toJSON().memory.recentRejections.filter((r: { nodeId: string }) => r.nodeId === 'writeTarget').map((r: { reason: string }) => r.reason);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('outside the approved scope');
    expect(notices[0]).not.toMatch(/: \.$/);
    expect(engine.toJSON().removedSet).not.toContain('writeTarget');
  });
});
