/** A procedure that only deletes from a tracked table owes no column source for it; the object graph is unchanged. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const column = (name: string) => ({ name, type: 'int', nullable: 'NULL', extra: '' });

/** root reads owed; archiveWriter reads owed, inserts into other, deletes from owed; producer loads owed. */
function archiveParts(deleteOnly: boolean) {
  const nodes = [
    makeNode({ id: 'root', name: 'root', schema: 'dbo', type: 'view', columns: [column('Net')] }),
    ...['owed', 'other', 'source'].map(id => makeNode({ id, name: id, schema: 'dbo', type: 'table' as const, columns: [column('Amount'), column('Stamp')] })),
    makeNode({ id: 'archiveWriter', name: 'archiveWriter', schema: 'dbo', type: 'procedure', columns: [], bodyScript: 'INSERT dbo.other SELECT Amount, Stamp FROM dbo.owed; DELETE dbo.owed WHERE Stamp < @Cutoff;' }),
    makeNode({ id: 'producer', name: 'producer', schema: 'dbo', type: 'procedure', columns: [], bodyScript: 'INSERT dbo.owed SELECT Amount, Stamp FROM dbo.source;' }),
  ];
  const pairs: Array<[string, string]> = [['owed', 'root'], ['archiveWriter', 'owed'], ['owed', 'archiveWriter'], ['archiveWriter', 'other'], ['source', 'producer'], ['producer', 'owed']];
  const model = makeModel(nodes, pairs, ['dbo']);
  if (deleteOnly) model.edges.find(edge => edge.source === 'archiveWriter' && edge.target === 'owed')!.deleteOnly = true;
  return { nodes, pairs, model };
}

function archiveWorld(mode: 'bb' | 'ct', deleteOnly: boolean) {
  const { nodes, pairs, model } = archiveParts(deleteOnly);
  const engine = new NavigationEngine(model, makeGraph(nodes, pairs), () => {}, {});
  expect(engine.init({ origin: 'root', question: 'Trace Net', direction: 'upstream', analysisMode: mode,
    ...(mode === 'ct' ? { targetColumns: ['Net'] } : {}),
    depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toMatchObject({ ok: true });
  engine.getHopContext();
  expect(engine.submitFindings({ focus_node_id: 'root', verdict: 'analyze', summary: 'Net uses owed Amount', sections: [{ angle: 'technical', text: 'Declared SQL' }],
    ...(mode === 'ct' ? { column_flow: [{ out_col: 'Net', upstream_columns: [{ node: 'owed', col: 'Amount' }] }] } : {}) })).toMatchObject({ ok: true });
  return engine;
}

describe('delete-only write carries no column data', () => {
  it('serves the delete-only writer as a row-level hop and accepts its honest submission with no refusal', () => {
    const engine = archiveWorld('ct', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: 'archiveWriter' }, analysis_mode: 'bb' });
    expect(engine.getCurrentTasks().filter(task => task.kind === 'column_lineage')).toEqual([]);
    expect(engine.getCurrentTasks().filter(task => /Amount/.test(task.question))).toEqual([]);
    const edgesBefore = JSON.stringify(engine.columnAspect?.edges);
    expect(engine.submitFindings({ focus_node_id: 'archiveWriter', verdict: 'analyze', summary: 'Archives old rows into other, then deletes them from owed',
      sections: [{ angle: 'technical', text: 'The delete removes rows; no Amount is written to owed.' }] })).toMatchObject({ ok: true });
    expect(JSON.stringify(engine.columnAspect?.edges)).toBe(edgesBefore);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: 'producer' }, analysis_mode: 'ct' });
    expect(engine.columnAspect?.active_columns).toEqual(['Amount']);
  });

  it('keeps the owed column on a writer whose edge is not delete-only', () => {
    const engine = archiveWorld('ct', false);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: 'archiveWriter' }, analysis_mode: 'ct' });
    expect(engine.getCurrentTasks().filter(task => task.kind === 'column_lineage')).not.toEqual([]);
  });

  it.each([true, false])('asks a reader of the table for its column on a downstream trace (delete-only mark=%s)', deleteOnly => {
    const { nodes, pairs, model } = archiveParts(deleteOnly);
    const engine = new NavigationEngine(model, makeGraph(nodes, pairs), () => {}, {});
    expect(engine.init({ origin: 'producer', question: 'Where does Amount go', direction: 'downstream', analysisMode: 'ct', targetColumns: ['Amount'],
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } } })).toMatchObject({ ok: true });
    engine.getHopContext();
    expect(engine.submitFindings({ focus_node_id: 'producer', verdict: 'analyze', summary: 'Loads owed from source', sections: [{ angle: 'technical', text: 'Declared SQL' }],
      column_flow: [{ out_col: 'Amount', writes_to: { node: 'owed', col: 'Amount' }, upstream_columns: [{ node: 'source', col: 'Amount' }] }] })).toMatchObject({ ok: true });
    const hops: Array<{ id: string; mode: unknown; columnTasks: number }> = [];
    for (let hop = 0; hop < 5; hop++) {
      const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string }; analysis_mode?: string };
      if (ctx.done || !ctx.focus_node) break;
      hops.push({ id: ctx.focus_node.id, mode: ctx.analysis_mode, columnTasks: engine.getCurrentTasks().filter(task => task.kind === 'column_lineage').length });
      if (ctx.focus_node.id === 'archiveWriter') break;
      expect(engine.submitFindings({ focus_node_id: ctx.focus_node.id, verdict: 'analyze', summary: 'analysed', sections: [{ angle: 'technical', text: 'SQL' }],
        ...(ctx.analysis_mode === 'ct' ? { column_flow: [] } : {}) })).toMatchObject({ ok: true });
    }
    expect(hops.find(hop => hop.id === 'archiveWriter')).toMatchObject({ mode: 'ct' });
    expect(hops.find(hop => hop.id === 'archiveWriter')!.columnTasks).toBeGreaterThan(0);
  });

  it('visits the same objects with and without the mark, in CT and BB', () => {
    const visit = (mode: 'bb' | 'ct', deleteOnly: boolean) => {
      const engine = archiveWorld(mode, deleteOnly);
      const order: string[] = [];
      for (let hop = 0; hop < 10; hop++) {
        const ctx = engine.getHopContext() as { done?: boolean; focus_node?: { id: string } };
        if (ctx.done || !ctx.focus_node) break;
        const id = ctx.focus_node.id;
        order.push(id);
        const ct = mode === 'ct' && !(deleteOnly && id === 'archiveWriter');
        const flow = id === 'producer' ? [{ out_col: 'Amount', writes_to: { node: 'owed', col: 'Amount' }, upstream_columns: [{ node: 'source', col: 'Amount' }] }] : [];
        expect(engine.submitFindings({ focus_node_id: id, verdict: 'analyze', summary: `${id} analysed`, sections: [{ angle: 'technical', text: `${id} SQL` }],
          ...(ct ? { column_flow: flow } : {}) })).toMatchObject({ ok: true });
      }
      const result = engine.getResult();
      return { order, nodes: result.fullNodes.map(n => n.id).sort(), edges: result.edges.map(edge => JSON.stringify(edge)).sort() };
    };
    for (const mode of ['bb', 'ct'] as const) {
      const marked = visit(mode, true);
      const control = visit(mode, false);
      expect(marked.order.slice().sort()).toEqual(control.order.slice().sort());
      expect(marked.nodes).toEqual(control.nodes);
      expect(marked.edges).toEqual(control.edges);
    }
  });
});
