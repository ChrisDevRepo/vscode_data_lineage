// Owner: src/ai/sm/columnTracer.ts and tools/toolSchemas.ts; qualified function task contracts.
/** Caller provenance is offered only on eligible neighboring functions; ordinary questions remain unchanged. */
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { submitFindingsSchemaForMode, toHopFinding } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { makeGraph, makeModel, makeNode } from '../helpers/modelFixtures';

const caller = '[d].[caller]', fn = '[d].[function]', source = '[d].[source]';
const col = (name: string) => ({ name, type: 'int', nullable: 'NULL' as const, extra: '' });
function world(functionReadsCaller = true, declaredDependency = false) {
  const nodes = [
    makeNode({ id: caller, schema: 'd', name: 'caller', type: 'view', columns: [{ ...col('Value'), ...(declaredDependency ? { expressionDependencies: [{ reference: fn, sourceElementType: 'SqlScalarFunction' }] } : {}) }], bodyScript: `CREATE VIEW ${caller} AS SELECT ${fn}(s.Amount) AS Value FROM ${source} s` }),
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
const finding = { focus_node_id: caller, summary: 'Function computes Value.', sections: { technical: 'Value is twice Amount.' }, column_flow: [] };

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
    const refused = engine.submitFindings({ ...finding, sections: [{ angle: 'technical' as const, text: finding.sections.technical }],
      questions: [{ nodeId: fn, question: 'Determine the output.', caller_context: { node: caller, col: 'Missing' } }, { nodeId: source, question: 'Explain the source rows.' }] });
    expect(refused).toMatchObject({ code: 'route_validation_failed', issuePaths: expect.arrayContaining(['questions.0.caller_context']) });
    expect(refused).toMatchObject({ detail: expect.arrayContaining([expect.objectContaining({
      path: 'questions.0.caller_context', allowed_values: ['Value'], when: { node: caller },
    })]) });
    expect(engine.currentFocus).toBe(caller);
    expect(engine.columnAspect?.edges ?? []).toEqual([]);
    expect(engine.toJSON().engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
  });

  it('retains qualified output and supplied caller SQL at the function hop, without inventing value edges', () => {
    const { engine } = world();
    const question = { nodeId: fn, question: 'Determine Value from the actual caller argument.', caller_context: { node: caller, col: 'Value' } };
    const accepted = engine.submitFindings({ ...finding, sections: [{ angle: 'technical' as const, text: finding.sections.technical }], questions: [question, { nodeId: source, question: 'Explain the source rows.' }] });
    expect(accepted).toHaveProperty('ok', true);
    expect(accepted).not.toHaveProperty('unaccounted_columns');
    const hop = engine.getHopContext();
    expect(hop).toMatchObject({ focus_node: { id: fn }, caller_requested_outputs: [{ node: caller, col: 'Value' }] });
    expect(hop.caller_objects).toContainEqual(expect.objectContaining({ node: caller, ddl: expect.stringContaining(`${fn}(s.Amount) AS Value`) }));
    expect(engine.columnAspect?.edges ?? []).toEqual([]);
    const task = engine.getCurrentTasks().find(t => t.callerContext);
    expect(task?.callerContext).toMatchObject({ node: caller, col: 'Value', callerTaskId: expect.any(String), ddlHash: expect.any(String) });
    const contextBeforeRetry = engine.peekHopContext();
    const tasksBeforeRetry = structuredClone(engine.getCurrentTasks());
    expect(JSON.stringify(contextBeforeRetry!.focus_node)).toContain(`CREATE FUNCTION ${fn}(@Amount int)`);
    const rejected = engine.submitFindings({ focus_node_id: fn, summary: 'Value is computed from the caller argument.',
      sections: [{ angle: 'technical', text: 'The supplied function multiplies the bound Amount by two.' }],
      column_flow: [{ out_col: 'Value', returns_to: { node: caller, col: 'Missing' }, upstream_columns: [{ node: source, col: 'Amount' }] }],
    });
    expect(rejected).toMatchObject({ code: 'route_validation_failed', issuePaths: expect.arrayContaining(['column_flow.0.returns_to']) });
    expect(engine.peekHopContext()).toEqual(contextBeforeRetry);
    expect(engine.getCurrentTasks()).toEqual(tasksBeforeRetry);
    expect(engine.columnAspect!.edges).toEqual([]);
    const repair = submitFindingsSchemaForMode('ct', 'technical', false, engine.hopSubmitColumns, engine.heldColumnFlow).parse({
      focus_node_id: fn,
      column_flow: [{ out_col: 'Value', returns_to: { node: caller, col: 'Value' }, upstream_columns: [{ node: source, col: 'Amount', transforms: ['compute'] }] }],
    });
    expect(engine.submitFindings(toHopFinding(repair))).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toContainEqual(expect.objectContaining({ from_node: source, from_col: 'Amount', to_node: caller, to_col: 'Value' }));
    expect(engine.columnAspect!.edges.some(edge => edge.from_col === '@Amount' || edge.to_col === '@Amount')).toBe(false);
  });

  it('keeps the qualified scalar caller mapping when its lookup source is beyond the requested trace', () => {
    const nodes = [
      makeNode({ id: caller, schema: 'd', name: 'caller', type: 'view', columns: [col('Value')], bodyScript: `SELECT ${fn}(1) AS Value` }),
      makeNode({ id: fn, schema: 'd', name: 'function', type: 'function', bodyScript: `CREATE FUNCTION ${fn}(@Id int) RETURNS int AS BEGIN RETURN (SELECT Amount FROM ${source} WHERE Id=@Id) END` }),
      makeNode({ id: source, schema: 'd', name: 'source', type: 'table', columns: [col('Amount'), col('Id')] }),
    ];
    const edges: Array<[string, string]> = [[source, fn], [fn, caller]];
    const engine = new NavigationEngine(makeModel(nodes, edges, ['d']), makeGraph(nodes, edges), () => {}, {});
    expect(engine.init({ origin: caller, question: 'Trace Value upstream one level.', direction: 'upstream', analysisMode: 'ct', targetColumns: ['Value'],
      depthIntent: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    const sections = [{ angle: 'technical' as const, text: 'The function supplies Value from its Amount lookup.' }];
    expect(engine.submitFindings({ ...finding, sections, questions: [{ nodeId: fn, question: 'Determine Value from the lookup.', caller_context: { node: caller, col: 'Value' } }] })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: fn }, caller_requested_outputs: [{ node: caller, col: 'Value' }] });
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, engine.hopSubmitColumns);
    const payload = { focus_node_id: fn, summary: 'Value comes from the lookup outside the requested trace.',
      sections: { technical: `${source}.Amount supplies the return value; its lookup lies beyond the upstream-one limit.` },
      column_flow: [{ out_col: 'Value', returns_to: { node: caller, col: 'Value' }, upstream_columns: [] }] };
    expect(new Ajv({ strict: false }).compile(toModelJsonSchema(schema))(payload)).toBe(true);
    expect(engine.submitFindings(toHopFinding(schema.parse(payload)))).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toEqual([]);
  });

  it.each([false, true])('keeps a terminal caller output in BB despite scalar metadata=%s', declaredDependency => {
    const { engine } = world(true, declaredDependency);
    expect(engine.submitFindings({ ...finding,
      sections: [{ angle: 'technical', text: 'The requested output ends here; investigate the function only for its row role.' }],
      column_flow: [{ out_col: 'Value', upstream_columns: [] }],
      questions: [{ nodeId: fn, question: 'Explain the function role without continuing Value.' },
        { nodeId: source, question: 'Explain source row eligibility.' }],
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: fn }, analysis_mode: 'bb' });
    expect(engine.getCurrentTasks().map(task => task.kind)).toEqual(['analytical']);
    expect(engine.columnAspect?.edges).toEqual([]);
  });

  it('preserves an authored function purpose without reviving a terminal caller output', () => {
    const { engine } = world();
    const purpose = 'Trace Value by explaining the function role separately from its terminal caller output.';
    expect(engine.submitFindings({ ...finding,
      sections: [{ angle: 'technical', text: 'The output terminates here; continue the authored investigation.' }],
      column_flow: [{ out_col: 'Value', upstream_columns: [] }],
      questions: [{ nodeId: fn, question: purpose }, { nodeId: source, question: 'Explain source row eligibility.' }],
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: fn }, analysis_mode: 'bb' });
    expect(engine.getCurrentTasks()).toHaveLength(1);
    expect(engine.getCurrentTasks()[0].question).toContain(purpose);
    expect(engine.columnAspect?.edges).toEqual([]);
  });


  it('does not restart CT when later BB work reaches a same-named scalar caller output', () => {
    const nodes = [
      makeNode({ id: caller, schema: 'd', name: 'caller', type: 'view', columns: [col('Value')], bodyScript: 'SELECT 1 AS Value' }),
      makeNode({ id: source, schema: 'd', name: 'source', type: 'view',
        columns: [{ ...col('Value'), expressionDependencies: [{ reference: fn, sourceElementType: 'SqlScalarFunction' }] }],
        bodyScript: `SELECT ${fn}(1) AS Value` }),
      makeNode({ id: fn, schema: 'd', name: 'function', type: 'function', bodyScript: 'RETURN 1' }),
    ];
    const edges: Array<[string, string]> = [[source, caller], [fn, source]];
    const engine = new NavigationEngine(makeModel(nodes, edges, ['d']), makeGraph(nodes, edges), () => {}, {});
    expect(engine.init({ origin: caller, question: 'Trace Value', analysisMode: 'ct', targetColumns: ['Value'], direction: 'upstream',
      depthIntent: { upstream: { levels: 'all', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    const sections = [{ angle: 'technical' as const, text: 'Investigate row eligibility separately from the terminal value.' }];
    expect(engine.submitFindings({ ...finding, sections, column_flow: [{ out_col: 'Value', upstream_columns: [] }],
      questions: [{ nodeId: source, question: 'Explain source eligibility.' }],
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: source }, analysis_mode: 'bb' });
    expect(engine.submitFindings({ focus_node_id: source, summary: 'A function supplies the source.', sections,
      questions: [{ nodeId: fn, question: 'Explain the function role in source eligibility.' }],
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: fn }, analysis_mode: 'bb' });
    expect(engine.getCurrentTasks().map(task => task.kind)).toEqual(['analytical']);
    expect(engine.columnAspect?.edges).toEqual([]);
  });

});


describe('qualified downstream input termination', () => {
  const sections = [{ angle: 'technical' as const, text: 'Value maps to Mapped; Other has no downstream output.' }];
  function downstream(targets = ['Value', 'Other']) {
    const nodes = [
      makeNode({ id: caller, schema: 'd', name: 'caller', type: 'view', columns: targets.map(col), bodyScript: `SELECT ${targets.map((name, index) => `${index + 1} AS ${name}`).join(', ')}` }),
      makeNode({ id: source, schema: 'd', name: 'source', type: 'view', columns: [col('Mapped')], bodyScript: `SELECT Value AS Mapped FROM ${caller}` }),
      makeNode({ id: fn, schema: 'd', name: 'consumer', type: 'view', columns: ['Mapped', 'Other'].map(col), bodyScript: `SELECT Mapped, 3 AS Other FROM ${source}` }),
    ];
    const edges: Array<[string, string]> = [[caller, source], [source, fn]];
    const engine = new NavigationEngine(makeModel(nodes, edges, ['d']), makeGraph(nodes, edges), () => {}, {});
    expect(engine.init({ origin: caller, question: 'Trace Value and Other downstream', analysisMode: 'ct', targetColumns: targets, direction: 'downstream',
      depthIntent: { upstream: { levels: 0, exactness: 'exact' }, downstream: { levels: 'all', exactness: 'exact' } },
    })).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(engine.submitFindings({ focus_node_id: caller, summary: 'Both columns originate here.', sections,
      column_flow: targets.map(out_col => ({ out_col, upstream_columns: [] })),
      questions: [{ nodeId: source, question: 'Determine downstream use of both inputs.' }],
    })).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: source }, analysis_mode: 'ct' });
    return engine;
  }
  const mapped = { focus_node_id: source, summary: 'Only Value continues.', sections,
    column_flow: [{ out_col: 'Mapped', upstream_columns: [{ node: caller, col: 'Value' }] }],
    questions: [{ nodeId: fn, question: 'Follow Mapped while preserving its input provenance.' }],
  };

  it.each([
    { name: 'a qualified input that never arrived', ref: { node: source, col: 'Other' } },
    { name: 'an input also mapped to an output', ref: { node: caller, col: 'Value' } },
  ])('rejects $name atomically and accepts only the corrected termination', ({ ref }) => {
    const engine = downstream();
    const before = engine.toJSON();
    const refused = engine.submitFindings({ ...mapped, terminated_inputs: [ref] });
    expect(refused).toHaveProperty('code');
    expect(engine.currentFocus).toBe(source);
    const after = engine.toJSON();
    expect(after.engineInternals.investigationTasks).toEqual(before.engineInternals.investigationTasks);
    expect(after.agenda).toEqual(before.agenda);
    expect(after.columnAspect).toEqual(before.columnAspect);
    const repairSchema = submitFindingsSchemaForMode('ct', 'technical', false, engine.hopSubmitColumns, engine.heldColumnFlow);
    const repair = repairSchema.parse({ focus_node_id: source, terminated_inputs: [{ node: caller, col: 'Other' }] });
    expect(engine.submitFindings(toHopFinding(repair))).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: fn }, analysis_mode: 'ct' });
    expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({ kind: 'column_lineage', activeColumns: ['Mapped'], sourceRefs: [{ node: source, col: 'Mapped' }] }));
    expect(engine.columnAspect?.edges.some(edge => edge.from_col === 'Other' || edge.to_col === 'Other')).toBe(false);
  });

  it('reports a failed termination at its submitted index and owes the whole terminated_inputs list again', () => {
    const engine = downstream(['Value', 'Other', 'Extra']);
    const first = engine.submitFindings({ ...mapped, terminated_inputs: [{ node: caller, col: 'Other' }] });
    expect(first).toMatchObject({ code: 'incomplete_task', hint: expect.stringContaining('Held: sections.technical, summary, questions, column_flow. Resend: terminated_inputs.') });
    const patch = (...names: string[]) => toHopFinding(submitFindingsSchemaForMode('ct', 'technical', false, engine.hopSubmitColumns, engine.heldColumnFlow)
      .parse({ focus_node_id: source, terminated_inputs: names.map(name => ({ node: caller, col: name })) }));
    const refused = engine.submitFindings(patch('Value'));
    expect(refused).toMatchObject({ issuePaths: expect.arrayContaining(['terminated_inputs.0']) });
    expect(engine.currentFocus).toBe(source);
    expect(engine.submitFindings(patch('Extra')), 'a sent list replaces the held list; the first call\'s Other entry is not merged back')
      .toMatchObject({ code: 'incomplete_task', reason: expect.stringContaining(`${caller}.Other`) });
    expect(engine.submitFindings(patch('Other', 'Extra'))).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({ focus_node: { id: fn }, analysis_mode: 'ct' });
    expect(engine.getCurrentTasks()).toContainEqual(expect.objectContaining({ activeColumns: ['Mapped'], sourceRefs: [{ node: source, col: 'Mapped' }] }));
  });

  it('serves qualified input termination only in CT, with matching Zod and JSON contracts', () => {
    const engine = downstream();
    const input = { ...mapped, sections: { technical: sections[0].text }, terminated_inputs: [{ node: caller, col: 'Other' }] };
    for (const mode of ['ct', 'bb'] as const) {
      const schema = submitFindingsSchemaForMode(mode, 'technical', true, engine.hopSubmitColumns);
      const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
      const payload = mode === 'ct' ? input : { ...input, column_flow: undefined };
      expect(schema.safeParse(payload).success).toBe(mode === 'ct');
      expect(wire(payload)).toBe(mode === 'ct');
    }
    const schema = submitFindingsSchemaForMode('ct', 'technical', true, {
      ...engine.hopSubmitColumns, incomingRefs: [{ node: caller, col: 'Other' }, { node: source, col: 'Mapped' }],
    });
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    for (const [ref, accepted] of [
      [{ node: caller, col: 'Other' }, true],
      [{ node: source, col: 'Mapped' }, true],
      [{ node: caller, col: 'Mapped' }, false],
      [{ node: fn, col: 'Other' }, false],
      [{ node: caller, col: 'Other', transforms: ['filter'] }, false],
    ] as const) {
      const payload = { ...input, terminated_inputs: [ref] };
      expect(schema.safeParse(payload).success, JSON.stringify(ref)).toBe(accepted);
      expect(wire(payload), JSON.stringify(ref)).toBe(accepted);
    }
  });
});
