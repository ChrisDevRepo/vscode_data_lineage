/** Routing questions preserve row-only branches without creating foreign upstream column tasks. */
import { expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { ObjectType } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

function questionWorld(mapped: boolean, declared = true, type: ObjectType = 'view') {
  const column = (name: string) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' });
  const nodes = [
    makeNode({ id: 'origin', name: 'origin', schema: 'dbo', type: 'view', columns: [column('Discount')] }),
    makeNode({ id: 'rules', name: 'rules', schema: 'dbo', type, columns: declared ? [column('ValidTo')] : [] }),
    makeNode({ id: 'amounts', name: 'amounts', schema: 'dbo', type: 'table', columns: [column('Amount')] }),
  ];
  const pairs: Array<[string, string]> = [['rules', 'origin'], ['amounts', 'origin']];
  if (type === 'table') {
    nodes.push(makeNode({ id: 'rulesWriter', name: 'rulesWriter', schema: 'dbo', type: 'view', columns: [column('ValidTo')] }));
    pairs.push(['rulesWriter', 'rules']);
  }
  const engine = new NavigationEngine(makeModel(nodes, pairs, ['dbo']), makeGraph(nodes, pairs), () => {}, {});
  expect(engine.init({
    origin: 'origin', question: 'Trace Discount upstream', direction: 'upstream', analysisMode: 'ct',
    targetColumns: ['Discount'],
    depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
  })).toMatchObject({ ok: true });
  engine.getHopContext();
  expect(engine.submitFindings({
    focus_node_id: 'origin', verdict: 'analyze', summary: 'Observed origin',
    sections: [{ angle: 'technical', text: 'Observed SQL' }],
    column_flow: [{ out_col: 'Discount', upstream_columns: [
      { node: 'amounts', col: 'Amount' },
      ...(mapped ? [{ node: 'rules', col: 'ValidTo', transforms: ['filter' as const] }] : []),
    ] }],
    questions: [{ nodeId: 'rules', question: 'Determine how ValidTo selects the Discount rows at origin.' }],
  })).toMatchObject({ ok: true });
  return engine;
}

it('retains the related view as BB when its question mentions a foreign origin output without a mapping', () => {
  const engine = questionWorld(false);
  const hop = engine.getHopContext();
  expect(hop.focus_node?.id).toBe('rules');
  expect(engine.toJSON().scopeNodeIds).toContain('rules');
  expect(engine.toJSON().removedSet).not.toContain('rules');
  expect(engine.columnAspect?.edges).not.toContainEqual(expect.objectContaining({ from_node: 'rules', from_col: 'Discount' }));
  expect(hop.analysis_mode).toBe('bb');
  expect(engine.columnAspect?.active_columns).toEqual([]);
  expect(engine.hopSubmitColumns.outCols).toBeNull();
  expect(engine.submitFindings({
    focus_node_id: 'rules', verdict: 'analyze', summary: 'Observed row impact',
    sections: [{ angle: 'technical', text: 'ValidTo selects the Discount rule' }],
  })).toMatchObject({ ok: true });
  expect(engine.getHopContext()).toMatchObject({ done: true });
  const result = engine.getResult();
  expect(result.fullNodes.map(node => node.id)).toContain('rules');
  expect(result.edges).toContainEqual(['rules', 'origin', 'read']);
});

it('preserves an explicit selector mapping despite the same origin-output mention', () => {
  const engine = questionWorld(true);
  expect(engine.getHopContext()).toMatchObject({ focus_node: { id: 'rules' }, analysis_mode: 'ct' });
  expect(engine.columnAspect?.active_columns).toEqual(['ValidTo']);
  expect(engine.hopSubmitColumns.outCols).toEqual(['ValidTo']);
  expect(engine.columnAspect?.edges).toContainEqual(expect.objectContaining({
    from_node: 'rules', from_col: 'ValidTo', to_node: 'origin', to_col: 'Discount', transforms: ['filter'],
  }));
});

it.each(['view', 'table'] as const)('keeps question-only %s work BB when column metadata is missing', type => {
  const engine = questionWorld(false, false, type);
  expect(engine.getHopContext()).toMatchObject({
    focus_node: { id: type === 'table' ? 'rulesWriter' : 'rules' }, analysis_mode: 'bb',
  });
  expect(engine.columnAspect?.active_columns).toEqual([]);
  expect(engine.hopSubmitColumns.outCols).toBeNull();
  expect(engine.columnAspect?.edges).not.toContainEqual(expect.objectContaining({ from_node: 'rules', from_col: 'Discount' }));
});

it.each(['procedure', 'external'] as const)('preserves explicit authored %s carry without column metadata', type => {
  const engine = questionWorld(true, false, type);
  expect(engine.columnAspect?.edges).toContainEqual(expect.objectContaining({
    from_node: 'rules', from_col: 'ValidTo', to_node: 'origin', to_col: 'Discount', transforms: ['filter'],
  }));
  if (type === 'procedure') {
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: 'rules' }, analysis_mode: 'ct' });
    expect(engine.columnAspect?.active_columns).toEqual(['ValidTo']);
  }
});
