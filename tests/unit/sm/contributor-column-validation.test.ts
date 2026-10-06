/**
 * A contributor's column is validated against the object the model names, wherever that object sits
 * in the graph. A column that does not exist on it, or a literal, is refused `contributor_col_not_on_source`;
 * adjacency decides only whether a valid contributor commits an edge (a non-neighbor is dropped with a notice).
 */
import { describe, expect, it } from 'vitest';
import type { DepthIntent } from '../../../src/ai/sm/smTypes';
import { directionFromDepth } from '../../../src/engine/shared/explorationDepthContract';
import { buildModel, newEngine } from './helpers/engineFixture';

const UP: DepthIntent = { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } };

/* eslint-disable @typescript-eslint/no-explicit-any -- the engine state is read directly */
function submitWith(contributor: { node: string; col: string }): any {
  const built = buildModel({
    nodes: [{ id: 'dbo.O', type: 'view', columns: ['a'] }, { id: 'dbo.P', type: 'procedure', columns: [] }, { id: 'dbo.T', type: 'table', columns: ['b'] }, { id: 'dbo.N', type: 'table', columns: ['c'] }],
    edges: [{ source: 'dbo.N', target: 'dbo.O', type: 'body' }, { source: 'dbo.T', target: 'dbo.P', type: 'body' }, { source: 'dbo.P', target: 'dbo.O', type: 'body' }],
    origin: 'dbo.O',
  });
  const engine: any = newEngine(built);
  expect(engine.init({ question: 'q', origin: 'dbo.O', analysisMode: 'ct', targetColumns: ['a'], direction: directionFromDepth(UP), depthIntent: UP }).ok).toBe(true);
  expect(engine.getHopContext().focus_node?.id).toBe('dbo.O');
  const outcome = engine.submitFindings({
    focus_node_id: 'dbo.O', verdict: 'analyze', summary: 'S', sections: [{ angle: 'technical', text: 'a' }],
    column_flow: [{ out_col: 'a', upstream_columns: [contributor] }],
  });
  return { outcome, engine };
}

describe('contributor column validation', () => {
  it.each([
    ['a column the object does not declare, on an object that is not a neighbor', { node: 'dbo.T', col: 'no_such_col' }],
    ['a literal, on an object that is not a neighbor', { node: 'dbo.T', col: '42' }],
    ['a column the object does not declare, on a neighbor', { node: 'dbo.N', col: 'no_such_col' }],
    ['a literal, on a neighbor', { node: 'dbo.N', col: '42' }],
  ])('refuses %s', (_label, contributor) => {
    const { outcome, engine } = submitWith(contributor);
    expect(outcome.code).toBe('contributor_col_not_on_source');
    expect(engine.tracer.edges).toEqual([]);
  });

  it('drops a real column of an object that is not a neighbor, committing no edge', () => {
    const { outcome, engine } = submitWith({ node: 'dbo.T', col: 'b' });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(engine.tracer.edges).toEqual([]);
  });

  it('keeps a real column of a neighbor', () => {
    const { outcome, engine } = submitWith({ node: 'dbo.N', col: 'c' });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(engine.tracer.edges).toHaveLength(1);
  });
});
