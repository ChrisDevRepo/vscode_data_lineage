/** A hop route never re-admits what the approved exclusion and depth borders kept out of the scope. */
import { describe, expect, it } from 'vitest';
import { delivered, drain, world, type DepthSide } from './helpers/bbShapes';

const ALL: DepthSide = { levels: 'all', exactness: 'approximate' };
const CLOSED: DepthSide = { levels: 0, exactness: 'exact' };

describe('approved border on hop routing', () => {
  it('keeps an object out when its only directed path runs through an excluded object', () => {
    // src -> origin, src -> reader; origin -> excluded -> reader
    const w = world(
      { origin: 'view', src: 'view', reader: 'view', excluded: 'view' },
      [['src', 'origin'], ['src', 'reader'], ['origin', 'excluded'], ['excluded', 'reader']],
      'origin', ALL, ALL, { excludeNodeIds: ['excluded'] },
    );
    expect(w.scope()).toEqual(['origin', 'src']);
    expect(drain(w.engine)).toEqual(['origin', 'src']);
    expect(delivered(w.engine).nodes).toEqual(['origin', 'src']);
    expect(w.scope()).toEqual(['origin', 'src']);
  });

  it('keeps an object out when an excluded type is its only directed connector', () => {
    const w = world(
      { origin: 'view', staging: 'table', reader: 'view', src: 'view' },
      [['origin', 'staging'], ['staging', 'reader'], ['src', 'origin'], ['src', 'reader']],
      'origin', ALL, ALL, { excludeTypes: ['table'] },
    );
    expect(drain(w.engine)).toEqual(['origin', 'src']);
    expect(delivered(w.engine).nodes).toEqual(['origin', 'src']);
  });

  it('measures an exact depth border on the kept path, not through an excluded shortcut', () => {
    // origin -> excluded -> far (2 levels) and origin -> a -> b -> c -> far (4 levels), border at 3
    const w = world(
      { origin: 'view', excluded: 'view', far: 'view', a: 'view', b: 'view', c: 'view' },
      [['origin', 'excluded'], ['excluded', 'far'], ['origin', 'a'], ['a', 'b'], ['b', 'c'], ['c', 'far']],
      'origin', CLOSED, { levels: 3, exactness: 'exact' }, { excludeNodeIds: ['excluded'] },
    );
    expect(w.scope()).toEqual(['a', 'b', 'c', 'origin']);
    expect(drain(w.engine)).toEqual(['origin', 'a', 'b', 'c']);
    expect(delivered(w.engine).nodes).toEqual(['a', 'b', 'c', 'origin']);
    expect(w.leads()).toEqual(['far:depth_boundary']);
  });
});
