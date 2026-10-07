/** Rejection remedies name the refused field and preserve real output destinations on retry. */
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import type { ColumnDef } from '../../../src/engine/types';

const result = '[ct].[result]', writer = '[ct].[load]', source = '[ct].[source]';
const column = (name: string): ColumnDef => ({ name, type: 'int', nullable: 'NULL', extra: '' });
function start(origin: string, logs: string[] = []) {
  const nodes = [
    makeNode({ id: result, schema: 'ct', name: 'result', type: 'table', columns: [column('Value')] }),
    makeNode({ id: source, schema: 'ct', name: 'source', type: 'table', columns: [column('Amount')] }),
    makeNode({ id: writer, schema: 'ct', name: 'load', type: 'procedure', bodyScript: `INSERT INTO ${result}(Value) SELECT s.Amount FROM ${source} s WHERE NOT EXISTS (SELECT 1 FROM ${result} r WHERE r.Value=s.Amount);` }),
  ];
  const edges: Array<[string, string]> = [[writer, result], [result, writer], [source, writer]];
  const engine = new NavigationEngine(makeModel(nodes, edges, ['ct']), makeGraph(nodes, edges), (_level, message) => { logs.push(message); }, {});
  expect(engine.init({ origin, question: 'Trace Value upstream', analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream', depthIntent: { upstream: { levels: 'all', exactness: 'approximate' }, downstream: { levels: 0, exactness: 'exact' } } })).toHaveProperty('ok', true);
  engine.getHopContext();
  return engine;
}

describe('field-specific rejection remedies', () => {
  it('corrects a caller declaration on a procedure question without suggesting scalar return mappings', () => {
    const engine = start(result);
    const finding = { focus_node_id: result, verdict: 'passthrough' as const, summary: 'Stored result', sections: [{ angle: 'technical' as const, text: 'The procedure stores Value.' }], column_flow: [{ out_col: 'Value', upstream_columns: [{ node: writer, col: 'Value' }] }], questions: [{ nodeId: writer, question: 'Establish the writer inputs.', caller_context: { node: result, col: 'Value' } }] };
    const rejected = engine.submitFindings(finding);
    expect(rejected).toMatchObject({ code: 'route_validation_failed', issuePaths: ['questions.0.caller_context'] });
    if (!('code' in rejected)) throw new Error('Expected caller-context rejection');
    expect(rejected.hint).toContain('questions[].caller_context');
    expect(rejected.hint).not.toContain('returns_to');
    expect(engine.columnAspect?.edges).toEqual([]);
    expect(engine.submitFindings({ ...finding, questions: [{ nodeId: writer, question: finding.questions[0].question }] })).toHaveProperty('ok', true);
  });

  it('removes an identical contributor while preserving the required real procedure destination', () => {
    const engine = start(writer);
    const entry = { out_col: 'Value', writes_to: { node: result, col: 'Value' }, upstream_columns: [{ node: source, col: 'Amount' }, { node: result, col: 'Value' }] };
    const finding = { focus_node_id: writer, verdict: 'analyze' as const, summary: 'Loads missing values', sections: [{ angle: 'technical' as const, text: 'Existing destination values select rows; Amount supplies new values.' }], column_flow: [entry] };
    const rejected = engine.submitFindings(finding);
    expect(rejected).toMatchObject({ code: 'column_self_loop' });
    if (!('code' in rejected)) throw new Error('Expected self-loop rejection');
    expect(rejected.hint).toContain('Remove the upstream_columns entry');
    expect(rejected.hint).not.toContain('omit writes_to');
    expect(engine.columnAspect?.edges).toEqual([]);
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns);
    expect(schema.safeParse({ ...finding, sections: { technical: finding.sections[0].text }, column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'Amount' }] }] }).success).toBe(false);
    expect(engine.submitFindings({ ...finding, column_flow: [{ ...entry, upstream_columns: [{ node: source, col: 'Amount' }] }] })).toHaveProperty('ok', true);
    expect(engine.columnAspect?.edges).toContainEqual(expect.objectContaining({ from_node: source, from_col: 'Amount', to_node: result, to_col: 'Value' }));
  });
  it('repairs a writes_to that names a non-destination with the served required-nullable contract', () => {
    const logs: string[] = [];
    const engine = start(writer, logs);
    const flow = (writes_to: { node: string; col: string } | null) => [{ out_col: 'Value', writes_to, upstream_columns: [{ node: source, col: 'Amount' }] }];
    const finding = { focus_node_id: writer, verdict: 'analyze' as const, summary: 'Loads missing values', sections: [{ angle: 'technical' as const, text: 'Amount supplies new values.' }] };
    const rejected = engine.submitFindings({ ...finding, column_flow: flow({ node: source, col: 'Amount' }) });
    expect(rejected).toMatchObject({ code: 'writes_to_names_reader', issuePaths: ['column_flow.0.writes_to.node'] });
    if (!('code' in rejected)) throw new Error('Expected writes_to rejection');
    expect(rejected.hint).toContain('or to null when it writes no table');
    expect(`${rejected.hint} ${rejected.reason}`).not.toMatch(/omit writes_to|defaults to the focus/i);
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns);
    const served = { ...finding, sections: { technical: finding.sections[0].text } };
    expect(schema.safeParse({ ...served, column_flow: flow(null) }).success).toBe(true);
    expect(schema.safeParse({ ...served, column_flow: flow({ node: result, col: 'Value' }) }).success).toBe(true);
    expect(logs.filter(line => line.includes('writes_to null on writer'))).toEqual([]);
    expect(engine.submitFindings({ ...finding, column_flow: flow({ node: result, col: 'Value' }) })).toHaveProperty('ok', true);
    expect(logs.filter(line => line.includes('writes_to null on writer'))).toEqual([]);
  });

  it('logs a null writes_to on a procedure that has a recorded write, without staging a writer edge', () => {
    const logs: string[] = [];
    const engine = start(writer, logs);
    const accepted = engine.submitFindings({ focus_node_id: writer, verdict: 'analyze' as const, summary: 'Loads missing values', sections: [{ angle: 'technical' as const, text: 'Amount supplies new values.' }], column_flow: [{ out_col: 'Value', writes_to: null, upstream_columns: [{ node: source, col: 'Amount' }] }] });
    expect(accepted).toHaveProperty('ok', true);
    expect(logs.filter(line => line.includes('writes_to null on writer'))).toHaveLength(1);
    expect(engine.columnAspect?.edges).not.toContainEqual(expect.objectContaining({ to_node: result }));
  });
});
