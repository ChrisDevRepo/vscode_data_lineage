/** A side at `levels: 0` is closed whatever its exactness; exactness only bounds open sides. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DepthIntent } from '../../../src/ai/sm/smTypes';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

type Exactness = 'exact' | 'approximate';
type Side = 'upstream' | 'downstream';

/** Chain a -> b -> c -> d with origin b: `a` is upstream, `c` and `d` are downstream. */
function start(depthIntent: DepthIntent) {
  const nodes = ['a', 'b', 'c', 'd'].map(id => makeNode({ id, name: id, schema: 'dbo', type: 'view' }));
  const pairs: Array<[string, string]> = [['a', 'b'], ['b', 'c'], ['c', 'd']];
  const model = makeModel(nodes, pairs, ['dbo']);
  const graph = makeGraph(nodes, pairs);
  const logs: string[] = [];
  const engine = new NavigationEngine(model, graph, (_level, message) => { logs.push(message); }, {});
  expect(engine.init({ origin: 'b', question: 'Trace related objects', direction: 'bidirectional', analysisMode: 'bb', depthIntent }))
    .toMatchObject({ ok: true });
  return { engine, logs, model, graph };
}

/** Intent that closes `closed` with the given exactness and leaves the other side open. */
function closedIntent(closed: Side, exactness: Exactness, open: DepthIntent['upstream'] = { levels: 'all', exactness: 'approximate' }): DepthIntent {
  const zero = { levels: 0 as const, exactness };
  return closed === 'downstream' ? { upstream: open, downstream: zero } : { upstream: zero, downstream: open };
}

function observe(engine: NavigationEngine, closed: Side) {
  const internals = engine.toJSON().engineInternals;
  engine.getHopContext();
  const open: Side = closed === 'downstream' ? 'upstream' : 'downstream';
  const target = closed === 'downstream' ? 'c' : 'a';
  const sibling = closed === 'downstream' ? 'a' : 'c';
  const result = engine.submitFindings({
    focus_node_id: 'b', verdict: 'analyze', summary: 'Origin', sections: [{ angle: 'technical', text: 'Origin DDL' }],
    questions: [{ nodeId: sibling, question: 'Open side' }, { nodeId: target, question: 'Closed side' }],
  } as never);
  return {
    open, enforcement: engine.getHopDiagnostics().depthEnforcement, budget: engine.getHopDiagnostics().depthBudget,
    limits: internals.depthLimits, scopeSize: engine.scopeSize, routes: (result as { route_outcomes?: unknown }).route_outcomes,
  };
}

