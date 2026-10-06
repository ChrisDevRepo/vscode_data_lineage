/** A live-engine invariant failure settles as an engine error or a refused follow-up with an accurate reason; it never reads as an invalid saved state. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const caller = '[d].[caller]', fn = '[d].[fn]', source = '[d].[source]';
const sections = [{ angle: 'technical' as const, text: 'Evidence.' }];
const col = (name: string, deps: string[] = []) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '',
  ...(deps.length ? { expressionDependencies: deps.map(reference => ({ reference, sourceElementType: 'SqlScalarFunction' })) } : {}) });

function world(declared: boolean) {
  const nodes: LineageNode[] = [
    makeNode({ id: caller, schema: 'd', name: 'caller', type: 'view', columns: [col('Value', declared ? [fn] : [])], bodyScript: `CREATE VIEW ${caller} AS SELECT ${fn}(s.Amount) AS Value FROM ${source} s` }),
    makeNode({ id: fn, schema: 'd', name: 'fn', type: 'function', bodyScript: `CREATE FUNCTION ${fn}(@Amount int) RETURNS int AS BEGIN RETURN @Amount END` }),
    makeNode({ id: source, schema: 'd', name: 'source', type: 'table', columns: [col('Amount')] }),
  ];
  const edges: Array<[string, string]> = [[source, caller], [fn, caller]];
  const logs: string[] = [];
  const engine = new NavigationEngine(makeModel(nodes, edges, ['d']), makeGraph(nodes, edges), (level, message) => { logs.push(`${level} ${message}`); }, {});
  expect(engine.init({ origin: caller, question: 'Trace Value', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Value'],
    depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } })).toMatchObject({ ok: true });
  expect(engine.getHopContext()).toMatchObject({ focus_node: { id: caller } });
  return { engine, nodes, logs };
}

describe('live engine invariant failures', () => {
  it('a queued function whose caller SQL changed stops the run with an engine error instead of throwing', () => {
    const { engine, nodes, logs } = world(false);
    expect(engine.submitFindings({ focus_node_id: caller, verdict: 'analyze', summary: 'Value applies fn', sections, column_flow: [],
      questions: [{ nodeId: fn, question: 'Establish the returned value.', caller_context: { node: caller, col: 'Value' } }] })).toMatchObject({ ok: true });
    nodes[0].bodyScript = `${nodes[0].bodyScript} -- changed`;
    let context: ReturnType<NavigationEngine['getHopContext']> | undefined;
    expect(() => { context = engine.getHopContext(); }).not.toThrow();
    expect(context).toMatchObject({ sm_status: 'error' });
    expect(context?.done).not.toBe(true);
    expect(engine.status).toBe('error');
    expect(engine.errorReason).toMatch(/^Exploration stopped: a queued function investigation no longer matches/);
    expect(engine.errorReason).not.toContain('saved exploration state');
    expect(logs.filter(line => line.startsWith('error [Invariant]'))).toHaveLength(1);
  });

  it('a queued scalar return whose caller binding vanished stops the run with an engine error instead of throwing', () => {
    const { engine, nodes } = world(true);
    expect(engine.submitFindings({ focus_node_id: caller, verdict: 'analyze', summary: 'Value applies fn', sections,
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'Amount' }] }] })).toMatchObject({ ok: true });
    delete (nodes[0].columns![0] as { expressionDependencies?: unknown }).expressionDependencies;
    expect(() => engine.getHopContext()).not.toThrow();
    expect(engine.status).toBe('error');
    expect(engine.errorReason).toMatch(/^Exploration stopped: a queued scalar function return no longer matches/);
  });

  it('a follow-up whose recorded scalar binding vanished is refused with nothing changed', () => {
    const { engine, nodes } = world(true);
    expect(engine.submitFindings({ focus_node_id: caller, verdict: 'analyze', summary: 'Value applies fn', sections,
      column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'Amount' }] }] })).toMatchObject({ ok: true });
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: fn } });
    expect(engine.submitFindings({ focus_node_id: fn, verdict: 'analyze', summary: 'fn returns Amount', sections,
      column_flow: [{ out_col: 'Value', returns_to: { node: caller, col: 'Value' }, upstream_columns: [{ node: source, col: 'Amount' }] }] })).toMatchObject({ ok: true });
    expect(engine.getHopContext()).toMatchObject({ done: true });
    const before = JSON.stringify(engine.toJSON());
    delete (nodes[0].columns![0] as { expressionDependencies?: unknown }).expressionDependencies;
    let result: ReturnType<NavigationEngine['supplementAgenda']> | undefined;
    expect(() => { result = engine.supplementAgenda([fn]); }).not.toThrow();
    expect(result).toMatchObject({ code: 'route_validation_failed', hint: expect.stringContaining('no longer resolves') });
    expect(engine.status).toBe('complete');
    expect(JSON.stringify(engine.toJSON())).toBe(before);
  });
});
