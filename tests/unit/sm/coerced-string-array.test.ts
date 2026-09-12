import { coercedBoolean } from '../../../src/ai/support/inputNormalization';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import {
  GetScopeBundleInputSchema,
} from '../../../src/ai/tools/toolSchemas';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

describe("coerced-boolean tests", () => {
  const trueLower = z.object({ x: coercedBoolean().optional() }).safeParse({ x: 'true' });
  it("\"true\" decodes to boolean true", () => { expect(trueLower.success && trueLower.data.x === true, '"true" decodes to boolean true').toBe(true); });

  const trueUpper = z.object({ x: coercedBoolean().optional() }).safeParse({ x: 'True' });
  it("\"True\" decodes to boolean true", () => { expect(trueUpper.success && trueUpper.data.x === true, '"True" decodes to boolean true').toBe(true); });

  const falseLower = z.object({ x: coercedBoolean().optional() }).safeParse({ x: 'false' });
  it("\"false\" parses successfully", () => { expect(falseLower.success, '"false" parses successfully').toBe(true); });

  it("\"false\" decodes to boolean false, NOT true (non-inversion)", () => { expect(falseLower.success ? falseLower.data.x : undefined, '"false" decodes to boolean false, NOT true (non-inversion)').toBe(false); });

  const falseUpper = z.object({ x: coercedBoolean().optional() }).safeParse({ x: 'False' });
  it("\"False\" parses successfully", () => { expect(falseUpper.success, '"False" parses successfully').toBe(true); });

  it("\"False\" decodes to boolean false, NOT true (non-inversion)", () => { expect(falseUpper.success ? falseUpper.data.x : undefined, '"False" decodes to boolean false, NOT true (non-inversion)').toBe(false); });

  const genuineTrue = z.object({ x: coercedBoolean().optional() }).safeParse({ x: true });
  it("genuine `true` remains `true`", () => { expect(genuineTrue.success && genuineTrue.data.x === true, 'genuine `true` remains `true`').toBe(true); });

  const genuineFalse = z.object({ x: coercedBoolean().optional() }).safeParse({ x: false });
  it("genuine `false` remains `false`", () => { expect(genuineFalse.success && genuineFalse.data.x === false, 'genuine `false` remains `false`').toBe(true); });

  const omitted = z.object({ x: coercedBoolean().optional() }).safeParse({});
  it("omitted field stays undefined (optional preserved)", () => { expect(omitted.success && omitted.data.x === undefined, 'omitted field stays undefined (optional preserved)').toBe(true); });

  it("an arbitrary non-boolean string still rejects (not swallowed into a default)", () => { expect(!z.object({ x: coercedBoolean().optional() }).safeParse({ x: 'maybe' }).success, 'an arbitrary non-boolean string still rejects (not swallowed into a default)').toBe(true); });

  it("a number still rejects — allowlist is string literals only", () => { expect(!z.object({ x: coercedBoolean().optional() }).safeParse({ x: 1 }).success, 'a number still rejects — allowlist is string literals only').toBe(true); });

  const ddlTrueString = GetScopeBundleInputSchema.safeParse({ origin: '[s].[t]', include_ddl: 'true' });
  it("include_ddl:\"true\" parses to boolean true", () => { expect(ddlTrueString.success && ddlTrueString.data.include_ddl === true, 'include_ddl:"true" parses to boolean true').toBe(true); });

  const ddlFalseString = GetScopeBundleInputSchema.safeParse({ origin: '[s].[t]', include_ddl: 'false' });
  it("include_ddl:\"false\" parses successfully", () => { expect(ddlFalseString.success, 'include_ddl:"false" parses successfully').toBe(true); });

  it("include_ddl:\"false\" parses to boolean false, NOT true (non-inversion at the real boundary)", () => { expect(ddlFalseString.success ? ddlFalseString.data.include_ddl : undefined, 'include_ddl:"false" parses to boolean false, NOT true (non-inversion at the real boundary)').toBe(false); });

  const ddlGenuine = GetScopeBundleInputSchema.safeParse({ origin: '[s].[t]', include_ddl: false });
  it("include_ddl genuine false remains false", () => { expect(ddlGenuine.success && ddlGenuine.data.include_ddl === false, 'include_ddl genuine false remains false').toBe(true); });

  const coercedField = toModelJsonSchema(z.object({ x: coercedBoolean().optional() }));
  const plainField = toModelJsonSchema(z.object({ x: z.boolean().optional() }));
  it("coercedBoolean field renders byte-identical to a plain z.boolean() field", () => { expect(JSON.stringify(coercedField), 'coercedBoolean field renders byte-identical to a plain z.boolean() field').toBe(JSON.stringify(plainField)); });

});
