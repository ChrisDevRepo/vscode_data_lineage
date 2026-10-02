/** Column tracing preserves directed provenance, renamed writes, and synthesis evidence. */
import { describe, expect, it } from 'vitest';
import { ColumnTracer, reachableColumnEndpoints } from '../../../src/ai/sm/columnTracer';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { buildSmCompletionEnvelope } from '../../../src/ai/prompting/smPrompts';
import { buildCurrentTaskBlock } from '../../../src/ai/prompting/prompts';
import type { ColumnFlowEntry, HopFindingKept } from '../../../src/ai/sm/smTypes';
import type { ObjectType } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

function node(id: string, type: ObjectType, columns: string[]) {
  return makeNode({ id, name: id, schema: 'dbo', type,
    columns: columns.map(name => ({ name, type: 'int', nullable: 'NULL', extra: '' })) });
}

function finding(focus: string, flow: ColumnFlowEntry[]): HopFindingKept {
  return { focus_node_id: focus, verdict: 'analyze', summary: `Observed ${focus}`,
    sections: [{ angle: 'technical', text: `Recorded ${focus}` }], column_flow: flow };
}

function writerWorld() {
  const nodes = [node('writer', 'procedure', []), node('carrier', 'table', ['Y']), node('reader', 'view', ['Z'])];
  const pairs: Array<[string, string]> = [['writer', 'carrier'], ['carrier', 'reader']];
  const model = makeModel(nodes, pairs, ['dbo']);
  const graph = makeGraph(nodes, pairs);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect(engine.init({ origin: 'writer', question: 'Trace X downstream', direction: 'downstream',
    analysisMode: 'ct', targetColumns: ['X'],
    depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
  })).toMatchObject({ ok: true });
  engine.getHopContext();
  return { engine, model, graph };
}

