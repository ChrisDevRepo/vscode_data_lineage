/** Backend routing dispatches once per node, deterministically, with node-specific questions. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

describe('backend routing invariants', () => {
  it('orders a cyclic converging graph and preserves each node\'s questions', () => {
    const nodes = ['A', 'B', 'C', 'D', 'E'].map(id => makeNode({ id, name: id, schema: 'dbo', type: 'view' }));
    const pairs: Array<[string, string]> = [['A', 'B'], ['B', 'D'], ['B', 'C'], ['C', 'E'], ['D', 'E'], ['E', 'B']];
    const model = makeModel(nodes, pairs, ['dbo']);
    const graph = makeGraph(nodes, pairs);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    expect(engine.init({ origin: 'A', question: 'Trace downstream', direction: 'downstream', analysisMode: 'bb',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
    })).toMatchObject({ ok: true });
    const order: string[] = [];
    for (let index = 0; index < 5; index++) {
      const hop = engine.getHopContext();
      expect(hop).not.toMatchObject({ done: true });
      const focus = engine.currentFocus!;
      expect(order).not.toContain(focus);
      order.push(focus);
      expect(engine.supplementAgenda([focus])).toMatchObject({ code: 'supplement_requires_complete_engine' });
      if (focus === 'C' || focus === 'D') {
        expect(engine.getCurrentTasks().map(task => task.question)).toContain(`Check ${focus}'s calculation`);
        expect(engine.getCurrentTasks().map(task => task.question)).not.toContain(`Check ${focus === 'C' ? 'D' : 'C'}'s calculation`);
      }
      if (focus === 'E') {
        expect(engine.getCurrentTasks().map(task => task.question)).toEqual(expect.arrayContaining(['Input from C', 'Input from D']));
      }
      const questions = focus === 'B'
        ? ['D', 'C'].map(nodeId => ({ nodeId, question: `Check ${nodeId}'s calculation` }))
        : focus === 'C' || focus === 'D' ? [{ nodeId: 'E', question: `Input from ${focus}` }] : [];
      expect(engine.submitFindings({ focus_node_id: focus, verdict: 'analyze', summary: `Observed ${focus}`,
        sections: [{ angle: 'technical', text: `Recorded ${focus}` }], questions,
      })).toMatchObject({ ok: true });
    }
    expect(order).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(engine.getHopContext()).toMatchObject({ done: true });
    expect(engine.toJSON().visited).toHaveLength(5);
    expect(engine.toJSON().hopCount).toBe(5);
  });
});
