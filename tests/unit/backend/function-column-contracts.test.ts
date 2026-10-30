import { z } from 'zod';
import { validateToolCandidate } from '../../../src/ai/support/toolValidation';
// Owner: src/ai/sm/columnTracer.ts and tools/toolSchemas.ts; qualified function task contracts.
/** Caller provenance is offered only on eligible neighboring functions; ordinary questions remain unchanged. */
import Ajv from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import {
  renderProblem,
  type ToolRejection,
} from '../../../src/ai/support/toolErrorEnvelope';
import {
  submitFindingsSchemaForMode,
  toHopFinding,
} from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { makeGraph, makeModel, makeNode } from '../helpers/modelFixtures';

const caller = '[d].[caller]',
  fn = '[d].[function]',
  source = '[d].[source]';
const col = (name: string) => ({
  name,
  type: 'int',
  nullable: 'NULL' as const,
  extra: '',
});
function world(functionReadsCaller = true, declaredDependency = false) {
  const nodes = [
    makeNode({
      id: caller,
      schema: 'd',
      name: 'caller',
      type: 'view',
      columns: [
        {
          ...col('Value'),
          ...(declaredDependency
            ? {
                expressionDependencies: [
                  { reference: fn, sourceElementType: 'SqlScalarFunction' },
                ],
              }
            : {}),
        },
      ],
      bodyScript: `CREATE VIEW ${caller} AS SELECT ${fn}(s.Amount) AS Value FROM ${source} s`,
    }),
    makeNode({
      id: fn,
      schema: 'd',
      name: 'function',
      type: 'function',
      bodyScript: `CREATE FUNCTION ${fn}(@Amount int) RETURNS int AS BEGIN RETURN @Amount * 2 END`,
    }),
    makeNode({
      id: source,
      schema: 'd',
      name: 'source',
      type: 'table',
      columns: [col('Amount')],
    }),
  ];
  const edges: Array<[string, string]> = [
    [source, caller],
    functionReadsCaller ? [fn, caller] : [caller, fn],
  ];
  const model = makeModel(nodes, edges, ['d']);
  const graph = makeGraph(nodes, edges);
  const engine = new NavigationEngine(model, graph, () => {}, {});
  expect(
    engine.init({
      origin: caller,
      question: 'Trace Value',
      direction: 'bidirectional',
      analysisMode: 'ct',
      targetColumns: ['Value'],
      depthIntent: {
        upstream: { levels: 'all', exactness: 'exact' },
        downstream: { levels: 'all', exactness: 'exact' },
      },
    }),
  ).toHaveProperty('ok', true);
  engine.getHopContext();
  return { engine };
}
const finding = {
  focus_node_id: caller,
  summary: 'Function computes Value.',
  sections: { technical: 'Value is twice Amount.' },
  column_flow: [],
};

