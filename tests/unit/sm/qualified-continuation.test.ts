/** Every non-root column task continues from qualified (node, column) identities; nothing is recovered by column name. */
import { describe, expect, it } from 'vitest';
import { columnAttachment, columnEndpointKeyFactory } from '../../../src/ai/sm/columnTracer';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { HopSubmission, InvestigationTask } from '../../../src/ai/sm/smTypes';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const column = (name: string) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' });
const view = (id: string, cols: string[]) => makeNode({ id, name: id, schema: 'dbo', type: 'view', columns: cols.map(column), bodyScript: `SELECT 1 AS x -- ${id}` });
const table = (id: string, cols: string[]) => makeNode({ id, name: id, schema: 'dbo', type: 'table', columns: cols.map(column) });
const proc = (id: string) => makeNode({ id, name: id, schema: 'dbo', type: 'procedure', columns: [], bodyScript: `-- ${id}` });
const all = { levels: 'all' as const, exactness: 'exact' as const };
const closed = { levels: 0 as const, exactness: 'exact' as const };

function engineFor(nodes: ReturnType<typeof view>[], pairs: Array<[string, string]>, logs: string[] = []): NavigationEngine {
  return new NavigationEngine(makeModel(nodes, pairs, ['dbo']), makeGraph(nodes, pairs), (_level, message) => { logs.push(message); }, {});
}
const sections = [{ angle: 'technical' as const, text: 'Evidence.' }];
function hop(engine: NavigationEngine, focus: string, extra: Partial<HopSubmission> = {}) {
  expect(engine.getHopContext()).toMatchObject({ focus_node: { id: focus } });
  const result = engine.submitFindings({ focus_node_id: focus, verdict: 'analyze', summary: `Reviewed ${focus}`, sections,
    ...(engine.currentHopAnalysisMode === 'ct' ? { column_flow: [] } : {}), ...extra } as HopSubmission);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
}
const columnTasks = (engine: NavigationEngine): Array<Extract<InvestigationTask, { kind: 'column_lineage' }>> =>
  engine.getCurrentTasks().filter((task): task is Extract<InvestigationTask, { kind: 'column_lineage' }> => task.kind === 'column_lineage');

