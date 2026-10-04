/** Unfinished checkpoints cannot restore pruning that disconnects retained visited analysis. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { InvalidEngineCheckpointError } from '../../../src/ai/sm/navigationSnapshotSchema';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

function checkpoint(direction: 'upstream' | 'downstream', complete = false, asymmetric = false) {
  const nodes = ['a', 'c', 'b'].map(id => makeNode({ id, name: id, schema: 'dbo', type: 'view' }));
  const pairs: Array<[string, string]> = direction === 'downstream' ? [['a', 'c'], ['c', 'b']] : [['c', 'a'], ['b', 'c']];
  if (asymmetric) pairs.push(direction === 'downstream' ? ['b', 'a'] : ['a', 'b']);
  const model = makeModel(nodes, pairs, ['dbo']);
  const graph = makeGraph(nodes, pairs);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect(engine.init({ origin: 'a', question: 'Trace this branch', direction: asymmetric ? 'bidirectional' : direction, analysisMode: 'bb',
    depthIntent: { upstream: { levels: direction === 'upstream' ? 'all' : 0, exactness: 'exact' }, downstream: { levels: direction === 'downstream' ? 'all' : 0, exactness: 'exact' } },
  })).toMatchObject({ ok: true });
  for (const id of ['a', 'c']) {
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id } });
    expect(engine.submitFindings({ focus_node_id: id, verdict: 'analyze', summary: `Observed ${id}`, sections: [{ angle: 'technical', text: `SQL at ${id}` }] })).toMatchObject({ ok: true });
  }
  expect(engine.getHopContext()).toMatchObject({ focus_node: { id: 'b' } });
  expect(engine.submitFindings({ focus_node_id: 'b', verdict: 'analyze', summary: 'Observed b', sections: [{ angle: 'technical', text: 'SQL at b' }] })).toMatchObject({ ok: true });
  if (complete) {
    expect(engine.getHopContext()).toMatchObject({ done: true });
  }
  const snapshot = engine.toJSON();
  const validSnapshot = structuredClone(snapshot);
  snapshot.removedSet.push('c');
  return { snapshot, validSnapshot, model, graph };
}

describe('restored directed support', () => {
  it.each(['upstream', 'downstream'] as const)('rejects an unfinished orphan checkpoint on the %s leg', direction => {
    const { snapshot, model, graph } = checkpoint(direction);
    expect(() => NavigationEngine.fromJSON(snapshot, model, graph, () => {})).toThrow(InvalidEngineCheckpointError);
  });
  it.each(['upstream', 'downstream'] as const)('keeps completed historical reports readable on the %s leg', direction => {
    const { snapshot, model, graph } = checkpoint(direction, true);
    expect(() => NavigationEngine.fromJSON(snapshot, model, graph, () => {})).not.toThrow();
    const restored = NavigationEngine.fromJSON(snapshot, model, graph, () => {});
    expect(restored.getResult().fullNodes.map(node => node.id)).toContain('c');
  });
  it.each(['upstream', 'downstream'] as const)('cannot restore support through the closed opposite leg of asymmetric %s scope', direction => {
    const { snapshot, validSnapshot, model, graph } = checkpoint(direction, false, true);
    expect(() => NavigationEngine.fromJSON(validSnapshot, model, graph, () => {})).not.toThrow();
    expect(() => NavigationEngine.fromJSON(snapshot, model, graph, () => {})).toThrow(InvalidEngineCheckpointError);
  });
});
