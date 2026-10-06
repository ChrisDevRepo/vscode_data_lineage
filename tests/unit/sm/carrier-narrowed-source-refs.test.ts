/** A carrier narrows the carried columns to its own; the source refs behind it narrow with them, so the state dump stays valid. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeModel, makeNode } from './helpers/fixtures';
import { makeGraph } from '../helpers/testUtils';

const column = (name: string) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' });

describe('source refs through a non-bodied carrier', () => {
  it('keeps only refs on carried columns at the consumer behind a written table', () => {
    const nodes = [
      makeNode({ id: 'origin', name: 'origin', schema: 'dbo', type: 'view', columns: [column('Discount')], bodyScript: 'SELECT Amount AS Discount FROM dbo.stage;' }),
      makeNode({ id: 'stage', name: 'stage', schema: 'dbo', type: 'table', columns: [column('Amount')] }),
      makeNode({ id: 'loader', name: 'loader', schema: 'dbo', type: 'procedure', columns: [], bodyScript: 'INSERT dbo.stage(Amount) SELECT Discount AS Total FROM dbo.origin;' }),
      makeNode({ id: 'report', name: 'report', schema: 'dbo', type: 'view', columns: [column('Amount')], bodyScript: 'SELECT Amount FROM dbo.stage;' }),
    ];
    const pairs: Array<[string, string]> = [['stage', 'origin'], ['origin', 'loader'], ['loader', 'stage'], ['stage', 'report']];
    const model = makeModel(nodes, pairs, ['dbo']);
    const graph = makeGraph(nodes, pairs);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const depth = { upstream: { levels: 'all' as const, exactness: 'exact' as const }, downstream: { levels: 'all' as const, exactness: 'exact' as const } };
    expect(engine.init({ origin: 'origin', question: 'Trace Discount sources and consumers', direction: 'bidirectional', analysisMode: 'ct', targetColumns: ['Discount'], depthIntent: depth })).toMatchObject({ ok: true });
    engine.getHopContext();
    expect(engine.submitFindings({
      focus_node_id: 'origin', verdict: 'analyze', summary: 'Discount reads Amount',
      sections: [{ angle: 'technical', text: 'SELECT Amount AS Discount FROM dbo.stage;' }],
      column_flow: [{ out_col: 'Discount', upstream_columns: [{ node: 'stage', col: 'Amount' }] }],
    })).toMatchObject({ ok: true });
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: 'loader' } });
    expect(engine.submitFindings({
      focus_node_id: 'loader', verdict: 'analyze', summary: 'Discount is written to stage.Amount as Total',
      sections: [{ angle: 'technical', text: 'INSERT dbo.stage(Amount) SELECT Discount AS Total FROM dbo.origin;' }],
      column_flow: [{ out_col: 'Total', writes_to: { node: 'stage', col: 'Amount' }, upstream_columns: [{ node: 'origin', col: 'Discount' }] }],
    })).toMatchObject({ ok: true });

    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: 'report' } });
    expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({ kind: 'column_lineage', activeColumns: ['Amount'], traversalSide: 'downstream', sourceRefs: [{ node: 'stage', col: 'Amount' }] }));

    expect(() => engine.toJSON()).not.toThrow();
    expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({ nodeId: 'report', sourceRefs: [{ node: 'stage', col: 'Amount' }] }));
  });
});

describe('source refs to a destination outside the active scope', () => {
  it('does not carry a written destination the depth left out', () => {
    const nodes = [
      makeNode({ id: 'stage', name: 'stage', schema: 'dbo', type: 'table', columns: [column('Amount')] }),
      makeNode({ id: 'loader', name: 'loader', schema: 'dbo', type: 'procedure', columns: [], bodyScript: 'INSERT dbo.archive(Total) SELECT Amount FROM dbo.stage; EXEC dbo.audit;' }),
      makeNode({ id: 'audit', name: 'audit', schema: 'dbo', type: 'procedure', columns: [], bodyScript: 'INSERT dbo.stage(Amount) SELECT 0;' }),
      makeNode({ id: 'archive', name: 'archive', schema: 'dbo', type: 'procedure', columns: [], bodyScript: 'SELECT 1;' }),
    ];
    const pairs: Array<[string, string]> = [['stage', 'loader'], ['loader', 'audit'], ['audit', 'stage'], ['loader', 'archive']];
    const model = makeModel(nodes, pairs, ['dbo']);
    const graph = makeGraph(nodes, pairs);
    const engine = new NavigationEngine(model, graph, () => {}, {});
    const depth = { upstream: { levels: 'all' as const, exactness: 'exact' as const }, downstream: { levels: 1 as const, exactness: 'exact' as const } };
    expect(engine.init({ origin: 'stage', question: 'Trace Amount sources and consumers', direction: 'bidirectional', analysisMode: 'ct', targetColumns: ['Amount'], depthIntent: depth })).toMatchObject({ ok: true });
    engine.getHopContext();
    expect(engine.submitFindings({
      focus_node_id: 'stage', verdict: 'analyze', summary: 'Amount is loaded from audit',
      sections: [{ angle: 'technical', text: 'Origin table.' }],
      column_flow: [{ out_col: 'Amount', upstream_columns: [] }],
    })).toMatchObject({ ok: true });
    let guard = 0;
    while ((engine.getHopContext() as { focus_node?: { id: string } }).focus_node?.id !== 'loader' && guard++ < 4) {
      const focus = (engine.getHopContext() as { focus_node: { id: string } }).focus_node.id;
      expect(engine.submitFindings({ focus_node_id: focus, verdict: 'analyze', summary: `Reviewed ${focus}`, sections: [{ angle: 'technical', text: 'Reviewed.' }], column_flow: [] })).toMatchObject({ ok: true });
    }
    expect(engine.submitFindings({
      focus_node_id: 'loader', verdict: 'analyze', summary: 'Amount is archived as Total',
      sections: [{ angle: 'technical', text: 'INSERT dbo.archive(Total) SELECT Amount FROM dbo.stage;' }],
      questions: [{ nodeId: 'audit', question: 'Confirm the audit path.' }],
      column_flow: [{ out_col: 'Total', writes_to: { node: 'archive', col: 'Total' }, upstream_columns: [{ node: 'stage', col: 'Amount' }] }],
    })).toMatchObject({ ok: true });
    expect(() => engine.toJSON()).not.toThrow();
    expect(engine.getCurrentTasks().flatMap(task => (task.kind === 'column_lineage' ? task.sourceRefs ?? [] : [])).every(ref => ref.node !== 'archive')).toBe(true);
  });
});