describe('downstream column provenance', () => {
  it.each([false, true])('recovers renamed endpoints on a completed follow-up without revisiting neighbors (restore=%s)', restore => {
    const nodes = [node('origin', 'view', ['A']), node('mid', 'view', ['B', 'Other']), node('leaf', 'view', ['C', 'Other'])];
    const pairs: Array<[string, string]> = [['origin', 'mid'], ['mid', 'leaf']];
    const model = makeModel(nodes, pairs, ['dbo']);
    const graph = makeGraph(nodes, pairs);
    let engine = new NavigationEngine(model, graph, () => {}, {});
    expect(engine.init({ origin: 'origin', question: 'Trace A downstream', direction: 'downstream',
      analysisMode: 'ct', targetColumns: ['A'],
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
    })).toMatchObject({ ok: true });
    const flows: Record<string, ColumnFlowEntry[]> = {
      origin: [{ out_col: 'A', upstream_columns: [] }],
      mid: [{ out_col: 'B', upstream_columns: [{ node: 'origin', col: 'A' }] }],
      leaf: [{ out_col: 'C', upstream_columns: [{ node: 'mid', col: 'B' }, { node: 'mid', col: 'Other' }] }],
    };
    for (const focus of ['origin', 'mid', 'leaf']) {
      engine.getHopContext();
      expect(engine.currentFocus).toBe(focus);
      expect(engine.submitFindings(finding(focus, flows[focus]))).toMatchObject({ ok: true });
    }
    expect(engine.getHopContext()).toMatchObject({ done: true });
    if (restore) engine = NavigationEngine.fromJSON(engine.toJSON(), model, graph, () => {});
    expect(engine.supplementAgenda(['leaf', 'leaf'])).toMatchObject({ ok: true, agendaed: 1 });
    engine.getHopContext();
    expect(engine.currentFocus).toBe('leaf');
    expect(engine.columnAspect?.active_columns).toContain('C');
    const before = engine.toJSON();
    expect(engine.submitFindings(finding('leaf', [{ out_col: 'Other', upstream_columns: [{ node: 'mid', col: 'Other' }] }])))
      .toMatchObject({ code: 'out_col_not_tracked' });
    expect(engine.toJSON().columnAspect?.edges).toEqual(before.columnAspect?.edges);
    expect(engine.submitFindings(finding('leaf', flows.leaf))).toMatchObject({ ok: true });
    expect(engine.getHopContext()).toMatchObject({ done: true });
    expect(engine.toJSON().hopCount).toBe(4);
  });

  it.each([false, true])('retains upstream rename connectivity seeded at the destination (reverse order=%s)', reverse => {
    const links = [
      { from: 'source.X', to: 'carrier.Y' },
      { from: 'carrier.Y', to: 'origin.Z' },
      { from: 'unrelated.A', to: 'unrelated.B' },
    ];
    if (reverse) links.reverse();
    const seeds = new Set(['origin.Z']);
    expect(reachableColumnEndpoints(seeds, links, 'upstream')).toEqual(new Set(['origin.Z', 'carrier.Y', 'source.X']));
    expect(reachableColumnEndpoints(seeds, links, 'downstream')).toEqual(seeds);
  });

  it.each([false, true])('carries a terminal renamed write through contraction (restore=%s)', restore => {
    const world = writerWorld();
    expect(world.engine.submitFindings(finding('writer', [
      { out_col: 'X', writes_to: { node: 'carrier', col: 'Y' }, upstream_columns: [] },
    ]))).toMatchObject({ ok: true });
    const engine = restore
      ? NavigationEngine.fromJSON(world.engine.toJSON(), world.model, world.graph, () => {})
      : world.engine;
    engine.getHopContext();
    expect(engine.currentFocus).toBe('reader');
    expect(engine.columnAspect?.active_columns).toEqual(['Y']);
    expect(engine.submitFindings(finding('reader', [
      { out_col: 'Z', upstream_columns: [{ node: 'carrier', col: 'Y' }] },
    ]))).toMatchObject({ ok: true });
    expect(engine.columnAspect?.edges).toEqual([
      expect.objectContaining({ from_node: 'writer', from_col: 'X', to_node: 'carrier', to_col: 'Y' }),
      expect.objectContaining({ from_node: 'carrier', from_col: 'Y', to_node: 'reader', to_col: 'Z' }),
    ]);
  });

  it('ends an explicitly terminal downstream column while retaining the next object as BB', () => {
    const nodes = [node('origin', 'view', ['A']), node('mid', 'view', ['A']), node('leaf', 'view', ['A'])];
    const pairs: Array<[string, string]> = [['origin', 'mid'], ['mid', 'leaf']];
    const engine = new NavigationEngine(makeModel(nodes, pairs, ['dbo']), makeGraph(nodes, pairs), () => {}, {});
    expect(engine.init({ origin: 'origin', question: 'Trace A downstream', direction: 'downstream',
      analysisMode: 'ct', targetColumns: ['A'],
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
    })).toMatchObject({ ok: true });
    engine.getHopContext();
    expect(engine.submitFindings(finding('origin', [{ out_col: 'A', upstream_columns: [] }]))).toMatchObject({ ok: true });
    engine.getHopContext();
    expect(engine.currentFocus).toBe('mid');
    expect(engine.columnAspect?.active_columns).toEqual(['A']);
    expect(engine.submitFindings(finding('mid', [{ out_col: 'A', upstream_columns: [] }]))).toMatchObject({ ok: true });
    engine.getHopContext();
    expect(engine.currentFocus).toBe('leaf');
    expect(engine.columnAspect?.active_columns).toEqual([]);
  });

  it.each([
    { name: 'partial mapping', flow: [{ out_col: 'B', upstream_columns: [{ node: 'origin', col: 'A' }] }], expected: ['B', 'C'] },
    { name: 'complete mapping', flow: [
      { out_col: 'B', upstream_columns: [{ node: 'origin', col: 'A' }] },
      { out_col: 'D', upstream_columns: [{ node: 'origin', col: 'C' }] },
    ], expected: ['B', 'D'] },
    { name: 'explicit terminal column', flow: [
      { out_col: 'B', upstream_columns: [{ node: 'origin', col: 'A' }] },
      { out_col: 'C', upstream_columns: [] },
    ], expected: ['B'] },
    { name: 'empty flow', flow: [], expected: ['A', 'C'] },
  ])('preserves only unresolved inputs alongside outputs ($name)', ({ flow, expected }) => {
    const nodes = [node('origin', 'view', ['A', 'C']), node('mid', 'view', ['B', 'C', 'D']), node('leaf', 'view', ['A', 'B', 'C', 'D'])];
    const pairs: Array<[string, string]> = [['origin', 'mid'], ['mid', 'leaf']];
    const engine = new NavigationEngine(makeModel(nodes, pairs, ['dbo']), makeGraph(nodes, pairs), () => {}, {});
    expect(engine.init({ origin: 'origin', question: 'Trace A and C downstream', direction: 'downstream',
      analysisMode: 'ct', targetColumns: ['A', 'C'],
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
    })).toMatchObject({ ok: true });
    engine.getHopContext();
    expect(engine.submitFindings(finding('origin', ['A', 'C'].map(out_col => ({ out_col, upstream_columns: [] }))))).toMatchObject({ ok: true });
    engine.getHopContext();
    expect(engine.currentFocus).toBe('mid');
    expect(engine.columnAspect?.active_columns).toEqual(['A', 'C']);
    expect(engine.submitFindings(finding('mid', flow))).toMatchObject({ ok: true });
    engine.getHopContext();
    expect(engine.currentFocus).toBe('leaf');
    expect(engine.columnAspect?.active_columns).toEqual(expected);
  });

  it('rejects an unrelated output reached only by walking backward through a shared input', () => {
    const nodes = [node('origin', 'view', ['A']), node('other', 'view', ['B']), node('reader', 'view', ['Total', 'Unrelated'])];
    const model = makeModel(nodes, [['origin', 'reader'], ['other', 'reader']], ['dbo']);
    const tracer = new ColumnTracer(['A']);
    const flow = [
      { out_col: 'Total', upstream_columns: [{ node: 'origin', col: 'A' }, { node: 'other', col: 'B' }] },
      { out_col: 'Unrelated', upstream_columns: [{ node: 'other', col: 'B' }] },
    ];
    const validated = tracer.validateColumnFlow('reader', finding('reader', flow), new Map(nodes.map(n => [n.id, n])),
      model, null, undefined, undefined, 'downstream', [{ node: 'origin', col: 'A' }]);
    expect(validated.invalidRoutes).toEqual([expect.objectContaining({ path: 'column_flow.1.upstream_columns' })]);
    expect(validated.stagedEdges.map(edge => edge.to_col)).toEqual(['Total', 'Total']);
  });

  it('keeps downstream origin attribution without tracking its other source outputs', () => {
    const nodes = [node('base', 'view', ['B']), node('origin', 'view', ['A'])];
    const model = makeModel(nodes, [['base', 'origin']], ['dbo']);
    const tracer = new ColumnTracer(['A']);
    const validated = tracer.validateColumnFlow('origin', finding('origin', [
      { out_col: 'A', upstream_columns: [{ node: 'base', col: 'B' }] },
    ]), new Map(nodes.map(n => [n.id, n])), model, null, undefined, undefined, 'downstream', [{ node: 'origin', col: 'A' }]);
    expect(validated.invalidRoutes).toEqual([]);
    expect(validated.stagedEdges).toEqual([expect.objectContaining({ from_node: 'base', to_node: 'origin' })]);
  });

  it('rejects a missing writer destination without committing an edge or advancing work', () => {
    const { engine } = writerWorld();
    const before = engine.toJSON();
    expect(engine.submitFindings(finding('writer', [
      { out_col: 'X', writes_to: { node: 'carrier', col: 'Missing' }, upstream_columns: [] },
    ]))).toMatchObject({ code: 'out_col_not_on_node' });
    expect(engine.columnAspect?.edges).toEqual([]);
    expect(engine.toJSON().agenda).toEqual(before.agenda);
    expect(engine.currentFocus).toBe('writer');
  });
});

