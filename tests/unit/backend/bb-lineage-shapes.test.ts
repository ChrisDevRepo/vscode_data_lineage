// Owner: src/ai/sm/smBase.ts and engine/graphGuards.ts; BB navigation and prune functional
// contracts.
/**
 * Object-level (BB) pruning: a prune that would disconnect analysis from the origin is rejected,
 * and an object another unpruned route reaches stays.
 */
import { describe, expect, it } from 'vitest';
import {
  delivered,
  drain,
  withoutDirectedPath,
  world,
  type DepthSide,
} from './helpers/bbShapes';
import type { ObjectType } from '../../../src/engine/types';

const ALL: DepthSide = { levels: 'all', exactness: 'approximate' };

const v = (...ids: string[]): Record<string, ObjectType> =>
  Object.fromEntries(ids.map((id) => [id, 'view' as ObjectType]));

describe('BB lineage: a prune without support is rejected at submission', () => {
  // Both sides open. d reads the origin's downstream table and is dispatched before s, the origin's
  // upstream source; d routes u, which lies upstream of the origin only through s. A prune of s by
  // d would disconnect u, so d's submission is rejected and nothing is enqueued for s on its
  // behalf.
  const types: Record<string, ObjectType> = {
    o: 'view',
    t: 'table',
    u: 'view',
    s: 'view',
    d: 'view',
    b: 'table',
  };
  const edges: Array<[string, string]> = [
    ['s', 'd'],
    ['u', 't'],
    ['d', 't'],
    ['s', 'u'],
    ['b', 'd'],
    ['u', 'd'],
    ['o', 'b'],
    ['s', 'o'],
    ['t', 's'],
  ];

  it('rejects the prune entry with the analysis it would disconnect', () => {
    const w = world(types, edges, 'o', ALL, ALL);
    expect(() =>
      drain(w.engine, w.graph, {
        o: { prune: ['s'] },
        d: { prune: ['s', 't'] },
      }),
    ).toThrow(
      /hop d rejected: .*"kind":"prune_unsupported","id":"s","path":"prune_neighbors\.0\.id".*"errors":\[\{"path":"prune_neighbors\.0\.id","code":"prune_target"/,
    );
    expect(w.engine.toJSON().agenda.map((entry) => entry.nodeId)).not.toContain(
      's',
    );
  });
});

describe('BB lineage: a prune is plain reachability', () => {
  // Cycle o -> x -> s -> o, both directions. The origin prunes x on its downstream side, but s, the
  // origin's upstream neighbour, routes x on the other side. The unpruned path o <- s <- x still
  // reaches x, so x stays and gets its hop: no sender's vote removes an object another route
  // reaches.
  it('an object another unpruned route reaches stays although one side pruned it', () => {
    const w = world(
      v('o', 's', 'x'),
      [
        ['o', 'x'],
        ['x', 's'],
        ['s', 'o'],
      ],
      'o',
      ALL,
      ALL,
    );
    const order = drain(w.engine, w.graph, { o: { prune: ['x'] } });
    expect(order).toEqual(['o', 's', 'x']);
    expect(delivered(w.engine)).toMatchObject({
      nodes: ['o', 's', 'x'],
      edges: ['o>x', 's>o', 'x>s'],
      pruned: [],
    });
    expect(
      withoutDirectedPath(w.engine, 'o', { upstream: true, downstream: true }),
    ).toEqual([]);
  });
});
