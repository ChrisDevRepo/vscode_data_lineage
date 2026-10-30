/** Format-only normalization at the model boundary: decode once, log, then the normal checks. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as vscode from 'vscode';
import { HumanMessage } from '@langchain/core/messages';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import { markObjectIdField, normalizeModelInput } from '../../../src/ai/tools/normalizeModelInput';
import { ExplorationDepthSelectionSchema } from '../../../src/engine/shared/explorationDepthContract';
import { GetScopeBundleInputSchema, SearchObjectsInputSchema, StartExplorationFreshProviderInputSchema } from '../../../src/ai/tools/toolSchemas';

const schema = z.object({
  rows: z.array(z.object({ id: z.string(), n: z.number(), on: z.boolean() })),
  meta: z.object({ label: z.string() }).optional(),
  name: z.string(),
}).strict();

describe('normalizeModelInput', () => {
  it.each([z.literal(1), z.literal([1, 2, 3]), z.enum({ one: 1, two: 2, three: 3 })])(
    'normalizes an exact numeric member of a literal or enum without guessing another member', owner => {
      expect(normalizeModelInput(owner, '1')).toEqual({ input: 1, fixes: [{ path: '', before: '1', after: 1 }] });
      for (const input of [null, 'three', 'one', '4']) expect(normalizeModelInput(owner, input)).toEqual({ input, fixes: [] });
    },
  );
  it('preserves valid string members while normalizing only uniquely admitted numeric or boolean literals', () => {
    for (const owner of [z.enum(['1', '2']), z.literal([1, '1'])]) {
      expect(normalizeModelInput(owner, '1')).toEqual({ input: '1', fixes: [] });
    }
    expect(normalizeModelInput(z.literal([1, true]), 'true')).toEqual({ input: true, fixes: [{ path: '', before: 'true', after: true }] });
  });
  it.each([
    '{"business":"First authored body","business":"Different authored body"}',
    '{"nested":{"business":"First","business":"Second"}}',
    String.raw`{"business":"First","\u0062usiness":"Second"}`,
    '{"business":"Same","business":"Same"}',
  ])('leaves duplicate object entries untouched rather than selecting a value: %s', input => {
    const shape = z.object({ business: z.string().optional(), nested: z.object({ business: z.string() }).optional() });
    expect(normalizeModelInput(shape, input)).toEqual({ input, fixes: [] });
    expect(shape.safeParse(normalizeModelInput(shape, input).input).success).toBe(false);
  });

  it('preserves duplicate-like prose and independent object keys while decoding structured text', () => {
    const value = { text: '"business":"First","business":"Second"', rows: [{ name: 'A' }, { name: 'B' }], nested: { name: 'C' } };
    const input = JSON.stringify(value);
    expect(normalizeModelInput(z.object({ text: z.string(), rows: z.array(z.object({ name: z.string() })), nested: z.object({ name: z.string() }) }), input).input).toEqual(value);
  });

  it('preserves every raw C0 character in structured string values and logs the conversion', () => {
    for (let code = 0; code < 0x20; code += 1) {
      const char = String.fromCharCode(code);
      const meta = `{"label":"before${char}after"}`;
      const input = { rows: [], meta, name: 'n' };
      const result = normalizeModelInput(schema, input);
      expect(result.input).toEqual({ ...input, meta: { label: `before${char}after` } });
      expect(result.fixes).toEqual([{ path: 'meta', before: meta, after: { label: `before${char}after` } }]);
      expect(input.meta).toBe(meta);
      const key = `{"before${char}after":"value"}`;
      expect(normalizeModelInput(z.record(z.string(), z.string()), key)).toEqual({ input: key, fixes: [] });
    }
  });

  it('normalizes literal newlines in nested array values without changing standard escapes or accepted strings', () => {
    const input = '[{"text":"line one\nline two\\nlast"}]';
    const array = z.array(z.object({ text: z.string() }));
    expect(normalizeModelInput(array, input).input).toEqual([{ text: 'line one\nline two\nlast' }]);
    expect(normalizeModelInput(z.string(), input)).toEqual({ input, fixes: [] });
    const ambiguous = z.union([z.object({ x: z.number(), text: z.string() }), z.object({ x: z.string(), text: z.string() })]);
    const raw = '{"x":"2","text":"line one\nline two"}';
    expect(normalizeModelInput(ambiguous, raw)).toEqual({ input: raw, fixes: [] });
  });

  it.each([' ', 'q', 'x', '(', 'α'])('preserves a non-JSON escape as literal backslash plus %s in structured text', suffix => {
    const meta = `{"label":"before\\${suffix}after"}`;
    const input = { rows: [], meta, name: 'n' };
    const result = normalizeModelInput(schema, input);
    expect(result.input).toEqual({ ...input, meta: { label: `before\\${suffix}after` } });
    expect(result.fixes).toEqual([{ path: 'meta', before: meta, after: { label: `before\\${suffix}after` } }]);
    expect(input.meta).toBe(meta);
  });

  it('retains every standard JSON escape with its defined meaning beside a literal non-JSON escape', () => {
    const meta = String.raw`{"label":"\"\\\/\b\f\n\r\t\u0041\ value"}`;
    const result = normalizeModelInput(schema, { rows: [], meta, name: 'n' });
    expect(result.input).toEqual({ rows: [], meta: { label: '"\\/\b\f\n\r\tA\\ value' }, name: 'n' });
  });

  it.each([1, 2, 3, 4, 5, 6])('preserves paired backslashes before an unknown escape with run length %i', count => {
    const text = `{"label":"${'\\'.repeat(count)}q"}`;
    const result = normalizeModelInput(z.object({ label: z.string() }), text);
    expect(result.input).toEqual({ label: `${'\\'.repeat(Math.ceil(count / 2))}q` });
  });

  it('normalizes array values while retaining ordinary string fields and ambiguous union branches', () => {
    const raw = String.raw`[{"key":"value\ alpha"}]`;
    expect(normalizeModelInput(z.array(z.record(z.string(), z.string())), raw).input)
      .toEqual([{ key: 'value\\ alpha' }]);
    expect(normalizeModelInput(z.string(), raw)).toEqual({ input: raw, fixes: [] });
    const union = z.union([z.object({ x: z.number(), text: z.string() }), z.object({ x: z.string(), text: z.string() })]);
    const ambiguous = String.raw`{"x":"2","text":"value\ q"}`;
    expect(normalizeModelInput(union, ambiguous)).toEqual({ input: ambiguous, fixes: [] });
  });

  it.each([String.raw`{"key\ q":"value"}`, String.raw`{"key\ q":"first","key\\ q":"second"}`])(
    'rejects unknown escapes in keys rather than collapsing supplied entries: %s', input => {
      expect(normalizeModelInput(z.record(z.string(), z.string()), input)).toEqual({ input, fixes: [] });
    },
  );

  it.each([
    String.raw`{"label":"cut off\ q`, String.raw`{"label":"complete\ q"`,
    String.raw`{"label":"bad\u12G4\ q"}`, String.raw`{"label":"bad\u123\ q"}`,
    String.raw`{"label":"unescaped "quote"\ q"}`, String.raw`{"label":"a\ q",}`,
    '{"label":"raw\nnewline', '{"label":"backslash\\\nnewline"}',
    '{"label":"raw\nnewline","n":9007199254740993}', '{"label":"raw\nnewline","other":"bad\\u12"}',
    String.raw`{"label":"a\ q","n":9007199254740993}`,
  ])('does not complete or guess other malformed structured text: %s', meta => {
    const input = { rows: [], meta, name: 'n' };
    expect(normalizeModelInput(schema, input)).toEqual({ input, fixes: [] });
  });

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

// Approved08: exact text has one result; branch constraints and whole-submission checks still apply.
describe('normalizeModelInput strict union decoding', () => {
  it.each(['2', '0', 'all'])('normalizes actual depth levels %s without changing the caller', levels => {
    const input = {
      upstream: { levels, exactness: 'exact' },
      downstream: { levels: 1, exactness: 'approximate' },
    };
    const result = normalizeModelInput(ExplorationDepthSelectionSchema, input);
    const expected = levels === 'all' ? 'all' : Number(levels);
    expect(result.input).toEqual({ ...input, upstream: { levels: expected, exactness: 'exact' } });
    expect(ExplorationDepthSelectionSchema.safeParse(result.input).success).toBe(true);
    expect(result.fixes).toEqual(levels === 'all' ? [] : [{ path: 'upstream.levels', before: levels, after: expected }]);
    expect(input.upstream.levels).toBe(levels);
    expect(normalizeModelInput(ExplorationDepthSelectionSchema, result.input).fixes).toEqual([]);
  });

  it.each(['-1', '1.5', '2 rows', 'ALL', '9007199254740993'])('rejects invalid or lossy depth %s', levels => {
    const input = {
      upstream: { levels, exactness: 'exact' },
      downstream: { levels: 1, exactness: 'exact' },
    };
    const result = normalizeModelInput(ExplorationDepthSelectionSchema, input);
    expect(result).toEqual({ input, fixes: [] });
    expect(ExplorationDepthSelectionSchema.safeParse(result.input).success).toBe(false);
  });

  it.each(['1.0000000000000001', '0.99999999999999999', '9007199254740993'])('rejects lossy JSON depth %s before normal schema checks', levels => {
    const input = `{"upstream":{"levels":${levels},"exactness":"exact"},"downstream":{"levels":0,"exactness":"exact"}}`;
    expect(normalizeModelInput(ExplorationDepthSelectionSchema, input)).toEqual({ input, fixes: [] });
    expect(ExplorationDepthSelectionSchema.safeParse(input).success).toBe(false);
  });

  it('preserves exact JSON numeric exponents, quoted content and nested values', () => {
    const schema = z.object({ rows: z.array(z.object({ n: z.number(), text: z.string(), flag: z.boolean(), absent: z.null() })) });
    const input = '{"rows":[{"n":1.25e-7,"text":"9007199254740993","flag":true,"absent":null},{"n":1e21,"text":"quoted \\\"number\\\" 1.0000000000000001","flag":false,"absent":null},{"n":-0,"text":"negative zero","flag":true,"absent":null},{"n":0e999,"text":"zero","flag":false,"absent":null}]}';
    const result = normalizeModelInput(schema, input);
    expect(result.input).toEqual(JSON.parse(input));
    expect(schema.safeParse(result.input).success).toBe(true);
    expect(result.fixes).toHaveLength(1);
  });

  it.each(['0.10000000000000001', '1e-999', '1e999'])('rejects the whole JSON list when nested value %s is lossy', value => {
    const schema = z.object({ values: z.array(z.object({ n: z.number() })) });
    const input = { values: `[{"n":2},{"n":${value}}]` };
    expect(normalizeModelInput(schema, input)).toEqual({ input, fixes: [] });
    expect(schema.safeParse(input).success).toBe(false);
  });

  it('uses the served start schema and preserves strictness and cross-field checks', () => {
    const input = { origin: '[dbo].[Source]', analysisMode: 'bb', classification: 'technical', depth: {
      upstream: { levels: '2', exactness: 'exact' }, downstream: { levels: '0', exactness: 'exact' },
    } };
    const result = normalizeModelInput(StartExplorationFreshProviderInputSchema, input);
    expect(StartExplorationFreshProviderInputSchema.safeParse(result.input).success).toBe(true);
    expect(result.fixes).toEqual([
      { path: 'depth.upstream.levels', before: '2', after: 2 },
      { path: 'depth.downstream.levels', before: '0', after: 0 },
    ]);
    for (const invalid of [
      { ...input, extra: true },
      { ...input, depth: { ...input.depth, upstream: { levels: '0', exactness: 'exact' } } },
      { ...input, depth: { ...input.depth, upstream: { levels: '2' } } },
      { ...input, depth: { ...input.depth, upstream: { levels: '2', exactness: 'EXACT' } } },
    ]) expect(StartExplorationFreshProviderInputSchema.safeParse(normalizeModelInput(StartExplorationFreshProviderInputSchema, invalid).input).success).toBe(false);
  });

  it('normalizes the native served call and logs its scalar fix once', async () => {
    const input = { origin: '[dbo].[Source]', analysisMode: 'bb', classification: 'technical', depth: {
      upstream: { levels: '2', exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' },
    } };
    const logs: string[] = [];
    const port = new VscodeModelPort({ id: 'synthetic', sendRequest: async () => ({ stream: {
      async *[Symbol.asyncIterator]() { yield new vscode.LanguageModelToolCallPart('depth', 'lineage_start_exploration', input); },
    } }) } as never, { debugLog: message => logs.push(message) });
    const result = await port.generateToolTurn({ messages: [new HumanMessage('Trace two levels upstream.')], phase: 'test',
      tools: [{ name: 'lineage_start_exploration', description: 'Start.', inputSchema: StartExplorationFreshProviderInputSchema }],
    });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.toolCalls).toEqual([{ valid: true, callId: 'depth', toolName: 'lineage_start_exploration', input: {
      ...input, depth: { ...input.depth, upstream: { levels: 2, exactness: 'exact' } },
    } }]);
    expect(logs.filter(line => line.startsWith('[Normalize]'))).toEqual([
      '[Normalize] tool=lineage_start_exploration path=depth.upstream.levels before="2"',
    ]);
    expect(input.depth.upstream.levels).toBe('2');
  });

  it('decodes arrays and wrapped unions once and logs each changed value', () => {
    const schema = z.object({ values: z.array(z.union([z.number().int().min(0), z.literal('all')]).nullable().optional()) });
    const input = { values: '["2","all",null]' };
    const result = normalizeModelInput(schema, input);
    expect(result.input).toEqual({ values: [2, 'all', null] });
    expect(result.fixes).toEqual([
      { path: 'values', before: '["2","all",null]', after: ['2', 'all', null] },
      { path: 'values.0', before: '2', after: 2 },
    ]);
    expect(input).toEqual({ values: '["2","all",null]' });
  });

  it('refuses different valid union interpretations and preserves already-valid strings', () => {
    const number = z.object({ value: z.number(), other: z.string() }).strict();
    const boolean = z.object({ value: z.string(), other: z.boolean() }).strict();
    const schema = z.object({ choice: z.union([number, boolean]) });
    const input = { choice: { value: '2', other: 'true' } };
    expect(normalizeModelInput(schema, input)).toEqual({ input, fixes: [] });
    expect(schema.safeParse(input).success).toBe(false);
    const acceptsString = z.object({ value: z.union([z.number(), z.string()]) });
    const valid = { value: '2' };
    expect(normalizeModelInput(acceptsString, valid)).toEqual({ input: valid, fixes: [] });
  });

  it.each([
    [' 003.00 ', 3], ['-0', -0], ['0.1', 0.1], ['0.0000001', 0.0000001], ['9007199254740992', 9007199254740992],
  ])('preserves an exact numeric value %s', (value, expected) => {
    const schema = z.object({ value: z.union([z.number(), z.number().min(-1)]) });
    const result = normalizeModelInput(schema, { value });
    expect(result).toEqual({ input: { value: expected }, fixes: [{ path: 'value', before: value, after: expected }] });
  });

  it.each(['9007199254740993', '1000000000000000100', '0.10000000000000001', '9'.repeat(400)])('refuses scalar text that changes numeric value: %s', value => {
    const schema = z.object({ value: z.number() });
    expect(normalizeModelInput(schema, { value })).toEqual({ input: { value }, fixes: [] });
  });
});

describe('normalizeModelInput object ids', () => {
  const idField = (ids: string[]) => {
    const field = z.string().refine(value => ids.includes(value));
    markObjectIdField(field, new Map(ids.map(id => [id, true])), false);
    return field;
  };
  const idsSchema = (ids: string[]) => z.object({
    prune: z.array(z.object({ id: idField(ids) })).optional(),
    nodeId: idField(ids).describe('kept through a clone').optional(),
  }).strict();

  it('rewrites an id spelling to the one admitted id, at any depth, and logs it', () => {
    const schema = idsSchema(['[dbo].[FactSales]', '[dbo].[DimDate]']);
    const result = normalizeModelInput(schema, { prune: [{ id: 'dbo.factsales' }], nodeId: '\u200b[DBO].[DimDate]' });
    expect(result.input).toEqual({ prune: [{ id: '[dbo].[FactSales]' }], nodeId: '[dbo].[DimDate]' });
    expect(result.fixes.map(fix => fix.path)).toEqual(['prune.0.id', 'nodeId']);
    expect(schema.safeParse(result.input).success).toBe(true);
  });

  it('preserves format characters inside SQL identifiers instead of binding another object', () => {
    const schema = idsSchema(['[dbo].[AB]']);
    const nodeId = '[dbo].[A\u200dB]';
    const result = normalizeModelInput(schema, { nodeId });
    expect(result).toEqual({ input: { nodeId }, fixes: [] });
    expect(schema.safeParse(result.input).success).toBe(false);
  });

  it('leaves an unknown, fuzzy or ambiguous id as sent', () => {
    const schema = idsSchema(['[dbo].[A]', '[DBO].[a]', '[dbo].[FactSales]']);
    for (const nodeId of ['dbo.a', 'dbo.FactSale', 'sales.FactSales']) {
      const result = normalizeModelInput(schema, { nodeId });
      expect(result.fixes).toEqual([]);
      expect(result.input).toEqual({ nodeId });
    }
    const union = z.union([
      z.object({ nodeId: idField(['[dbo].[FactSales]']), other: z.number() }).strict(),
      z.object({ nodeId: idField(['[sales].[FactSales]']), other: z.number() }).strict(),
    ]);
    const ambiguous = { nodeId: 'FactSales', other: 'bad' };
    expect(normalizeModelInput(union, ambiguous)).toEqual({ input: ambiguous, fixes: [] });
  });
});

describe('normalizeModelInput id-form search', () => {
  it('splits an id-form query into name plus schema filter', () => {
    const result = normalizeModelInput(SearchObjectsInputSchema, { query: '[dbo].[FactSales]' });
    expect(result.input).toEqual({ query: 'FactSales', schemas: ['dbo'] });
    expect(result.fixes.map(fix => fix.path)).toEqual(['query', 'schemas']);
  });

  it('keeps regex queries, plain names and conflicting schema filters as sent', () => {
    for (const input of [
      { query: 'dbo.Fact.*', mode: 'regex' },
      { query: 'FactSales' },
      { query: 'dbo.FactSales', schemas: ['sales'] },
      { query: 'srv.db.dbo.FactSales' },
    ]) expect(normalizeModelInput(SearchObjectsInputSchema, input)).toEqual({ input, fixes: [] });
  });
});


describe('normalizeModelInput union decoding', () => {
  it('decodes the real optional scope-depth union without changing the submitted payload', () => {
    const input = { origin: '[dbo].[Orders]', upstream_depth: '2', downstream_depth: '0' };
    const result = normalizeModelInput(GetScopeBundleInputSchema, input);
    expect(result.input).toEqual({ origin: '[dbo].[Orders]', upstream_depth: 2, downstream_depth: 0 });
    expect(GetScopeBundleInputSchema.safeParse(result.input).success).toBe(true);
    expect(input.upstream_depth).toBe('2');
    expect(result.fixes.map(fix => [fix.path, fix.before, fix.after])).toEqual([
      ['upstream_depth', '2', 2], ['downstream_depth', '0', 0],
    ]);
  });

  it.each(['-1', '1.5', 'all the way', '9007199254740993', '1.0000000000000001', '9007199254740991.1'])(
    'preserves a depth rejected by its numeric bounds: %s', depth => {
      const input = { origin: '[dbo].[Orders]', depth };
      const result = normalizeModelInput(GetScopeBundleInputSchema, input);
      expect(result).toEqual({ input, fixes: [] });
      expect(GetScopeBundleInputSchema.safeParse(result.input).success).toBe(false);
    },
  );

  it('keeps a valid string arm and refuses differently decoded union branches', () => {
    const textual = z.object({ value: z.union([z.number(), z.string()]) });
    const input = { value: '2' };
    expect(normalizeModelInput(textual, input)).toEqual({ input, fixes: [] });
    const ambiguous = z.object({ value: z.union([
      z.object({ x: z.number(), y: z.string() }),
      z.object({ x: z.string(), y: z.number() }),
    ]) });
    const raw = { value: { x: '2', y: '3' } };
    expect(normalizeModelInput(ambiguous, raw)).toEqual({ input: raw, fixes: [] });
  });

  it('decodes nested object/list and scalar unions through nullable and optional wrappers', () => {
    const schema = z.object({ value: z.union([
      z.object({ rows: z.array(z.object({ n: z.union([z.number(), z.literal('all')]) })) }),
      z.literal('none'),
    ]).nullable().optional() });
    const result = normalizeModelInput(schema, { value: JSON.stringify({ rows: JSON.stringify([{ n: '2' }]) }) });
    expect(result.input).toEqual({ value: { rows: [{ n: 2 }] } });
    expect(schema.safeParse(result.input).success).toBe(true);
    expect(result.fixes.map(fix => fix.path)).toEqual(['value', 'value.rows', 'value.rows.0.n']);
  });
});


it('decides by the served JSON Schema, not by what Zod would coerce (D-126)', () => {
  const coerced = z.object({ n: z.coerce.number() }).strict();
  expect(normalizeModelInput(coerced, { n: '2' })).toEqual({ input: { n: 2 }, fixes: [{ path: 'n', before: '2', after: 2 }] });
});

it('retains issue-path decoding for records and tuples', () => {
  const schema = z.object({ record: z.record(z.string(), z.number()), tuple: z.tuple([z.object({ n: z.number() })]) });
  const result = normalizeModelInput(schema, { record: { count: '2' }, tuple: ['{"n":"3"}'] });
  expect(result.input).toEqual({ record: { count: 2 }, tuple: [{ n: 3 }] });
  expect(schema.safeParse(result.input).success).toBe(true);
});

it.each(['0.0000001', '001.2300', '-0', '1' + '0'.repeat(21)])('decodes an exact finite numeric spelling %s', text => {
  const schema = z.object({ n: z.number() });
  expect(normalizeModelInput(schema, { n: text }).input).toEqual({ n: Number(text) });
});
