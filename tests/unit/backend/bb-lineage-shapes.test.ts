// Owner: src/ai/sm/smBase.ts and engine/graphGuards.ts; BB navigation and prune functional contracts.
/**
 * Object-level (BB) lineage by graph shape: the delivered graph is the approved directed ball of the
 * origin minus what a prune removed, every delivered node keeps a directed path to the origin, and
 * every delivered edge joins two delivered nodes.
 */
import { describe, expect, it } from 'vitest';
import { delivered, drain, submit, withoutDirectedPath, world, type DepthSide, type HopScript } from './helpers/bbShapes';
import type { ObjectType } from '../../../src/engine/types';

const ALL: DepthSide = { levels: 'all', exactness: 'approximate' };
const CLOSED: DepthSide = { levels: 0, exactness: 'exact' };
const exact = (levels: number): DepthSide => ({ levels, exactness: 'exact' });

interface Shape {
  name: string;
  types: Record<string, ObjectType>;
  edges: Array<[string, string]>;
  up: DepthSide;
  down: DepthSide;
  script?: Record<string, HopScript>;
  nodes: string[];
  pruned?: string[];
  leads?: string[];
}

const v = (...ids: string[]): Record<string, ObjectType> => Object.fromEntries(ids.map(id => [id, 'view' as ObjectType]));

const SHAPES: Shape[] = [
  { name: 'chain under an exact border defers the next level', types: v('o', 'a', 'b', 'c'), edges: [['o', 'a'], ['a', 'b'], ['b', 'c']], up: CLOSED, down: exact(2), nodes: ['a', 'b', 'o'], leads: ['c:depth_boundary'] },
  { name: 'transitive shortcut sets the level', types: v('o', 'a', 'b', 'c'), edges: [['o', 'a'], ['a', 'b'], ['b', 'c'], ['o', 'c']], up: CLOSED, down: exact(1), nodes: ['a', 'c', 'o'], leads: ['b:depth_boundary'] },
  { name: 'a table counts as a level and is kept at the border', types: { o: 'view', t: 'table', a: 'view' }, edges: [['o', 't'], ['t', 'a']], up: CLOSED, down: exact(1), nodes: ['o', 't'], leads: ['a:depth_boundary'] },
  { name: 'diamond keeps the join on one keep vote', types: v('o', 'a', 'b', 'j', 'k'), edges: [['o', 'a'], ['o', 'b'], ['a', 'j'], ['b', 'j'], ['j', 'k']], up: CLOSED, down: ALL, script: { a: { prune: ['j'] } }, nodes: ['a', 'b', 'j', 'k', 'o'] },
  { name: 'one submission prunes an arm and investigates the other without cutting the shared join', types: v('o', 'a', 'b', 'j'), edges: [['o', 'a'], ['o', 'b'], ['a', 'j'], ['b', 'j']], up: CLOSED, down: ALL, script: { o: { prune: ['a'], ask: ['b'] } }, nodes: ['b', 'j', 'o'], pruned: ['a'], leads: ['a:pruned_by_ai'] },
  { name: 'diamond cuts the join and its tail when both arms prune', types: v('o', 'a', 'b', 'j', 'k'), edges: [['o', 'a'], ['o', 'b'], ['a', 'j'], ['b', 'j'], ['j', 'k']], up: CLOSED, down: ALL, script: { a: { prune: ['j'] }, b: { prune: ['j'] } }, nodes: ['a', 'b', 'o'], pruned: ['j', 'k'], leads: ['j:pruned_by_ai', 'j:pruned_by_ai'] },
  { name: 'unequal parallel paths keep the far node through the surviving arm', types: v('o', 'a', 'b', 'c', 'd'), edges: [['o', 'a'], ['a', 'b'], ['b', 'c'], ['o', 'c'], ['c', 'd']], up: CLOSED, down: ALL, script: { o: { prune: ['a'] } }, nodes: ['c', 'd', 'o'], pruned: ['a', 'b'], leads: ['a:pruned_by_ai'] },
  { name: 'pruned table cut vertex takes its exclusive readers', types: { o: 'view', t: 'table', b: 'view', c: 'view' }, edges: [['o', 't'], ['t', 'b'], ['b', 'c']], up: CLOSED, down: ALL, script: { o: { prune: ['t'] } }, nodes: ['o'], pruned: ['b', 'c', 't'], leads: ['t:pruned_by_ai'] },
  { name: 'pruned table beside a kept path removes only the table', types: { o: 'view', t: 'table', a: 'view', b: 'view' }, edges: [['o', 't'], ['t', 'b'], ['o', 'a'], ['a', 'b']], up: CLOSED, down: ALL, script: { o: { prune: ['t'] } }, nodes: ['a', 'b', 'o'], pruned: ['t'], leads: ['t:pruned_by_ai'] },
  { name: 'a later reader cannot prune the table it arrived through', types: { o: 'view', t: 'table', f: 'view', g: 'view' }, edges: [['o', 't'], ['t', 'f'], ['t', 'g']], up: CLOSED, down: ALL, script: { f: { prune: ['t'] }, g: { prune: ['t'] } }, nodes: ['f', 'g', 'o', 't'] },
  { name: 'two-cycle with a tail', types: v('o', 'a', 'b'), edges: [['o', 'a'], ['a', 'o'], ['a', 'b']], up: ALL, down: ALL, nodes: ['a', 'b', 'o'] },
  { name: 'figure-eight through the origin', types: v('o', 'a', 'b', 'c', 'd'), edges: [['o', 'a'], ['a', 'b'], ['b', 'o'], ['o', 'c'], ['c', 'd'], ['d', 'o']], up: ALL, down: ALL, nodes: ['a', 'b', 'c', 'd', 'o'] },
  { name: 'cycle whose entry is pruned leaves with its entry', types: v('o', 'a', 'b', 'c'), edges: [['o', 'a'], ['a', 'b'], ['b', 'c'], ['c', 'a']], up: CLOSED, down: ALL, script: { o: { prune: ['a'] } }, nodes: ['o'], pruned: ['a', 'b', 'c'], leads: ['a:pruned_by_ai'] },
  { name: 'a visited cycle member cannot be pruned by a later member', types: v('o', 'c', 'f'), edges: [['o', 'c'], ['c', 'f'], ['f', 'c']], up: CLOSED, down: ALL, script: { f: { prune: ['c'] } }, nodes: ['c', 'f', 'o'] },
  { name: 'table origin read and written by one procedure, downstream', types: { t: 'table', p: 'procedure', x: 'table' }, edges: [['t', 'p'], ['p', 't'], ['p', 'x']], up: CLOSED, down: ALL, nodes: ['p', 't', 'x'] },
  { name: 'table origin read and written by one procedure, upstream', types: { t: 'table', p: 'procedure', x: 'table', s: 'table' }, edges: [['t', 'p'], ['p', 't'], ['p', 'x'], ['s', 'p']], up: ALL, down: CLOSED, nodes: ['p', 's', 't'] },
  { name: 'procedure origin keeps its written sink and its read source', types: { p: 'procedure', s: 'table', r: 'table' }, edges: [['p', 's'], ['r', 'p']], up: ALL, down: ALL, nodes: ['p', 'r', 's'] },
  { name: 'every neighbour pruned leaves the origin as a dead end', types: v('o', 'a', 'b'), edges: [['o', 'a'], ['b', 'o']], up: ALL, down: ALL, script: { o: { prune: ['a', 'b'] } }, nodes: ['o'], pruned: ['a', 'b'], leads: ['a:pruned_by_ai', 'b:pruned_by_ai'] },
  { name: 'a sibling consumer of an upstream source is not lineage', types: v('o', 'n', 'y'), edges: [['n', 'o'], ['n', 'y']], up: ALL, down: ALL, nodes: ['n', 'o'] },
  { name: 'a second component is never entered', types: v('o', 'a', 'x', 'y'), edges: [['o', 'a'], ['x', 'y']], up: ALL, down: ALL, nodes: ['a', 'o'] },
  { name: 'a sideways node past the other side border is deferred, not added', types: v('o', 'n', 'y', 'a', 'b'), edges: [['n', 'o'], ['n', 'y'], ['o', 'a'], ['a', 'b'], ['b', 'y']], up: ALL, down: exact(1), nodes: ['a', 'n', 'o'], leads: ['b:depth_boundary', 'y:depth_boundary'] },
];

