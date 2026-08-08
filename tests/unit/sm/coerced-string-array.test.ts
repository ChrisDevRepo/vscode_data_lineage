import { coercedBoolean } from '../../../src/ai/support/inputNormalization';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import {
  GetScopeBundleInputSchema,
} from '../../../src/ai/tools/toolSchemas';
import { z } from 'zod';
import { assert, assertEq } from '../helpers/testUtils';
import { describe, it } from 'vitest';

describe("coerced-boolean tests", () => {
  const trueLower = z.object({ x: coercedBoolean().optional() }).safeParse({ x: 'true' });
  it("\"true\" decodes to boolean true", () => { assert(trueLower.success && trueLower.data.x === true, '"true" decodes to boolean true'); });

  const trueUpper = z.object({ x: coercedBoolean().optional() }).safeParse({ x: 'True' });
  it("\"True\" decodes to boolean true", () => { assert(trueUpper.success && trueUpper.data.x === true, '"True" decodes to boolean true'); });

  const falseLower = z.object({ x: coercedBoolean().optional() }).safeParse({ x: 'false' });
  it("\"false\" parses successfully", () => { assert(falseLower.success, '"false" parses successfully'); });

  it("\"false\" decodes to boolean false, NOT true (non-inversion)", () => { assertEq(falseLower.success ? falseLower.data.x : undefined, false, '"false" decodes to boolean false, NOT true (non-inversion)'); });

  const falseUpper = z.object({ x: coercedBoolean().optional() }).safeParse({ x: 'False' });
  it("\"False\" parses successfully", () => { assert(falseUpper.success, '"False" parses successfully'); });

  it("\"False\" decodes to boolean false, NOT true (non-inversion)", () => { assertEq(falseUpper.success ? falseUpper.data.x : undefined, false, '"False" decodes to boolean false, NOT true (non-inversion)'); });

  const genuineTrue = z.object({ x: coercedBoolean().optional() }).safeParse({ x: true });
  it("genuine `true` remains `true`", () => { assert(genuineTrue.success && genuineTrue.data.x === true, 'genuine `true` remains `true`'); });

  const genuineFalse = z.object({ x: coercedBoolean().optional() }).safeParse({ x: false });
  it("genuine `false` remains `false`", () => { assert(genuineFalse.success && genuineFalse.data.x === false, 'genuine `false` remains `false`'); });

  const omitted = z.object({ x: coercedBoolean().optional() }).safeParse({});
  it("omitted field stays undefined (optional preserved)", () => { assert(omitted.success && omitted.data.x === undefined, 'omitted field stays undefined (optional preserved)'); });

  it("an arbitrary non-boolean string still rejects (not swallowed into a default)", () => { assert(
    !z.object({ x: coercedBoolean().optional() }).safeParse({ x: 'maybe' }).success,
    'an arbitrary non-boolean string still rejects (not swallowed into a default)',
  ); });

  it("a number still rejects — allowlist is string literals only", () => { assert(
    !z.object({ x: coercedBoolean().optional() }).safeParse({ x: 1 }).success,
    'a number still rejects — allowlist is string literals only',
  ); });

  const ddlTrueString = GetScopeBundleInputSchema.safeParse({ origin: '[s].[t]', include_ddl: 'true' });
  it("include_ddl:\"true\" parses to boolean true", () => { assert(ddlTrueString.success && ddlTrueString.data.include_ddl === true, 'include_ddl:"true" parses to boolean true'); });

  const ddlFalseString = GetScopeBundleInputSchema.safeParse({ origin: '[s].[t]', include_ddl: 'false' });
  it("include_ddl:\"false\" parses successfully", () => { assert(ddlFalseString.success, 'include_ddl:"false" parses successfully'); });

  it("include_ddl:\"false\" parses to boolean false, NOT true (non-inversion at the real boundary)", () => { assertEq(
    ddlFalseString.success ? ddlFalseString.data.include_ddl : undefined,
    false,
    'include_ddl:"false" parses to boolean false, NOT true (non-inversion at the real boundary)',
  ); });

  const ddlGenuine = GetScopeBundleInputSchema.safeParse({ origin: '[s].[t]', include_ddl: false });
  it("include_ddl genuine false remains false", () => { assert(ddlGenuine.success && ddlGenuine.data.include_ddl === false, 'include_ddl genuine false remains false'); });

  const coercedField = toModelJsonSchema(z.object({ x: coercedBoolean().optional() }));
  const plainField = toModelJsonSchema(z.object({ x: z.boolean().optional() }));
  it("coercedBoolean field renders byte-identical to a plain z.boolean() field", () => { assertEq(JSON.stringify(coercedField), JSON.stringify(plainField), 'coercedBoolean field renders byte-identical to a plain z.boolean() field'); });

});
