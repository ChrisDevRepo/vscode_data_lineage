/** Function investigations preserve explicitly declared real caller outputs and exact caller SQL. */
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { HumanMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import { OpenAiCompatiblePort } from '../../harness/openAiCompatiblePort';
import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import { submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import type { ColumnDef } from '../../../src/engine/types';

const caller = '[ct].[caller]', fn = '[ct].[calc]', rates = '[ct].[rates]', orders = '[ct].[orders]';
const target = { node: caller, col: 'Gross' };
const column = (name: string): ColumnDef => ({ name, type: 'int', nullable: 'NULL', extra: '' });
const callerSql = `SELECT ${fn}(o.Amount,o.Region) AS Gross, ${fn}(o.OtherAmount,o.OtherRegion) AS Net FROM ${orders} o WHERE ${fn}(o.FilterAmount,o.FilterRegion)>0;`;
function start(tvf = false) {
  const nodes = [
    makeNode({ id: caller, schema: 'ct', name: 'caller', type: 'view', columns: [column('Gross'), column('Net')], bodyScript: tvf ? `SELECT t.Rate AS Gross FROM ${orders} o CROSS APPLY ${fn}(o.Region) t;` : callerSql }),
    makeNode({ id: fn, schema: 'ct', name: 'calc', type: 'function', ...(tvf ? { columns: [column('Rate')] } : {}), bodyScript: tvf ? `CREATE FUNCTION ${fn}(@Region int) RETURNS TABLE AS RETURN SELECT Rate FROM ${rates} WHERE Region=@Region;` : `CREATE FUNCTION ${fn}(@Amount int,@Region int) RETURNS int AS BEGIN RETURN @Amount*(SELECT Rate FROM ${rates} WHERE Region=@Region); END;` }),
    makeNode({ id: rates, schema: 'ct', name: 'rates', type: 'table', columns: [column('Rate'), column('Region')] }),
    makeNode({ id: orders, schema: 'ct', name: 'orders', type: 'table', columns: ['Amount','Region','OtherAmount','OtherRegion','FilterAmount','FilterRegion'].map(column) }),
  ];
  const edges: Array<[string,string]> = [[fn,caller],[orders,caller],[rates,fn]];
  const model = makeModel(nodes, edges, ['ct']);
  const graph = makeGraph(nodes, edges);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect(engine.init({ origin: caller, question: 'Trace Gross to original sources', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Gross'], depthIntent: { upstream: { levels: 'all', exactness: 'approximate' }, downstream: { levels: 0, exactness: 'exact' } } })).toHaveProperty('ok', true);
  engine.getHopContext();
  return { engine, model, graph };
}
function finding(tvf = false, declaration = target) {
  return { focus_node_id: caller, verdict: 'analyze' as const, sections: [{ angle: 'technical' as const, text: 'The supplied caller SQL defines the function argument expressions.' }], summary: 'Function caller', column_flow: [{ out_col: 'Gross', upstream_columns: tvf ? [{ node: fn, col: 'Rate' }] : [{ node: orders, col: 'Amount' }, { node: orders, col: 'Region' }] }], questions: [{ nodeId: fn, question: 'Establish the function contribution to the declared caller output.', caller_context: declaration }] };
}
describe('explicit function caller context', () => {
  it('routes the missing-metadata scalar task using the declared Gross output and full SQL, without inventing edges', () => {
    const { engine } = start();
    expect(engine.submitFindings(finding())).toHaveProperty('ok', true);
    expect(engine.columnAspect?.edges.some(edge => edge.from_node === rates)).toBe(false);
    const hop = engine.getHopContext();
    expect(hop).toMatchObject({ analysis_mode: 'ct', caller_output_targets: [target], caller_requested_outputs: [target], caller_objects: [{ node: caller, ddl: callerSql }] });
    expect(engine.submitFindings({ focus_node_id: fn, verdict: 'analyze', sections: [{ angle: 'technical', text: 'Rate contributes to Gross.' }], summary: 'Scalar body', column_flow: [{ out_col: 'Gross', returns_to: target, upstream_columns: [{ node: rates, col: 'Rate' }] }] })).toHaveProperty('ok', true);
    expect(engine.columnAspect?.edges).toContainEqual(expect.objectContaining({ from_node: rates, from_col: 'Rate', to_node: caller, to_col: 'Gross', hop_node: fn }));
    expect(engine.columnAspect?.edges.some(edge => edge.from_node === fn || edge.to_node === fn)).toBe(false);
    expect(engine.getHopContext()).toEqual({ done: true });
    const delivered = engine.getResult();
    expect(delivered.fullNodes.map(node => node.id).sort()).toEqual([caller, fn, rates, orders].sort());
    expect(delivered.edges.map(edge => edge.slice(0, 2))).toEqual(expect.arrayContaining([[rates, fn], [fn, caller], [orders, caller]]));
    expect(delivered.columnAspect?.edges).toContainEqual(expect.objectContaining({ from_node: rates, from_col: 'Rate', to_node: caller, to_col: 'Gross' }));
  });
  it('keeps a TVF real output while supplying its caller argument SQL', () => {
    const { engine, model } = start(true);
    expect(engine.submitFindings(finding(true))).toHaveProperty('ok', true);
    const hop = engine.getHopContext();
    expect(hop.caller_output_targets).toBeUndefined();
    expect(hop).toMatchObject({ analysis_mode: 'ct', caller_requested_outputs: [target], caller_objects: [{ node: caller, ddl: model.nodes[0].bodyScript }] });
    expect(engine.columnAspect?.active_columns).toEqual(['Rate']);
    expect(engine.submitFindings({ focus_node_id: fn, verdict: 'analyze', sections: [{ angle: 'technical', text: 'Rate is the real TVF output.' }], summary: 'TVF body', column_flow: [{ out_col: 'Rate', upstream_columns: [{ node: rates, col: 'Rate' }, { node: orders, col: 'Region' }] }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toEqual({ done: true });
    const delivered = engine.getResult();
    expect(delivered.fullNodes.map(node => node.id).sort()).toEqual([caller, fn, rates, orders].sort());
    expect(delivered.columnAspect?.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from_node: rates, from_col: 'Rate', to_node: fn, to_col: 'Rate' }), expect.objectContaining({ from_node: fn, from_col: 'Rate', to_node: caller, to_col: 'Gross' })]));
    expect(delivered.columnAspect?.edges.some(edge => edge.from_node === fn && edge.from_col !== 'Rate' || edge.to_node === fn && edge.to_col !== 'Rate')).toBe(false);
  });
  it.each([{ node: caller, col: 'Net' }, { node: orders, col: 'Amount' }, { node: fn, col: 'return_value' }])('rejects a destination outside the current real caller task atomically: %j', declaration => {
    const { engine } = start();
    const before = engine.toJSON();
    expect(engine.submitFindings(finding(false, declaration))).toMatchObject({ code: 'route_validation_failed' });
    expect(engine.columnAspect?.edges).toEqual(before.columnAspect?.edges);
    expect(engine.getCurrentTasks().every(task => task.status === 'active')).toBe(true);
  });
  it('retains declared caller provenance across queued restore and completed follow-up', () => {
    const { engine, model, graph } = start();
    expect(engine.submitFindings(finding())).toHaveProperty('ok', true);
    const restored = NavigationEngine.fromJSON(engine.toJSON(), model, graph, () => {}, {});
    expect(restored.getHopContext()).toMatchObject({ caller_output_targets: [target], caller_requested_outputs: [target], caller_objects: [{ node: caller, ddl: callerSql }] });
    expect(restored.submitFindings({ focus_node_id: fn, verdict: 'analyze', sections: [{ angle: 'technical', text: 'No upstream value for this SQL-grounded output.' }], summary: 'Function result', column_flow: [{ out_col: 'Gross', returns_to: target, upstream_columns: [] }] })).toHaveProperty('ok', true);
    expect(restored.getHopContext()).toEqual({ done: true });
    expect(restored.supplementAgenda([fn])).toHaveProperty('ok', true);
    const supplemented = NavigationEngine.fromJSON(restored.toJSON(), model, graph, () => {}, {});
    expect(supplemented.getHopContext()).toMatchObject({ caller_output_targets: [target], caller_requested_outputs: [target], caller_objects: [{ node: caller, ddl: callerSql }] });
  });
  it('restores a legitimately end-branched TVF with historical caller evidence', () => {
    const { engine, model, graph } = start(true);
    expect(engine.submitFindings(finding(true))).toHaveProperty('ok', true);
    expect(engine.getHopContext().focus_node?.id).toBe(fn);
    expect(engine.submitFindings({ focus_node_id: fn, verdict: 'end_branch', reason: 'SQL establishes no relevant contribution.' })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toEqual({ done: true });
    expect(() => NavigationEngine.fromJSON(engine.toJSON(), model, graph, () => {}, {})).not.toThrow();
  });
  it('preserves an explicitly authored predicate dependency without creating a value edge at declaration', () => {
    const { engine, model } = start();
    model.nodes[0]!.bodyScript = `SELECT o.Amount AS Gross FROM ${orders} o WHERE ${fn}(o.FilterAmount,o.FilterRegion)>0;`;
    const input = finding(); input.column_flow[0]!.upstream_columns = [{ node: orders, col: 'Amount' }];
    expect(engine.submitFindings(input)).toHaveProperty('ok', true);
    expect(engine.columnAspect?.edges.some(edge => edge.from_node === rates)).toBe(false);
    expect(engine.getHopContext().caller_objects).toEqual([{ node: caller, ddl: model.nodes[0]!.bodyScript }]);
    expect(engine.submitFindings({ focus_node_id: fn, verdict: 'analyze', sections: [{ angle: 'technical', text: 'Rate controls whether the caller row survives.' }], summary: 'Predicate contribution', column_flow: [{ out_col: 'Gross', returns_to: target, upstream_columns: [{ node: rates, col: 'Rate', transforms: ['filter'] }] }] })).toHaveProperty('ok', true);
    expect(engine.columnAspect?.edges).toContainEqual(expect.objectContaining({ from_node: rates, from_col: 'Rate', to_node: caller, to_col: 'Gross', transforms: ['filter'] }));
    expect(engine.getHopContext()).toEqual({ done: true });
    const delivered = engine.getResult();
    expect(delivered.fullNodes.map(node => node.id).sort()).toEqual([caller, fn, rates, orders].sort());
    expect(delivered.columnAspect?.edges).toContainEqual(expect.objectContaining({ from_node: rates, from_col: 'Rate', to_node: caller, to_col: 'Gross', transforms: ['filter'] }));
  });
  it.each(['callerTaskId', 'ddlHash'] as const)('rejects forged queued declaration provenance: %s', field => {
    const { engine, model, graph } = start(); engine.submitFindings(finding());
    const snapshot = engine.toJSON();
    const task = snapshot.engineInternals.investigationTasks.find(task => task.callerContext)!;
    task.callerContext = { ...task.callerContext!, [field]: field === 'ddlHash' ? '0'.repeat(64) : 'task_wrong_caller' };
    expect(() => NavigationEngine.fromJSON(snapshot, model, graph, () => {}, {})).toThrow('invalid or incompatible');
  });
  it.each(['SQL', 'edge'] as const)('rejects a changed caller %s snapshot before dispatch/restore', kind => {
    const { engine, model, graph } = start(); engine.submitFindings(finding()); const snapshot = engine.toJSON();
    if (kind === 'SQL') model.nodes[0]!.bodyScript = callerSql + ' -- changed';
    else model.edges = model.edges.map(edge => edge.source === fn && edge.target === caller ? { ...edge, source: caller, target: fn } : edge);
    expect(() => NavigationEngine.fromJSON(snapshot, model, graph, () => {}, {})).toThrow('invalid or incompatible');
    expect(() => engine.getHopContext()).toThrow('invalid or incompatible');
  });
  it('retains the structured declaration through the served caller schema and rejects invented fields', () => {
    const { engine } = start(); const input = { ...finding(), sections: { technical: 'Caller SQL supplies actual arguments.' } };
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns);
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ questions: [{ caller_context: target }] });
    expect(schema.safeParse({ ...input, questions: [{ ...input.questions[0], caller_context: { ...target, function_col: 'return_value' } }] }).success).toBe(false);
  });
  it('correlates caller-only contributors with each qualified scalar return destination', () => {
    const { model } = start(); const other = '[ct].[other_caller]';
    model.nodes.push(makeNode({ id: other, schema: 'ct', name: 'other_caller', type: 'view', columns: [column('Gross')], bodyScript: `SELECT ${fn}(1,1) AS Gross;` }));
    model.edges.push({ source: fn, target: other, type: 'body' });
    const tracer = new ColumnTracer(['Gross']); tracer.setActiveColumns(['Gross']);
    const targets = [target, { node: other, col: 'Gross' }];
    const result = tracer.validateColumnFlow(fn, { focus_node_id: fn, verdict: 'analyze', sections: [], summary: 'Two caller tasks', column_flow: [
      { out_col: 'Gross', returns_to: target, upstream_columns: [] },
      { out_col: 'Gross', returns_to: targets[1], upstream_columns: [{ node: orders, col: 'Amount' }] },
    ] }, new Map(model.nodes.map(node => [node.id, node])), model, null, undefined, new Set(), 'upstream', targets, targets, targets);
    expect(result.invalidRoutes).toContainEqual(expect.objectContaining({ path: 'column_flow.1.upstream_columns.0.node' }));
    expect(result.stagedEdges.some(edge => edge.from_node === orders && edge.to_node === other)).toBe(false);
  });

  it.each(['native', 'HTTP'] as const)('%s raw boundary preserves the caller declaration and input identity', async lane => {
    const { engine } = start();
    const raw = { ...finding(), sections: { technical: 'Exact caller arguments remain evidence.' } };
    const before = structuredClone(raw);
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns);
    const reply = { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'caller-1', type: 'function', function: { name: 'lineage_submit_findings', arguments: JSON.stringify(raw) } }] } }] };
    const sendRequest = vi.fn(async () => ({ stream: { async *[Symbol.asyncIterator]() { yield new vscode.LanguageModelToolCallPart('caller-1', 'lineage_submit_findings', raw); } } }));
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(reply) }));
    const port = lane === 'native' ? new VscodeModelPort({ id: 'synthetic', name: 'synthetic', vendor: 'test', family: 'test', version: '1', maxInputTokens: 128000, countTokens: async () => 1, sendRequest } as never)
      : new OpenAiCompatiblePort({ baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic', apiKey: 'synthetic-test-key', laneId: 'synthetic' }, { fetchImpl });
    const result = await port.generateToolTurn({ messages: [new HumanMessage('Investigate the declared function caller')], tools: [{ name: 'lineage_submit_findings', description: 'Submit observed findings', inputSchema: schema }], phase: 'active' });
    expect(result.toolCalls[0]).toMatchObject({ valid: true, input: { questions: [{ caller_context: target }] } });
    expect(raw).toEqual(before);
    expect(lane === 'native' ? sendRequest : fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([null, { ...target, invented: true }])('rejects malformed caller context before dispatch: %j', caller_context => {
    const { engine } = start(); const raw = { ...finding(), sections: { technical: 'Caller.' }, questions: [{ nodeId: fn, question: 'Investigate.', caller_context }] };
    expect(submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns).safeParse(raw).success).toBe(false);
  });

  it('rejects changed TVF caller SQL after dispatch without silently downgrading its context', () => {
    const { engine, model } = start(true); expect(engine.submitFindings(finding(true))).toHaveProperty('ok', true);
    engine.getHopContext(); model.nodes[0]!.bodyScript += ' -- changed caller'; const before = engine.toJSON();
    expect(engine.submitFindings({ focus_node_id: fn, verdict: 'analyze', summary: 'TVF result', sections: [{ angle: 'technical', text: 'Rate contributes.' }], column_flow: [{ out_col: 'Rate', upstream_columns: [{ node: rates, col: 'Rate' }] }] })).toMatchObject({ code: 'route_validation_failed' });
    expect(engine.columnAspect?.edges).toEqual(before.columnAspect?.edges);
    expect(engine.getCurrentTasks().every(task => task.status === 'active')).toBe(true);
  });

});
