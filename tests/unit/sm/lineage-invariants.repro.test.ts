/**
 * Hand-written engine-level reproductions of engine defects found during a pre-release sweep
 * (local revision 03d9f7386). Every repro is now repaired and runs as a plain regression `it`;
 * pin a newly found, still-open defect as `it.fails` and flip it to `it` once its owner is fixed.
 * Synthetic graphs, named nodes, explicit action sequences; no generator involved.
 */
import { describe, expect, it } from 'vitest';
import type { DepthIntent } from '../../../src/ai/sm/smTypes';
import { directionFromDepth } from '../../../src/engine/shared/explorationDepthContract';
import { buildModel, newEngine, type Built } from './helpers/engineFixture';

type Kind = 'table' | 'view' | 'procedure' | 'function';
const node = (id: string, type: Kind, columns: string[] = []) => ({ id, type, columns });
const edge = (source: string, target: string) => ({ source, target, type: 'exec' as const });
const side = (levels: number | 'all', exactness: 'exact' | 'approximate' = 'approximate') => ({ levels, exactness });
const BOTH: DepthIntent = { upstream: side('all'), downstream: side('all') };

/* eslint-disable @typescript-eslint/no-explicit-any -- the repros read private engine state on purpose */
function start(nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[], origin: string, depth: DepthIntent = BOTH, extra: object = {}, caseSensitive = false): { built: Built; engine: any } {
  const built = buildModel({ nodes, edges, origin } as never);
  if (caseSensitive) {
    (built.model as { identifierCaseSensitive?: boolean }).identifierCaseSensitive = true;
    (built.model as { neighborIndex: unknown }).neighborIndex = Object.fromEntries(nodes.map(n => [n.id, { in: edges.filter(e => e.target === n.id).map(e => e.source), out: edges.filter(e => e.source === n.id).map(e => e.target) }]));
  }
  const engine: any = newEngine(built);
  const init = engine.init({ question: 'q', origin, analysisMode: 'bb', direction: directionFromDepth(depth), depthIntent: depth, ...extra });
  expect(init.ok).toBe(true);
  return { built, engine };
}
/** Dispatches the next hop and submits findings for it; the focus is asserted, not chosen. */
function hop(engine: any, focus: string, extra: object = {}): void {
  expect(engine.getHopContext().focus_node?.id).toBe(focus);
  const result = engine.submitFindings({ focus_node_id: focus, verdict: 'analyze', summary: 'S', sections: [{ angle: 'technical', text: 'a' }], ...extra });
  expect(result.ok, JSON.stringify(result)).toBe(true);
}
const prune = (...ids: string[]) => ({ prune_neighbors: ids.map(id => ({ id, reason: 'off the answer' })) });

