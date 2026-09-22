import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

/**
 * The two most common warehouse column shapes: a key renamed between layers
 * (`rpt.CustomerKey ← src_v.CustId`) and two report columns derived from one source column
 * (`rpt.CustomerKey`, `rpt.CustomerCode` ← `src_v.CustId`). The next hop traces the source-side
 * name, and one source column is asked about once.
 */
describe('CT rename and convergence across a hop', () => {
  const rpt: LineageNode = makeNode({
    id: 'rpt', schema: 'dbo', name: 'rpt', type: 'view',
    columns: [
      { name: 'CustomerKey', type: 'int', nullable: 'NOT NULL', extra: '' },
      { name: 'CustomerCode', type: 'nvarchar(20)', nullable: 'NOT NULL', extra: '' },
    ],
  });
  const srcView: LineageNode = makeNode({
    id: 'src_v', schema: 'dbo', name: 'src_v', type: 'view',
    columns: [{ name: 'CustId', type: 'int', nullable: 'NOT NULL', extra: '' }],
  });
  const nodes = [rpt, srcView];
  const edges: Array<[string, string]> = [['src_v', 'rpt']];

  function commitOrigin(targetColumns: string[]): NavigationEngine {
    const engine = new NavigationEngine(makeModel(nodes, edges, ['dbo']), makeGraph(nodes, edges), () => {}, {});
    engine.init({ origin: 'rpt', question: 'trace', direction: 'upstream', analysisMode: 'ct', targetColumns });
    engine.getHopContext();
    const result = engine.submitFindings({
      focus_node_id: 'rpt',
      sections: [{ angle: 'business' as const, text: 'keys come from src_v.CustId' }],
      summary: 'ok',
      verdict: 'analyze',
      route_requests: [{ nodeId: 'src_v', question: 'where does CustId come from?', columns: ['CustId'] }],
      column_flow: targetColumns.map((out_col) => ({ out_col, upstream_columns: [{ node: 'src_v', col: 'CustId' }] })),
    });
    expect('error' in result ? result : null, 'origin column_flow is accepted').toBeNull();
    const hop = engine.getHopContext() as { done?: boolean };
    expect(!hop.done && engine.currentFocus, 'the source view dispatches next').toBe('src_v');
    return engine;
  }

  it('a renamed column is traced under its source-side name at the next hop', () => {
    const engine = commitOrigin(['CustomerKey']);
    expect(engine.columnAspect?.active_columns, 'active column is the source name').toEqual(['CustId']);
    const questions = engine.pendingLineageQuestions;
    expect(questions.length, 'one continuation question').toBe(1);
    expect(questions[0], 'question is labelled with the source column').toContain('`CustId` at `src_v`');
    expect(questions[0], 'question names what it feeds').toContain('`CustomerKey` at `rpt`');
  });

  it('two target columns from one source column ask about that source column once', () => {
    const engine = commitOrigin(['CustomerKey', 'CustomerCode']);
    expect(engine.columnAspect?.active_columns, 'one active column at the shared source').toEqual(['CustId']);
    expect(engine.pendingLineageQuestions.length, 'one question for the shared source column').toBe(1);
    expect(engine.pendingLineageQuestions[0], 'the one question names every column it feeds').toContain('`CustomerKey`, `CustomerCode` at `rpt`');
  });
});
