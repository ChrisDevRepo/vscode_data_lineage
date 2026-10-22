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

  it('leaves an unknown, fuzzy or ambiguous id as sent', () => {
    const schema = idsSchema(['[dbo].[A]', '[DBO].[a]', '[dbo].[FactSales]']);
    for (const nodeId of ['dbo.a', 'dbo.FactSale', 'sales.FactSales']) {
      const result = normalizeModelInput(schema, { nodeId });
      expect(result.fixes).toEqual([]);
      expect(result.input).toEqual({ nodeId });
    }
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