describe('lineage invariant repros (03d9f7386)', () => {
  // N1 cycles:517125208 — wrong oracle: the tool carries depth only and direction is read off it, so "upstream" always has downstream closed.
  it('N1 guard: an upstream-only scope never admits a cycle node past the exact upstream ceiling', () => {
    const depth: DepthIntent = { upstream: side(1, 'exact'), downstream: side(0, 'exact') };
    const s = start([node('dbo.P0', 'procedure'), node('dbo.P1', 'procedure'), node('dbo.P2', 'procedure'), node('dbo.P3', 'procedure'), node('dbo.P4', 'procedure')],
      [edge('dbo.P0', 'dbo.P1'), edge('dbo.P1', 'dbo.P2'), edge('dbo.P2', 'dbo.P3'), edge('dbo.P3', 'dbo.P4'), edge('dbo.P4', 'dbo.P0')], 'dbo.P2', depth);
    hop(s.engine, 'dbo.P2', { questions: [{ nodeId: 'dbo.P1', question: 'check' }] });
    hop(s.engine, 'dbo.P1', { questions: [{ nodeId: 'dbo.P0', question: 'check' }] });
    expect(s.engine.getHopContext().done).toBe(true);
    expect(s.engine.getResult().fullNodes.map((n: { id: string }) => n.id)).not.toContain('dbo.P0');
  });

  // N2 bridge-prune:2862368159 — a supplement target whose only route to the origin runs through a pruned object is the user's decision: it is admitted and the connector comes back with it.
  it('N2: supplement of a node cut off by a prune restores the pruned connector at the action, and the state dump stays valid', () => {
    const s = start([node('dbo.T0', 'table'), node('dbo.P2', 'procedure'), node('dbo.P3', 'procedure')], [edge('dbo.P2', 'dbo.T0'), edge('dbo.P3', 'dbo.P2')], 'dbo.T0');
    hop(s.engine, 'dbo.T0', prune('dbo.P2'));
    expect(s.engine.getHopContext().done).toBe(true);
    expect(s.engine.supplementAgenda(['dbo.P3'])).toMatchObject({ ok: true, agendaed: 1, skipped: 0 });
    expect(s.engine.toJSON().removedSet).toEqual([]);
    s.engine.getHopContext();
    expect(() => s.engine.toJSON()).not.toThrow();
  });

  // N3 tree-star:3485169028 — real: supplement scheduling casts a keep vote in the name of the completed run's last focus.
  it('N3: supplementing visited nodes leaves no prune ballot and the state dump stays valid', () => {
    const depth: DepthIntent = { upstream: side(3, 'exact'), downstream: side(0, 'exact') };
    const s = start([node('dbo.T0', 'table'), node('dbo.P1', 'procedure'), node('dbo.P2', 'procedure')], [edge('dbo.P1', 'dbo.T0'), edge('dbo.P2', 'dbo.T0')], 'dbo.T0', depth);
    hop(s.engine, 'dbo.T0');
    hop(s.engine, 'dbo.P1');
    hop(s.engine, 'dbo.P2');
    expect(s.engine.getHopContext().done).toBe(true);
    s.engine.supplementAgenda(['dbo.T0', 'dbo.P1', 'dbo.P2']);
    s.engine.getHopContext();
    expect([...s.engine.pruneBallots.keys()]).toEqual([]);
    expect(() => s.engine.toJSON()).not.toThrow();
  });

  // N4 degenerate:1903012138 — one hop's prune_neighbors resolve as one removal proposal, so the list order never changes the outcome.
  it('N4: every order of the same prune_neighbors set removes the same objects and leaves the same scope', () => {
    const nodes = [node('dbo.P0', 'procedure'), node('dbo.P1', 'procedure'), node('dbo.T2', 'table'), node('dbo.P5', 'procedure'), node('dbo.P9', 'procedure'), node('dbo.P12', 'procedure')];
    const edges = [edge('dbo.P0', 'dbo.P12'), edge('dbo.P1', 'dbo.P9'), edge('dbo.P5', 'dbo.P1'), edge('dbo.T2', 'dbo.P5'), edge('dbo.P9', 'dbo.T2'), edge('dbo.T2', 'dbo.P9'), edge('dbo.P5', 'dbo.P0')];
    const outcome = (...ids: string[]): string => {
      const { engine } = start(nodes, edges, 'dbo.P9');
      hop(engine, 'dbo.P9', prune(...ids));
      engine.getHopContext(); // the agenda is empty: pending votes resolve here
      return JSON.stringify([[...engine.removedSet].sort(), [...engine.scopeNodeIds].sort(), engine._totalNodes]);
    };
    const set = ['dbo.P1', 'dbo.T2', 'dbo.P0'];
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map(order => outcome(...order.map(i => set[i])));
    expect(new Set(orders).size).toBe(1);
    expect(JSON.parse(orders[0])[0]).toEqual(['dbo.P0', 'dbo.P1', 'dbo.P12', 'dbo.P5', 'dbo.T2']);
  });

  // N5 uniform:2634403074 — the carried column list folds spellings by the model's identifier policy.
  const carriedOnF5 = (caseSensitive: boolean): string[] => {
    const depth: DepthIntent = { upstream: side(0, 'exact'), downstream: side(1, 'exact') };
    const { engine } = start([node('dbo.F2', 'function', ['c', 'e', 'E']), node('dbo.F3', 'function', ['e']), node('dbo.F5', 'function', ['e'])], [edge('dbo.F3', 'dbo.F5'), edge('dbo.F3', 'dbo.F2')], 'dbo.F3', depth, { analysisMode: 'ct', targetColumns: ['e'] }, caseSensitive);
    const write = (col: string) => ({ out_col: 'e', writes_to: { node: 'dbo.F2', col }, upstream_columns: [{ node: 'dbo.F3', col: 'e' }] });
    hop(engine, 'dbo.F3', { questions: [{ nodeId: 'dbo.F5', question: 'check' }], column_flow: [write('c'), write('E')] });
    return engine._agenda.entries.find((e: { nodeId: string }) => e.nodeId === 'dbo.F5').activeColumns;
  };
  it('N5: column spellings differing only by case are carried once on a case-insensitive model', () => {
    const carried = carriedOnF5(false);
    expect(new Set(carried.map(c => c.toLowerCase())).size).toBe(carried.length);
  });
  it('N5: a case-sensitive model keeps both spellings', () => {
    expect([...carriedOnF5(true)].sort()).toEqual(['E', 'c', 'e']);
  });

  // Coverage gaps the generator never draws: a true self-loop edge and a case-sensitive model with case-only-different ids.
  it('self-loop: an edge from a procedure to itself neither stalls the run nor blocks the state dump', () => {
    const s = start([node('dbo.T0', 'table'), node('dbo.P1', 'procedure')], [edge('dbo.P1', 'dbo.T0'), edge('dbo.P1', 'dbo.P1')], 'dbo.T0');
    hop(s.engine, 'dbo.T0');
    hop(s.engine, 'dbo.P1');
    expect(s.engine.getHopContext().done).toBe(true);
    expect(s.engine.visited.size).toBe(2);
    expect(() => s.engine.toJSON()).not.toThrow();
  });

  it('case-sensitive model: ids and columns differing only by case stay distinct through hops', () => {
    const s = start([node('dbo.T0', 'table', ['Id', 'id']), node('dbo.Src', 'procedure'), node('dbo.src', 'procedure')], [edge('dbo.Src', 'dbo.T0'), edge('dbo.src', 'dbo.T0')], 'dbo.T0', BOTH, undefined, true);
    hop(s.engine, 'dbo.T0', { questions: [{ nodeId: 'dbo.Src', question: 'check' }, { nodeId: 'dbo.src', question: 'check' }] });
    hop(s.engine, 'dbo.Src');
    hop(s.engine, 'dbo.src');
    expect(s.engine.getHopContext().done).toBe(true);
    expect(s.engine.getResult().fullNodes.map((n: { id: string }) => n.id).sort()).toEqual(['dbo.Src', 'dbo.T0', 'dbo.src']);
    expect(s.engine.visited.size).toBe(3);
  });
});
