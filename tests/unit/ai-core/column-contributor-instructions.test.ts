/** Contributor guidance separates value derivation from SQL-supported contextual dependencies. */
import { describe, expect, it } from 'vitest';
import { SubmitFindingsModelSchema } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';

const flow = SubmitFindingsModelSchema.shape.column_flow.unwrap().element;

describe('column contributor instructions', () => {
  it('advertises caller bindings, value inputs and SQL-supported contextual dependencies', () => {
    const projected = toModelJsonSchema(SubmitFindingsModelSchema) as {
      properties: { column_flow: { items: { properties: { upstream_columns: { description: string } } } } };
    };
    const description = projected.properties.column_flow.items.properties.upstream_columns.description;
    expect(description).toContain('caller-bound value inputs');
    expect(description).toContain('real SQL-supported dependencies of out_col');
    expect(description).toContain('Resolve parameters and computed aliases to their source columns');
    expect(description).toContain('Contextual columns may also be listed when');
    expect(description).toContain('explain these dataset operations in sections');
    expect(description).toContain('each set-operation (UNION) branch’s column at that position');
    expect(description).toContain('Exclude the entry’s own writes_to column and unused expressions');
    expect(description).toContain('upstream_columns: [] records no in-scope suppliers for this output');
  });

  it('distinguishes aggregate values from grouping and row-selection roles', () => {
    const description = flow.shape.upstream_columns.element.shape.transforms.description!;
    expect(description).toContain('aggregate: value summarised by an aggregate');
    expect(description).toContain('compute: expression input, including a CASE condition operand');
    expect(description).toContain('combine: a SQL-supported join, grouping, partition or ordering key that affects the output');
    expect(description).toContain('Contextual combine or filter roles may stand alone');
    expect(description).toContain('do not infer arithmetic or aggregate roles from them');
    expect(description).toContain('omit when SQL does not determine it');
  });

  it('preserves the closed contributor shape and existing optional role vocabulary', () => {
    const source = { node: '[demo].[source]', col: 'Amount' };
    expect(flow.safeParse({ out_col: 'Total', upstream_columns: [source] }).success).toBe(true);
    for (const role of ['pass_through', 'compute', 'aggregate', 'combine', 'filter']) {
      expect(flow.safeParse({ out_col: 'Total', upstream_columns: [{ ...source, transforms: [role] }] }).success).toBe(true);
    }
    expect(flow.safeParse({ out_col: 'Total', upstream_columns: [{ ...source, transforms: ['window'] }] }).success).toBe(false);
    expect(flow.safeParse({ out_col: 'Total', upstream_columns: [{ ...source, parameter: '@Amount' }] }).success).toBe(false);
  });
});
