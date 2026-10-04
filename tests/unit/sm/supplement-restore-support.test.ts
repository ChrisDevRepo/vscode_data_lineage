/** Accepted user follow-ups restore outside the initial direction without admitting disconnected visits. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { InvalidEngineCheckpointError } from '../../../src/ai/sm/navigationSnapshotSchema';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

function world(direction: 'upstream' | 'downstream', mode: 'bb' | 'ct') {
  const nodes = ['a', 'b', 'c', 'd', 'x'].map(id => makeNode({ id, name: id, schema: 'dbo', type: 'view',
    columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }] }));
  const pairs: Array<[string, string]> = direction === 'downstream'
    ? [['a', 'b'], ['c', 'a'], ['d', 'c']] : [['b', 'a'], ['a', 'c'], ['c', 'd']];
  const model = makeModel(nodes, pairs, ['dbo']);
  const graph = makeGraph(nodes, pairs);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect(engine.init({ origin: 'a', question: 'Inspect related objects', direction, analysisMode: mode,
    ...(mode === 'ct' ? { targetColumns: ['Amount'] } : {}),
    depthIntent: { upstream: { levels: direction === 'upstream' ? 'all' : 0, exactness: 'exact' },
      downstream: { levels: direction === 'downstream' ? 'all' : 0, exactness: 'exact' } },
  })).toMatchObject({ ok: true });
  for (const id of ['a', 'b']) {
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id } });
    keep(engine, id);
  }
  expect(engine.getHopContext()).toMatchObject({ done: true });
  return { engine, model, graph };
}

function keep(engine: NavigationEngine, id: string) {
  expect(engine.submitFindings({ focus_node_id: id, verdict: 'analyze', summary: `Observed ${id}`,
    sections: [{ angle: 'technical', text: `Evidence at ${id}` }],
    ...(engine.currentHopAnalysisMode === 'ct' ? { column_flow: [] } : {}),
  })).toMatchObject({ ok: true });
}

describe.each(['upstream', 'downstream'] as const)('supplement restoration (%s)', direction => {
  it.each(['bb', 'ct'] as const)('resumes an accepted opposite-side target before and after dispatch (%s)', mode => {
    const w = world(direction, mode);
    expect(w.engine.supplementAgenda(['c'])).toMatchObject({ ok: true, agendaed: 1 });
    let engine = NavigationEngine.fromJSON(w.engine.toJSON(), w.model, w.graph, () => {});
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: 'c' } });
    engine = NavigationEngine.fromJSON(engine.toJSON(), w.model, w.graph, () => {});
    expect(engine.currentFocus).toBe('c');
    keep(engine, 'c');
    expect(engine.getHopContext()).toMatchObject({ done: true });
    expect(engine.getResult().fullNodes.map(node => node.id)).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });

  it('rejects an opposite-side visited node without recorded supplement admission', () => {
    const w = world(direction, 'bb');
    w.engine.supplementAgenda(['c']); w.engine.getHopContext();
    const snapshot = w.engine.toJSON();
    delete snapshot.engineInternals.supplementNodeIds;
    expect(() => NavigationEngine.fromJSON(snapshot, w.model, w.graph, () => {})).toThrow(InvalidEngineCheckpointError);
  });

  

  it('rejects an admitted target when its connection disappears', () => {
    const w = world(direction, 'bb');
    w.engine.supplementAgenda(['c']); w.engine.getHopContext();
    const snapshot = w.engine.toJSON();
    w.graph.dropNode('c'); w.graph.addNode('c');
    expect(() => NavigationEngine.fromJSON(snapshot, w.model, w.graph, () => {})).toThrow(InvalidEngineCheckpointError);
  });

  it('refuses disconnected targets and validates malformed supplement metadata', () => {
    const w = world(direction, 'bb');
    expect(w.engine.supplementAgenda(['x'])).toMatchObject({ ok: true, agendaed: 0, skipped: 1 });
    const snapshot = w.engine.toJSON();
    snapshot.engineInternals.supplementNodeIds = ['x'];
    expect(() => NavigationEngine.fromJSON(snapshot, w.model, w.graph, () => {})).toThrow(InvalidEngineCheckpointError);
    snapshot.engineInternals.supplementNodeIds = ['a', 'a'];
    expect(() => NavigationEngine.fromJSON(snapshot, w.model, w.graph, () => {})).toThrow(InvalidEngineCheckpointError);
  });
});
