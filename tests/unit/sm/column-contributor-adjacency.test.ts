/**
 * A column contributor is an object the focus is connected to. Each case names a contributor with
 * no edge to the hop (a neighbour's neighbour, another component, or an unrelated object after a
 * supplement) and checks that no column edge is recorded from it.
 */
import { describe, expect, it } from 'vitest';
import type { DepthIntent } from '../../../src/ai/sm/smTypes';
import { directionFromDepth } from '../../../src/engine/shared/explorationDepthContract';
import { buildModel, completeRun, newEngine } from './helpers/engineFixture';

type Kind = 'table' | 'view' | 'procedure' | 'function';
const node = (id: string, type: Kind, columns: string[] = []) => ({ id, type, columns });
const edge = (source: string, target: string) => ({ source, target, type: 'body' as const });
const side = (levels: number | 'all') => ({ levels, exactness: 'exact' as const });
const UP: DepthIntent = { upstream: side('all'), downstream: side(0) };
const DOWN: DepthIntent = { upstream: side(0), downstream: side('all') };

/* eslint-disable @typescript-eslint/no-explicit-any -- the engine state is read directly */
function start(nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[], origin: string, depth: DepthIntent, targetColumns: string[]) {
  const built = buildModel({ nodes, edges, origin } as never);
  const engine: any = newEngine(built);
  const init = engine.init({ question: 'q', origin, analysisMode: 'ct', targetColumns, direction: directionFromDepth(depth), depthIntent: depth });
  expect(init.ok, JSON.stringify(init)).toBe(true);
  return engine;
}

function submit(engine: any, focus: string, column_flow: object[], extra: object = {}): any {
  expect(engine.getHopContext().focus_node?.id).toBe(focus);
  return engine.submitFindings({ focus_node_id: focus, verdict: 'analyze', summary: 'S', sections: [{ angle: 'technical', text: 'a' }], column_flow, ...extra });
}

const edgesOf = (engine: any): string[] => engine.tracer.edges.map((e: any) => `${e.from_node}.${e.from_col}>${e.to_node}.${e.to_col}@${e.hop_node}`);
const delivered = (engine: any): string[] => (completeRun(engine), engine.getResult().columnAspect?.edges ?? []).map((e: any) => `${e.from_node}.${e.from_col}>${e.to_node}.${e.to_col}@${e.hop_node}`);

describe('column contributor adjacency', () => {
  it('downstream trace: a view naming a procedure that only writes to its neighbour records no edge from it', () => {
    const engine = start([node('dbo.V6', 'view', ['c', 'a']), node('dbo.P2', 'procedure'), node('dbo.P3', 'procedure'), node('dbo.P7', 'procedure')],
      [edge('dbo.V6', 'dbo.P2'), edge('dbo.V6', 'dbo.P3'), edge('dbo.P7', 'dbo.P2')], 'dbo.V6', DOWN, ['a']);
    submit(engine, 'dbo.V6', [{ out_col: 'a', upstream_columns: [{ node: 'dbo.P7', col: 'c' }] }]);
    expect(edgesOf(engine).filter(e => e.includes('dbo.P7'))).toEqual([]);
    expect(delivered(engine).filter(e => e.includes('dbo.P7'))).toEqual([]);
  });

  it('upstream trace: a view keeps its direct table source and drops the procedure two hops away', () => {
    const engine = start([node('dbo.P0', 'procedure'), node('dbo.T3', 'table', ['b', 'e']), node('dbo.V4', 'view', ['d', 'e'])],
      [edge('dbo.P0', 'dbo.T3'), edge('dbo.T3', 'dbo.V4')], 'dbo.V4', UP, ['d']);
    submit(engine, 'dbo.V4', [{ out_col: 'd', upstream_columns: [{ node: 'dbo.T3', col: 'b' }] }, { out_col: 'd', upstream_columns: [{ node: 'dbo.P0', col: 'd' }] }]);
    expect(edgesOf(engine)).toEqual(['dbo.T3.b>dbo.V4.d@dbo.V4']);
    expect(delivered(engine)).toEqual(['dbo.T3.b>dbo.V4.d@dbo.V4']);
  });

  it('isolated origin: a passthrough naming a contributor from another component records no edge', () => {
    const engine = start([node('dbo.V0', 'view', ['a', 'b', 'c']), node('dbo.P8', 'procedure'), node('dbo.T4', 'table', ['b'])],
      [edge('dbo.P8', 'dbo.T4')], 'dbo.V0', UP, ['c']);
    submit(engine, 'dbo.V0', [{ out_col: 'c', upstream_columns: [{ node: 'dbo.P8', col: 'b' }] }], { verdict: 'passthrough' });
    expect(edgesOf(engine)).toEqual([]);
  });

  it('supplemented table hop: a procedure with no edge to the table is not recorded as contributor', () => {
    const engine = start([node('dbo.T0', 'table', ['b', 'a', 'd']), node('dbo.F2', 'function', ['c', 'e', 'd', 'b']), node('dbo.P5', 'procedure')],
      [edge('dbo.T0', 'dbo.F2')], 'dbo.F2', UP, ['e']);
    expect(submit(engine, 'dbo.F2', [{ out_col: 'e', upstream_columns: [{ node: 'dbo.T0', col: 'd' }] }]).ok).toBe(true);
    expect(engine.getHopContext().done).toBe(true);
    expect(engine.supplementAgenda(['dbo.T0'])).toMatchObject({ ok: true, agendaed: 1 });
    submit(engine, 'dbo.T0', [{ out_col: 'd', upstream_columns: [{ node: 'dbo.P5', col: 'a' }] }]);
    expect(edgesOf(engine)).toEqual(['dbo.T0.d>dbo.F2.e@dbo.F2']);
  });

  it('keeps contributors on either side of the focus', () => {
    const engine = start([node('dbo.T1', 'table', ['x']), node('dbo.P2', 'procedure'), node('dbo.T3', 'table', ['y'])],
      [edge('dbo.T1', 'dbo.P2'), edge('dbo.P2', 'dbo.T3')], 'dbo.T3', UP, ['y']);
    submit(engine, 'dbo.T3', [{ out_col: 'y', upstream_columns: [{ node: 'dbo.P2', col: 'y' }] }]);
    submit(engine, 'dbo.P2', [{ out_col: 'y', writes_to: { node: 'dbo.T3', col: 'y' }, upstream_columns: [{ node: 'dbo.T1', col: 'x' }] }]);
    expect(edgesOf(engine)).toContain('dbo.T1.x>dbo.T3.y@dbo.P2');
  });
});
