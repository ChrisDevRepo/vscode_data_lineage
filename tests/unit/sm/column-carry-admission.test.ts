/**
 * Carry and admission read one closure: a column is handed downstream only when the next hop could
 * link it onward. A procedure that writes a destination from the tracked column has its own output
 * attached only as an input of that destination (a second contributor); the output does not seed its
 * other consumers, so it is neither carried to them nor admitted as their contributor.
 */
import { describe, expect, it } from 'vitest';
import { columnAttachment } from '../../../src/ai/sm/columnTracer';
import type { DepthIntent } from '../../../src/ai/sm/smTypes';
import { directionFromDepth } from '../../../src/engine/shared/explorationDepthContract';
import { buildModel, newEngine } from './helpers/engineFixture';

const BOTH: DepthIntent = { upstream: { levels: 4, exactness: 'exact' }, downstream: { levels: 4, exactness: 'exact' } };
const node = (id: string, type: 'table' | 'view' | 'procedure') => ({ id, type, columns: ['Amount'] });
const edge = (source: string, target: string) => ({ source, target, type: 'body' as const });
const key = (node: string, col: string): string => `${node}.${col}`;

/* eslint-disable @typescript-eslint/no-explicit-any -- the engine state is read directly */
function submit(engine: any, focus: string, extra: object): any {
  expect(engine.getHopContext().focus_node?.id).toBe(focus);
  return engine.submitFindings({ focus_node_id: focus, verdict: 'analyze', summary: 'S', sections: [{ angle: 'technical', text: 'a' }], ...extra });
}

describe('column carry offers what admission attaches', () => {
  it('a writer procedure hands its destination column on, never its own output, to its other consumers', () => {
    const built = buildModel({
      nodes: [node('dbo.A', 'view'), node('dbo.B', 'procedure'), node('dbo.C', 'table'), node('dbo.E', 'procedure')],
      edges: [edge('dbo.A', 'dbo.B'), edge('dbo.B', 'dbo.C'), edge('dbo.B', 'dbo.E')],
      origin: 'dbo.A',
    });
    const engine: any = newEngine(built);
    expect(engine.init({ question: 'q', origin: 'dbo.A', analysisMode: 'ct', targetColumns: ['Amount'], direction: directionFromDepth(BOTH), depthIntent: BOTH }).ok).toBe(true);
    const route = (...ids: string[]) => ids.map(nodeId => ({ nodeId, question: 'what does it do with Amount?' }));
    expect(submit(engine, 'dbo.A', { column_flow: [{ out_col: 'Amount', upstream_columns: [] }], questions: route('dbo.B') }).ok).toBe(true);
    const atB = submit(engine, 'dbo.B', {
      column_flow: [{ out_col: 'Amount', writes_to: { node: 'dbo.C', col: 'Amount' }, upstream_columns: [{ node: 'dbo.A', col: 'Amount' }] }],
      questions: route('dbo.C', 'dbo.E'),
    });
    expect(atB.ok, JSON.stringify(atB)).toBe(true);
    let focus = '';
    for (let hop = 0; hop < 3 && focus !== 'dbo.E'; hop++) {
      focus = engine.getHopContext().focus_node?.id;
      if (focus !== 'dbo.E') expect(engine.submitFindings({ focus_node_id: focus, verdict: 'analyze', summary: 'S', sections: [{ angle: 'technical', text: 'a' }], column_flow: [{ out_col: 'Amount', upstream_columns: [] }] }).ok).toBe(true);
    }
    expect(focus).toBe('dbo.E');
    expect(engine.incomingColumnRefs().map((ref: { node: string; col: string }) => key(ref.node, ref.col))).not.toContain('dbo.B.Amount');
    const refused = engine.submitFindings({
      focus_node_id: 'dbo.E', verdict: 'analyze', summary: 'S', sections: [{ angle: 'technical', text: 'a' }],
      column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: 'dbo.B', col: 'Amount' }] }],
    });
    expect(refused.code).toBe('out_col_not_tracked');
  });

  it('the closure names the endpoints the tracked value flows through, inputs of what it feeds excluded', () => {
    const k = (node: string, col: string): string => `${node}.${col}`;
    const edges = [
      { hop_node: 'B', from_node: 'A', from_col: 'Amount', to_node: 'C', to_col: 'Amount' },
      { hop_node: 'B', from_node: 'B', from_col: 'Amount', to_node: 'C', to_col: 'Amount' },
    ];
    const attachment = columnAttachment([{ node: 'A', col: 'Amount' }], edges, 'downstream', k);
    expect([...attachment.endpoints].sort()).toEqual(['A.Amount', 'B.Amount', 'C.Amount']);
    expect([...attachment.flowing].sort()).toEqual(['A.Amount', 'C.Amount']);
  });
});
