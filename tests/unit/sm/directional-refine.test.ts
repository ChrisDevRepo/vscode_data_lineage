/** Refine removal safety uses directed upstream/downstream closure without changing direction. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

function engineFor(pairs: Array<[string, string]>, side: 'both' | 'upstream' | 'downstream') {
  const nodes = ['a', 'b', 'c', 'd'].map(id => makeNode({ id, name: id, schema: 'dbo', type: 'view' }));
  const engine = new NavigationEngine(makeModel(nodes, pairs, ['dbo']), makeGraph(nodes, pairs), () => {}, {});
  expect(engine.init({ origin: 'a', question: 'Trace related objects', direction: 'bidirectional', analysisMode: 'bb',
    depthIntent: { upstream: { levels: side === 'downstream' ? 0 : 'all', exactness: 'exact' },
      downstream: { levels: side === 'upstream' ? 0 : 'all', exactness: 'exact' } },
  })).toMatchObject({ ok: true });
  return engine;
}

const downstream: Array<[string, string]> = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['a', 'd']];
const upstream = downstream.map(([from, to]) => [to, from] as [string, string]);

describe('directional refine removal safety', () => {
  it.each([
    ['downstream', 'both', downstream], ['upstream', 'both', upstream],
    ['downstream', 'downstream', downstream], ['upstream', 'upstream', upstream],
  ] as const)('requires passing B when only a sideways %s detour remains (approved=%s)', (_side, approved, pairs) => {
    const engine = engineFor([...pairs], approved);
    const before = engine.toJSON();
    expect(engine.classifyForRefine(['b'])).toEqual({ prunable: [], mustPass: ['b'] });
    expect(engine.toJSON()).toEqual(before);
  });

  it.each(['both', 'downstream'] as const)('allows pruning B when an independent directed path still reaches every survivor (approved=%s)', approved => {
    const engine = engineFor([...downstream, ['a', 'c']], approved);
    expect(engine.classifyForRefine(['b'])).toEqual({ prunable: ['b'], mustPass: [] });
  });

  it('permits an upstream leaf removal when every remaining node keeps its sole upstream leg', () => {
    const engine = engineFor(upstream, 'both');
    expect(engine.classifyForRefine(['c'])).toEqual({ prunable: ['c'], mustPass: [] });
  });
});
