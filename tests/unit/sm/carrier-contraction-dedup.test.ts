/** Shared carrier subgraphs expand by carried context rather than by every graph path. */
import { describe, expect, it, vi } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

function world(pairs: Array<[string, string]>, direction: 'upstream' | 'downstream', ct = false) {
  const nodes = [...new Set(pairs.flat())].map(id => makeNode({ id, name: id, schema: 'dbo',
    type: id === 'a' || id === 'z' ? 'view' : 'table',
    columns: ['Amount', 'Other'].map(name => ({ name, type: 'int', nullable: 'NULL', extra: '' })),
  }));
  const model = makeModel(nodes, pairs, ['dbo']); const graph = makeGraph(nodes, pairs);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect(engine.init({ origin: 'a', question: 'Inspect dependencies', direction, analysisMode: ct ? 'ct' : 'bb',
    ...(ct ? { targetColumns: ['Amount'] } : {}),
    depthIntent: { upstream: { levels: direction === 'upstream' ? 'all' : 0, exactness: 'exact' },
      downstream: { levels: direction === 'downstream' ? 'all' : 0, exactness: 'exact' } },
  })).toMatchObject({ ok: true });
  engine.getHopContext();
  return { engine, nodes };
}

describe('carrier contraction work bound', () => {
  it.each(['upstream', 'downstream'] as const)('expands a 16-diamond carrier chain with linear work (%s)', direction => {
    const pairs: Array<[string, string]> = [['a', 't0']];
    for (let i = 0; i < 16; i++) {
      pairs.push([`t${i}`, `l${i}`], [`t${i}`, `r${i}`], [`l${i}`, `t${i + 1}`], [`r${i}`, `t${i + 1}`]);
    }
    pairs.push(['t16', 'z']);
    const w = world(direction === 'upstream' ? pairs.map(([a, b]) => [b, a]) : pairs, direction);
    const calls = vi.spyOn(w.engine as unknown as { enqueueHop(...args: unknown[]): void }, 'enqueueHop');
    expect(w.engine.submitFindings({ focus_node_id: 'a', verdict: 'analyze', summary: 'Inspect carriers',
      sections: [{ angle: 'technical', text: 'Dependency evidence' }],
    })).toMatchObject({ ok: true });
    expect(calls.mock.calls.length).toBeLessThan(w.nodes.length * 4);
    expect(w.engine.getHopContext()).toMatchObject({ focus_node: { id: 'z' } });
    expect(w.engine.getCurrentTasks()).toHaveLength(1);
  });

  it('terminates a carrier cycle and retains separate source-qualified column arrivals', () => {
    const w = world([['left', 'a'], ['right', 'a'], ['join', 'left'], ['join', 'right'],
      ['cycle', 'join'], ['join', 'cycle'], ['z', 'join']], 'upstream', true);
    expect(w.engine.submitFindings({ focus_node_id: 'a', verdict: 'analyze', summary: 'Two contributing sources',
      sections: [{ angle: 'technical', text: 'Source evidence' }],
      column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: 'left', col: 'Amount' }, { node: 'right', col: 'Other' }] }],
    })).toMatchObject({ ok: true });
    expect(w.engine.getHopContext()).toMatchObject({ focus_node: { id: 'z' }, analysis_mode: 'ct' });
    const tasks = w.engine.getCurrentTasks().filter(task => task.kind === 'column_lineage');
    expect(tasks.flatMap(task => task.kind === 'column_lineage' ? task.sourceRefs ?? [] : []))
      .toEqual(expect.arrayContaining([{ node: 'left', col: 'Amount' }, { node: 'right', col: 'Other' }]));
    expect(() => w.engine.toJSON()).not.toThrow();
  });
});
