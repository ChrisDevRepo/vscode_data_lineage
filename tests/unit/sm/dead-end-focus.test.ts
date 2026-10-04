/** A focus that prunes every neighbor stays in the result as a short dead end. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

describe('dead-end focus', () => {
  it('keeps the focus with its short finding and removes only the pruned neighbors', () => {
    const nodes = ['a', 'b', 'c', 'd'].map(id => makeNode({
      id, name: id, schema: 'dbo', type: 'view',
      columns: [{ name: 'Amount', type: 'int', nullable: 'NULL', extra: '' }],
    }));
    const pairs: Array<[string, string]> = [['a', 'b'], ['b', 'c'], ['b', 'd']];
    const model = makeModel(nodes, pairs, ['dbo']);
    const engine = new NavigationEngine(model, makeGraph(nodes, pairs), () => {}, {});
    expect(engine.init({
      origin: 'a', question: 'Trace', direction: 'downstream', analysisMode: 'bb',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
    })).toMatchObject({ ok: true });
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: 'a' } });
    expect(engine.submitFindings({
      focus_node_id: 'a', verdict: 'analyze', summary: 'Starts at a',
      sections: [{ angle: 'technical', text: 'a hands Amount to b' }],
      questions: [{ nodeId: 'b', question: 'What does b do with Amount?' }],
    })).toMatchObject({ ok: true });
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: 'b' } });
    expect(engine.submitFindings({
      focus_node_id: 'b', verdict: 'analyze', summary: 'b stops',
      sections: [{ angle: 'technical', text: 'b ends the path' }],
      prune_neighbors: [
        { id: 'c', reason: 'c is off the path' },
        { id: 'd', reason: 'd is off the path' },
      ],
    })).toMatchObject({ ok: true });
    const state = engine.toJSON();
    expect(state.removedSet).not.toContain('a');
    expect(state.removedSet).not.toContain('b');
    expect(state.removedSet).toEqual(expect.arrayContaining(['c', 'd']));
    expect(state.agenda.map(entry => entry.nodeId)).not.toEqual(expect.arrayContaining(['c', 'd']));
    const slot = engine.getDetailSlots().find(item => item.nodeId === 'b');
    expect(slot?.summary).toBe('b stops');
    expect(engine.getHopContext()).toMatchObject({ done: true });
  });
});
