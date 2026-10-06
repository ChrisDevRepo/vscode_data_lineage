/** A queued scalar-return function and a later column arrival at it merge demands on its one visit; neither is refused or dropped. */
import { describe, expect, it } from 'vitest';
import { AgendaManager } from '../../../src/ai/sm/agendaManager';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { HopSubmission, InvestigationTask } from '../../../src/ai/sm/smTypes';
import type { LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const v = '[d].[v]', f = '[d].[f]', b = '[d].[b]', w = '[d].[a]', t = '[d].[t]';
const col = (name: string, deps: string[] = []) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '',
  ...(deps.length ? { expressionDependencies: deps.map(reference => ({ reference, sourceElementType: 'SqlScalarFunction' })) } : {}) });
const sections = [{ angle: 'technical' as const, text: 'Evidence.' }];
const caller = makeNode({ id: v, schema: 'd', name: 'v', type: 'view', columns: [col('X', [f])], bodyScript: `CREATE VIEW ${v} AS SELECT ${f}() AS X` });
const fn = (reads: string) => makeNode({ id: f, schema: 'd', name: 'f', type: 'function', bodyScript: `CREATE FUNCTION ${f}() RETURNS int AS BEGIN RETURN (SELECT MAX(X) FROM ${reads}) END` });
type Column = Extract<InvestigationTask, { kind: 'column_lineage' }>;

/** Approves a bidirectional X trace at `v`, whose X is computed by the scalar function `f`, and commits the origin hop. */
function start(nodes: LineageNode[], edges: Array<[string, string]>, logs: string[]) {
  const engine = new NavigationEngine(makeModel(nodes, edges, ['d']), makeGraph(nodes, edges), (_level, message) => { logs.push(message); }, {});
  expect(engine.init({ origin: v, question: 'Trace X', direction: 'bidirectional', analysisMode: 'ct', targetColumns: ['X'],
    depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } } })).toMatchObject({ ok: true });
  expect(engine.getHopContext()).toMatchObject({ focus_node: { id: v } });
  expect(engine.submitFindings({ focus_node_id: v, verdict: 'analyze', summary: 'X is computed by f', sections,
    column_flow: [{ out_col: 'X', upstream_columns: [] }] })).toMatchObject({ ok: true });
  expect(engine.toJSON().agenda.find(entry => entry.nodeId === f)?.columnCarry).toMatchObject({ kind: 'scalar_return', outputs: [{ node: v, col: 'X' }] });
  return engine;
}
const tasksAt = (engine: NavigationEngine, nodeId: string): Column[] =>
  engine.toJSON().agenda.find(entry => entry.nodeId === nodeId)!.taskIds
    .map(id => engine.investigationTasks.find(task => task.id === id) as Column);
function submit(engine: NavigationEngine, finding: Partial<HopSubmission> & { focus_node_id: string }) {
  const result = engine.submitFindings({ verdict: 'analyze', summary: `Reviewed ${finding.focus_node_id}`, sections, ...finding } as HopSubmission);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
}

describe('scalar-return and later column arrival at one function', () => {
  it('accepts a downstream continuation whose consumer is a function already queued for a scalar return', () => {
    const logs: string[] = [];
    const reader = makeNode({ id: b, schema: 'd', name: 'b', type: 'view', columns: [col('X')], bodyScript: `CREATE VIEW ${b} AS SELECT X FROM ${v}` });
    const engine = start([caller, reader, fn(b)], [[f, v], [v, b], [b, f]], logs);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: b } });
    submit(engine, { focus_node_id: b, verdict: 'passthrough', column_flow: [{ out_col: 'X', upstream_columns: [{ node: v, col: 'X' }] }] });
    expect(tasksAt(engine, f)).toEqual(expect.arrayContaining([
      expect.objectContaining({ returnTargets: [{ node: v, col: 'X' }] }),
      expect.objectContaining({ traversalSide: 'downstream', sourceRefs: [{ node: b, col: 'X' }] }),
    ]));
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: f }, caller_output_targets: [{ node: v, col: 'X' }] });
    submit(engine, { focus_node_id: f, column_flow: [{ out_col: 'X', returns_to: { node: v, col: 'X' }, upstream_columns: [{ node: b, col: 'X', transforms: ['aggregate'] }] }] });
    expect(engine.columnAspect?.edges).toContainEqual(expect.objectContaining({ hop_node: f, from_node: b, from_col: 'X', to_node: v, to_col: 'X' }));
  });

  it('keeps an ordinary carry contracted through a table as its own task beside the scalar return, and says so', () => {
    const logs: string[] = [];
    const writer = makeNode({ id: w, schema: 'd', name: 'a', type: 'procedure', columns: [], bodyScript: `INSERT ${t}(X) SELECT X FROM ${v}` });
    const stored = makeNode({ id: t, schema: 'd', name: 't', type: 'table', columns: [col('X')] });
    const engine = start([caller, writer, stored, fn(t)], [[f, v], [v, w], [w, t], [t, f]], logs);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: w } });
    submit(engine, { focus_node_id: w, column_flow: [{ out_col: 'X', writes_to: { node: t, col: 'X' }, upstream_columns: [{ node: v, col: 'X' }] }] });
    const entry = engine.toJSON().agenda.find(item => item.nodeId === f)!;
    expect(entry.columnCarry).toMatchObject({ kind: 'scalar_return', outputs: [{ node: v, col: 'X' }] });
    expect(tasksAt(engine, f)).toEqual(expect.arrayContaining([
      expect.objectContaining({ returnTargets: [{ node: v, col: 'X' }] }),
      expect.objectContaining({ activeColumns: ['X'], traversalSide: 'downstream', sourceRefs: [{ node: t, col: 'X' }] }),
    ]));
    expect(logs.filter(line => line.startsWith('[Agenda] ordinary carry kept as a separate task') && line.includes(f))).toHaveLength(1);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: f }, caller_output_targets: [{ node: v, col: 'X' }] });
    submit(engine, { focus_node_id: f, column_flow: [{ out_col: 'X', returns_to: { node: v, col: 'X' }, upstream_columns: [{ node: t, col: 'X', transforms: ['aggregate'] }] }] });
    expect(() => engine.toJSON()).not.toThrow();
  });
});

describe('AgendaManager carry merge', () => {
  it.each([
    ['scalar first', 0],
    ['ordinary first', 1],
  ] as const)('reports ordinary columns kept beside a scalar-return carry (%s)', (_label, order) => {
    const reported: string[] = [];
    const agenda = new AgendaManager(false, (nodeId, columns) => reported.push(`${nodeId}:${columns.join(',')}`));
    const scalar = { taskIds: ['t1'], nodeId: f, priority: 2, depth: 1, activeColumns: ['X'], columnCarry: { kind: 'scalar_return' as const, outputs: [{ node: v, col: 'X' }] } };
    const ordinary = { taskIds: ['t2'], nodeId: f, priority: 2, depth: 1, activeColumns: ['Y'], columnCarry: { kind: 'carry' as const, columns: ['Y'] } };
    for (const entry of order === 0 ? [scalar, ordinary] : [ordinary, scalar]) agenda.push(entry);
    expect(agenda.get(f)).toMatchObject({ columnCarry: { kind: 'scalar_return' }, activeColumns: ['X'] });
    expect(agenda.get(f)?.taskIds.sort()).toEqual(['t1', 't2']);
    expect(reported).toEqual([`${f}:Y`]);
  });
});
