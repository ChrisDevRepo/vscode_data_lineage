/** Caller provenance is offered only on eligible neighboring functions; ordinary questions remain unchanged. */
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const caller = '[d].[caller]', fn = '[d].[function]', source = '[d].[source]';
const col = (name: string) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' });
function world(functionReadsCaller = true) {
  const nodes = [
    makeNode({ id: caller, schema: 'd', name: 'caller', type: 'view', columns: [col('Value')], bodyScript: `CREATE VIEW ${caller} AS SELECT ${fn}(s.Amount) AS Value FROM ${source} s` }),
    makeNode({ id: fn, schema: 'd', name: 'function', type: 'function', bodyScript: `CREATE FUNCTION ${fn}(@Amount int) RETURNS int AS BEGIN RETURN @Amount * 2 END` }),
    makeNode({ id: source, schema: 'd', name: 'source', type: 'table', columns: [col('Amount')] }),
  ];
  const edges: Array<[string, string]> = [[source, caller], functionReadsCaller ? [fn, caller] : [caller, fn]];
  const model = makeModel(nodes, edges, ['d']);
  const graph = makeGraph(nodes, edges);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect(engine.init({ origin: caller, question: 'Trace Value', direction: 'bidirectional', analysisMode: 'ct', targetColumns: ['Value'], depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } } })).toHaveProperty('ok', true);
  engine.getHopContext();
  return { engine };
}
const finding = { focus_node_id: caller, verdict: 'analyze' as const, summary: 'Function computes Value.', sections: { technical: 'Value is twice Amount.' }, column_flow: [] };

describe('neighbor-specific function caller context', () => {
  it('serves the function declaration and refuses it on an ordinary neighbor in both Zod and JSON Schema', () => {
    const { engine } = world();
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    for (const [nodeId, context, accepted] of [[fn, true, true], [source, true, false], [source, false, true], [fn, false, true]] as const) {
      const payload = { ...finding, questions: [{ nodeId, question: 'Establish the contribution.', ...(context ? { caller_context: { node: caller, col: 'Value' } } : {}) }] };
      expect(schema.safeParse(payload).success, nodeId).toBe(accepted);
      expect(wire(payload), nodeId).toBe(accepted);
    }
  });

  it('omits caller context when no neighbor is an eligible loaded function, without sharing the cached function schema', () => {
    const eligible = world().engine.hopSubmitColumns;
    const ineligible = world(false).engine.hopSubmitColumns;
    expect(eligible.callerContextNodeIds).toEqual([fn]);
    expect(ineligible.callerContextNodeIds).toEqual([]);
    const yes = submitFindingsSchemaForMode('ct', 'technical', true, eligible);
    const no = submitFindingsSchemaForMode('ct', 'technical', true, ineligible);
    expect(no).not.toBe(yes);
    expect(JSON.stringify(toModelJsonSchema(no))).not.toContain('caller_context');
    expect(submitFindingsSchemaForMode('ct', 'technical', true, eligible)).toBe(yes);
  });

  it('keeps semantic caller-output validation atomic for an eligible function', () => {
    const { engine } = world();
    const before = engine.toJSON();
    const refused = engine.submitFindings({ ...finding, verdict: 'analyze', sections: [{ angle: 'technical' as const, text: finding.sections.technical }],
      questions: [{ nodeId: fn, question: 'Determine the output.', caller_context: { node: caller, col: 'Missing' } }] });
    expect(refused).toMatchObject({ code: 'route_validation_failed', issuePaths: ['questions.0.caller_context'] });
    expect(engine.currentFocus).toBe(caller);
    expect(engine.columnAspect?.edges ?? []).toEqual([]);
    expect(engine.toJSON().engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
  });

  it('retains qualified output and supplied caller SQL at the function hop, without inventing value edges', () => {
    const { engine } = world();
    const question = { nodeId: fn, question: 'Determine Value from the actual caller argument.', caller_context: { node: caller, col: 'Value' } };
    expect(engine.submitFindings({ ...finding, verdict: 'analyze', sections: [{ angle: 'technical' as const, text: finding.sections.technical }], questions: [question] })).toHaveProperty('ok', true);
    const hop = engine.getHopContext();
    expect(hop).toMatchObject({ focus_node: { id: fn }, caller_requested_outputs: [{ node: caller, col: 'Value' }] });
    expect(hop.caller_objects).toContainEqual(expect.objectContaining({ node: caller, ddl: expect.stringContaining(`${fn}(s.Amount) AS Value`) }));
    expect(engine.columnAspect?.edges ?? []).toEqual([]);
    const task = engine.getCurrentTasks().find(t => t.callerContext);
    expect(task?.callerContext).toMatchObject({ node: caller, col: 'Value', callerTaskId: expect.any(String), ddlHash: expect.any(String) });
  });
});