describe('BB lineage by shape', () => {
  it.each(SHAPES)('$name', shape => {
    const origin = Object.keys(shape.types)[0];
    const w = world(shape.types, shape.edges, origin, shape.up, shape.down);
    const before = w.scope();
    const order = drain(w.engine, w.graph, shape.script);
    const result = delivered(w.engine);
    expect(result.nodes).toEqual(shape.nodes);
    expect(result.pruned).toEqual(shape.pruned ?? []);
    expect(result.pruned.filter(id => order.includes(id))).toEqual([]);
    expect(w.leads()).toEqual(shape.leads ?? []);
    expect(withoutDirectedPath(w.engine, origin, { upstream: shape.up.levels !== 0, downstream: shape.down.levels !== 0 })).toEqual([]);
    const kept = new Set(shape.nodes);
    expect(result.edges).toEqual(shape.edges.filter(([s, t]) => kept.has(s) && kept.has(t)).map(([s, t]) => `${s}>${t}`).sort());
    expect(w.scope()).toEqual(before);
    expect(delivered(w.engine)).toEqual(result);
  });
});

describe('BB lineage: a prune inside a cycle through the origin', () => {
  // origin -> d -> j -> origin, j -> x. The origin and j both prune d: the upstream leg still holds j,
  // and x, whose only directed path ran origin -> d -> j -> x, can no longer be routed by j.
  it('a sender cannot route a continuation its own prune disconnects; naming both removes both', () => {
    const w = world(v('origin', 'd', 'j', 'x'), [['origin', 'd'], ['d', 'j'], ['j', 'origin'], ['j', 'x']], 'origin', ALL, ALL);
    expect(w.engine.getHopContext()).toMatchObject({ focus_node: { id: 'origin' } });
    expect(submit(w.engine, 'origin', { prune: ['d'], ask: ['j'] })).not.toHaveProperty('pruned');
    expect(w.engine.getHopContext()).toMatchObject({ focus_node: { id: 'j' } });
    const before = w.engine.toJSON();
    expect(submit(w.engine, 'j', { prune: ['d'], ask: ['x'] })).toMatchObject({
      code: 'route_validation_failed', issuePaths: ['prune_neighbors.0.id'],
      reason: 'prune_neighbors.0.id: `d`: Removing it would disconnect committed analysis of x.',
    });
    expect(w.engine.toJSON().removedSet).toEqual(before.removedSet);
    const ack = submit(w.engine, 'j', { prune: ['d', 'x'], ask: [] });
    expect(ack).toMatchObject({ ok: true, pruned: ['d', 'x'] });
    expect(ack).not.toHaveProperty('cut_ids');
    expect(w.engine.getHopContext()).toMatchObject({ done: true });
    expect(delivered(w.engine)).toMatchObject({ nodes: ['j', 'origin'], pruned: ['d', 'x'] });
    expect(withoutDirectedPath(w.engine, 'origin', { upstream: true, downstream: true })).toEqual([]);
  });
});

