/** Column evidence preserves object topology under identical approved scope and prune decisions. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { findDisconnectedViewNodes } from '../../../src/ai/tools/presentResult';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

function run(mode: 'bb' | 'ct', shape: 'row-branch' | 'dead-end' | 'diamond', direction: 'upstream' | 'downstream') {
  const pairs: Array<[string, string]> = shape === 'row-branch'
    ? [['carrier', 'root'], ['side', 'root'], ['behind', 'side']]
    : shape === 'dead-end'
      ? [['focus', 'root'], ['off', 'focus'], ['exclusive', 'off']]
      : [['left', 'root'], ['right', 'root'], ['shared', 'left'], ['shared', 'right'], ['source', 'shared']];
  const edges = direction === 'upstream' ? pairs : pairs.map(([a, b]): [string, string] => [b, a]);
  const nodes = [...new Set(edges.flat())].map(id => makeNode({ id, name: id, schema: 'dbo', type: 'view',
    columns: [{ name: id === 'side' || id === 'behind' ? 'Region' : 'Amount', type: 'int', nullable: 'NULL', extra: '' }],
  }));
  const model = makeModel(nodes, edges, ['dbo']);
  const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
  expect(engine.init({ origin: 'root', question: 'Explain Amount and its row restrictions', direction, analysisMode: mode,
    ...(mode === 'ct' ? { targetColumns: ['Amount'] } : {}),
    depthIntent: { upstream: { levels: direction === 'upstream' ? 'all' : 0, exactness: 'exact' },
      downstream: { levels: direction === 'downstream' ? 'all' : 0, exactness: 'exact' } },
  })).toMatchObject({ ok: true });
  let done = false;
  for (let hop = 0; hop <= nodes.length; hop++) {
    const context = engine.getHopContext();
    if (context.done) { done = true; break; }
    const id = engine.currentFocus!;
    // Only authored column references carry CT; the side branch remains object-only work.
    const suppliers = direction === 'upstream'
      ? edges.filter(([from, to]) => to === id && from !== 'side').map(([from]) => from)
      : [];
    const pruning = shape === 'dead-end' && id === 'focus';
    const result = engine.submitFindings({ focus_node_id: id, verdict: 'analyze', summary: `SQL at ${id}`,
      sections: [{ angle: 'technical', text: `Recorded logic at ${id}` }],
      ...(pruning ? { prune_neighbors: [{ id: 'off', reason: 'The focus SQL excludes this branch' }] } : {}),
      ...(engine.currentHopAnalysisMode === 'ct' ? { column_flow: id === 'side' || id === 'behind' ? [] : [{ out_col: 'Amount',
        upstream_columns: pruning ? [] : suppliers.map(node => ({ node, col: 'Amount' })),
      }] } : {}),
    });
    expect(result, `${mode}/${shape}/${direction}: ${id}`).toMatchObject({ ok: true });
  }
  expect(done, 'all scheduled work must finish').toBe(true);
  const result = engine.getResult();
  const ids = result.fullNodes.map(node => node.id).sort();
  expect(findDisconnectedViewNodes(ids, result.edges, 'root')).toEqual([]);
  expect(result.detail_slots.map(slot => slot.nodeId).sort()).toEqual(ids);
  expect(result.node_states.filter(state => state.action === 'prune').map(state => state.nodeId)).not.toContain('focus');
  expect(result.edges.map(edge => JSON.stringify(edge)).sort()).toEqual(edges
    .filter(([from, to]) => ids.includes(from) && ids.includes(to))
    .map(([from, to]) => JSON.stringify([from, to, 'read'])).sort());
  return { ids, edges: result.edges.map(edge => JSON.stringify(edge)).sort() };
}

describe('controlled BB/CT exact object graph parity', () => {
  const variants = (['upstream', 'downstream'] as const).map(direction => ({ direction }));
  it.each(variants)('keeps a connected row-only branch ($direction)', ({ direction }) => {
    const bb = run('bb', 'row-branch', direction);
    expect(bb.ids).toEqual(['behind', 'carrier', 'root', 'side']);
    expect(run('ct', 'row-branch', direction)).toEqual(bb);
  });
  it.each(variants)('retains the dead-end focus and cuts its exclusive branch ($direction)', ({ direction }) => {
    const bb = run('bb', 'dead-end', direction);
    expect(bb.ids).toEqual(['focus', 'root']);
    expect(run('ct', 'dead-end', direction)).toEqual(bb);
  });
  it.each(variants)('preserves both diamond arms and typed edges ($direction)', ({ direction }) => {
    const bb = run('bb', 'diamond', direction);
    expect(bb.ids).toEqual(['left', 'right', 'root', 'shared', 'source']);
    expect(run('ct', 'diamond', direction)).toEqual(bb);
  });
});
