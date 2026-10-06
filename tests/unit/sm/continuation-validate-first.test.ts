/**
 * A carrier's continuation is judged before adjacency: an `upstream_columns` entry naming an object that is
 * neither a writer of the carrier nor a neighbor is refused `continuation_not_writer`, the same refusal as a
 * non-writer neighbor, never dropped with a notice that lets the call pass.
 */
import { describe, expect, it } from 'vitest';
import type { DepthIntent } from '../../../src/ai/sm/smTypes';
import { directionFromDepth } from '../../../src/engine/shared/explorationDepthContract';
import { buildModel, newEngine } from './helpers/engineFixture';

const UP: DepthIntent = { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } };

/* eslint-disable @typescript-eslint/no-explicit-any -- the engine state is read directly */
function submitWith(contributor: { node: string; col: string }): any {
  const built = buildModel({
    nodes: [
      { id: 'dbo.T', type: 'table', columns: ['a'] },
      { id: 'dbo.P', type: 'procedure', columns: [] },
      { id: 'dbo.S', type: 'table', columns: ['s'] },
      { id: 'dbo.X', type: 'table', columns: ['x'] },
    ],
    edges: [{ source: 'dbo.P', target: 'dbo.T', type: 'body' }, { source: 'dbo.S', target: 'dbo.P', type: 'body' }],
    origin: 'dbo.T',
  });
  const engine: any = newEngine(built);
  expect(engine.init({ question: 'q', origin: 'dbo.T', analysisMode: 'ct', targetColumns: ['a'], direction: directionFromDepth(UP), depthIntent: UP }).ok).toBe(true);
  expect(engine.getHopContext().focus_node?.id).toBe('dbo.T');
  const outcome = engine.submitFindings({
    focus_node_id: 'dbo.T', verdict: 'analyze', summary: 'S', sections: [{ angle: 'technical', text: 'a' }],
    column_flow: [{ out_col: 'a', upstream_columns: [contributor] }],
  });
  return { outcome, engine };
}

describe('continuation is validated before adjacency', () => {
  it('refuses a real column of an object that is neither a writer nor a neighbor', () => {
    const { outcome, engine } = submitWith({ node: 'dbo.X', col: 'x' });
    expect(outcome.code).toBe('continuation_not_writer');
    expect(engine.tracer.edges).toEqual([]);
  });

  it('keeps the continuation at a writer of the carrier', () => {
    const { outcome } = submitWith({ node: 'dbo.P', col: 'a' });
    expect(outcome.code, JSON.stringify(outcome)).toBeUndefined();
  });
});
