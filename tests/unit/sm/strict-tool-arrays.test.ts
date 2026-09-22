import { EntryDetectionSchema } from '../../../src/ai/agent/state';
import { droppedKeyPaths, normalizeStartExplorationInput } from '../../../src/ai/support/inputNormalization';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import {
  PresentResultModelSchema,
  StartExplorationInputSchema,
  StartExplorationProviderInputSchema,
  SubmitFindingsBbInputSchema,
} from '../../../src/ai/tools/toolSchemas';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

describe("strict-tool-arrays tests", () => {
  const PINNED_ENTRY_DETECTION_SCHEMA = '{"type":"object","properties":{"entry":{"type":"string","enum":["column_trace","visual_render","discovery"],"description":"Discrete entry route selected from the user request."},"targetColumns":{"description":"Explicit user-named columns for column_trace; null for discovery or visual_render.","anyOf":[{"type":"array","items":{"type":"string","minLength":1,"pattern":"^[^*%?]+$","description":"A column the user named verbatim. When the user named no specific column, omit targetColumns; wildcards are rejected at the boundary."}},{"type":"null"}]}},"required":["entry"],"additionalProperties":false}';
  const entryCoerced = EntryDetectionSchema.safeParse({ entry: 'column_trace', targetColumns: '["TotalRevenue"]' });
  it("entry detection accepts string-encoded array", () => { expect(entryCoerced.success, 'entry detection accepts string-encoded array').toBe(true); });

  it("entry detection decodes to real array", () => {
    expect(entryCoerced.success, 'entry detection accepts string-encoded array').toBe(true);
    if (!entryCoerced.success) return;
    expect(JSON.stringify(entryCoerced.data.targetColumns), 'entry detection decodes to real array').toBe('["TotalRevenue"]');
  });

  const startCoerced = StartExplorationInputSchema.safeParse({
      origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: '["TotalRevenue","TaxAmt"]',
    });
  it("strict start schema accepts string-encoded CT array", () => { expect(startCoerced.success, 'strict start schema accepts string-encoded CT array').toBe(true); });

  it("strict start schema decodes to real array", () => {
    expect(startCoerced.success, 'strict start schema accepts string-encoded CT array').toBe(true);
    if (!startCoerced.success) return;
    expect(JSON.stringify(startCoerced.data.targetColumns), 'strict start schema decodes to real array').toBe('["TotalRevenue","TaxAmt"]');
  });

  const providerCoerced = StartExplorationProviderInputSchema.safeParse({
      origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: '["TotalRevenue"]',
    });
  it("provider start schema decodes string-encoded CT array", () => { expect(providerCoerced.success && 'targetColumns' in providerCoerced.data && providerCoerced.data.targetColumns?.[0] === 'TotalRevenue', 'provider start schema decodes string-encoded CT array').toBe(true); });

  const ct = StartExplorationInputSchema.safeParse({
      origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: ['TotalRevenue'],
    });
  it("real CT array remains valid", () => { expect(ct.success && ct.data.targetColumns?.[0] === 'TotalRevenue', 'real CT array remains valid').toBe(true); });

  it("genuine wildcard element remains rejected", () => { expect(!StartExplorationInputSchema.safeParse({
      origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: ['*'],
    }).success, 'genuine wildcard element remains rejected').toBe(true); });

  it("decoded wildcard element still rejected by ColumnIdentifierSchema", () => { expect(!StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: '["*"]' }).success, 'decoded wildcard element still rejected by ColumnIdentifierSchema').toBe(true); });

  it("entry detection rejects plain (non-JSON) string", () => { expect(!EntryDetectionSchema.safeParse({ entry: 'column_trace', targetColumns: 'TotalRevenue' }).success, 'entry detection rejects plain (non-JSON) string').toBe(true); });

  it("strict start schema rejects non-JSON string", () => { expect(!StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: 'not json [' }).success, 'strict start schema rejects non-JSON string').toBe(true); });

  it("entry detection rejects string-encoded JSON object", () => { expect(!EntryDetectionSchema.safeParse({ entry: 'column_trace', targetColumns: '{"a":1}' }).success, 'entry detection rejects string-encoded JSON object').toBe(true); });

  it("strict start schema rejects string-encoded JSON scalar", () => { expect(!StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'ct', classification: 'business', targetColumns: '"TotalRevenue"' }).success, 'strict start schema rejects string-encoded JSON scalar').toBe(true); });

  it("omitted targetColumns defaults to null", () => { expect(EntryDetectionSchema.safeParse({ entry: 'discovery' }).success, 'omitted targetColumns defaults to null').toBe(true); });

  it("explicit null remains valid", () => { expect(EntryDetectionSchema.safeParse({ entry: 'visual_render', targetColumns: null }).success, 'explicit null remains valid').toBe(true); });

  const discoveryEmpty = EntryDetectionSchema.safeParse({ entry: 'discovery', targetColumns: [] });
  it("discovery with empty [] normalizes to null", () => { expect(discoveryEmpty.success && discoveryEmpty.data.targetColumns === null, 'discovery with empty [] normalizes to null').toBe(true); });

  const renderEmpty = EntryDetectionSchema.safeParse({ entry: 'visual_render', targetColumns: [] });
  it("visual render with empty [] normalizes to null", () => { expect(renderEmpty.success && renderEmpty.data.targetColumns === null, 'visual render with empty [] normalizes to null').toBe(true); });

  it("column trace with empty [] still rejects (needs named columns)", () => { expect(!EntryDetectionSchema.safeParse({ entry: 'column_trace', targetColumns: [] }).success, 'column trace with empty [] still rejects (needs named columns)').toBe(true); });

  it("unknown entry fields reject", () => { expect(!EntryDetectionSchema.safeParse({ entry: 'discovery', extra: 1 }).success, 'unknown entry fields reject').toBe(true); });

  it("entry-detection model schema bytes unchanged by preprocess/coercion", () => { expect(JSON.stringify(toModelJsonSchema(EntryDetectionSchema)), 'entry-detection model schema bytes unchanged by preprocess/coercion').toBe(PINNED_ENTRY_DETECTION_SCHEMA); });

  const startModelSchema = toModelJsonSchema(StartExplorationProviderInputSchema);
  it("start_exploration model schema pins four mutually exclusive lifecycle branches", () => { expect((startModelSchema.anyOf as unknown[] | undefined)?.length, 'start_exploration model schema pins four mutually exclusive lifecycle branches').toBe(4); });

  it("BB with string-encoded named targetColumns rejected (mode/field conflict survives decode)", () => { expect(!StartExplorationInputSchema.safeParse({ origin: '[s].[t]', analysisMode: 'bb', classification: 'business', targetColumns: '["TotalDue"]' }).success, 'BB with string-encoded named targetColumns rejected (mode/field conflict survives decode)').toBe(true); });

  const raw = {
      origin: '[s].[t]',
      analysisMode: 'bb',
      classification: 'business',
      targetColumns: [] as string[],
    };
  const normalized = normalizeStartExplorationInput(raw, 'bb');
  it("actual empty BB array normalizes to property absence", () => { expect(!('targetColumns' in normalized.input), 'actual empty BB array normalizes to property absence').toBe(true); });

  it("one normalization is observable", () => { expect(normalized.normalizations.length, 'one normalization is observable').toBe(1); });

  it("normalization reason is stable", () => { expect(normalized.normalizations[0]?.reason, 'normalization reason is stable').toBe('empty_bb_array_to_absence'); });

  it("normalization does not mutate the raw payload", () => { expect('targetColumns' in raw, 'normalization does not mutate the raw payload').toBe(true); });

  const bbEmptyString = normalizeStartExplorationInput({ ...raw, targetColumns: '[]' }, 'bb');
  it("string-encoded BB \"[]\" normalizes to property absence", () => { expect(!('targetColumns' in bbEmptyString.input), 'string-encoded BB "[]" normalizes to property absence').toBe(true); });

  it("both normalization events observable for DEBUG logging", () => { expect(bbEmptyString.normalizations.map(n => n.reason).join(','), 'both normalization events observable for DEBUG logging').toBe('string_encoded_array_to_array,empty_bb_array_to_absence'); });

  const rawImmutable = { origin: '[s].[t]', targetColumns: '["A"]' };
  const decodedResult = normalizeStartExplorationInput(rawImmutable);
  it("normalizeStartExplorationInput decodes string-encoded array", () => { expect(Array.isArray(decodedResult.input.targetColumns), 'normalizeStartExplorationInput decodes string-encoded array').toBe(true); });

  it("normalization never mutates the raw model input", () => { expect(rawImmutable.targetColumns === '["A"]', 'normalization never mutates the raw model input').toBe(true); });

  const nullStringDiscovery = EntryDetectionSchema.safeParse({ entry: 'discovery', targetColumns: 'null' });
  it("string-encoded \"null\" normalizes to real null", () => { expect(nullStringDiscovery.success && nullStringDiscovery.data.targetColumns === null, 'string-encoded "null" normalizes to real null').toBe(true); });

  it("string-encoded \"null\" satisfies visual_render (forbids targetColumns)", () => { expect(EntryDetectionSchema.safeParse({ entry: 'visual_render', targetColumns: 'null' }).success, 'string-encoded "null" satisfies visual_render').toBe(true); });

  it("string-encoded \"null\" still fails column_trace (needs named columns)", () => { expect(!EntryDetectionSchema.safeParse({ entry: 'column_trace', targetColumns: 'null' }).success, 'string-encoded "null" still fails column_trace').toBe(true); });

  it("genuine null remains valid", () => { expect(EntryDetectionSchema.safeParse({ entry: 'discovery', targetColumns: null }).success, 'genuine null remains valid').toBe(true); });

  it("string-encoded \"Null\" is NOT unwrapped (allowlist is exact)", () => { expect(!EntryDetectionSchema.safeParse({ entry: 'discovery', targetColumns: 'Null' }).success, 'string-encoded "Null" is not unwrapped').toBe(true); });

  it("string-encoded \"nullish\" is NOT unwrapped", () => { expect(!EntryDetectionSchema.safeParse({ entry: 'discovery', targetColumns: 'nullish' }).success, 'string-encoded "nullish" is not unwrapped').toBe(true); });

});

