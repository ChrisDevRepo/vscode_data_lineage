import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

type Ctx = { done?: boolean; focus_node?: { id: string } };

describe('CT in-place update (UPDATE fact SET amount = amount * r.rate)', () => {
  const fact = makeNode({ id: 'fact', schema: 'dbo', name: 'fact', type: 'table', columns: [{ name: 'amount', type: 'decimal', nullable: 'NULL', extra: '' }] });
  const rates = makeNode({ id: 'rates', schema: 'dbo', name: 'rates', type: 'view', columns: [{ name: 'rate', type: 'decimal', nullable: 'NULL', extra: '' }] });
  const upd = makeNode({ id: 'spupd', schema: 'dbo', name: 'spupd', type: 'procedure' });
  const nodes = [fact, rates, upd];
  const edges: Array<[string, string]> = [['fact', 'spupd'], ['rates', 'spupd'], ['spupd', 'fact']];
  const model: DatabaseModel = {
    ...makeModel(nodes, edges, ['dbo']),
    neighborIndex: {
      fact: { in: ['spupd'], out: ['spupd'] },
      spupd: { in: ['fact', 'rates'], out: ['fact'] },
      rates: { in: [], out: ['spupd'] },
    },
  };

  it('the self-referencing write is refused once, the repair commits, and the walk terminates', () => {
    const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
    engine.init({ origin: 'fact', question: 'where does amount come from', direction: 'upstream', analysisMode: 'ct', targetColumns: ['amount'] });
    const visited: string[] = [];
    let selfLoopRejects = 0;
    for (let hop = 0; hop < 10; hop++) {
      const ctx = engine.getHopContext() as Ctx;
      if (ctx.done || !ctx.focus_node) break;
      const id = ctx.focus_node.id;
      visited.push(id);
      const base = { focus_node_id: id, sections: [{ angle: 'business' as const, text: id }], summary: id, verdict: 'analyze' as const };
      if (id === 'fact') {
        engine.submitFindings({ ...base, route_requests: [{ nodeId: 'spupd', question: 'how is amount written', columns: ['amount'] }], column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'spupd', col: 'amount' }] }] });
      } else if (id === 'spupd') {
        const first = engine.submitFindings({ ...base, column_flow: [{ out_col: 'amount', writes_to: { node: 'fact', col: 'amount' }, upstream_columns: [{ node: 'fact', col: 'amount' }, { node: 'rates', col: 'rate' }] }] });
        if (JSON.stringify(first).includes('column_self_loop')) selfLoopRejects++;
        const repaired = engine.submitFindings({ ...base, route_requests: [{ nodeId: 'rates', question: 'rate', columns: ['rate'] }], column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'fact', col: 'amount' }, { node: 'rates', col: 'rate' }] }] });
        expect('error' in repaired ? repaired : null, 'omitting writes_to commits').toBeNull();
      } else {
        engine.submitFindings({ ...base, column_flow: [{ out_col: engine.columnAspect!.active_columns[0], upstream_columns: [] }] });
      }
    }
    expect(selfLoopRejects, 'the in-place shape costs exactly one refusal').toBe(1);
    expect(visited.filter((v) => v === 'spupd').length, 'the updater is not re-dispatched in a loop').toBe(1);
    expect(engine.getResult().fullNodes.map((n) => n.id).sort()).toEqual(['fact', 'rates', 'spupd']);
  });
});

