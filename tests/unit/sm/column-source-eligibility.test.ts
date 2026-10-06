/** Served `column_flow` contributor eligibility follows stored column metadata; columnless scalar functions stay caller-context questions. */
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';

const caller = '[d].[caller]', fn = '[d].[scalarfn]', tvf = '[d].[tablefn]', source = '[d].[source]';
const col = (name: string) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' });

function world() {
  const nodes = [
    makeNode({ id: caller, schema: 'd', name: 'caller', type: 'view', columns: [col('Value')], bodyScript: `CREATE VIEW ${caller} AS SELECT ${fn}(s.Amount) AS Value FROM ${source} s` }),
    makeNode({ id: fn, schema: 'd', name: 'scalarfn', type: 'function', bodyScript: `CREATE FUNCTION ${fn}(@Amount int) RETURNS int AS BEGIN RETURN @Amount END` }),
    makeNode({ id: tvf, schema: 'd', name: 'tablefn', type: 'function', columns: [col('Rate')] }),
    makeNode({ id: source, schema: 'd', name: 'source', type: 'table', columns: [col('Amount'), col('Region')] }),
  ];
  const edges: Array<[string, string]> = [[source, caller], [fn, caller], [tvf, caller]];
  const model = makeModel(nodes, edges, ['d']);
  const graph = makeGraph(nodes, edges);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect(engine.init({ origin: caller, question: 'Trace Value', direction: 'bidirectional', analysisMode: 'ct', targetColumns: ['Value'], depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } } })).toHaveProperty('ok', true);
  engine.getHopContext();
  return { engine };
}

const finding = { focus_node_id: caller, verdict: 'analyze' as const, summary: 'View applies the function.', sections: { technical: 'Value is the function over Amount.' } };