// `sections` arriving JSON-string-encoded is the same shape `targetColumns` already absorbs.
describe("string-encoded sections", () => {
  const encodedSubmit = SubmitFindingsBbInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: '[{"angle": "business", "text": "Grounded analysis."}]',
    summary: 'ok',
    verdict: 'analyze',
  });

  it("submit_findings accepts string-encoded sections", () => {
    expect(encodedSubmit.success, 'submit_findings accepts string-encoded sections').toBe(true);
  });

  it("submit_findings decodes sections to a real array", () => {
    expect(encodedSubmit.success && encodedSubmit.data.sections[0]?.angle === 'business',
      'submit_findings decodes sections to a real array').toBe(true);
  });

  it("a real sections array remains valid", () => {
    expect(SubmitFindingsBbInputSchema.safeParse({
      focus_node_id: '[dbo].[vSales]',
      sections: [{ angle: 'business', text: 'ok' }],
      summary: 'ok',
      verdict: 'analyze',
    }).success, 'a real sections array remains valid').toBe(true);
  });

  it("a string that is not encoded JSON is still rejected", () => {
    expect(!SubmitFindingsBbInputSchema.safeParse({
      focus_node_id: '[dbo].[vSales]',
      sections: 'business: the view carries ListPrice through unchanged',
      summary: 'ok',
      verdict: 'analyze',
    }).success, 'a string that is not encoded JSON is still rejected').toBe(true);
  });

  it("a decoded element that violates the element schema is still rejected", () => {
    expect(!SubmitFindingsBbInputSchema.safeParse({
      focus_node_id: '[dbo].[vSales]',
      sections: '[{"angle": "commercial", "text": "ok"}]',
      summary: 'ok',
      verdict: 'analyze',
    }).success, 'a decoded element that violates the element schema is still rejected').toBe(true);
  });

  it("present_result accepts string-encoded sections", () => {
    expect(PresentResultModelSchema.safeParse({
      name: 'Sales lineage',
      summary: 'One line.',
      highlight_groups: [{ label: 'Target', color: 'target', node_ids: ['[dbo].[vSales]'] }],
      sections: '[{"label": "Upstream Inputs", "text": "Grounded detail."}]',
    }).success, 'present_result accepts string-encoded sections').toBe(true);
  });

  it("an uncoerced array schema rejects the same payload — the coercion is what changed it", () => {
    // Pins the counterfactual a stash would have shown: the string parses only because
    // `sections` is wrapped; a bare `z.array()` of the same element rejects it outright.
    const uncoerced = z.array(z.object({ angle: z.enum(['business', 'technical']), text: z.string() }).strict());
    expect(!uncoerced.safeParse('[{"angle": "business", "text": "Grounded analysis."}]').success,
      'an uncoerced array schema rejects the same payload').toBe(true);
  });

  it("the model-facing submit_findings schema bytes are unchanged by the coercion", () => {
    const rendered = JSON.stringify(toModelJsonSchema(SubmitFindingsBbInputSchema));
    expect(rendered.includes('"sections"') && !rendered.includes('preprocess'),
      'the model-facing submit_findings schema bytes are unchanged by the coercion').toBe(true);
  });
});

