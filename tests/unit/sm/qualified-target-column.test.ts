/**
 * A CT target column is one column however the user spelled it. The closure roots every committed
 * column edge must attach to resolve through the same origin resolver as the active columns, so a
 * node-qualified spelling (`[x].[v].[Discount]`, `v.Discount`) roots the same column as `Discount`.
 */
import { describe, expect, it } from 'vitest';
import type { DepthIntent } from '../../../src/ai/sm/smTypes';
import { directionFromDepth } from '../../../src/engine/shared/explorationDepthContract';
import { buildModel, newEngine } from './helpers/engineFixture';

const UP: DepthIntent = { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } };

/* eslint-disable @typescript-eslint/no-explicit-any -- the engine state is read directly */
function start(targetColumns: string[]): any {
  const built = buildModel({
    nodes: [{ id: 'x.v', type: 'view', columns: ['Discount'] }, { id: 'x.s', type: 'table', columns: ['Amt'] }],
    edges: [{ source: 'x.s', target: 'x.v', type: 'body' }],
    origin: 'x.v',
  });
  const engine: any = newEngine(built);
  const init = engine.init({ question: 'q', origin: 'x.v', analysisMode: 'ct', targetColumns, direction: directionFromDepth(UP), depthIntent: UP });
  expect(init.ok, JSON.stringify(init)).toBe(true);
  return engine;
}

describe('qualified CT target column', () => {
  it.each([['[x].[v].[Discount]'], ['v.Discount'], ['Discount']])('target %s commits and delivers the origin column edge', (spelling) => {
    const engine = start([spelling]);
    expect(engine.getHopContext().focus_node?.id).toBe('x.v');
    const outcome = engine.submitFindings({
      focus_node_id: 'x.v', verdict: 'analyze', summary: 'S', sections: [{ angle: 'technical', text: 'a' }],
      column_flow: [{ out_col: 'Discount', upstream_columns: [{ node: 'x.s', col: 'Amt' }] }],
    });
    expect('error' in outcome, JSON.stringify(outcome)).toBe(false);
    const keys = (edges: any[]): string[] => edges.map(e => `${e.from_node}.${e.from_col}>${e.to_node}.${e.to_col}`);
    expect(keys(engine.tracer.edges)).toEqual(['x.s.Amt>x.v.Discount']);
    expect(keys(engine.getResult().columnAspect?.edges ?? [])).toEqual(['x.s.Amt>x.v.Discount']);
  });
});
