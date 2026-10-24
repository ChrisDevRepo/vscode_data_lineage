import { describe, expect, it } from 'vitest';
import { applyAllowlistFilter } from '../../../src/engine/modelFilters';
import type { DatabaseModel } from '../../../src/engine/types';

const model: DatabaseModel = {
  nodes: ['Sales', 'sales'].map(schema => ({ id: `[${schema}].[Orders]`, schema, name: 'Orders', fullName: `${schema}.Orders`, type: 'table' })),
  edges: [{ source: '[Sales].[Orders]', target: '[sales].[Orders]', type: 'body' }],
  schemas: [], catalog: {}, neighborIndex: {}, identifierCaseSensitive: true,
};

describe('allowlist scope', () => {
  it('leaves an unscoped model unchanged', () => {
    expect(applyAllowlistFilter(model, undefined)).toBe(model);
  });

  it.each([[], ['absent'], ['[Sales].[Orders]'], ['[Sales].[Orders]', '[sales].[Orders]']].map(ids => ({ ids })))('retains only exact scoped IDs: $ids', ({ ids }) => {
    const filtered = applyAllowlistFilter(model, new Set(ids));
    expect(filtered.nodes.map(n => n.id)).toEqual(ids.filter(id => id !== 'absent'));
    expect(filtered.edges).toHaveLength(ids.length === 2 ? 1 : 0);
    expect(model.nodes).toHaveLength(2);
  });
});
