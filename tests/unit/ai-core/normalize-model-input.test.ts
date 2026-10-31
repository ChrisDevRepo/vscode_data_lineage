/** Format-only normalization at the model boundary: decode once, log, then the normal checks. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  markObjectIdField,
  normalizeModelInput,
} from '../../../src/ai/tools/normalizeModelInput';

const schema = z
  .object({
    rows: z.array(z.object({ id: z.string(), n: z.number(), on: z.boolean() })),
    meta: z.object({ label: z.string() }).optional(),
    name: z.string(),
  })
  .strict();

describe('normalizeModelInput', () => {
  it('decodes JSON text where the schema expects a list or object, and logs each path', () => {
    const input = {
      rows: '[{"id":"a","n":"3","on":"true"}]',
      meta: '{"label":"x"}',
      name: '[1]',
    };
    const result = normalizeModelInput(schema, input);
    expect(schema.safeParse(result.input).success).toBe(true);
    expect(result.input).toEqual({
      rows: [{ id: 'a', n: 3, on: true }],
      meta: { label: 'x' },
      name: '[1]',
    });
    expect(result.fixes.map((fix) => fix.path).sort()).toEqual([
      'meta',
      'rows',
      'rows.0.n',
      'rows.0.on',
    ]);
  });

  it('leaves broken, wrong-type or inexact text as sent so the schema rejects it', () => {
    for (const rows of ['[{"id":"a"', '{"id":"a"}', '"[]"']) {
      const result = normalizeModelInput(schema, { rows, name: 'n' });
      expect(result.fixes).toEqual([]);
      expect(result.input).toEqual({ rows, name: 'n' });
    }
    const inexact = normalizeModelInput(schema, {
      rows: [{ id: 'a', n: '3 rows', on: 'yes' }],
      name: 'n',
    });
    expect(inexact.fixes).toEqual([]);
    expect(schema.safeParse(inexact.input).success).toBe(false);
  });
});

describe('normalizeModelInput object ids', () => {
  const idField = (ids: string[]) => {
    const field = z.string().refine((value) => ids.includes(value));
    markObjectIdField(field, new Map(ids.map((id) => [id, true])), false);
    return field;
  };
  const idsSchema = (ids: string[]) =>
    z
      .object({
        prune: z.array(z.object({ id: idField(ids) })).optional(),
        nodeId: idField(ids).describe('kept through a clone').optional(),
      })
      .strict();

  it('rewrites an id spelling to the one admitted id, at any depth, and logs it', () => {
    const schema = idsSchema(['[dbo].[FactSales]', '[dbo].[DimDate]']);
    const result = normalizeModelInput(schema, {
      prune: [{ id: 'dbo.factsales' }],
      nodeId: '\u200b[DBO].[DimDate]',
    });
    expect(result.input).toEqual({
      prune: [{ id: '[dbo].[FactSales]' }],
      nodeId: '[dbo].[DimDate]',
    });
    expect(result.fixes.map((fix) => fix.path)).toEqual([
      'prune.0.id',
      'nodeId',
    ]);
    expect(schema.safeParse(result.input).success).toBe(true);
  });

  it('leaves an unknown, fuzzy or ambiguous id as sent', () => {
    const schema = idsSchema(['[dbo].[A]', '[DBO].[a]', '[dbo].[FactSales]']);
    for (const nodeId of ['dbo.a', 'dbo.FactSale', 'sales.FactSales']) {
      const result = normalizeModelInput(schema, { nodeId });
      expect(result.fixes).toEqual([]);
      expect(result.input).toEqual({ nodeId });
    }
    const union = z.union([
      z
        .object({ nodeId: idField(['[dbo].[FactSales]']), other: z.number() })
        .strict(),
      z
        .object({ nodeId: idField(['[sales].[FactSales]']), other: z.number() })
        .strict(),
    ]);
    const ambiguous = { nodeId: 'FactSales', other: 'bad' };
    expect(normalizeModelInput(union, ambiguous)).toEqual({
      input: ambiguous,
      fixes: [],
    });
  });
});
