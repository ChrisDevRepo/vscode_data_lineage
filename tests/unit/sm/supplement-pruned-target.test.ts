/**
 * A follow-up that names a pruned object is the user's decision and wins over the AI's earlier prune.
 * The named object is added back together with the pruned connectors on its shortest path to the
 * kept graph, at the action, so the result needs no repair at render. A target with no path to the
 * start even through pruned objects stays refused.
 */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DepthIntent } from '../../../src/ai/sm/smTypes';
import { directionFromDepth } from '../../../src/engine/shared/explorationDepthContract';
import { buildModel } from './helpers/engineFixture';

const side = (levels: number | 'all') => ({ levels, exactness: 'approximate' as const });
const BOTH: DepthIntent = { upstream: side('all'), downstream: side('all') };
const node = (id: string, type: 'table' | 'view' | 'procedure') => ({ id, type, columns: [] as string[] });
const edge = (source: string, target: string) => ({ source, target, type: 'exec' as const });

/* eslint-disable @typescript-eslint/no-explicit-any -- the engine state is read directly */
function pruned(nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[], origin: string, prunedIds: string[]): { engine: any; logs: string[] } {
  const built = buildModel({ nodes, edges, origin } as never);
  const logs: string[] = [];
  const engine: any = new NavigationEngine(built.model, built.graph, (_level: string, message: string) => { logs.push(message); }, {});
  expect(engine.init({ question: 'q', origin, analysisMode: 'bb', direction: directionFromDepth(BOTH), depthIntent: BOTH }).ok).toBe(true);
  expect(engine.getHopContext().focus_node?.id).toBe(origin);
  const outcome = engine.submitFindings({
    focus_node_id: origin, verdict: 'analyze', summary: 'S', sections: [{ angle: 'technical', text: 'a' }],
    prune_neighbors: prunedIds.map(id => ({ id, reason: 'off the answer' })),
  });
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  expect(engine.getHopContext().done).toBe(true);
  return { engine, logs };
}

describe('supplement of a pruned target', () => {
  it('adds the named object back with the pruned connector on its path, so the render restores nothing', () => {
    const { engine, logs } = pruned(
      [node('dbo.O', 'table'), node('dbo.TA', 'table'), node('dbo.VA', 'view')],
      [edge('dbo.TA', 'dbo.O'), edge('dbo.VA', 'dbo.TA')], 'dbo.O', ['dbo.TA']);
    expect(engine.toJSON().removedSet).toEqual(expect.arrayContaining(['dbo.TA', 'dbo.VA']));
    expect(engine.supplementAgenda(['dbo.VA'])).toMatchObject({ ok: true, agendaed: 1, skipped: 0 });
    expect(engine.toJSON().removedSet).toEqual([]);
    expect(logs.filter(line => line.includes('restore pruned connector'))).toEqual([expect.stringContaining('dbo.TA')]);
    expect(engine.getHopContext().focus_node?.id).toBe('dbo.VA');
    engine.submitFindings({ focus_node_id: 'dbo.VA', verdict: 'analyze', summary: 'S', sections: [{ angle: 'technical', text: 'a' }] });
    expect(engine.getHopContext().done).toBe(true);
    const ids = engine.getResult().fullNodes.map((n: { id: string }) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['dbo.O', 'dbo.TA', 'dbo.VA']));
    expect(logs.filter(line => line.includes('restores pruned connector'))).toEqual([]);
  });

  it('credits the work total for a restored bodied connector, as the prune debited it', () => {
    const { engine } = pruned(
      [node('dbo.O', 'table'), node('dbo.V1', 'view'), node('dbo.V2', 'view')],
      [edge('dbo.V1', 'dbo.O'), edge('dbo.V2', 'dbo.V1')], 'dbo.O', ['dbo.V1']);
    expect(engine._totalNodes).toBe(1);
    expect(engine.supplementAgenda(['dbo.V2'])).toMatchObject({ ok: true, agendaed: 1 });
    expect(engine._totalNodes).toBe(3);
  });

  it('refuses a target with no path to the start even through pruned objects', () => {
    const { engine } = pruned(
      [node('dbo.O', 'table'), node('dbo.TA', 'table'), node('dbo.ISLAND', 'view')],
      [edge('dbo.TA', 'dbo.O')], 'dbo.O', ['dbo.TA']);
    expect(engine.supplementAgenda(['dbo.ISLAND'])).toMatchObject({
      ok: true, agendaed: 0, skipped: 1, skippedDetails: [expect.objectContaining({ nodeId: 'dbo.ISLAND', reason: 'not_connected_to_trace' })],
    });
    expect(engine.toJSON().removedSet).toEqual(['dbo.TA']);
  });

  it('restores the connectors along the approved leg, so every later hop of the target dispatches and the state dump stays valid', () => {
    const nodes = [node('dbo.T0', 'table'), node('dbo.V1', 'view'), node('dbo.V2', 'view'), node('dbo.P3', 'procedure'), node('dbo.F4', 'view'), node('dbo.F5', 'view'), node('dbo.P6', 'procedure')];
    const edges = [edge('dbo.T0', 'dbo.V1'), edge('dbo.V1', 'dbo.V2'), edge('dbo.V2', 'dbo.P3'), edge('dbo.P3', 'dbo.T0'), edge('dbo.T0', 'dbo.F4'), edge('dbo.F4', 'dbo.F5'), edge('dbo.F5', 'dbo.P6'), edge('dbo.P6', 'dbo.T0')];
    const down: DepthIntent = { upstream: side(0), downstream: side('all') };
    const built = buildModel({ nodes, edges, origin: 'dbo.F5' } as never);
    const engine: any = new NavigationEngine(built.model, built.graph, () => {}, {});
    expect(engine.init({ question: 'q', origin: 'dbo.F5', analysisMode: 'bb', direction: directionFromDepth(down), depthIntent: down }).ok).toBe(true);
    const hop = (focus: string, extra: object = {}): void => {
      expect(engine.getHopContext().focus_node?.id).toBe(focus);
      expect(engine.submitFindings({ focus_node_id: focus, verdict: 'analyze', summary: 'S', sections: [{ angle: 'technical', text: 'a' }], ...extra }).ok).toBe(true);
    };
    hop('dbo.F5', { questions: [{ nodeId: 'dbo.P6', question: 'q' }] });
    hop('dbo.P6', { prune_neighbors: [{ id: 'dbo.T0', reason: 'off the answer' }] });
    expect(engine.getHopContext().done).toBe(true);
    expect(engine.supplementAgenda(['dbo.V2'])).toMatchObject({ ok: true, agendaed: 1 });
    expect(engine.toJSON().removedSet).toEqual(['dbo.F4', 'dbo.P3']);
    for (let guard = 0; guard < 6; guard++) {
      const focus = engine.getHopContext().focus_node?.id;
      if (!focus) break;
      expect(engine.submitFindings({ focus_node_id: focus, verdict: 'analyze', summary: 'S', sections: [{ angle: 'technical', text: 'a' }] }).ok).toBe(true);
      expect(() => engine.toJSON()).not.toThrow();
    }
  });
});