describe('metadata-derived upstream contributor eligibility', () => {
  it('admits mixed-case and unbracketed spellings of a qualified column source before any narrowing', () => {
    const { engine } = world();
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns);
    for (const spelling of ['d.source', '[D].[SOURCE]', 'D.Source', source]) {
      const parsed = schema.safeParse({ ...finding, column_flow: [{ out_col: 'Value', upstream_columns: [{ node: spelling, col: 'Amount' }] }] });
      expect(parsed.success, spelling).toBe(true);
    }
  });

  it('serves only column-carrying neighbors as upstream node sources while keeping the columnless function in caller-context questions', () => {
    const { engine } = world();
    const hop = engine.hopSubmitColumns;
    expect(hop.columnSourceNodeIds).toEqual([source, tvf]);
    expect(hop.callerContextNodeIds).toEqual([fn, tvf]);
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, hop);
    const invented = { ...finding, column_flow: [{ out_col: 'Value', upstream_columns: [{ node: fn, col: 'Invented' }] }] };
    expect(schema.safeParse(invented).success).toBe(false);
    expect(schema.safeParse({ ...finding, column_flow: [{ out_col: 'Value', upstream_columns: [{ node: fn, col: '' }] }] }).success).toBe(false);
    const real = { ...finding, column_flow: [{ out_col: 'Value', upstream_columns: [{ node: source, col: 'Amount' }, { node: source, col: 'Region' }, { node: tvf, col: 'Rate' }] }] };
    expect(schema.safeParse(real).success).toBe(true);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    expect(wire(invented)).toBe(false);
    expect(wire(real)).toBe(true);
    const nodeSchema = (toModelJsonSchema(schema) as { properties: { column_flow: { items: { properties: { upstream_columns: { items: { properties: { node: { enum?: string[] } } } } } } } } }).properties.column_flow.items.properties.upstream_columns.items.properties.node;
    expect(nodeSchema.enum).toEqual([source, tvf]);
    expect(schema.safeParse({ ...finding, questions: [{ nodeId: fn, question: 'Establish the returned value.', caller_context: { node: caller, col: 'Value' } }], column_flow: [] }).success).toBe(true);
  });

  it('keeps the procedure and external missing-metadata fallback eligible and excludes a columnless view', () => {
    const focus = '[d].[summary]', proc = '[d].[load]', ext = '[d].[extref]', bare = '[d].[bareview]';
    const nodes = [
      makeNode({ id: focus, schema: 'd', name: 'summary', type: 'view', columns: [col('Value')], bodyScript: `CREATE VIEW ${focus} AS SELECT Value FROM dbo.elsewhere` }),
      makeNode({ id: proc, schema: 'd', name: 'load', type: 'procedure', bodyScript: `INSERT dbo.out(Value) SELECT Value FROM dbo.elsewhere` }),
      makeNode({ id: ext, schema: 'd', name: 'extref', type: 'external' }),
      makeNode({ id: bare, schema: 'd', name: 'bareview', type: 'view' }),
    ];
    const edges: Array<[string, string]> = [[proc, focus], [ext, focus], [bare, focus]];
    const model = makeModel(nodes, edges, ['d']);
    const engine = new NavigationEngine(model, makeGraph(nodes, edges), () => {}, {});
    expect(engine.init({ origin: focus, question: 'Trace Value', direction: 'bidirectional', analysisMode: 'ct', targetColumns: ['Value'], depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } } })).toHaveProperty('ok', true);
    engine.getHopContext();
    const hop = engine.hopSubmitColumns;
    expect(hop.columnSourceNodeIds).toEqual([ext, proc]);
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, hop);
    expect(schema.safeParse({ ...finding, focus_node_id: focus, column_flow: [{ out_col: 'Value', upstream_columns: [{ node: proc, col: 'Value' }] }] }).success).toBe(true);
    expect(schema.safeParse({ ...finding, focus_node_id: focus, column_flow: [{ out_col: 'Value', upstream_columns: [{ node: ext, col: 'Value' }] }] }).success).toBe(true);
    expect(schema.safeParse({ ...finding, focus_node_id: focus, column_flow: [{ out_col: 'Value', upstream_columns: [{ node: bare, col: 'Value' }] }] }).success).toBe(false);
  });

  it('caches by the eligible-source identity across fresh hop columns', () => {
    const { engine } = world();
    const first = submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns);
    expect(submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns)).toBe(first);
    const narrowed = submitFindingsSchemaForMode('ct', 'technical', true, { outCols: ['Value'], writesTo: false, columnSourceNodeIds: [source] });
    expect(narrowed).not.toBe(first);
    expect(submitFindingsSchemaForMode('ct', 'technical', true, { outCols: ['Value'], writesTo: false, columnSourceNodeIds: [source] })).toBe(narrowed);
    expect(engine.hopSubmitColumns.columnSourceNodeIds).toEqual([source, tvf]);
    expect(submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns)).toBe(first);
  });

  it('derives the scalar-return function hop from the caller read suppliers and refuses invented function columns there', () => {
    const { engine } = world();
    const submitted = engine.submitFindings({ ...finding, verdict: 'analyze', sections: [{ angle: 'technical' as const, text: finding.sections.technical }],
      column_flow: [],
      prune_neighbors: [{ id: tvf, reason: 'Rate does not reach the traced value.' }],
      questions: [{ nodeId: fn, question: 'Establish how the function computes its returned value.', caller_context: { node: caller, col: 'Value' } }] });
    expect(submitted).toHaveProperty('ok', true);
    const hop = engine.getHopContext();
    expect(hop).toMatchObject({ focus_node: { id: fn }, caller_output_targets: [{ node: caller, col: 'Value' }] });
    const fnHop = engine.hopSubmitColumns;
    expect(fnHop.columnSourceNodeIds).toEqual([caller, source]);
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, fnHop);
    const gold = { focus_node_id: fn, verdict: 'analyze' as const, summary: 'Function returns the surcharged amount.', sections: { technical: 'The caller arguments come from the source table.' },
      column_flow: [{ out_col: 'Value', returns_to: { node: caller, col: 'Value' }, upstream_columns: [{ node: source, col: 'Amount' }, { node: source, col: 'Region' }] }] };
    expect(schema.safeParse(gold).success).toBe(true);
    for (const invented of [[{ node: fn, col: 'Invented' }], [{ node: fn, col: '@Amount' }], [{ node: fn, col: 'return_value' }]] as const) {
      expect(schema.safeParse({ ...gold, column_flow: [{ ...gold.column_flow[0], upstream_columns: [...invented] }] }).success, invented[0]!.col).toBe(false);
    }
    expect(new Ajv({ strict: false }).compile(toModelJsonSchema(schema))(gold)).toBe(true);
  });

  it('leaves the BB schema without column_flow', () => {
    const { engine } = world();
    const projected = toModelJsonSchema(submitFindingsSchemaForMode('bb', 'technical', true, engine.hopSubmitColumns)) as { properties: Record<string, unknown> };
    expect(projected.properties.column_flow).toBeUndefined();
  });
});