describe('closed side depth cap', () => {
  it.each(['downstream', 'upstream'] as const)('resolves a closed %s side the same for approximate and exact', closed => {
    const approximate = start(closedIntent(closed, 'approximate'));
    const exact = start(closedIntent(closed, 'exact'));
    const seen = observe(approximate.engine, closed);
    expect(seen).toEqual(observe(exact.engine, closed));
    expect(seen.limits).toMatchObject({ [closed]: 0, [seen.open]: null });
    expect(seen.enforcement).toBe('strict');
    expect(seen.scopeSize).toBe(closed === 'downstream' ? 2 : 3);
    expect(seen.routes).toContainEqual(expect.objectContaining({ accepted: false, deferred: true, reason: 'out_of_direction' }));
    expect(approximate.logs.find(line => line.startsWith('[Depth] resolved'))).toContain(closed === 'downstream' ? 'cap=up:all/down:0' : 'cap=up:0/down:all');
    expect(approximate.engine.currentDepthIntent[closed]).toEqual({ levels: 0, exactness: 'approximate' });
  });

  it.each(['downstream', 'upstream'] as const)('keeps the published budget of a closed %s side with a finite exact open side', closed => {
    const open = { levels: 1 as const, exactness: 'exact' as const };
    const approximate = observe(start(closedIntent(closed, 'approximate', open)).engine, closed);
    expect(approximate).toEqual(observe(start(closedIntent(closed, 'exact', open)).engine, closed));
    expect(approximate.budget).toBe(1);
  });

  it('resolves a closed approximate side as a strict cap', () => {
    const { engine } = start(closedIntent('downstream', 'approximate'));
    expect(engine.getHopDiagnostics().depthEnforcement).toBe('strict');
    expect(engine.toJSON().engineInternals.depthLimits).toEqual({ upstream: null, downstream: 0 });
  });

  it.each(['downstream', 'upstream'] as const)('leaves an open approximate %s side unbounded', side => {
    const approximate = { levels: 1 as const, exactness: 'approximate' as const };
    const closed: Side = side === 'downstream' ? 'upstream' : 'downstream';
    const { engine } = start(closedIntent(closed, 'approximate', approximate));
    expect(engine.getHopDiagnostics().depthEnforcement).toBe('strict');
    expect(engine.toJSON().engineInternals.depthLimits).toEqual({ [closed]: 0, [side]: null });
    const bothOpen = start({ upstream: approximate, downstream: { levels: 2, exactness: 'approximate' } });
    expect(bothOpen.engine.getHopDiagnostics().depthEnforcement).toBe('silent');
    expect(bothOpen.engine.toJSON().engineInternals.depthLimits).toEqual({ upstream: null, downstream: null });
    expect(bothOpen.engine.scopeSize).toBe(4);
  });

  it('resolves a refine that closes a side the same for approximate and exact', () => {
    const refined = (exactness: Exactness) => {
      const { engine, logs } = start({ upstream: { levels: 'all', exactness: 'approximate' }, downstream: { levels: 'all', exactness: 'approximate' } });
      expect(engine.init({ origin: 'b', question: 'Trace related objects', direction: 'upstream', analysisMode: 'bb', depthIntent: closedIntent('downstream', exactness) }))
        .toMatchObject({ ok: true });
      return { cap: logs.filter(line => line.startsWith('[Depth] resolved')).pop()?.replace(/ up=.*? enforcement/, ' enforcement'), limits: engine.toJSON().engineInternals.depthLimits, enforcement: engine.getHopDiagnostics().depthEnforcement, scope: engine.scopeSize };
    };
    const approximate = refined('approximate');
    expect(approximate).toEqual(refined('exact'));
    expect(approximate).toMatchObject({ limits: { upstream: null, downstream: 0 }, enforcement: 'strict', scope: 2 });
  });

  it.each(['downstream', 'upstream'] as const)('reports the same depth breach beside a closed %s side for approximate and exact', closed => {
    const run = (exactness: Exactness) => {
      const nodes = ['a', 'b', 'c', 'd', 'e'].map(id => makeNode({ id, name: id, schema: 'dbo', type: 'view' }));
      const pairs: Array<[string, string]> = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']];
      const engine = new NavigationEngine(makeModel(nodes, pairs, ['dbo']), makeGraph(nodes, pairs), () => {}, {});
      // Origin c: a, b upstream; d, e downstream. The closed side is at 0 levels, the open side at one exact level.
      expect(engine.init({ origin: 'c', question: 'Trace related objects', direction: 'bidirectional', analysisMode: 'bb', depthIntent: closedIntent(closed, exactness, { levels: 1, exactness: 'exact' }) }))
        .toMatchObject({ ok: true });
      const breach = (id: string) => (engine as unknown as { depthBorderBreach(id: string, depth: number | undefined): number | null }).depthBorderBreach(id, undefined);
      const [nearClosed, farClosed, nearOpen, farOpen] = closed === 'downstream' ? ['d', 'e', 'b', 'a'] : ['b', 'a', 'd', 'e'];
      return { nearClosed: breach(nearClosed), farClosed: breach(farClosed), nearOpen: breach(nearOpen), farOpen: breach(farOpen) };
    };
    const approximate = run('approximate');
    expect(approximate).toEqual(run('exact'));
    expect(approximate).toEqual({ nearClosed: 1, farClosed: 2, nearOpen: null, farOpen: 2 });
  });
});
