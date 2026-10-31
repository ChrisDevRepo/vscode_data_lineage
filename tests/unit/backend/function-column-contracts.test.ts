import { validateToolCandidate } from '../../../src/ai/support/toolValidation';
// Owner: src/ai/sm/columnTracer.ts and tools/toolSchemas.ts; qualified function task contracts.
/** Caller provenance is offered only on eligible neighboring functions; ordinary questions remain unchanged. */
import Ajv from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { submitFindingsSchemaForMode } from '../../../src/ai/tools/toolSchemas';
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
});
