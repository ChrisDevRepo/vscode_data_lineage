/** Declared scalar calls route qualified caller outputs without inventing function columns or table writes. */
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { HumanMessage } from '@langchain/core/messages';
import { OpenAiCompatiblePort } from '../../harness/openAiCompatiblePort';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import { AiSession } from '../../../src/ai/session/session';
import { executeSubmitFindings } from '../../../src/ai/tools/handlers/submitFindings';
import { stubToolServices } from './helpers/toolServices';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import { TaskLedger } from '../../../src/ai/sm/taskLedger';
import { parseNavigationSnapshot } from '../../../src/ai/sm/navigationSnapshotSchema';
import { submitFindingsSchemaForMode, parseToolInput } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { droppedScalarReturnFieldError } from '../../../src/ai/support/inputNormalization';
import { resolveScalarReturnTarget } from '../../../src/ai/sm/scalarReturnBinding';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import type { ColumnDef, ColumnExpressionDependency, LineageNode } from '../../../src/engine/types';

const caller = '[ct].[caller]', fn = '[ct].[calc]', tax = '[ct].[rates]', orders = '[ct].[orders]';
const target = { node: caller, col: 'Gross' };
const column = (name: string, expressionDependencies?: ColumnExpressionDependency[]): ColumnDef => ({ name, type: 'int', nullable: 'NULL', extra: '', ...(expressionDependencies ? { expressionDependencies } : {}) });
function world(declaration: ColumnExpressionDependency[] | undefined = [{ reference: fn, sourceElementType: 'SqlScalarFunction' }]) {
  const nodes: LineageNode[] = [
    makeNode({ id: caller, schema: 'ct', name: 'caller', type: 'view', columns: [column('Gross', declaration), column('Other')], bodyScript: `SELECT ${fn}(o.Amount,o.Region) AS Gross FROM ${orders} o;` }),
    makeNode({ id: fn, schema: 'ct', name: 'calc', type: 'function', bodyScript: `CREATE FUNCTION ${fn}(@Amount int,@Region int) RETURNS int AS BEGIN RETURN @Amount*(SELECT Rate FROM ${tax} WHERE Region=@Region); END` }),
    makeNode({ id: tax, schema: 'ct', name: 'rates', type: 'table', columns: [column('Rate'), column('Region')] }),
    makeNode({ id: orders, schema: 'ct', name: 'orders', type: 'table', columns: [column('Amount'), column('Region')] }),
  ];
  const edges: Array<[string, string]> = [[fn, caller], [orders, caller], [tax, fn]];
  return { model: makeModel(nodes, edges, ['ct']), graph: makeGraph(nodes, edges) };
}
function start(declaration?: ColumnExpressionDependency[]) {
  const { model, graph } = world(declaration);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect(engine.init({ origin: caller, question: 'Trace Gross', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Gross'], depthIntent: { upstream: { levels: 'all', exactness: 'approximate' }, downstream: { levels: 0, exactness: 'exact' } } })).toHaveProperty('ok', true);
  engine.getHopContext();
  expect(engine.submitFindings({ focus_node_id: caller, verdict: 'analyze', sections: [{ angle: 'technical', text: 'Caller supplies Amount and Region to the function.' }], summary: 'Declared scalar projection', column_flow: [{ out_col: 'Gross', upstream_columns: [{ node: orders, col: 'Amount' }, { node: orders, col: 'Region' }] }] })).toHaveProperty('ok', true);
  return { engine, model, graph };
}
function flow(returns_to: {node:string;col:string} | undefined = target) {
  return { focus_node_id: fn, verdict: 'analyze' as const, sections: [{ angle: 'technical' as const, text: 'Rate contributes to the caller Gross.' }], summary: 'Scalar return', column_flow: [{ out_col: 'Gross', ...(returns_to ? { returns_to } : {}), upstream_columns: [{ node: tax, col: 'Rate' }] }] };
}

describe('declared scalar return routing', () => {
  it('keeps the function a CT hop and attributes its authored source directly to the real caller', () => {
    const { engine, model } = start();
    const hop = engine.getHopContext();
    expect(hop.focus_node?.id).toBe(fn);
    expect(hop.analysis_mode).toBe('ct');
    expect(hop.caller_output_targets).toEqual([target]);
    expect(hop.caller_objects).toEqual([{ node: caller, ddl: model.nodes[0].bodyScript }]);
    expect(model.nodes.find(node => node.id === fn)?.columns).toBeUndefined();
    expect(engine.submitFindings(flow())).toHaveProperty('ok', true);
    expect(engine.columnAspect?.edges).toContainEqual(expect.objectContaining({ hop_node: fn, from_node: tax, from_col: 'Rate', to_node: caller, to_col: 'Gross' }));
    expect(engine.columnAspect?.edges.some(edge => edge.from_node === fn || edge.to_node === fn)).toBe(false);
  });
  it.each([[[]], [[{ reference: fn }]], [[{ reference: fn, sourceElementType: 'SqlTableValuedFunction' }]], [[{ reference: fn, sourceElementType: 'SqlScalarFunction', externalSource: 'remote' }]], [[{ reference: '[ct].[other]', sourceElementType: 'SqlScalarFunction' }]]])('does not authorize scalar carry from undeclared/nonlocal/non-scalar metadata %j', declaration => {
    const { engine } = start(declaration);
    const hop = engine.getHopContext();
    expect(hop.analysis_mode).toBe('bb');
    expect(hop.caller_output_targets).toBeUndefined();
  });
  it.each(['omitted', 'empty', 'end_branch'])('rejects %s flow without settling an owed scalar output', kind => {
    const { engine } = start(); engine.getHopContext(); const before = engine.toJSON();
    const input = kind === 'end_branch' ? { focus_node_id: fn, verdict: 'end_branch' as const, reason: 'No contribution' } : { ...flow(), ...(kind === 'empty' ? { column_flow: [] } : { column_flow: undefined }) };
    expect(engine.submitFindings(input)).toMatchObject({ code: 'route_validation_failed' });
    expect(engine.columnAspect!.edges).toEqual(before.columnAspect!.edges);
    expect(engine.getCurrentTasks().every(task => task.status === 'active')).toBe(true);
    expect(engine.submitFindings({ ...flow(), column_flow: [{ out_col: 'Gross', returns_to: target, upstream_columns: [] }] })).toHaveProperty('ok', true);
  });
  it.each(['return_value', '@Amount'])('rejects a fabricated function contributor %s on the caller hop', col => {
    const { model, graph } = world(); const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: caller, question: 'Trace Gross', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Gross'], depthIntent: { upstream: { levels: 'all', exactness: 'approximate' }, downstream: { levels: 0, exactness: 'exact' } } });
    engine.getHopContext();
    expect(engine.submitFindings({ ...flow(), focus_node_id: caller, column_flow: [{ out_col: 'Gross', upstream_columns: [{ node: fn, col }] }] })).toMatchObject({ code: 'contributor_col_not_on_source' });
    expect(engine.columnAspect!.edges).toEqual([]);
  });
  it('rejects a four-part compiler reference colliding with a loaded two-part function identity', () => {
    const { model } = world([{ reference: '[server].[database].[ct].[calc]', sourceElementType: 'SqlScalarFunction' }]);
    const map = new Map(model.nodes.map(node => [node.id, node]));
    expect(resolveScalarReturnTarget(fn, target, map)).toBeNull();
    expect(resolveScalarReturnTarget(fn, { node: '[server].[database].[ct].[caller]', col: 'Gross' }, map)).toBeNull();
  });
  it('does not collapse embedded dots or endpoint delimiters into another declared identity', () => {
    const { model } = world([{ reference: '[a.b].[f]', sourceElementType: 'SqlScalarFunction' }]);
    model.nodes[1] = { ...model.nodes[1]!, id: '[a].[b.f]', fullName: '[a].[b.f]' };
    expect(resolveScalarReturnTarget('[a].[b.f]', target, new Map(model.nodes.map(node => [node.id, node])))).toBeNull();
    const ledger = new TaskLedger();
    const base = { kind: 'column_lineage' as const, source: 'engine' as const, question: 'same', nodeId: fn, activeColumns: ['Gross'] as [string], createdHop: 1 };
    expect(ledger.ensureTask({ ...base, returnTargets: [{ node: 'a|b', col: 'c' }] }).id).not.toBe(ledger.ensureTask({ ...base, returnTargets: [{ node: 'a', col: 'b|c' }] }).id);
  });
  it.each(['FN', 'FS'])('accepts an authoritative local SQL catalog scalar type %s', sourceElementType => {
    const { engine } = start([{ reference: fn, sourceElementType }]);
    expect(engine.getHopContext().caller_output_targets).toEqual([target]);
  });
  it('requires an exact return destination and preserves all state for a corrected retry', () => {
    const { engine } = start(); engine.getHopContext();
    const before = [...engine.columnAspect!.edges];
    const invalid = flow(); delete invalid.column_flow[0]!.returns_to;
    expect(engine.submitFindings(invalid)).toMatchObject({ code: 'route_validation_failed' });
    expect(engine.columnAspect!.edges).toEqual(before);
    expect(engine.submitFindings(flow())).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges.filter(edge => edge.hop_node === fn)).toHaveLength(1);
  });
  it.each([{ node: fn, col: 'Gross' }, { node: caller, col: 'Other' }, { node: orders, col: 'Amount' }, { node: caller, col: 'return_value' }, { node: fn, col: 'return_value' }, { node: fn, col: '@Amount' }])('rejects invented/unbound return destinations %j atomically', invalid => {
    const { engine } = start(); engine.getHopContext(); const before = [...engine.columnAspect!.edges];
    expect(engine.submitFindings(flow(invalid))).toMatchObject({ code: 'route_validation_failed' });
    expect(engine.columnAspect!.edges).toEqual(before);
  });
  it('preserves returns_to from the native raw boundary through normalization and the real handler', async () => {
    const { engine, model, graph } = start(); engine.getHopContext();
    const raw = { focus_node_id: fn, verdict: 'analyze', sections: { technical: 'Rate contributes to the declared caller output.' }, summary: 'Scalar return', column_flow: flow().column_flow };
    const before = structuredClone(raw);
    const sendRequest = vi.fn(async () => ({ stream: { async *[Symbol.asyncIterator]() { yield new vscode.LanguageModelToolCallPart('return-1', 'lineage_submit_findings', raw); } } }));
    const port = new VscodeModelPort({ id: 'synthetic', name: 'synthetic', vendor: 'test', family: 'test', version: '1', maxInputTokens: 128000, countTokens: async () => 1, sendRequest } as never);
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns);
    const result = await port.generateToolTurn({ messages: [new HumanMessage('Resolve declared caller outputs')], tools: [{ name: 'lineage_submit_findings', description: 'Submit observed findings', inputSchema: schema }], phase: 'active' });
    const call = result.toolCalls[0]!; expect(call.valid).toBe(true); expect(raw).toEqual(before); expect(sendRequest).toHaveBeenCalledTimes(1);
    if (!call.valid) throw new Error('Valid scalar call rejected');
    expect(call.input).toMatchObject({ column_flow: [{ returns_to: target }] });
    const session = new AiSession(); session.model = model; session.stateMachine = engine; session.classification = 'technical'; session.beginTurn();
    const { services } = stubToolServices({ session, model, graph, turnEpoch: () => 1 });
    const outcome = JSON.parse(executeSubmitFindings(call.input, services));
    expect(outcome.ok).toBe(true);
    expect(engine.columnAspect!.edges).toContainEqual(expect.objectContaining({ hop_node: fn, from_node: tax, from_col: 'Rate', to_node: caller, to_col: 'Gross' }));
  });
  it('rejects an ordinary raw return field before dispatch without changing legacy stripping', async () => {
    const raw = { focus_node_id: caller, verdict: 'passthrough', sections: {}, summary: 'Ordinary hop', column_flow: [{ out_col: 'Gross', returns_to: target, upstream_columns: [], legacyUnknown: true }] };
    const before = structuredClone(raw);
    const sendRequest = vi.fn(async () => ({ stream: { async *[Symbol.asyncIterator]() { yield new vscode.LanguageModelToolCallPart('ordinary-1', 'lineage_submit_findings', raw); } } }));
    const port = new VscodeModelPort({ id: 'synthetic', name: 'synthetic', vendor: 'test', family: 'test', version: '1', maxInputTokens: 128000, countTokens: async () => 1, sendRequest } as never);
    const schema = submitFindingsSchemaForMode('ct', 'technical', false, { outCols: ['Gross'], writesTo: false });
    const result = await port.generateToolTurn({ messages: [new HumanMessage('Ordinary hop')], tools: [{ name: 'lineage_submit_findings', description: 'Submit findings', inputSchema: schema }], phase: 'active' });
    expect(result.toolCalls[0]).toMatchObject({ valid: false, code: 'invalid_tool_input', input: raw });
    expect(raw).toEqual(before);
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])('HTTP raw boundary admits only a supplied scalar destination: scalar=%s', scalar => {
    const raw = { focus_node_id: fn, verdict: 'passthrough', sections: {}, summary: 'Synthetic boundary', column_flow: [{ out_col: 'Gross', returns_to: target, upstream_columns: [], ...(scalar ? {} : { legacyUnknown: true }) }] };
    const before = structuredClone(raw);
    const reply = { model: 'synthetic', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'synthetic-1', type: 'function', function: { name: 'lineage_submit_findings', arguments: JSON.stringify(raw) } }] } }] };
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(reply) }));
    const port = new OpenAiCompatiblePort({ baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic', apiKey: 'synthetic-test-key', laneId: 'synthetic' }, { fetchImpl });
    const schema = submitFindingsSchemaForMode('ct', 'technical', false, { outCols: ['Gross'], writesTo: false, ...(scalar ? { returnTargets: [target] } : {}) });
    return port.generateToolTurn({ messages: [new HumanMessage('Synthetic boundary')], tools: [{ name: 'lineage_submit_findings', description: 'Submit findings', inputSchema: schema }], phase: 'active' }).then(result => {
      expect(result.toolCalls[0]?.valid).toBe(scalar); expect(raw).toEqual(before); expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.toolCalls[0]?.input).toMatchObject({ column_flow: [{ returns_to: target }] });
      if (!scalar) expect(result.toolCalls[0]).toMatchObject({ code: 'invalid_tool_input' });
    });
  });
  it('serves correlated target pairs and excludes writes_to on a scalar task', () => {
    const schema = submitFindingsSchemaForMode('ct', 'both', false, { outCols: ['Gross', 'Net'], writesTo: false, returnTargets: [target, { node: '[ct].[second]', col: 'Net' }] });
    const input = { focus_node_id: fn, verdict: 'passthrough', sections: {}, summary: 'Return', column_flow: [{ out_col: 'Gross', returns_to: target, upstream_columns: [] }] };
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, column_flow: [{ ...input.column_flow[0], returns_to: { node: '[ct].[second]', col: 'Gross' } }] }).success).toBe(false);
    expect(schema.safeParse({ ...input, column_flow: [{ ...input.column_flow[0], writes_to: target }] }).success).toBe(false);
    const ordinary = submitFindingsSchemaForMode('ct', 'both', false, { outCols: ['Gross'], writesTo: false });
    const ordinaryParsed = ordinary.safeParse(input);
    expect(ordinaryParsed.success).toBe(true);
    expect(parseToolInput(ordinary, input).ok).toBe(false);
    expect(ordinaryParsed.success && droppedScalarReturnFieldError(input, ordinaryParsed.data)?.issues[0]?.path).toEqual(['column_flow', 0]);
    expect(JSON.stringify(toModelJsonSchema(ordinary))).not.toContain('returns_to');
    const unrelated = { ...input, column_flow: [{ out_col: 'Gross', upstream_columns: [], legacyUnknown: true }] };
    expect(parseToolInput(ordinary, unrelated).ok).toBe(true);
  });
  it('writes v2 for qualified state and resumes the same bound task; v1 preserves ordinary checkpoints', () => {
    const { engine, model, graph } = start(); const checkpoint = engine.toJSON();
    expect(checkpoint.snapshotVersion).toBe(2);
    const resumed = NavigationEngine.fromJSON(checkpoint, model, graph, () => {}, {});
    expect(resumed.getHopContext().caller_output_targets).toEqual([target]);
    expect(resumed.submitFindings(flow())).toHaveProperty('ok', true);
    expect(() => parseNavigationSnapshot({ ...checkpoint, snapshotVersion: 1 })).toThrow();
    const ordinary = start([]).engine.toJSON(); expect(ordinary.snapshotVersion).toBe(1);
    expect(NavigationEngine.fromJSON(ordinary, world([]).model, world([]).graph, () => {}, {}).toJSON()).toEqual(ordinary);
  });
  it('rejects stale caller bindings on restore instead of silently downgrading to BB', () => {
    const { engine, graph } = start(); const checkpoint = engine.toJSON();
    expect(() => NavigationEngine.fromJSON(checkpoint, world([]).model, graph, () => {}, {})).toThrow('invalid or incompatible');
  });
  it('merges two real caller tasks and resumes both same-name obligations without double commits', () => {
    const { model } = world(); const second = '[ct].[second]', root = '[ct].[root]';
    model.nodes.push({ ...model.nodes[0]!, id: second, fullName: second, name: 'second' });
    model.nodes.push(makeNode({ id: root, schema: 'ct', name: 'root', type: 'view', columns: [column('Gross')], bodyScript: `SELECT Gross FROM ${caller} UNION ALL SELECT Gross FROM ${second}` }));
    const pairs: Array<[string, string]> = [[caller, root], [second, root], [fn, caller], [fn, second], [orders, caller], [orders, second], [tax, fn]];
    const fullModel = makeModel(model.nodes, pairs, ['ct']); const graph = makeGraph(model.nodes, pairs);
    const engine = new NavigationEngine(fullModel, graph, () => {}, {});
    engine.init({ origin: root, question: 'Trace Gross', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Gross'], depthIntent: { upstream: { levels: 'all', exactness: 'approximate' }, downstream: { levels: 0, exactness: 'exact' } } });
    engine.getHopContext();
    expect(engine.submitFindings({ ...flow(), focus_node_id: root, column_flow: [{ out_col: 'Gross', upstream_columns: [{ node: caller, col: 'Gross' }, { node: second, col: 'Gross' }] }] })).toHaveProperty('ok', true);
    for (let i = 0; i < 2; i++) {
      engine.getHopContext(); const focus = engine.currentFocus!;
      expect([caller, second]).toContain(focus);
      expect(engine.submitFindings({ ...flow(), focus_node_id: focus, column_flow: [{ out_col: 'Gross', upstream_columns: [{ node: orders, col: 'Amount' }, { node: orders, col: 'Region' }] }] })).toHaveProperty('ok', true);
    }
    const hop = engine.getHopContext(); expect(hop.focus_node?.id).toBe(fn);
    expect(hop.caller_output_targets).toEqual([target, { node: second, col: 'Gross' }]);
    const checkpoint = engine.toJSON();
    const resumed = NavigationEngine.fromJSON(checkpoint, fullModel, graph, () => {}, {});
    expect(resumed.peekHopContext()?.caller_output_targets).toEqual(hop.caller_output_targets);
    const before = [...resumed.columnAspect!.edges];
    expect(resumed.submitFindings(flow())).toMatchObject({ code: 'route_validation_failed' });
    expect(resumed.columnAspect!.edges).toEqual(before);
    expect(resumed.submitFindings({ ...flow(), column_flow: hop.caller_output_targets!.map(returns_to => ({ ...flow().column_flow[0]!, returns_to })) })).toHaveProperty('ok', true);
    expect(resumed.columnAspect!.edges.filter(edge => edge.hop_node === fn)).toHaveLength(2);
    const stable = [...resumed.columnAspect!.edges];
    expect(resumed.submitFindings(flow())).toHaveProperty('code');
    expect(resumed.columnAspect!.edges).toEqual(stable);
    const inconsistent = structuredClone(checkpoint);
    const task = inconsistent.engineInternals.investigationTasks.find(task => task.kind === 'column_lineage' && task.returnTargets);
    if (task?.kind === 'column_lineage') task.activeColumns.push('Other');
    expect(() => parseNavigationSnapshot(inconsistent)).toThrow();
  });
  it('keeps same-spelling caller targets as separate obligations and task identities', () => {
    const { model } = world(); const second = '[ct].[second]';
    model.nodes.push({ ...model.nodes[0]!, id: second, fullName: second, name: 'second' });
    const map = new Map(model.nodes.map(node => [node.id, node])); const targets = [target, { node: second, col: 'Gross' }];
    const tracer = new ColumnTracer(['Gross']);
    const result = tracer.validateColumnFlow(fn, flow(), map, model, null, undefined, undefined, 'upstream', targets, targets);
    expect(result.invalidRoutes).toContainEqual(expect.objectContaining({ kind: 'bad_return_target', reason: expect.stringContaining(second) }));
    const ledger = new TaskLedger();
    const base = { kind: 'column_lineage' as const, source: 'engine' as const, question: 'Trace Gross', nodeId: fn, activeColumns: ['Gross'] as [string], createdHop: 1 };
    expect(ledger.ensureTask({ ...base, returnTargets: [target] }).id).not.toBe(ledger.ensureTask({ ...base, returnTargets: [targets[1]!] }).id);
    const combined = { ...flow(), column_flow: targets.map(returns_to => ({ ...flow().column_flow[0]!, returns_to })) };
    const accepted = tracer.validateColumnFlow(fn, combined, map, model, null, undefined, undefined, 'upstream', targets, targets);
    expect(accepted.invalidRoutes).toEqual([]);
    expect(accepted.stagedEdges.map(edge => edge.to_node)).toEqual([caller, second]);
    expect(resolveScalarReturnTarget(fn, { node: second, col: 'Other' }, map)).toBeNull();
  });
});