describe('column synthesis evidence', () => {
  it('keeps expression notes and transforms alongside their endpoints without rewriting sections', () => {
    const { engine } = writerWorld();
    expect(engine.submitFindings(finding('writer', [
      { out_col: 'X', writes_to: { node: 'carrier', col: 'Y' }, upstream_columns: [] },
    ]))).toMatchObject({ ok: true });
    engine.getHopContext();
    const submission = finding('reader', [{ out_col: 'Z', upstream_columns: [
      { node: 'carrier', col: 'Y', note: 'Y multiplied by two', transforms: ['compute'] },
    ] }]);
    expect(engine.submitFindings(submission)).toMatchObject({ ok: true });
    engine.getHopContext();
    const envelope = buildSmCompletionEnvelope(engine.getResult(), 'Trace X downstream', []);
    expect(envelope.result.detail_slots.find(slot => slot.nodeId === 'reader')?.sections).toEqual(submission.sections);
    expect(envelope.synthesis_reminder).toContain('carrier.Y → reader.Z');
    expect(envelope.synthesis_reminder).toContain('Y multiplied by two');
    expect(envelope.synthesis_reminder).toContain('compute');
  });
});

describe('column task instructions', () => {
  it('allows resolved downstream outputs outside the incoming column names', () => {
    const prompt = buildCurrentTaskBlock([{ kind: 'column_lineage', question: 'Trace carrier.Y into reader.Z' }], ['Y']);
    expect(prompt).toContain('Active columns: [Y]');
    expect(prompt).toContain('resolved outputs');
    expect(prompt).not.toContain('column_flow` may not name it');
  });
});

