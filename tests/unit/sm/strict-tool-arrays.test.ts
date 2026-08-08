import { EntryDetectionSchema } from '../../../src/ai/agent/state';
import { normalizeStartExplorationInput } from '../../../src/ai/support/inputNormalization';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import {
  StartExplorationInputSchema,
  StartExplorationProviderInputSchema,
} from '../../../src/ai/tools/toolSchemas';
import { assert, assertEq } from '../helpers/testUtils';
import { describe, it } from 'vitest';

describe("strict-tool-arrays tests", () => {
  const PINNED_ENTRY_DETECTION_SCHEMA = '{"type":"object","properties":{"entry":{"type":"string","enum":["column_trace","visual_render","discovery"],"description":"Discrete entry route selected from the user request."},"targetColumns":{"description":"Explicit user-named columns for column_trace; null for discovery or visual_render.","anyOf":[{"type":"array","items":{"type":"string","minLength":1,"pattern":"^[^*%?]+$","description":"A real, user-named column identifier. NEVER a wildcard — if the user did not name a specific column, omit targetColumns entirely."}},{"type":"null"}]}},"required":["entry"],"additionalProperties":false}';
  const entryCoerced = EntryDetectionSchema.safeParse({ entry: 'column_trace', targetColumns: '["TotalRevenue"]' });
  it("entry detection accepts string-encoded array", () => { assert(entryCoerced.success, 'entry detection accepts string-encoded array'); });

  it("entry detection decodes to real array", () => { if (entryCoerced.success) {
    assertEq(JSON.stringify(entryCoerced.data.targetColumns), '["TotalRevenue"]', 'entry detection decodes to real array');
  } });

  const startCoerced = StartExplorationInputSchema.safeParse({
      origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: '["TotalRevenue","TaxAmt"]',
    });
  it("strict start schema accepts string-encoded CT array", () => { assert(startCoerced.success, 'strict start schema accepts string-encoded CT array'); });

  it("strict start schema decodes to real array", () => { if (startCoerced.success) {
    assertEq(JSON.stringify(startCoerced.data.targetColumns), '["TotalRevenue","TaxAmt"]', 'strict start schema decodes to real array');
  } });

  const providerCoerced = StartExplorationProviderInputSchema.safeParse({
      origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: '["TotalRevenue"]',
    });
  it("provider start schema decodes string-encoded CT array", () => { assert(providerCoerced.success && 'targetColumns' in providerCoerced.data && providerCoerced.data.targetColumns?.[0] === 'TotalRevenue', 'provider start schema decodes string-encoded CT array'); });

  const ct = StartExplorationInputSchema.safeParse({
      origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: ['TotalRevenue'],
    });
  it("real CT array remains valid", () => { assert(ct.success && ct.data.targetColumns?.[0] === 'TotalRevenue', 'real CT array remains valid'); });

  it("genuine wildcard element remains rejected", () => { assert(
    !StartExplorationInputSchema.safeParse({
      origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: ['*'],
    }).success,
    'genuine wildcard element remains rejected',
  ); });

  it("decoded wildcard element still rejected by ColumnIdentifierSchema", () => { assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: '["*"]' }).success,
    'decoded wildcard element still rejected by ColumnIdentifierSchema',
  ); });

  it("entry detection rejects plain (non-JSON) string", () => { assert(!EntryDetectionSchema.safeParse({ entry: 'column_trace', targetColumns: 'TotalRevenue' }).success, 'entry detection rejects plain (non-JSON) string'); });

  it("strict start schema rejects non-JSON string", () => { assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: 'not json [' }).success,
    'strict start schema rejects non-JSON string',
  ); });

  it("entry detection rejects string-encoded JSON object", () => { assert(!EntryDetectionSchema.safeParse({ entry: 'column_trace', targetColumns: '{"a":1}' }).success, 'entry detection rejects string-encoded JSON object'); });

  it("strict start schema rejects string-encoded JSON scalar", () => { assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: '"TotalRevenue"' }).success,
    'strict start schema rejects string-encoded JSON scalar',
  ); });

  it("omitted targetColumns defaults to null", () => { assert(EntryDetectionSchema.safeParse({ entry: 'discovery' }).success, 'omitted targetColumns defaults to null'); });

  it("explicit null remains valid", () => { assert(EntryDetectionSchema.safeParse({ entry: 'visual_render', targetColumns: null }).success, 'explicit null remains valid'); });

  const discoveryEmpty = EntryDetectionSchema.safeParse({ entry: 'discovery', targetColumns: [] });
  it("discovery with empty [] normalizes to null", () => { assert(discoveryEmpty.success && discoveryEmpty.data.targetColumns === null, 'discovery with empty [] normalizes to null'); });

  const renderEmpty = EntryDetectionSchema.safeParse({ entry: 'visual_render', targetColumns: [] });
  it("visual render with empty [] normalizes to null", () => { assert(renderEmpty.success && renderEmpty.data.targetColumns === null, 'visual render with empty [] normalizes to null'); });

  it("column trace with empty [] still rejects (needs named columns)", () => { assert(!EntryDetectionSchema.safeParse({ entry: 'column_trace', targetColumns: [] }).success, 'column trace with empty [] still rejects (needs named columns)'); });

  it("unknown entry fields reject", () => { assert(!EntryDetectionSchema.safeParse({ entry: 'discovery', extra: 1 }).success, 'unknown entry fields reject'); });

  it("entry-detection model schema bytes unchanged by preprocess/coercion", () => { assertEq(JSON.stringify(toModelJsonSchema(EntryDetectionSchema)), PINNED_ENTRY_DETECTION_SCHEMA, 'entry-detection model schema bytes unchanged by preprocess/coercion'); });

  const startModelSchema = toModelJsonSchema(StartExplorationProviderInputSchema);
  it("start_exploration model schema pins four mutually exclusive lifecycle branches", () => { assertEq((startModelSchema.anyOf as unknown[] | undefined)?.length, 4, 'start_exploration model schema pins four mutually exclusive lifecycle branches'); });

  it("BB with string-encoded named targetColumns rejected (mode/field conflict survives decode)", () => { assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', targetColumns: '["TotalDue"]' }).success,
    'BB with string-encoded named targetColumns rejected (mode/field conflict survives decode)',
  ); });

  const raw = {
      origin: '[s].[t]',
      analysisMode: 'bb',
      classification: 'business',
      targetColumns: [] as string[],
    };
  const normalized = normalizeStartExplorationInput(raw, 'bb');
  it("actual empty BB array normalizes to property absence", () => { assert(!('targetColumns' in normalized.input), 'actual empty BB array normalizes to property absence'); });

  it("one normalization is observable", () => { assertEq(normalized.normalizations.length, 1, 'one normalization is observable'); });

  it("normalization reason is stable", () => { assertEq(normalized.normalizations[0]?.reason, 'empty_bb_array_to_absence', 'normalization reason is stable'); });

  it("normalization does not mutate the raw payload", () => { assert('targetColumns' in raw, 'normalization does not mutate the raw payload'); });

  const bbEmptyString = normalizeStartExplorationInput({ ...raw, targetColumns: '[]' }, 'bb');
  it("string-encoded BB \"[]\" normalizes to property absence", () => { assert(!('targetColumns' in bbEmptyString.input), 'string-encoded BB "[]" normalizes to property absence'); });

  it("both normalization events observable for DEBUG logging", () => { assertEq(
    bbEmptyString.normalizations.map(n => n.reason).join(','),
    'string_encoded_array_to_array,empty_bb_array_to_absence',
    'both normalization events observable for DEBUG logging',
  ); });

  const rawImmutable = { origin: '[s].[t]', targetColumns: '["A"]' };
  const decodedResult = normalizeStartExplorationInput(rawImmutable);
  it("normalizeStartExplorationInput decodes string-encoded array", () => { assert(Array.isArray(decodedResult.input.targetColumns), 'normalizeStartExplorationInput decodes string-encoded array'); });

  it("normalization never mutates the raw model input", () => { assert(rawImmutable.targetColumns === '["A"]', 'normalization never mutates the raw model input'); });

});