describe('neighbor-specific function caller context', () => {
  it('serves the function declaration and refuses it on an ordinary neighbor in both Zod and JSON Schema', () => {
    const { engine } = world();
    const schema = submitFindingsSchemaForMode(
      'ct',
      'technical',
      true,
      engine.hopSubmitColumns,
    );
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    for (const [nodeId, context, accepted] of [
      [fn, true, true],
      [source, true, false],
      [source, false, true],
      [fn, false, true],
    ] as const) {
      const payload = {
        ...finding,
        questions: [
          {
            nodeId,
            question: 'Establish the contribution.',
            ...(context
              ? { caller_context: { node: caller, col: 'Value' } }
              : {}),
          },
        ],
      };
      expect(validateToolCandidate(schema, payload).success, nodeId).toBe(
        accepted,
      );
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
    expect(JSON.stringify(toModelJsonSchema(no))).not.toContain(
      'caller_context',
    );
    expect(submitFindingsSchemaForMode('ct', 'technical', true, eligible)).toBe(
      yes,
    );
  });

  it('keeps semantic caller-output validation atomic for an eligible function', () => {
    const { engine } = world();
    const before = engine.toJSON();
    const refused = engine.submitFindings({
      ...finding,
      sections: [
        { angle: 'technical' as const, text: finding.sections.technical },
      ],
      questions: [
        {
          nodeId: fn,
          question: 'Determine the output.',
          caller_context: { node: caller, col: 'Missing' },
        },
        { nodeId: source, question: 'Explain the source rows.' },
      ],
    });
    expect(refused).toMatchObject({
      code: 'invalid_input',
      issuePaths: expect.arrayContaining(['questions.0.caller_context']),
    });
    expect(refused).toMatchObject({
      detail: expect.arrayContaining([
        expect.objectContaining({
          path: 'questions.0.caller_context',
          allowed_values: ['Value'],
          when: { node: caller },
        }),
      ]),
    });
    expect(engine.currentFocus).toBe(caller);
    expect(engine.columnAspect?.edges ?? []).toEqual([]);
    expect(engine.toJSON().engineInternals.investigationTasks).toEqual(
      before.engineInternals.investigationTasks,
    );
  });

  it('retains qualified output and supplied caller SQL at the function hop, without inventing value edges', () => {
    const { engine } = world();
    const question = {
      nodeId: fn,
      question: 'Determine Value from the actual caller argument.',
      caller_context: { node: caller, col: 'Value' },
    };
    const accepted = engine.submitFindings({
      ...finding,
      sections: [
        { angle: 'technical' as const, text: finding.sections.technical },
      ],
      questions: [
        question,
        { nodeId: source, question: 'Explain the source rows.' },
      ],
    });
    expect(accepted).toHaveProperty('ok', true);
    expect(accepted).not.toHaveProperty('unaccounted_columns');
    const hop = engine.getHopContext();
    expect(hop).toMatchObject({
      focus_node: { id: fn },
      caller_requested_outputs: [{ node: caller, col: 'Value' }],
    });
    expect(hop.caller_objects).toContainEqual(
      expect.objectContaining({
        node: caller,
        ddl: expect.stringContaining(`${fn}(s.Amount) AS Value`),
      }),
    );
    expect(engine.columnAspect?.edges ?? []).toEqual([]);
    const task = engine.getCurrentTasks().find((t) => t.callerContext);
    expect(task?.callerContext).toMatchObject({
      node: caller,
      col: 'Value',
      callerTaskId: expect.any(String),
      ddlHash: expect.any(String),
    });
    const contextBeforeRetry = engine.peekHopContext();
    const tasksBeforeRetry = structuredClone(engine.getCurrentTasks());
    expect(JSON.stringify(contextBeforeRetry!.focus_node)).toContain(
      `CREATE FUNCTION ${fn}(@Amount int)`,
    );
    const rejected = engine.submitFindings({
      focus_node_id: fn,
      summary: 'Value is computed from the caller argument.',
      sections: [
        {
          angle: 'technical',
          text: 'The supplied function multiplies the bound Amount by two.',
        },
      ],
      column_flow: [
        {
          out_col: 'Missing',
          out_node: caller,
          upstream_columns: [{ node: source, col: 'Amount' }],
        },
      ],
    });
    expect(rejected).toMatchObject({
      code: 'invalid_input',
      issuePaths: expect.arrayContaining(['column_flow.0.out_col']),
    });
    expect(engine.peekHopContext()).toEqual(contextBeforeRetry);
    expect(engine.getCurrentTasks()).toEqual(tasksBeforeRetry);
    expect(engine.columnAspect!.edges).toEqual([]);
    // D-098: the held summary and sections compose with the flow-only correction.
    expect(
      engine.submitModelFindings({
        focus_node_id: fn,
        column_flow: [
          {
            out_col: 'Value',
            out_node: caller,
            upstream_columns: [
              { node: source, col: 'Amount', transforms: ['compute'] },
            ],
          },
        ],
      }),
    ).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toContainEqual(
      expect.objectContaining({
        from_node: source,
        from_col: 'Amount',
        to_node: caller,
        to_col: 'Value',
      }),
    );
    expect(
      engine.columnAspect!.edges.some(
        (edge) => edge.from_col === '@Amount' || edge.to_col === '@Amount',
      ),
    ).toBe(false);
  });

  it('keeps the qualified scalar caller mapping when its lookup source is beyond the requested trace', () => {
    const nodes = [
      makeNode({
        id: caller,
        schema: 'd',
        name: 'caller',
        type: 'view',
        columns: [col('Value')],
        bodyScript: `SELECT ${fn}(1) AS Value`,
      }),
      makeNode({
        id: fn,
        schema: 'd',
        name: 'function',
        type: 'function',
        bodyScript: `CREATE FUNCTION ${fn}(@Id int) RETURNS int AS BEGIN RETURN (SELECT Amount FROM ${source} WHERE Id=@Id) END`,
      }),
      makeNode({
        id: source,
        schema: 'd',
        name: 'source',
        type: 'table',
        columns: [col('Amount'), col('Id')],
      }),
    ];
    const edges: Array<[string, string]> = [
      [source, fn],
      [fn, caller],
    ];
    const engine = new NavigationEngine(
      makeModel(nodes, edges, ['d']),
      makeGraph(nodes, edges),
      () => {},
      {},
    );
    expect(
      engine.init({
        origin: caller,
        question: 'Trace Value upstream one level.',
        direction: 'upstream',
        analysisMode: 'ct',
        targetColumns: ['Value'],
        depthIntent: {
          upstream: { levels: 1, exactness: 'exact' },
          downstream: { levels: 0, exactness: 'exact' },
        },
      }),
    ).toHaveProperty('ok', true);
    engine.getHopContext();
    const sections = [
      {
        angle: 'technical' as const,
        text: 'The function supplies Value from its Amount lookup.',
      },
    ];
    expect(
      engine.submitFindings({
        ...finding,
        sections,
        questions: [
          {
            nodeId: fn,
            question: 'Determine Value from the lookup.',
            caller_context: { node: caller, col: 'Value' },
          },
        ],
      }),
    ).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({
      focus_node: { id: fn },
      caller_requested_outputs: [{ node: caller, col: 'Value' }],
    });
    const schema = submitFindingsSchemaForMode(
      'ct',
      'technical',
      true,
      engine.hopSubmitColumns,
    );
    const payload = {
      focus_node_id: fn,
      summary: 'Value comes from the lookup outside the requested trace.',
      sections: {
        technical: `${source}.Amount supplies the return value; its lookup lies beyond the upstream-one limit.`,
      },
      column_flow: [
        { out_col: 'Value', out_node: caller, upstream_columns: [] },
      ],
    };
    expect(
      new Ajv({ strict: false }).compile(toModelJsonSchema(schema))(payload),
    ).toBe(true);
    expect(
      engine.submitFindings(toHopFinding(admit(schema, payload))),
    ).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toEqual([]);
  });

  it.each([false, true])(
    'keeps a terminal caller output in BB despite scalar metadata=%s',
    (declaredDependency) => {
      const { engine } = world(true, declaredDependency);
      expect(
        engine.submitFindings({
          ...finding,
          sections: [
            {
              angle: 'technical',
              text: 'The requested output ends here; investigate the function only for its row role.',
            },
          ],
          column_flow: [{ out_col: 'Value', upstream_columns: [] }],
          questions: [
            {
              nodeId: fn,
              question: 'Explain the function role without continuing Value.',
            },
            { nodeId: source, question: 'Explain source row eligibility.' },
          ],
        }),
      ).toHaveProperty('ok', true);
      expect(engine.getHopContext()).toMatchObject({
        focus_node: { id: fn },
        analysis_mode: 'bb',
      });
      expect(engine.getCurrentTasks().map((task) => task.kind)).toEqual([
        'analytical',
      ]);
      expect(engine.columnAspect?.edges).toEqual([]);
    },
  );

  it('preserves an authored function purpose without reviving a terminal caller output', () => {
    const { engine } = world();
    const purpose =
      'Trace Value by explaining the function role separately from its terminal caller output.';
    expect(
      engine.submitFindings({
        ...finding,
        sections: [
          {
            angle: 'technical',
            text: 'The output terminates here; continue the authored investigation.',
          },
        ],
        column_flow: [{ out_col: 'Value', upstream_columns: [] }],
        questions: [
          { nodeId: fn, question: purpose },
          { nodeId: source, question: 'Explain source row eligibility.' },
        ],
      }),
    ).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({
      focus_node: { id: fn },
      analysis_mode: 'bb',
    });
    expect(engine.getCurrentTasks()).toHaveLength(1);
    expect(engine.getCurrentTasks()[0].question).toContain(purpose);
    expect(engine.columnAspect?.edges).toEqual([]);
  });

  it('does not restart CT when later BB work reaches a same-named scalar caller output', () => {
    const nodes = [
      makeNode({
        id: caller,
        schema: 'd',
        name: 'caller',
        type: 'view',
        columns: [col('Value')],
        bodyScript: 'SELECT 1 AS Value',
      }),
      makeNode({
        id: source,
        schema: 'd',
        name: 'source',
        type: 'view',
        columns: [
          {
            ...col('Value'),
            expressionDependencies: [
              { reference: fn, sourceElementType: 'SqlScalarFunction' },
            ],
          },
        ],
        bodyScript: `SELECT ${fn}(1) AS Value`,
      }),
      makeNode({
        id: fn,
        schema: 'd',
        name: 'function',
        type: 'function',
        bodyScript: 'RETURN 1',
      }),
    ];
    const edges: Array<[string, string]> = [
      [source, caller],
      [fn, source],
    ];
    const engine = new NavigationEngine(
      makeModel(nodes, edges, ['d']),
      makeGraph(nodes, edges),
      () => {},
      {},
    );
    expect(
      engine.init({
        origin: caller,
        question: 'Trace Value',
        analysisMode: 'ct',
        targetColumns: ['Value'],
        direction: 'upstream',
        depthIntent: {
          upstream: { levels: 'all', exactness: 'exact' },
          downstream: { levels: 0, exactness: 'exact' },
        },
      }),
    ).toHaveProperty('ok', true);
    engine.getHopContext();
    const sections = [
      {
        angle: 'technical' as const,
        text: 'Investigate row eligibility separately from the terminal value.',
      },
    ];
    expect(
      engine.submitFindings({
        ...finding,
        sections,
        column_flow: [{ out_col: 'Value', upstream_columns: [] }],
        questions: [
          { nodeId: source, question: 'Explain source eligibility.' },
        ],
      }),
    ).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({
      focus_node: { id: source },
      analysis_mode: 'bb',
    });
    expect(
      engine.submitFindings({
        focus_node_id: source,
        summary: 'A function supplies the source.',
        sections,
        questions: [
          {
            nodeId: fn,
            question: 'Explain the function role in source eligibility.',
          },
        ],
      }),
    ).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({
      focus_node: { id: fn },
      analysis_mode: 'bb',
    });
    expect(engine.getCurrentTasks().map((task) => task.kind)).toEqual([
      'analytical',
    ]);
    expect(engine.columnAspect?.edges).toEqual([]);
  });

  it('never asks a scalar-function hop for an outcome on its explicit caller output, and offers an open second caller no column_flow', () => {
    // The return target is the caller whose column task opened this hop, so it is already visited; any other caller reads the function and cannot be mapped here.
    const reader = '[d].[reader]';
    const nodes = [
      makeNode({
        id: caller,
        schema: 'd',
        name: 'caller',
        type: 'view',
        columns: [
          {
            ...col('Value'),
            expressionDependencies: [
              { reference: fn, sourceElementType: 'SqlScalarFunction' },
            ],
          },
        ],
        bodyScript: `CREATE VIEW ${caller} AS SELECT ${fn}(s.Amount) AS Value FROM ${source} s`,
      }),
      makeNode({
        id: reader,
        schema: 'd',
        name: 'reader',
        type: 'view',
        columns: [
          {
            ...col('Other'),
            expressionDependencies: [
              { reference: fn, sourceElementType: 'SqlScalarFunction' },
            ],
          },
        ],
        bodyScript: `CREATE VIEW ${reader} AS SELECT ${fn}(c.Value) AS Other FROM ${caller} c`,
      }),
      makeNode({
        id: fn,
        schema: 'd',
        name: 'function',
        type: 'function',
        bodyScript: `CREATE FUNCTION ${fn}(@Amount int) RETURNS int AS BEGIN RETURN @Amount * 2 END`,
      }),
      makeNode({
        id: source,
        schema: 'd',
        name: 'source',
        type: 'table',
        columns: [col('Amount')],
      }),
    ];
    // reader also consumes caller, so it lies inside the bidirectional scope; a sibling caller alone would sit outside it.
    const edges: Array<[string, string]> = [
      [source, caller],
      [fn, caller],
      [fn, reader],
      [caller, reader],
    ];
    const engine = new NavigationEngine(
      makeModel(nodes, edges, ['d']),
      makeGraph(nodes, edges),
      () => {},
      {},
    );
    expect(
      engine.init({
        origin: caller,
        question: 'Trace Value',
        direction: 'bidirectional',
        analysisMode: 'ct',
        targetColumns: ['Value'],
        depthIntent: {
          upstream: { levels: 'all', exactness: 'exact' },
          downstream: { levels: 'all', exactness: 'exact' },
        },
      }),
    ).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(
      engine.submitFindings({
        ...finding,
        sections: [
          { angle: 'technical' as const, text: finding.sections.technical },
        ],
        questions: [
          {
            nodeId: fn,
            question: 'Determine Value from the actual caller argument.',
            caller_context: { node: caller, col: 'Value' },
          },
          { nodeId: source, question: 'Explain the source rows.' },
          { nodeId: reader, question: 'Explain how reader consumes Value.' },
        ],
      }),
    ).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({
      focus_node: { id: fn },
      analysis_mode: 'ct',
      caller_requested_outputs: [{ node: caller, col: 'Value' }],
    });
    const schema = submitFindingsSchemaForMode(
      'ct',
      'technical',
      true,
      engine.hopSubmitColumns,
    );
    const flow = (node: string, c: string) => ({
      focus_node_id: fn,
      summary: 'Value is twice Amount.',
      sections: { technical: 'The function doubles the bound Amount.' },
      column_flow: [
        {
          out_col: c,
          out_node: node,
          upstream_columns: [
            { node: source, col: 'Amount', transforms: ['compute'] },
          ],
        },
      ],
    });
    expect(validateToolCandidate(schema, flow(reader, 'Other')).success).toBe(
      false,
    );
    expect(validateToolCandidate(schema, flow(caller, 'Value')).success).toBe(
      true,
    );
    const before = engine.toJSON();
    const missing = engine.submitFindings({
      ...toHopFinding(admit(schema, flow(caller, 'Value'))),
      questions: [],
      prune_neighbors: [],
    });
    expect(missing).toMatchObject({
      code: 'invalid_input',
      detail: [
        expect.objectContaining({
          kind: 'neighbor_outcome_missing',
          id: reader,
        }),
      ],
    });
    const shown = JSON.parse(renderProblem(missing as ToolRejection, 1)) as {
      errors: Array<{ path: string; code: string; allowed?: string[] }>;
    };
    expect(shown.errors).toEqual([
      expect.objectContaining({
        path: '',
        code: 'neighbor_undecided',
        allowed: [reader],
      }),
    ]);
    expect((missing as ToolRejection).resend).toEqual(['questions']);
    expect(engine.columnAspect?.edges ?? []).toEqual([]);
    expect(engine.toJSON().visited).toEqual(before.visited);
    expect(
      engine.submitFindings({
        focus_node_id: fn,
        summary: '',
        sections: [],
        questions: [
          { nodeId: reader, question: 'Explain how reader uses the function.' },
        ],
        prune_neighbors: [],
      }),
    ).toHaveProperty('ok', true);
    expect(engine.columnAspect!.edges).toContainEqual(
      expect.objectContaining({
        from_node: source,
        from_col: 'Amount',
        to_node: caller,
        to_col: 'Value',
      }),
    );
    expect(
      engine.columnAspect!.edges.some(
        (edge) => edge.to_node === reader || edge.from_node === reader,
      ),
    ).toBe(false);
  });
});

describe('case-sensitive scalar caller identities', () => {
  it.each([false, true])(
    'preserves two caller columns through native schemas and snapshots (distinct functions=%s)',
    (distinctFunctions) => {
      const result = '[dbo].[Result]',
        upper = '[dbo].[Calc]',
        lower = distinctFunctions ? '[dbo].[calc]' : upper;
      const outputs = [
        { node: upper, column: 'Value' },
        { node: lower, column: 'value' },
      ];
      const functions = [...new Set(outputs.map((output) => output.node))];
      const nodes = [
        makeNode({
          id: result,
          schema: 'dbo',
          name: 'Result',
          type: 'view',
          columns: outputs.map((output) => ({
            ...col(output.column),
            expressionDependencies: [
              {
                reference: output.node,
                sourceElementType: 'SqlScalarFunction',
              },
            ],
          })),
          bodyScript: `SELECT ${upper}(1) AS Value, ${lower}(2) AS value;`,
        }),
        ...functions.map((id) =>
          makeNode({
            id,
            schema: 'dbo',
            name: id,
            type: 'function',
            bodyScript: `CREATE FUNCTION ${id}(@x int) RETURNS int AS BEGIN RETURN @x; END;`,
          }),
        ),
      ];
      const pairs: Array<[string, string]> = functions.map((id) => [
        id,
        result,
      ]);
      const engine = new NavigationEngine(
        { ...makeModel(nodes, pairs, ['dbo']), identifierCaseSensitive: true },
        makeGraph(nodes, pairs),
        () => {},
        {},
      );
      expect(
        engine.init({
          origin: result,
          question: 'Trace Value and value',
          direction: 'upstream',
          analysisMode: 'ct',
          targetColumns: ['Value', 'value'],
          depthIntent: {
            upstream: { levels: 'all', exactness: 'exact' },
            downstream: { levels: 0, exactness: 'exact' },
          },
        }),
      ).toHaveProperty('ok', true);
      engine.getHopContext();
      const callerReply = {
        focus_node_id: result,
        summary: 'Each output calls its declared function.',
        sections: {
          technical: 'Case-distinct outputs retain their own caller bindings.',
        },
        column_flow: [],
        questions: outputs.map((output) => ({
          nodeId: output.node,
          question: `Establish ${output.column}.`,
          caller_context: { node: result, col: output.column },
        })),
      };
      const callerSchema = submitFindingsSchemaForMode(
        'ct',
        'technical',
        true,
        engine.hopSubmitColumns,
      );
      expect(
        new Ajv({ strict: false }).compile(toModelJsonSchema(callerSchema))(
          callerReply,
        ),
      ).toBe(true);
      expect(
        engine.submitFindings(toHopFinding(admit(callerSchema, callerReply))),
      ).toHaveProperty('ok', true);
      const snapshot = engine.toJSON();
      expect(snapshot.snapshotVersion).toBe(1);
      expect(
        snapshot.engineInternals.investigationTasks
          .filter(
            (task) => task.kind === 'column_lineage' && task.callerContext,
          )
          .map((task) => task.callerContext!.col)
          .sort(),
      ).toEqual(['Value', 'value']);
      const visited: string[] = [];
      for (let index = 0; index < functions.length; index++) {
        const hop = engine.getHopContext(),
          focus = engine.currentFocus!;
        visited.push(focus);
        const targets = outputs
          .filter((output) => output.node === focus)
          .map((output) => ({ node: result, col: output.column }));
        expect(hop.caller_requested_outputs).toEqual(targets);
        const schema = submitFindingsSchemaForMode(
          'ct',
          'technical',
          true,
          engine.hopSubmitColumns,
        );
        const reply = {
          focus_node_id: focus,
          summary: 'The scalar returns the supplied argument.',
          sections: {
            technical: 'Each return stays bound to its declared caller column.',
          },
          column_flow: targets.map((target) => ({
            out_col: target.col,
            out_node: target.node,
            upstream_columns: [],
          })),
        };
        const native = new Ajv({ strict: false }).compile(
          toModelJsonSchema(schema),
        );
        expect(native(reply)).toBe(true);
        expect(
          native({
            ...reply,
            column_flow: [
              { out_col: 'VALUE', out_node: result, upstream_columns: [] },
            ],
          }),
        ).toBe(false);
        expect(
          engine.submitFindings(toHopFinding(admit(schema, reply))),
        ).toHaveProperty('ok', true);
      }
      expect(visited.sort()).toEqual(functions.sort());
      expect(engine.getHopContext()).toMatchObject({ done: true });
      expect(engine.columnAspect!.edges).toEqual([]);
    },
  );
});

describe('qualified downstream input termination', () => {
  const sections = [
    {
      angle: 'technical' as const,
      text: 'Value maps to Mapped; Other has no downstream output.',
    },
  ];
  function downstream(targets = ['Value', 'Other']) {
    const nodes = [
      makeNode({
        id: caller,
        schema: 'd',
        name: 'caller',
        type: 'view',
        columns: targets.map(col),
        bodyScript: `SELECT ${targets.map((name, index) => `${index + 1} AS ${name}`).join(', ')}`,
      }),
      makeNode({
        id: source,
        schema: 'd',
        name: 'source',
        type: 'view',
        columns: [col('Mapped')],
        bodyScript: `SELECT Value AS Mapped FROM ${caller}`,
      }),
      makeNode({
        id: fn,
        schema: 'd',
        name: 'consumer',
        type: 'view',
        columns: ['Mapped', 'Other'].map(col),
        bodyScript: `SELECT Mapped, 3 AS Other FROM ${source}`,
      }),
    ];
    const edges: Array<[string, string]> = [
      [caller, source],
      [source, fn],
    ];
    const engine = new NavigationEngine(
      makeModel(nodes, edges, ['d']),
      makeGraph(nodes, edges),
      () => {},
      {},
    );
    expect(
      engine.init({
        origin: caller,
        question: 'Trace Value and Other downstream',
        analysisMode: 'ct',
        targetColumns: targets,
        direction: 'downstream',
        depthIntent: {
          upstream: { levels: 0, exactness: 'exact' },
          downstream: { levels: 'all', exactness: 'exact' },
        },
      }),
    ).toHaveProperty('ok', true);
    engine.getHopContext();
    expect(
      engine.submitFindings({
        focus_node_id: caller,
        summary: 'Both columns originate here.',
        sections,
        column_flow: targets.map((out_col) => ({
          out_col,
          upstream_columns: [],
        })),
        questions: [
          {
            nodeId: source,
            question: 'Determine downstream use of both inputs.',
          },
        ],
      }),
    ).toHaveProperty('ok', true);
    expect(engine.getHopContext()).toMatchObject({
      focus_node: { id: source },
      analysis_mode: 'ct',
    });
    return engine;
  }
  const mapped = {
    focus_node_id: source,
    summary: 'Only Value continues.',
    sections,
    column_flow: [
      { out_col: 'Mapped', upstream_columns: [{ node: caller, col: 'Value' }] },
    ],
    questions: [
      {
        nodeId: fn,
        question: 'Follow Mapped while preserving its input provenance.',
      },
    ],
  };

  it('ends an unmapped arriving input at this hop and names it, with no terminated_inputs field to author', () => {
    const engine = downstream();
    const schema = submitFindingsSchemaForMode(
      'ct',
      'technical',
      true,
      engine.hopSubmitColumns,
    );
    expect(
      validateToolCandidate(schema, {
        ...mapped,
        sections: { technical: sections[0].text },
        terminated_inputs: [{ node: caller, col: 'Other' }],
      }).success,
    ).toBe(false);
    expect(engine.submitFindings(mapped)).toMatchObject({
      ok: true,
      ended_columns: [`${caller}.Other`],
    });
    expect(engine.getHopContext()).toMatchObject({
      focus_node: { id: fn },
      analysis_mode: 'ct',
    });
    expect(engine.getCurrentTasks()).toContainEqual(
      expect.objectContaining({
        kind: 'column_lineage',
        activeColumns: ['Mapped'],
        sourceRefs: [{ node: source, col: 'Mapped' }],
      }),
    );
    expect(
      engine.columnAspect?.edges.some(
        (edge) => edge.from_col === 'Other' || edge.to_col === 'Other',
      ),
    ).toBe(false);
  });
});

function admit<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = validateToolCandidate(schema, input);
  if (!result.success) throw new Error(JSON.stringify(result.rejection));
  return result.data;
}
