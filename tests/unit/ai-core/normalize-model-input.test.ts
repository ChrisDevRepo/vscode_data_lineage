/** Format-only normalization at the model boundary (D-043, D-044): decode once, log, then the normal checks. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { normalizeModelInput } from '../../../src/ai/tools/normalizeModelInput';

const schema = z.object({
  rows: z.array(z.object({ id: z.string(), n: z.number(), on: z.boolean() })),
  meta: z.object({ label: z.string() }).optional(),
  name: z.string(),
}).strict();

describe('normalizeModelInput', () => {
  it('decodes JSON text where the schema expects a list or object, and logs each path', () => {
    const input = { rows: '[{"id":"a","n":"3","on":"true"}]', meta: '{"label":"x"}', name: '[1]' };
    const result = normalizeModelInput(schema, input);
    expect(schema.safeParse(result.input).success).toBe(true);
    expect(result.input).toEqual({ rows: [{ id: 'a', n: 3, on: true }], meta: { label: 'x' }, name: '[1]' });
    expect(result.fixes.map(fix => fix.path).sort()).toEqual(['meta', 'rows', 'rows.0.n', 'rows.0.on']);
  });

  it('leaves broken, wrong-type or inexact text as sent so the schema rejects it', () => {
    for (const rows of ['[{"id":"a"', '{"id":"a"}', '"[]"']) {
      const result = normalizeModelInput(schema, { rows, name: 'n' });
      expect(result.fixes).toEqual([]);
      expect(result.input).toEqual({ rows, name: 'n' });
    }
    const inexact = normalizeModelInput(schema, { rows: [{ id: 'a', n: '3 rows', on: 'yes' }], name: 'n' });
    expect(inexact.fixes).toEqual([]);
    expect(schema.safeParse(inexact.input).success).toBe(false);
  });

  it('returns the same object when nothing needs a fix', () => {
    const input = { rows: [], name: 'n' };
    expect(normalizeModelInput(schema, input).input).toBe(input);
  });
});