describe('BB lineage: a prune reports what it removed', () => {
  it('the acknowledgement names the pruned neighbour and the readers cut with it', () => {
    const w = world({ o: 'view', t: 'table', b: 'view', c: 'view' }, [['o', 't'], ['t', 'b'], ['b', 'c']], 'o', CLOSED, ALL);
    expect(w.engine.getHopContext()).toMatchObject({ focus_node: { id: 'o' } });
    expect(submit(w.engine, 'o', { prune: ['t'] })).toMatchObject({ ok: true, pruned: ['t'], cut_ids: ['b', 'c'] });
    expect(w.engine.commitRemovals).toEqual({ pruned: ['t'], cut_ids: ['b', 'c'] });
  });
});

describe('BB lineage: a prune without support is rejected at submission', () => {
  // Both sides open. d reads the origin's downstream table and is dispatched before s, the origin's
  // upstream source; d routes u, which lies upstream of the origin only through s. A prune of s by
  // d would disconnect u, so d's submission is rejected and nothing is enqueued for s on its behalf.
  const types: Record<string, ObjectType> = { o: 'view', t: 'table', u: 'view', s: 'view', d: 'view', b: 'table' };
  const edges: Array<[string, string]> = [['s', 'd'], ['u', 't'], ['d', 't'], ['s', 'u'], ['b', 'd'], ['u', 'd'], ['o', 'b'], ['s', 'o'], ['t', 's']];

  it('rejects the prune entry with the analysis it would disconnect', () => {
    const w = world(types, edges, 'o', ALL, ALL);
    expect(() => drain(w.engine, w.graph, { o: { prune: ['s'] }, d: { prune: ['s', 't'] } }))
      .toThrow('prune_neighbors.0.id: `s`: Removing it would disconnect committed analysis of u.');
    expect(w.engine.toJSON().agenda.map(entry => entry.nodeId)).not.toContain('s');
  });

  it('authored questions preserve a kept neighbour and no accepted vote is refused later', () => {
    const w = world(types, edges, 'o', ALL, ALL);
    const order = drain(w.engine, w.graph, { o: { prune: ['s'] } });
    expect(order).toContain('s');
    expect(w.logs.some(line => line.includes('[Prune] reject'))).toBe(false);
    expect(delivered(w.engine).pruned).toEqual([]);
  });

  it('rejects a vote whose removal, together with pending prunes, would disconnect committed analysis', () => {
    const w = world(v('o', 'a', 'b', 'c', 'd', 'e'), [['o', 'a'], ['o', 'e'], ['a', 'b'], ['b', 'o'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['e', 'o'], ['e', 'b'], ['e', 'c']], 'o', ALL, ALL);
    expect(() => drain(w.engine, w.graph, { o: { prune: ['b', 'c', 'e'] }, a: { prune: ['o', 'b', 'e'] } }))
      .toThrow(/hop a rejected: .*`b`: Removing it would disconnect committed analysis of d\..*`e`: Removing it would disconnect committed analysis of d\./);
  });
});

describe('BB lineage: a prune is plain reachability', () => {
  // Cycle o -> x -> s -> o, both directions. The origin prunes x on its downstream side, but s, the
  // origin's upstream neighbour, routes x on the other side. The unpruned path o <- s <- x still
  // reaches x, so x stays and gets its hop: no sender's vote removes an object another route reaches.
  it('an object another unpruned route reaches stays although one side pruned it', () => {
    const w = world(v('o', 's', 'x'), [['o', 'x'], ['x', 's'], ['s', 'o']], 'o', ALL, ALL);
    const order = drain(w.engine, w.graph, { o: { prune: ['x'] } });
    expect(order).toEqual(['o', 's', 'x']);
    expect(delivered(w.engine)).toMatchObject({ nodes: ['o', 's', 'x'], edges: ['o>x', 's>o', 'x>s'], pruned: [] });
    expect(withoutDirectedPath(w.engine, 'o', { upstream: true, downstream: true })).toEqual([]);
  });
});
