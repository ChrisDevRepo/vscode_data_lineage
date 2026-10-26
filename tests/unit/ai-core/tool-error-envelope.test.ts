/** Deterministic production tool-error-envelope contract. */
import { exampleForFields, readToolError, isConsentGateRejection, makeRejection, rejectionFromZodError, rejectionModelContent } from '../../../src/ai/support/toolErrorEnvelope';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe("tool-error-envelope", () => {
  it('retains typed correction alternatives on nonform rejections', () => {
    const rejection = makeRejection({ code: 'invalid_regex', issuePaths: ['query'], resend: ['mode'] });
    expect(rejection.resend).toEqual(['mode']);
    expect(readToolError(JSON.parse(JSON.stringify(rejection)))?.resend).toEqual(['mode']);
  });
  it('includes owner guidance from the first rejection and adds choices on the last repair opportunity', () => {
    const rejection = makeRejection({ code: 'contributor_col_not_on_source',
      reason: 'column_flow.0.upstream_columns.1.col: Column Missing does not exist on [d].[Source].',
      hint: 'Correct this column reference or remove this supplier.',
      issuePaths: ['column_flow.0.upstream_columns.1.col'],
      detail: [{ kind: 'bad_contributor_col', path: 'column_flow.0.upstream_columns.1.col', id: '[d].[Source]',
        allowed_values: ['Amount', 'Rate'], when: { node: '[d].[Source]' } }],
    });
    const original = structuredClone(rejection);
    expect(JSON.parse(rejectionModelContent(rejection, false))).toEqual({ code: rejection.code, reason: rejection.reason, hint: rejection.hint });
    const last = JSON.parse(rejectionModelContent(rejection, true));
    expect(last).toMatchObject({ code: rejection.code, reason: rejection.reason, hint: rejection.hint,
      detail: [{ path: 'column_flow.0.upstream_columns.1.col', allowed_values: ['Amount', 'Rate'], when: { node: '[d].[Source]' } }] });
    expect(last).not.toHaveProperty('issuePaths');
    expect(rejection, 'projection leaves complete local diagnostics unchanged').toEqual(original);
    for (const final of [false, true]) {
      const guidanceOnly = makeRejection({ code: 'invalid_input', hint: 'Supply the required tool call.' });
      expect(JSON.parse(rejectionModelContent(guidanceOnly, final))).toEqual({ code: 'invalid_input', reason: guidanceOnly.hint });
      expect(JSON.parse(rejectionModelContent({ ...rejection, hint: rejection.reason }, final))).not.toHaveProperty('hint');
    }
  });
  it.each([0, 3, 12])('reserves all %i allowed values for the last repair opportunity, retaining first-fault guidance', count => {
    const allowed = Array.from({ length: count }, (_, index) => `C${index}`);
    const rejection = makeRejection({ code: 'invalid_input', reason: 'diagnostic prose', hint: 'diagnostic hint', detail: [{ kind: 'x' }],
      errors: [{ path: 'column_flow.0.upstream_columns.0.col', issue: 'Unknown column.', got: 'Missing', allowed, when: { node: 'n' } },
        { path: 'badge_label', issue: '51 chars, limit 50' }],
      resend: ['column_flow', 'badge_label'], example: { column_flow: [{ out_col: 'Value' }] }, wayOut: 'Remove it.' });
    expect(readToolError(JSON.parse(JSON.stringify(rejection)))).toEqual(rejection);
    expect(JSON.parse(rejectionModelContent(rejection, false))).toEqual({ code: 'invalid_input', resend: ['column_flow', 'badge_label'],
      errors: [{ path: 'column_flow.0.upstream_columns.0.col', issue: 'Unknown column.', got: 'Missing', when: { node: 'n' }, ...(count === 0 ? { allowed_meaning: 'nothing is allowed here: withdraw the field' } : {}) },
        { path: 'badge_label', issue: '51 chars, limit 50' }] });
    expect(JSON.parse(rejectionModelContent(rejection, true))).toEqual({ code: 'invalid_input', resend: ['column_flow', 'badge_label'],
      errors: [{ path: 'column_flow.0.upstream_columns.0.col', issue: 'Unknown column.', got: 'Missing', when: { node: 'n' }, allowed, ...(count === 0 ? { allowed_meaning: 'nothing is allowed here: withdraw the field' } : {}) },
        { path: 'badge_label', issue: '51 chars, limit 50' }],
      example: { column_flow: [{ out_col: 'Value' }] }, way_out: 'Remove it.' });
  });
  it('derives form errors from Zod issues: accepted values from the issue, a long value never echoed', () => {
    const schema = z.object({ mode: z.enum(['a', 'b']), items: z.array(z.object({ name: z.string() }).strict()), count: z.number() }).strict();
    const input = { mode: 'z', items: [{ name: 'ok', extra: 1 }], count: 'x'.repeat(200) };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error('Expected faults');
    const rejection = rejectionFromZodError(parsed.error, { code: 'invalid_input', input, schema, form: true });
    expect(rejection.hint).toBeUndefined();
    expect(rejection.errors).toEqual(expect.arrayContaining([
      { path: 'mode', issue: 'Invalid value', got: 'z', allowed: ['a', 'b'] },
      { path: 'items.0.extra', issue: 'Unrecognized key; remove or correct it.', allowed: ['name'] },
      { path: 'count', issue: 'Wrong type', expected: 'number' },
    ]));
    expect(exampleForFields(schema, ['items.0.extra'])).toEqual({ items: [{ name: '...' }] });
    expect(exampleForFields(schema, ['mode', 'count'])).toEqual({ mode: 'a' });
  });
  it.each([z.number(), z.number().int()])('reports the declared numeric type without choosing a value: %s', owner => {
    const schema = z.object({ value: owner });
    const expected = z.toJSONSchema(owner).type;
    for (const value of [null, 'three']) {
      const parsed = schema.safeParse({ value });
      if (parsed.success) throw new Error('Expected a numeric type fault.');
      const rejection = rejectionFromZodError(parsed.error, { code: 'invalid_input', input: { value }, schema, form: true });
      expect(rejection.issuePaths).toEqual(['value']);
      expect(rejection.errors).toEqual([{ path: 'value', issue: 'Wrong type', expected, got: value === null ? 'null' : value }]);
    }
  });
  it.each([
    { owner: z.string().min(1).max(5).regex(/\S/), expected: '...' },
    { owner: z.enum(['first', 'second']), expected: 'first' },
    { owner: z.number().min(1), expected: undefined },
    { owner: z.string().regex(/^identifier$/), expected: undefined },
  ])('publishes a scalar shape only when its owning constraints accept it', ({ owner, expected }) => {
    const schema = z.object({ value: owner });
    const example = exampleForFields(schema, ['value']);
    expect(example).toEqual(expected === undefined ? undefined : { value: expected });
    if (example !== undefined) expect(schema.safeParse(example).success).toBe(true);
  });
  it.each([false, true])('gives first-feedback correction guidance for an unknown key (nested=%s)', nested => {
    const schema = z.object({ entry: z.object({ value: z.string() }).strict() }).strict();
    const input = nested ? { entry: { value: 'Keep this text.', extra: 'Move or remove me.' } }
      : { entry: { value: 'Keep this text.' }, extra: 'Move or remove me.' };
    const before = structuredClone(input);
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error('Expected unknown key rejection');
    const rejection = rejectionFromZodError(parsed.error, { code: 'invalid_input', input, schema, form: true });
    const first = JSON.parse(rejectionModelContent(rejection, false));
    expect(first.errors).toEqual([{ path: nested ? 'entry.extra' : 'extra',
      issue: 'Unrecognized key; remove or correct it.' }]);
    expect(JSON.parse(rejectionModelContent(rejection, true)).errors[0].allowed).toEqual([nested ? 'value' : 'entry']);
    expect(input).toEqual(before);
    expect(schema.safeParse({ entry: { value: input.entry.value } }).success).toBe(true);
  });
  it.each([
    { owner: z.array(z.object({ id: z.never(), reason: z.string() }).strict()).optional(), expected: { items: [] } },
    { owner: z.array(z.object({ id: z.never() }).strict()).min(1).optional(), expected: undefined },
    { owner: z.array(z.never()).min(1), expected: undefined },
    { owner: z.array(z.string().min(5)).refine(value => value.length > 0), expected: undefined },
    { owner: z.object({ value: z.string().min(5) }).strict(), expected: undefined },
    { owner: z.array(z.object({ id: z.enum(['valid']) }).strict()), expected: { items: [{ id: 'valid' }] } },
  ])('publishes only an example accepted by its owning field: $expected', ({ owner, expected }) => {
    const schema = z.object({ required: z.string(), items: owner }).strict();
    const example = exampleForFields(schema, ['items.0.id']);
    expect(example).toEqual(expected);
    if (example !== undefined) expect(owner.safeParse((example as { items: unknown }).items).success).toBe(true);
  });
  it('retains the empty allowed set of a native never fault in form feedback', () => {
    const schema = z.object({ items: z.array(z.object({ id: z.never() }).strict()) }).strict();
    const input = { items: [{ id: 'invalid' }] };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error('Expected a never fault');
    const rejection = rejectionFromZodError(parsed.error, { code: 'invalid_input', input, schema, form: true });
    expect(JSON.parse(rejectionModelContent(rejection)).errors).toEqual([
      expect.objectContaining({ path: 'items.0.id', allowed: [], allowed_meaning: 'nothing is allowed here: withdraw the field' }),
    ]);
  });
  it('defers resend scope to a draft owner without losing or recomputing field repair facts', () => {
    const schema = z.object({ name: z.string() }).strict();
    const input = { name: 42 };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error('Expected a field type failure');
    const full = rejectionFromZodError(parsed.error, { code: 'invalid_input', input, schema });
    const owned = rejectionFromZodError(parsed.error, { code: 'invalid_input', input, schema, resend: 'owner' });
    expect(full.hint).toContain('otherwise resend the full tool call');
    expect(owned.hint).toBe('Send "name" as a string.');
    expect(owned).toMatchObject({ code: full.code, reason: full.reason, detail: full.detail, issuePaths: ['name'] });
    expect(rejectionModelContent(owned)).not.toContain('otherwise resend the full tool call');
  });
  it('selects actionable facts without leaking diagnostic fields or held report bodies', () => {
    const rejection = makeRejection({ code: 'invalid_input', reason: 'sections.0.label: Label is required.',
      hint: 'Resend the label; the body remains held.', issuePaths: ['sections.0.label'], detail: [
        { kind: 'too_small', path: 'sections.0.label', minimum: 1, reason: 'Label is required.', input: 'RAW_INPUT_SENTINEL', stack: 'STACK_SENTINEL' },
        { held_draft: { sections: [{ label: 'Sources', start: 'B1', text: 'HELD_BODY_SENTINEL' }] }, debug: 'DEBUG_SENTINEL' },
      ] });
    const content = rejectionModelContent(rejection, true);
    expect(JSON.parse(content)).toMatchObject({ code: 'invalid_input', reason: rejection.reason, hint: rejection.hint,
      detail: [
        { kind: 'too_small', path: 'sections.0.label', minimum: 1 },
        { held_draft: { sections: [{ label: 'Sources', start: 'B1' }] } },
      ] });
    expect(content).not.toMatch(/RAW_INPUT_SENTINEL|STACK_SENTINEL|HELD_BODY_SENTINEL|DEBUG_SENTINEL/);
    expect(JSON.parse(content)).not.toHaveProperty('issuePaths');
    expect(rejection.detail).toEqual(expect.arrayContaining([expect.objectContaining({ input: 'RAW_INPUT_SENTINEL' })]));
  });
  it("readToolError: makeRejection shape round-trips through JSON", () => {
    const made = makeRejection({ code: 'focus_node_id_mismatch', hint: 'use the expected id', detail: { expected: 'a', got: 'b' } });
    const r = readToolError(JSON.parse(JSON.stringify(made)));
    expect(r, 'the rejection reads back as itself').toEqual(made);
    expect(r!.reason, 'reason falls back to the code').toBe('focus_node_id_mismatch');
  });

  it("readToolError: an object carrying an unrecognized key is not a rejection", () => {
    expect(readToolError({ code: 'x', reason: 'y', extra: 1 })).toBeNull();
  });

  it("readToolError: an explicit reason wins over the code", () => {
    const r = readToolError(makeRejection({ code: 'invalid_input', reason: 'focus_node_id `x` not found' }));
    expect(r!.reason).toBe('focus_node_id `x` not found');
  });

  it("structured detail is preserved for bounded retry projection", () => {
    const detail = [{ id: 'vwraworders', path: 'column_flow.0.upstream_columns.0', reason: 'self loop' }];
    const r = readToolError(makeRejection({ code: 'column_self_loop', hint: 'Correct writes_to.', detail }));
    expect(r!.detail, 'structured detail is preserved for bounded retry projection').toEqual(detail);
  });

  it("typed fields ride the rejection, never a walk over detail", () => {
    const made = makeRejection({
      code: 'validation',
      issuePaths: ['sections.0.body', 'not a path!', 'sections.0.body', 'badge_label'],
      entryIds: ['[dbo].[a]'],
    });
    expect(made.issuePaths, 'paths: grammar-checked and deduped at the source').toEqual(['sections.0.body', 'badge_label']);
    const r = readToolError(JSON.parse(JSON.stringify(made)));
    expect(r!.entryIds).toEqual(['[dbo].[a]']);
    expect(makeRejection({ code: 'x', issuePaths: Array.from({ length: 40 }, (_, i) => `p${i}`) }).issuePaths, 'every path is kept').toHaveLength(40);
  });

  it("the retired {error} and {ok:false} shapes are not rejections", () => {
    expect(readToolError({ error: 'focus_mismatch', hint: 'h' }), '{error} is not read').toBeNull();
    expect(readToolError({ ok: false, reason: 'over_discovery_budget' }), '{ok:false} is not read').toBeNull();
    expect(readToolError({ success: false, errors: ['x'], hint: 'h' }), '{success:false,errors} is not read').toBeNull();
  });

  it("a payload without a code and reason is not a rejection", () => {
    expect(readToolError({ ok: true, nodes: [] }) === null, 'success payload → null').toBe(true);
    expect(readToolError({}) === null, 'empty object → null').toBe(true);
    expect(readToolError(null) === null, 'null → null').toBe(true);
    expect(readToolError('a string') === null, 'non-object → null').toBe(true);
  });

  it("the consent gate is separable from a real rejection", () => {
    const gate = readToolError(makeRejection({ code: 'action_required', hint: 'awaiting user confirmation' }));
    expect(gate !== null, 'gate envelope parses as a rejection shape').toBe(true);
    expect(isConsentGateRejection(gate!.code), 'action_required is the consent gate').toBe(true);
    const failure = readToolError(makeRejection({ code: 'validation', reason: 'bad node id' }));
    expect(!isConsentGateRejection(failure!.code), 'a validation failure is not a gate').toBe(true);
  });

  describe('rejectionFromZodError: invalid_union with a single repeated missing field', () => {
    it('states a lone missing field as required and missing, not a bare dotted name', () => {
      const levelsSchema = z.union([z.number().int().min(0), z.literal('all')]);
      const sideSchema = z.object({ levels: levelsSchema, exactness: z.enum(['exact', 'approximate']) }).strict();
      const bbVariant = z.object({
        analysisMode: z.literal('bb'),
        depth: z.object({ upstream: sideSchema, downstream: sideSchema }).strict(),
      }).strict();
      const ctVariant = z.object({
        analysisMode: z.literal('ct'),
        depth: z.object({ upstream: sideSchema, downstream: sideSchema }).strict(),
        targetColumns: z.array(z.string()),
      }).strict();
      const provider = z.union([bbVariant, ctVariant]);
      const payload = { analysisMode: 'bb', depth: { upstream: { exactness: 'exact' }, downstream: { levels: 2, exactness: 'exact' } } };
      const result = provider.safeParse(payload);
      expect(result.success, 'a call omitting depth.upstream.levels fails both variants').toBe(false);
      if (result.success) return;
      const rejection = rejectionFromZodError(result.error, { code: 'invalid_tool_input', input: payload });
      expect(rejection.reason.includes('depth.upstream.levels is required and missing entirely from this call'), 'the sole missing field states it is required and missing').toBe(true);
      expect(rejection.reason.match(/depth\.upstream\.levels/g)?.length, 'the identical bb/ct verdict collapses to one variant instead of repeating per branch').toBe(1);
    });

    it('a branch naming several fields keeps the plain comma-joined listing untouched', () => {
      const bbVariant = z.object({ origin: z.string(), classification: z.string(), analysisMode: z.literal('bb') }).strict();
      const ctVariant = z.object({ origin: z.string(), classification: z.string(), analysisMode: z.literal('ct'), targetColumns: z.array(z.string()) }).strict();
      const result = z.union([bbVariant, ctVariant]).safeParse({});
      expect(result.success, 'empty-object args fail the union as expected').toBe(false);
      if (result.success) return;
      const rejection = rejectionFromZodError(result.error, { code: 'invalid_tool_input', input: {} });
      expect(rejection.reason.includes('variant 1: origin, classification, analysisMode'), 'a multi-field bare listing is not rewritten').toBe(true);
      expect(rejection.reason.includes('is required and missing entirely'), 'the multi-field wording addition never fires').toBe(false);
    });
  });

  describe('rejectionFromZodError: a present value outside its enum', () => {
    const flowSchema = z.object({
      verdict: z.enum(['pass', 'fail']),
      flow: z.array(z.object({ out: z.literal('Qty'), src: z.string() }).strict()).optional(),
      pair: z.array(z.object({ out: z.enum(['a', 'b']) }).strict()).min(2).optional(),
    }).strict();
    const rejectionFor = (payload: unknown) => {
      const result = flowSchema.safeParse(payload);
      expect(result.success, 'the payload violates an enum').toBe(false);
      if (result.success) throw new Error('unreachable');
      return rejectionFromZodError(result.error, { code: 'invalid_input', input: payload, schema: flowSchema });
    };

    it('an entry inside an optional array names both repairs and holds choices for escalation', () => {
      const rejection = rejectionFor({ verdict: 'pass', flow: [{ out: 'Qty', src: 'x' }, { out: 'Other', src: 'y' }, { out: 'More', src: 'z' }] });
      expect(rejection.hint).toContain('Set "flow[].out" to an allowed value, or remove the entry from "flow".');
      expect(rejection.detail).toEqual([{ kind: 'invalid_value', path: 'flow.1.out', allowed_values: ['Qty'] }, { kind: 'invalid_value', path: 'flow.2.out', allowed_values: ['Qty'] }]);
      expect(rejection.hint, 'the generic resend rule still closes the hint').toContain('otherwise resend the full tool call');
    });

    it('a top-level required enum field holds allowed values and names only the set repair', () => {
      const rejection = rejectionFor({ verdict: 'maybe' });
      expect(rejection.hint).toContain('Set "verdict" to an allowed value.');
      expect(rejection.detail).toEqual([{ kind: 'invalid_value', path: 'verdict', allowed_values: ['pass', 'fail'] }]);
      expect(rejection.hint).not.toContain('remove the entry');
    });

    it('an entry the array minimum forbids dropping is offered the set repair only', () => {
      const rejection = rejectionFor({ verdict: 'pass', pair: [{ out: 'a' }, { out: 'z' }] });
      expect(rejection.hint).toContain('Set "pair[].out" to an allowed value.');
      expect(rejection.hint).not.toContain('remove the entry');
    });

    it('flagged entries that cannot all be dropped within the array minimum are offered the set repair only', () => {
      const rejection = rejectionFor({ verdict: 'pass', pair: [{ out: 'a' }, { out: 'y' }, { out: 'z' }] });
      expect(rejection.hint).toContain('Set "pair[].out" to an allowed value.');
      expect(rejection.hint).not.toContain('remove the entry');
    });

    it('a nullable array at its minimum is offered the set repair only', () => {
      const schema = z.object({ pair: z.array(z.object({ out: z.enum(['a', 'b']) }).strict()).min(2).nullable() }).strict();
      const payload = { pair: [{ out: 'a' }, { out: 'z' }] };
      const result = schema.safeParse(payload);
      if (result.success) throw new Error('the payload violates an enum');
      const rejection = rejectionFromZodError(result.error, { code: 'invalid_input', input: payload, schema });
      expect(rejection.hint).toContain('Set "pair[].out" to an allowed value.');
      expect(rejection.hint).not.toContain('remove the entry');
    });

    it('the first and the repeated rejection of the same call carry the identical hint', () => {
      const payload = { verdict: 'pass', flow: [{ out: 'Other', src: 'y' }] };
      expect(rejectionFor(payload).hint).toBe(rejectionFor(structuredClone(payload)).hint);
    });

    it('the allowed values stay in detail rather than the first reason or hint', () => {
      const rejection = rejectionFor({ verdict: 'pass', flow: [{ out: 'Qty', src: 'x' }, { out: 'Other', src: 'y' }, { out: 'More', src: 'z' }] });
      expect(rejection.reason).toContain('at flow[1].out');
      expect(rejection.reason, 'the second offending entry is still named').toContain('flow[2].out');
      expect(rejection.reason, 'the reason names the defect without the values').not.toContain('"Qty"');
      expect(rejection.hint).not.toContain('"Qty"');
      expect(rejection.detail).toEqual([{ kind: 'invalid_value', path: 'flow.1.out', allowed_values: ['Qty'] }, { kind: 'invalid_value', path: 'flow.2.out', allowed_values: ['Qty'] }]);
      const enumRejection = rejectionFor({ verdict: 'maybe' });
      expect(enumRejection.reason).not.toMatch(/"pass"|"fail"/);
      expect(enumRejection.hint).not.toMatch(/"pass"|"fail"/);
      expect(enumRejection.detail).toEqual([{ kind: 'invalid_value', path: 'verdict', allowed_values: ['pass', 'fail'] }]);
    });

    it('a caller-supplied hint keeps the same structured choices without exposing them early', () => {
      const payload = { verdict: 'maybe' };
      const result = flowSchema.safeParse(payload);
      if (result.success) throw new Error('the payload violates an enum');
      const rejection = rejectionFromZodError(result.error, { code: 'invalid_input', input: payload, schema: flowSchema, hint: 'Own hint.' });
      expect(rejection.reason).not.toMatch(/"pass"|"fail"/);
      expect(rejection.hint).toBe('Own hint.');
      expect(rejection.detail).toEqual([{ kind: 'invalid_value', path: 'verdict', allowed_values: ['pass', 'fail'] }]);
    });

    it('an absent enum field keeps the addition hint, not the value hint', () => {
      const rejection = rejectionFor({});
      expect(rejection.hint).not.toContain('Set "verdict"');
    });
  });

  describe('rejectionFromZodError: a value of the wrong type under a size bound', () => {
    const schema = z.object({ notes: z.array(z.string()).max(8).optional(), title: z.string().max(8).optional() });

    it.each([undefined, 'nine char'])('a string sent for a bounded array states its type fault while preserving an independent text limit (%s)', title => {
      const input = { notes: 'Ignore logging-related objects', ...(title === undefined ? {} : { title }) };
      const parsed = schema.safeParse(input);
      expect(parsed.success).toBe(false);
      const rejection = rejectionFromZodError(parsed.error!, { code: 'invalid_tool_input', input, schema });
      expect(rejection.reason).toContain('expected array, received string');
      expect(rejection.hint).toContain('Send "notes" as an array.');
      expect(rejection.hint, 'a mistyped list cannot have a character correction').not.toContain('Shorten "notes"');
      if (title === undefined) {
        expect(rejection.reason, 'the item bound is not restated as a character bound').not.toMatch(/Too big|characters|limit 8/);
        expect(rejection.issuePaths).toEqual(['notes']);
      } else {
        expect(rejection.reason).toContain('9 chars, limit 8');
        expect(rejection.hint).toContain('Shorten "title" to at most 8 characters');
        expect(rejection.issuePaths).toEqual(['notes', 'title']);
      }
    });

    it('a size violation on a value of the right type is still reported', () => {
      const input = { notes: Array.from({ length: 9 }, () => 'n'), title: 'nine char' };
      const rejection = rejectionFromZodError(schema.safeParse(input).error!, { code: 'invalid_tool_input', input, schema });
      expect(rejection.reason).toContain('9 items, limit 8');
      expect(rejection.reason).toContain('9 chars, limit 8');
    });
  });

  describe('rejectionFromZodError: a string or number outside its bound', () => {
    const schema = z.object({
      name: z.string().max(8).trim().min(1, 'name is required'),
      revision: z.number().int().positive().optional(),
    });
    const reject = (input: unknown) => rejectionFromZodError(schema.safeParse(input).error!, { code: 'invalid_input', input, schema });

    it('a string over its cap states the measured length and the shorten action once', () => {
      const rejection = reject({ name: 'x'.repeat(20) });
      expect(rejection.reason).toContain('20 chars, limit 8');
      expect(rejection.hint).toContain('Shorten "name" to at most 8 characters; the engine never truncates authored text.');
      expect(rejection.hint!.match(/Shorten/g)).toHaveLength(1);
    });

    it('a blank string keeps the schema message instead of a raw length that meets the bound', () => {
      const rejection = reject({ name: '   ' });
      expect(rejection.reason).toContain('name is required');
      expect(rejection.reason).not.toMatch(/3 chars/);
      expect(rejection.hint).toContain('Send "name" with at least 1 character.');
    });

    it('an exclusive bound is stated as exclusive', () => {
      const rejection = reject({ name: 'ok', revision: 0 });
      expect(rejection.reason).toContain('0, more than 0');
      expect(rejection.reason).not.toContain('minimum 0');
    });
  });

  describe('rejectionFromZodError: a key misplaced on a column_flow entry', () => {
    const ref = z.object({ node: z.string(), col: z.string(), note: z.string().optional() }).strict();
    const entry = z.object({ out_col: z.string(), writes_to: z.object({ node: z.string(), col: z.string() }).strict().nullish(), upstream_columns: z.array(ref) }).strict();
    const schema = z.object({ column_flow: z.array(entry) }).strict();
    const ok = { out_col: 'a', writes_to: null, upstream_columns: [] };
    const input = { column_flow: [ok, ok, ok, ok, { ...ok, note: 'misplaced' }] };

    it('stays rejected and names the concrete path with schema-derived allowed fields', () => {
      const parsed = schema.safeParse(input);
      expect(parsed.success).toBe(false);
      const rejection = rejectionFromZodError(parsed.error!, { code: 'invalid_tool_input', input, schema });
      expect(rejection.detail).toContainEqual({ path: 'column_flow[4].note', error: 'field_not_allowed', allowed: ['out_col', 'writes_to', 'upstream_columns'] });
      expect(rejection.hint).toContain('"note" is not a field of column_flow[4]');
      const wire = JSON.parse(rejectionModelContent(rejection, true));
      expect(wire.detail).toContainEqual({ path: 'column_flow[4].note', error: 'field_not_allowed', allowed: ['out_col', 'writes_to', 'upstream_columns'] });
      expect(wire.issuePaths ?? []).not.toContain('column_flow.4.note');
    });
  });

});


it('stages the exact nonform owner example and legal exit until the second rejection', () => {
  const example = { analysisMode: 'bb' };
  const rejection = makeRejection({ code: 'invalid_input', reason: 'analysisMode: Invalid value',
    issuePaths: ['analysisMode'], example, wayOut: 'Submit the corrected proposal for approval.' });
  const before = structuredClone(rejection);
  const first = JSON.parse(rejectionModelContent(rejection, false));
  expect(first).not.toHaveProperty('example'); expect(first).not.toHaveProperty('way_out');
  const second = JSON.parse(rejectionModelContent(rejection, true));
  expect(second.example).toEqual(example);
  expect(second.way_out).toBe(rejection.wayOut);
  expect(rejection).toEqual(before);
});