describe('qualified CT continuation', () => {
  it('a depth-deferred contributor keeps its qualified source; a same-named sibling stays BB', () => {
    const e = engineFor([view('v', ['Amount']), view('a', ['Amount']), view('s1', ['Amount']), view('s2', ['Amount'])],
      [['a', 'v'], ['s1', 'a'], ['s2', 'a']]);
    expect(e.init({ origin: 'v', question: 'Trace Amount', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Amount'],
      depthIntent: { upstream: { levels: 1, exactness: 'exact' }, downstream: closed } })).toMatchObject({ ok: true });
    hop(e, 'v', { column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: 'a', col: 'Amount' }] }] });
    hop(e, 'a', { column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: 's1', col: 'Amount' }] }] });
    expect(e.getHopContext()).toMatchObject({ done: true });
    const leads = e.pendingLeads;
    const s1Lead = leads.find(lead => lead.nodeId === 's1')!;
    const s2Lead = leads.find(lead => lead.nodeId === 's2')!;
    expect(e.investigationTasks.find(task => task.id === s1Lead.taskId)).toMatchObject({ kind: 'column_lineage', sourceRefs: [{ node: 's1', col: 'Amount' }] });
    expect(e.investigationTasks.find(task => task.id === s2Lead.taskId)).toMatchObject({ kind: 'analytical' });

    expect(e.supplementAgenda([], [s2Lead.id])).toMatchObject({ ok: true, agendaed: 1 });
    expect(e.getHopContext()).toMatchObject({ focus_node: { id: 's2' }, analysis_mode: 'bb' });
    expect(columnTasks(e)).toEqual([]);
  });

  it('a lead-backed follow-up continues CT from the deferred source endpoint', () => {
    const e = engineFor([view('v', ['Amount']), view('a', ['Amount']), view('s1', ['Total']), table('src', ['Raw'])],
      [['a', 'v'], ['s1', 'a'], ['src', 's1']]);
    expect(e.init({ origin: 'v', question: 'Trace Amount', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Amount'],
      depthIntent: { upstream: { levels: 1, exactness: 'exact' }, downstream: closed } })).toMatchObject({ ok: true });
    hop(e, 'v', { column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: 'a', col: 'Amount' }] }] });
    hop(e, 'a', { column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: 's1', col: 'Total' }] }] });
    expect(e.getHopContext()).toMatchObject({ done: true });
    const lead = e.pendingLeads.find(item => item.nodeId === 's1')!;
    expect(e.supplementAgenda([], [lead.id])).toMatchObject({ ok: true, agendaed: 1 });
    expect(e.getHopContext()).toMatchObject({ focus_node: { id: 's1' }, analysis_mode: 'ct' });
    expect(columnTasks(e)).toEqual([expect.objectContaining({ activeColumns: ['Total'], sourceRefs: [{ node: 's1', col: 'Total' }] })]);
    expect(e.submitFindings({ focus_node_id: 's1', verdict: 'analyze', summary: 'Total from Raw', sections,
      column_flow: [{ out_col: 'Total', upstream_columns: [{ node: 'src', col: 'Raw' }] }] })).toMatchObject({ ok: true });
    expect(e.columnAspect?.edges).toContainEqual(expect.objectContaining({ from_node: 'src', from_col: 'Raw', to_node: 's1', to_col: 'Total' }));
  });

  it('a plain follow-up on an object with no committed column endpoint is BB, not a guessed CT by column name', () => {
    const e = engineFor([view('v', ['Amount']), view('a', ['Amount']), view('c', ['Amount'])], [['a', 'v'], ['v', 'c']]);
    expect(e.init({ origin: 'v', question: 'Trace Amount', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Amount'],
      depthIntent: { upstream: all, downstream: closed } })).toMatchObject({ ok: true });
    hop(e, 'v', { column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: 'a', col: 'Amount' }] }] });
    hop(e, 'a', { column_flow: [{ out_col: 'Amount', upstream_columns: [] }] });
    expect(e.getHopContext()).toMatchObject({ done: true });
    expect(e.supplementAgenda(['c'])).toMatchObject({ ok: true, agendaed: 1 });
    expect(e.getHopContext()).toMatchObject({ focus_node: { id: 'c' }, analysis_mode: 'bb' });
    expect(columnTasks(e)).toEqual([]);
  });

  it('a plain follow-up on a committed contributor continues from that qualified endpoint', () => {
    const e = engineFor([view('v', ['Amount']), view('a', ['Net']), table('src', ['Raw'])], [['a', 'v'], ['src', 'a']]);
    expect(e.init({ origin: 'v', question: 'Trace Amount', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Amount'],
      depthIntent: { upstream: all, downstream: closed } })).toMatchObject({ ok: true });
    hop(e, 'v', { column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: 'a', col: 'Net' }] }], prune_neighbors: [{ id: 'a', reason: 'Answered at the origin.' }] });
    expect(e.getHopContext()).toMatchObject({ done: true });
    expect(e.supplementAgenda(['a'])).toMatchObject({ ok: true, agendaed: 1 });
    expect(e.getHopContext()).toMatchObject({ focus_node: { id: 'a' }, analysis_mode: 'ct' });
    expect(columnTasks(e)).toEqual([expect.objectContaining({ activeColumns: ['Net'], sourceRefs: [{ node: 'a', col: 'Net' }] })]);
  });

  it('a column continuation reaching a user pass node stays a source-qualified question, not a CT hop whose links cannot attach', () => {
    const e = engineFor([view('v', ['Amount']), view('p', ['Amount']), table('t', ['Amount']), proc('w'), table('src', ['Raw'])],
      [['t', 'p'], ['p', 'v'], ['w', 't'], ['src', 'w']]);
    expect(e.init({ origin: 'v', question: 'Trace Amount', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Amount'], passNodeIds: ['p'],
      depthIntent: { upstream: all, downstream: closed } })).toMatchObject({ ok: true });
    hop(e, 'v', { column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: 'p', col: 'Amount' }] }] });
    expect(e.getHopContext()).toMatchObject({ focus_node: { id: 'w' }, analysis_mode: 'bb' });
    expect(columnTasks(e)).toEqual([]);
    expect(e.getCurrentTasks()).toEqual([expect.objectContaining({ question: expect.stringContaining('`p.Amount` continues through `p`') })]);
    expect(e.submitFindings({ focus_node_id: 'w', verdict: 'analyze', summary: 'Loads t', sections })).toMatchObject({ ok: true });
    expect(e.columnAspect?.edges).toEqual([expect.objectContaining({ from_node: 'p', to_node: 'v' })]);
  });

  it('keeps each side of a bidirectional trace on its own qualified leg and every committed edge chains back to the origin', () => {
    const e = engineFor([view('o', ['Amount']), view('a', ['Amount']), table('raw', ['Amount']), view('c', ['Total']), view('d', ['Total'])],
      [['raw', 'a'], ['a', 'o'], ['o', 'c'], ['c', 'd']]);
    expect(e.init({ origin: 'o', question: 'Trace Amount both ways', direction: 'bidirectional', analysisMode: 'ct', targetColumns: ['Amount'],
      depthIntent: { upstream: all, downstream: all } })).toMatchObject({ ok: true });
    hop(e, 'o', { column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: 'a', col: 'Amount' }] }] });
    const queued = e.investigationTasks.filter(task => task.kind === 'column_lineage' && task.status === 'pending');
    expect(queued).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'a', traversalSide: 'upstream', sourceRefs: [{ node: 'a', col: 'Amount' }] }),
      expect.objectContaining({ nodeId: 'c', traversalSide: 'downstream', sourceRefs: [{ node: 'o', col: 'Amount' }] }),
    ]));
    for (let guard = 0; guard < 6; guard++) {
      const context = e.getHopContext() as { done?: boolean; focus_node?: { id: string } };
      if (context.done) break;
      const focus = context.focus_node!.id;
      const flow = focus === 'a' ? [{ out_col: 'Amount', upstream_columns: [{ node: 'raw', col: 'Amount' }] }]
        : focus === 'c' ? [{ out_col: 'Total', upstream_columns: [{ node: 'o', col: 'Amount' }] }]
          : focus === 'd' ? [{ out_col: 'Total', upstream_columns: [{ node: 'c', col: 'Total' }] }] : [];
      if (focus === 'd') expect(columnTasks(e)).toEqual([expect.objectContaining({ traversalSide: 'downstream', sourceRefs: [{ node: 'c', col: 'Total' }] })]);
      expect(e.submitFindings({ focus_node_id: focus, verdict: 'analyze', summary: `Reviewed ${focus}`, sections, column_flow: flow }), focus).toMatchObject({ ok: true });
    }
    const edges = e.columnAspect!.edges;
    expect(edges.map(edge => `${edge.from_node}.${edge.from_col}>${edge.to_node}.${edge.to_col}`).sort())
      .toEqual(['a.Amount>o.Amount', 'c.Total>d.Total', 'o.Amount>c.Total', 'raw.Amount>a.Amount']);
    const closure = columnAttachment([{ node: 'o', col: 'Amount' }], edges, 'both', columnEndpointKeyFactory(new Map()));
    expect(edges.filter(edge => !closure.attaches(edge))).toEqual([]);
    expect(e.getResult().columnAspect?.edges).toHaveLength(edges.length);
  });

  it('refuses a link that does not chain back to the origin and commits nothing', () => {
    const e = engineFor([view('v', ['Amount', 'Other']), view('a', ['Amount', 'Other']), table('src', ['Raw'])], [['a', 'v'], ['src', 'a']]);
    expect(e.init({ origin: 'v', question: 'Trace Amount', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Amount'],
      depthIntent: { upstream: all, downstream: closed } })).toMatchObject({ ok: true });
    hop(e, 'v', { column_flow: [{ out_col: 'Amount', upstream_columns: [{ node: 'a', col: 'Amount' }] }] });
    expect(e.getHopContext()).toMatchObject({ focus_node: { id: 'a' } });
    const before = JSON.stringify(e.columnAspect?.edges);
    expect(e.submitFindings({ focus_node_id: 'a', verdict: 'analyze', summary: 'Other from Raw', sections,
      column_flow: [{ out_col: 'Amount', writes_to: { node: 'a', col: 'Other' }, upstream_columns: [{ node: 'src', col: 'Raw' }] }] }))
      .toMatchObject({ code: 'out_col_not_tracked' });
    expect(JSON.stringify(e.columnAspect?.edges)).toBe(before);
  });

  it('a column task without a qualified source stops the dispatch with an engine error, never a BB visit', () => {
    const logs: string[] = [];
    const e = engineFor([view('v', ['Amount']), view('a', ['Amount'])], [['a', 'v']], logs);
    expect(e.init({ origin: 'v', question: 'Trace Amount', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Amount'],
      depthIntent: { upstream: all, downstream: closed } })).toMatchObject({ ok: true });
    hop(e, 'v', { column_flow: [{ out_col: 'Amount', upstream_columns: [] }] });
    (e as unknown as { enqueueHop(id: string, q: string, d: number, p: number, o: object): void })
      .enqueueHop('a', 'Injected', 1, 2, { carry: { kind: 'carry', columns: ['Amount'] } });
    const tasksBefore = e.investigationTasks.length;
    const context = e.getHopContext();
    expect(context).toMatchObject({ sm_status: 'error' });
    expect(context.done).not.toBe(true);
    expect(e.status).toBe('error');
    expect(e.errorReason).toMatch(/^Exploration stopped: a queued column investigation has no qualified source column/);
    expect(e.investigationTasks).toHaveLength(tasksBefore);
    expect(logs.filter(line => line.startsWith('[Invariant] dispatch refused field=sourceRefs'))).toHaveLength(1);
    expect(() => e.toJSON()).not.toThrow();
  });
});