describe('shared BB and CT object retention', () => {
  it.each(['end_branch', 'prune_neighbors'] as const)('%s follows the same object decisions with recorded column evidence', action => {
    const results = (['bb', 'ct'] as const).map(mode => {
      const nodes = [node('origin', 'view', ['X']), node('source', action === 'end_branch' ? 'view' : 'table', ['X'])];
      const pairs: Array<[string, string]> = [['source', 'origin']];
      const engine = new NavigationEngine(makeModel(nodes, pairs, ['dbo']), makeGraph(nodes, pairs), () => {}, {});
      expect(engine.init({ origin: 'origin', question: 'Trace origin upstream', direction: 'upstream', analysisMode: mode,
        ...(mode === 'ct' ? { targetColumns: ['X'] } : {}),
        depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
      })).toMatchObject({ ok: true });
      engine.getHopContext();
      const submission = finding('origin', [{ out_col: 'X', upstream_columns: [{ node: 'source', col: 'X' }] }]);
      if (mode === 'bb') delete submission.column_flow;
      if (action === 'prune_neighbors') submission.prune_neighbors = [{ id: 'source', reason: 'Off the requested object path' }];
      expect(engine.submitFindings(submission)).toMatchObject({ ok: true });
      if (action === 'end_branch') {
        engine.getHopContext();
        expect(engine.currentFocus).toBe('source');
        expect(engine.submitFindings({ focus_node_id: 'source', verdict: 'end_branch', reason: 'Off the requested object path' })).toMatchObject({ ok: true });
      }
      expect(engine.getHopContext()).toMatchObject({ done: true });
      const result = engine.getResult();
      if (mode === 'ct') {
        expect(engine.columnAspect?.edges).toEqual([expect.objectContaining({ from_node: 'source', to_node: 'origin' })]);
        expect(result.columnAspect?.edges).toEqual([expect.objectContaining({ from_node: 'source', to_node: 'origin' })]);
      }
      return { nodes: result.fullNodes.map(n => n.id).sort(), edges: result.edges };
    });
    expect(results[0]).toEqual({ nodes: ['origin'], edges: [] });
    expect(results[1]).toEqual(results[0]);
  });
});
