/** A column trace walks value inputs as column tasks and row-role objects as object visits, and delivers both. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { buildColumnTraceView } from '../../../src/engine/columnTraceView';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

describe('CT direct lineage across a full walk', () => {
  it('traces the value input, visits the filter object without a column task and keeps it in result and Detail', () => {
    const col = (name: string) => ({ name, type: 'int', nullable: 'NULL', extra: '' });
    const nodes = [
      makeNode({ id: 'report', schema: 'dbo', name: 'report', type: 'view', columns: [col('Total')] }),
      makeNode({ id: 'sales', schema: 'dbo', name: 'sales', type: 'view', columns: [col('Amount'), col('StoreId')] }),
      makeNode({ id: 'flags', schema: 'dbo', name: 'flags', type: 'view', columns: [col('IsOpen'), col('StoreId')] }),
    ];
    // report reads sales (value) and flags (WHERE / JOIN only).
    const pairs: Array<[string, string]> = [['sales', 'report'], ['flags', 'report']];
    const engine = new NavigationEngine(makeModel(nodes, pairs, ['dbo']), makeGraph(nodes, pairs), () => {}, {});
    expect(engine.init({ origin: 'report', question: 'trace Total upstream', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Total'],
      depthIntent: { upstream: { levels: 'all', exactness: 'approximate' }, downstream: { levels: 0, exactness: 'exact' } } })).toMatchObject({ ok: true });

    const visited = new Map<string, { mode: string | undefined; active: string[] }>();
    for (let step = 0; step < 6; step++) {
      if ((engine.getHopContext() as { done?: boolean }).done) break;
      const focus = engine.currentFocus!;
      visited.set(focus, { mode: engine.currentHopAnalysisMode, active: [...(engine.columnAspect?.active_columns ?? [])] });
      const flow = focus === 'report'
        ? [{ out_col: 'Total', upstream_columns: [
            { node: 'sales', col: 'Amount', transforms: ['aggregate'] },
            { node: 'sales', col: 'StoreId', transforms: ['combine'] },
            { node: 'flags', col: 'IsOpen', transforms: ['filter'] },
            { node: 'flags', col: 'StoreId', transforms: ['combine'] },
          ] }]
        : focus === 'sales' ? [{ out_col: 'Amount', upstream_columns: [] }] : undefined;
      const finding = { focus_node_id: focus, verdict: 'analyze' as const, summary: 'observed',
        sections: [{ angle: 'business', text: `observed ${focus}` }], ...(flow && engine.currentHopAnalysisMode === 'ct' ? { column_flow: flow } : {}) };
      expect(engine.submitFindings(finding as never), `hop ${focus}`).toMatchObject({ ok: true });
    }

    expect([...visited.keys()].sort()).toEqual(['flags', 'report', 'sales']);
    expect(visited.get('sales')).toMatchObject({ mode: 'ct', active: ['Amount'] });
    expect(visited.get('flags')?.mode, 'the filter object is an object visit, never a column task').toBe('bb');

    const result = engine.getResult();
    expect(result.fullNodes.map(n => n.id).sort()).toEqual(['flags', 'report', 'sales']);
    const edges = result.columnAspect!.edges.map(e => `${e.from_node}.${e.from_col}->${e.to_node}.${e.to_col}`);
    expect(edges).toEqual(['sales.Amount->report.Total']);
    expect(result.detail_slots.find(slot => slot.nodeId === 'flags')?.sections).toEqual([{ angle: 'business', text: 'observed flags' }]);

    const view = buildColumnTraceView({ config: DEFAULT_CONFIG,
      objects: new Map(nodes.map(n => [n.id, { id: n.id, label: n.name, schema: n.schema, objectType: n.type }])),
      relations: result.columnAspect!.edges.map(e => ({ hopNode: e.hop_node, fromNode: e.from_node, fromCol: e.from_col, toNode: e.to_node, toCol: e.to_col })),
      objectEdges: pairs.map(([source, target]) => ({ source, target })),
    });
    expect(view.nodes.map(n => n.id).sort()).toEqual(['flags', 'report', 'sales']);
    expect(view.nodes.find(n => n.id === 'flags')?.rows).toEqual([]);
    expect(view.objectEdges.map(e => `${e.source}->${e.target}`)).toEqual(['flags->report']);
  });
});
