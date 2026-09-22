import { coercedBoolean } from '../../../src/ai/support/inputNormalization';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import {
  GetScopeBundleInputSchema,
} from '../../../src/ai/tools/toolSchemas';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

describe("coerced-boolean tests", () => {
  const schema = z.object({ x: coercedBoolean().optional() });

  it.each([
    ['true', true],
    ['True', true],
    ['false', false],
    ['False', false],
    [true, true],
    [false, false],
  ])('%p decodes to boolean %p (non-inversion preserved)', (input, expected) => {
    const result = schema.safeParse({ x: input });
    expect(result.success && result.data.x === expected).toBe(true);
  });

  it("omitted field stays undefined (optional preserved)", () => {
    const omitted = schema.safeParse({});
    expect(omitted.success && omitted.data.x === undefined, 'omitted field stays undefined (optional preserved)').toBe(true);
  });

  it.each(['maybe', 1])('a non-boolean value %p rejects (not swallowed into a default, allowlist is string literals only)', (input) => {
    expect(!schema.safeParse({ x: input }).success).toBe(true);
  });

  it.each([
    ['true', true],
    ['false', false],
    [false, false],
  ])('include_ddl:%p parses to boolean %p at the real tool-schema boundary', (input, expected) => {
    const result = GetScopeBundleInputSchema.safeParse({ origin: '[s].[t]', include_ddl: input });
    expect(result.success && result.data.include_ddl === expected).toBe(true);
  });

  const coercedField = toModelJsonSchema(z.object({ x: coercedBoolean().optional() }));
  const plainField = toModelJsonSchema(z.object({ x: z.boolean().optional() }));
  it("coercedBoolean field renders byte-identical to a plain z.boolean() field", () => { expect(JSON.stringify(coercedField), 'coercedBoolean field renders byte-identical to a plain z.boolean() field').toBe(JSON.stringify(plainField)); });

});