describe('CT wide origin: every column traced at once', () => {
  it('forty columns commit in one hop and each continues at its source', () => {
    const cols = Array.from({ length: 40 }, (_, i) => ({ name: `c${i}`, type: 'int', nullable: 'NULL', extra: '' }));
    const wide = makeNode({ id: 'wide', schema: 'dbo', name: 'wide', type: 'view', columns: cols });
    const src = makeNode({ id: 'src', schema: 'dbo', name: 'src', type: 'view', columns: cols });
    const nodes = [wide, src];
    const edges: Array<[string, string]> = [['src', 'wide']];
    const engine = new NavigationEngine(makeModel(nodes, edges, ['dbo']), makeGraph(nodes, edges), () => {}, {});
    engine.init({ origin: 'wide', question: 'trace all', direction: 'upstream', analysisMode: 'ct', targetColumns: cols.map((c) => c.name) });
    engine.getHopContext();
    const res = engine.submitFindings({
      focus_node_id: 'wide', sections: [{ angle: 'business' as const, text: 'all from src' }], summary: 'ok', verdict: 'analyze',
      route_requests: [{ nodeId: 'src', question: 'origin', columns: cols.map((c) => c.name) }],
      column_flow: cols.map((c) => ({ out_col: c.name, upstream_columns: [{ node: 'src', col: c.name }] })),
    });
    expect('error' in res ? res : null).toBeNull();
    const ctx = engine.getHopContext() as Ctx;
    expect(ctx.focus_node?.id).toBe('src');
    expect(engine.columnAspect?.active_columns.length, 'all forty columns stay active at the source').toBe(40);
    expect(engine.pendingLineageQuestions.length, 'one question per source column').toBe(40);
  });
});

describe('CT route stated columns:none for a node an earlier hop named as a source', () => {
  // v1 names src.k as the source of v1.k; v2 routes the same src as row-role only. src is
  // dispatched with k active AND with the continuation question, so the node itself is asked.
  const k = [{ name: 'k', type: 'int', nullable: 'NULL', extra: '' }];
  const origin = makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'view', columns: k });
  const v1 = makeNode({ id: 'v1', schema: 'dbo', name: 'v1', type: 'view', columns: k });
  const v2 = makeNode({ id: 'v2', schema: 'dbo', name: 'v2', type: 'view', columns: k });
  const src = makeNode({ id: 'src', schema: 'dbo', name: 'src', type: 'view', columns: k });
  const nodes = [origin, v1, v2, src];
  const edges: Array<[string, string]> = [['v1', 'origin'], ['v2', 'origin'], ['src', 'v1'], ['src', 'v2']];

  it('the committed column and its question reach the node; the row-role statement never drops it', () => {
    const engine = new NavigationEngine(makeModel(nodes, edges, ['dbo']), makeGraph(nodes, edges), () => {}, {});
    engine.init({ origin: 'origin', question: 'trace k', direction: 'upstream', analysisMode: 'ct', targetColumns: ['k'] });
    let srcActive: string[] | undefined;
    let srcQuestions: string[] = [];
    for (let hop = 0; hop < 10; hop++) {
      const ctx = engine.getHopContext() as Ctx;
      if (ctx.done || !ctx.focus_node) break;
      const id = ctx.focus_node.id;
      const base = { focus_node_id: id, sections: [{ angle: 'business' as const, text: id }], summary: id, verdict: 'analyze' as const };
      if (id === 'origin') {
        engine.submitFindings({ ...base, route_requests: [{ nodeId: 'v1', question: 'k', columns: ['k'] }, { nodeId: 'v2', question: 'rows', columns: 'none' as const }], column_flow: [{ out_col: 'k', upstream_columns: [{ node: 'v1', col: 'k' }] }] });
      } else if (id === 'v1') {
        engine.submitFindings({ ...base, route_requests: [{ nodeId: 'src', question: 'k', columns: ['k'] }], column_flow: [{ out_col: 'k', upstream_columns: [{ node: 'src', col: 'k' }] }] });
      } else if (id === 'v2') {
        engine.submitFindings({ ...base, route_requests: [{ nodeId: 'src', question: 'rows', columns: 'none' as const }] });
      } else {
        if (id === 'src') { srcActive = [...(engine.columnAspect?.active_columns ?? [])]; srcQuestions = [...engine.pendingLineageQuestions]; }
        const active = engine.columnAspect?.active_columns ?? [];
        engine.submitFindings({ ...base, column_flow: active.map((out_col) => ({ out_col, upstream_columns: [] })) });
      }
    }
    expect(srcActive, 'src is dispatched carrying the committed column').toEqual(['k']);
    expect(srcQuestions.length, 'src is asked about it — the node that owns the answer').toBe(1);
  });
});
