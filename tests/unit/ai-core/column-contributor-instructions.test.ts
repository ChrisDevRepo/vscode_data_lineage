/** Model-facing contributor guidance preserves bindings and admits value inputs only as column sources. */
import { describe, expect, it } from 'vitest';
import { SubmitFindingsModelSchema } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';

const flow = SubmitFindingsModelSchema.shape.column_flow.unwrap().element;

describe('column contributor instructions', () => {
  it('advertises caller bindings and value-flow sources, and excludes row-selection keys', () => {
    const projected = toModelJsonSchema(SubmitFindingsModelSchema) as {
      properties: { column_flow: { items: { properties: { upstream_columns: { description: string } } } } };
    };
    const description = projected.properties.column_flow.items.properties.upstream_columns.description;
    expect(description).toContain('caller-bound value inputs');
    expect(description).toContain('only the real source columns whose value flows into out_col');
    expect(description).toContain('Resolve parameters and computed aliases to their source columns');
    expect(description).toContain('A column used only to join, filter, group, partition or order rows is not a source');
    expect(description).toContain('Exclude the entry’s own writes_to column and unused expressions');
    expect(description).toContain('writers upstream, readers downstream');
  });

  it('distinguishes aggregate values from grouping and row-selection roles', () => {
    const description = flow.shape.upstream_columns.element.shape.transforms.description!;
    expect(description).toContain('aggregate: value summarised by an aggregate');
    expect(description).toContain('compute: expression input, including a CASE condition operand');
    expect(description).toContain('combine: join, grouping, partition or ordering key');
    expect(description).toContain('filter: column in a WHERE or HAVING predicate that removes rows');
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