// route_requests and prune_neighbors arriving JSON-string-encoded is the same asymmetry sections
// already absorbs: the same generation emitted both sections (accepted) and route_requests
// (rejected as invalid_tool_input) string-encoded, because sections alone used coercedStringArray.
describe("string-encoded route_requests and prune_neighbors", () => {
  const arrayForm = SubmitFindingsBbInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    route_requests: [{ nodeId: '[dbo].[vOrders]', question: 'Does vOrders carry TotalDue unchanged?' }],
    prune_neighbors: ['[dbo].[vDead]'],
  });

  const stringEncoded = SubmitFindingsBbInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    route_requests: '[{"nodeId":"[dbo].[vOrders]","question":"Does vOrders carry TotalDue unchanged?"}]',
    prune_neighbors: '["[dbo].[vDead]"]',
  });

  it("submit_findings accepts string-encoded route_requests and prune_neighbors", () => {
    expect(stringEncoded.success, 'submit_findings accepts string-encoded route_requests and prune_neighbors').toBe(true);
  });

  it("string-encoded and array forms parse to the same value", () => {
    expect(arrayForm.success && stringEncoded.success && JSON.stringify(stringEncoded.data.route_requests) === JSON.stringify(arrayForm.data.route_requests)
      && JSON.stringify(stringEncoded.data.prune_neighbors) === JSON.stringify(arrayForm.data.prune_neighbors),
      'string-encoded and array forms parse to the same value').toBe(true);
  });
});

describe('droppedKeyPaths', () => {
  it('names every key a parse stripped, and nothing a parse only normalized', () => {
    const raw = { column_flow: [{ out_col: 'a', bogus: 1, writes_to: null }], note: '{"x":1}' };
    const parsed = { column_flow: [{ out_col: 'a' }], note: { x: 1 } };
    expect(droppedKeyPaths(raw, parsed)).toEqual(['column_flow.0.bogus']);
    expect(droppedKeyPaths(parsed, parsed)).toEqual([]);
  });
});
