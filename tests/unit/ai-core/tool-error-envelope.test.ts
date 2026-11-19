/** Deterministic production tool-error-envelope contract. */
import { readToolError, isConsentGateRejection, makeRejection, rejectionFromZodError, renderFaults } from '../../../src/ai/support/toolErrorEnvelope';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe("tool-error-envelope", () => {
  it("readToolError: makeRejection shape round-trips through JSON", () => {
    const made = makeRejection({ code: 'focus_node_id_mismatch', hint: 'use the expected id', detail: { expected: 'a', got: 'b' } });
    const r = readToolError(JSON.parse(JSON.stringify(made)));
    expect(r, 'the rejection reads back as itself').toEqual(made);
    expect(r!.reason, 'reason falls back to the code').toBe('focus_node_id_mismatch');
  });

  it("readToolError: an object carrying an unrecognized key is not a rejection", () => {
    expect(readToolError({ code: 'x', reason: 'y', extra: 1 })).toBeNull();
  });

  it("readToolError: a makeRejection output with detail round-trips through JSON", () => {
    const made = makeRejection({ code: 'x', reason: 'y', detail: { next_action: 'start_exploration', ids: ['a'] } });
    expect(readToolError(JSON.parse(JSON.stringify(made)))).toEqual(made);
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
    it('states a lone missing field as required and missing, not a bare path', () => {
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
      expect(rejection.reason.includes('/depth/upstream/levels is required and missing entirely from this call'), 'the sole missing field states it is required and missing').toBe(true);
      expect(rejection.reason.match(/\/depth\/upstream\/levels/g)?.length, 'the identical bb/ct verdict collapses to one variant instead of repeating per branch').toBe(1);
    });

    it('a branch naming several fields keeps the plain comma-joined listing untouched', () => {
      const bbVariant = z.object({ origin: z.string(), classification: z.string(), analysisMode: z.literal('bb') }).strict();
      const ctVariant = z.object({ origin: z.string(), classification: z.string(), analysisMode: z.literal('ct'), targetColumns: z.array(z.string()) }).strict();
      const result = z.union([bbVariant, ctVariant]).safeParse({});
      expect(result.success, 'empty-object args fail the union as expected').toBe(false);
      if (result.success) return;
      const rejection = rejectionFromZodError(result.error, { code: 'invalid_tool_input', input: {} });
      expect(rejection.reason.includes('variant 1: /origin, /classification, /analysisMode'), 'a multi-field bare listing is not rewritten').toBe(true);
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

    it('an entry inside an optional array names the allowed value and both repairs', () => {
      const rejection = rejectionFor({ verdict: 'pass', flow: [{ out: 'Qty', src: 'x' }, { out: 'Other', src: 'y' }, { out: 'More', src: 'z' }] });
      expect(rejection.hint).toContain('Set "flow[].out" to one of "Qty", or remove the entry from "flow".');
      expect(rejection.hint, 'the generic resend rule still closes the hint').toContain('Resend the full tool call');
    });

    it('a top-level required enum field names the allowed values and only the set repair', () => {
      const rejection = rejectionFor({ verdict: 'maybe' });
      expect(rejection.hint).toContain('Set "verdict" to one of "pass", "fail".');
      expect(rejection.hint).not.toContain('remove the entry');
    });

    it('an entry the array minimum forbids dropping is offered the set repair only', () => {
      const rejection = rejectionFor({ verdict: 'pass', pair: [{ out: 'a' }, { out: 'z' }] });
      expect(rejection.hint).toContain('Set "pair[].out" to one of "a", "b".');
      expect(rejection.hint).not.toContain('remove the entry');
    });

    it('flagged entries that cannot all be dropped within the array minimum are offered the set repair only', () => {
      const rejection = rejectionFor({ verdict: 'pass', pair: [{ out: 'a' }, { out: 'y' }, { out: 'z' }] });
      expect(rejection.hint).toContain('Set "pair[].out" to one of "a", "b".');
      expect(rejection.hint).not.toContain('remove the entry');
    });

    it('a nullable array at its minimum is offered the set repair only', () => {
      const schema = z.object({ pair: z.array(z.object({ out: z.enum(['a', 'b']) }).strict()).min(2).nullable() }).strict();
      const payload = { pair: [{ out: 'a' }, { out: 'z' }] };
      const result = schema.safeParse(payload);
      if (result.success) throw new Error('the payload violates an enum');
      const rejection = rejectionFromZodError(result.error, { code: 'invalid_input', input: payload, schema });
      expect(rejection.hint).toContain('Set "pair[].out" to one of "a", "b".');
      expect(rejection.hint).not.toContain('remove the entry');
    });

    it('the first and the repeated rejection of the same call carry the identical hint', () => {
      const payload = { verdict: 'pass', flow: [{ out: 'Other', src: 'y' }] };
      expect(rejectionFor(payload).hint).toBe(rejectionFor(structuredClone(payload)).hint);
    });

    it('the allowed values are stated once: in the hint, not again in the reason line', () => {
      const rejection = rejectionFor({ verdict: 'pass', flow: [{ out: 'Qty', src: 'x' }, { out: 'Other', src: 'y' }, { out: 'More', src: 'z' }] });
      expect(rejection.reason).toContain('→ at /flow/1/out');
      expect(rejection.reason, 'the second offending entry is still named').toContain('(same at /flow/2/out)');
      expect(rejection.reason, 'the reason names the defect without the values').not.toContain('"Qty"');
      expect(rejection.hint).toContain('one of "Qty"');
      const enumRejection = rejectionFor({ verdict: 'maybe' });
      expect(enumRejection.reason).not.toMatch(/"pass"|"fail"/);
      expect(enumRejection.hint).toContain('one of "pass", "fail"');
    });

    it('a caller-supplied hint leaves the allowed values in the reason', () => {
      const payload = { verdict: 'maybe' };
      const result = flowSchema.safeParse(payload);
      if (result.success) throw new Error('the payload violates an enum');
      const rejection = rejectionFromZodError(result.error, { code: 'invalid_input', input: payload, schema: flowSchema, hint: 'Own hint.' });
      expect(rejection.reason).toContain('"pass"');
      expect(rejection.reason).toContain('"fail"');
    });

    it('an absent enum field keeps the addition hint, not the value hint', () => {
      const rejection = rejectionFor({});
      expect(rejection.hint).not.toContain('Set "verdict"');
    });
  });

  describe('rejectionFromZodError: a value of the wrong type under a size bound', () => {
    const schema = z.object({ notes: z.array(z.string()).max(8).optional(), title: z.string().max(8).optional() });

    it('a string sent for a bounded array states the type fault only', () => {
      const input = { notes: 'Ignore logging-related objects' };
      const parsed = schema.safeParse(input);
      expect(parsed.success).toBe(false);
      const rejection = rejectionFromZodError(parsed.error!, { code: 'invalid_tool_input', input, schema });
      expect(rejection.reason).toContain('expected array, received string');
      expect(rejection.reason, 'the item bound is not restated as a character bound').not.toMatch(/Too big|characters|limit 8/);
      expect(rejection.issuePaths).toEqual(['notes']);
    });

    it('a size violation on a value of the right type is still reported', () => {
      const input = { notes: Array.from({ length: 9 }, () => 'n'), title: 'nine char' };
      const rejection = rejectionFromZodError(schema.safeParse(input).error!, { code: 'invalid_tool_input', input, schema });
      expect(rejection.reason).toContain('9 items, limit 8');
      expect(rejection.reason).toContain('9 chars, limit 8');
    });
  });

  describe('renderFaults: a mistyped list', () => {
    const schema = z.object({ flow: z.array(z.object({ out: z.string() })), title: z.string() });
    const render = (input: unknown) => {
      const rejection = rejectionFromZodError(schema.safeParse(input).error!, { code: 'invalid_input', input, schema });
      return renderFaults(rejection, () => schema);
    };

    it('a list sent as an object or text is told to be sent as the array', () => {
      expect(render({ flow: { out: 'a' }, title: 't' })).toEqual(['/flow: wrong JSON type. Send the array directly.']);
      expect(render({ flow: '[{"out":"a"}]', title: 't' })).toEqual(['/flow: wrong JSON type. Send the array directly.']);
    });

    it('a mistyped scalar keeps the reason alone', () => {
      expect(render({ flow: [], title: 5 })).toEqual([]);
    });
  });

  // A structured field sent as text is a type fault. The reason names the needed
  // type (from the schema, not the text's first char); it makes no JSON-validity claim and gives
  // no re-escape instruction that would contradict the fault line's direct-send repair.
  describe('reason: a structured field sent as text names the type fault', () => {
    const schema = z.object({ sections: z.object({ technical: z.string() }), flow: z.array(z.object({ out: z.string() })) });
    const reason = (input: unknown) => rejectionFromZodError(schema.safeParse(input).error!, { code: 'invalid_input', input, schema }).reason;

    it('names the needed type with no JSON-validity claim and no re-escape instruction', () => {
      for (const sections of ['{"technical":"cut', '[{"technical":"x"}]']) {
        const text = reason({ sections, flow: [{ out: 'a' }] });
        expect(text).toContain('received text where an object is needed.');
        expect(text).not.toContain('not valid JSON');
        expect(text).not.toContain('line breaks inside strings');
        expect(text).not.toContain('characters of text');
      }
      for (const flow of ['[{"out":"a\nb"}]', '{"out":"a"}']) {
        const text = reason({ sections: { technical: 'x' }, flow });
        expect(text).toContain('received text where an array is needed.');
        expect(text).not.toContain('not valid JSON');
        expect(text).not.toContain('line breaks inside strings');
      }
    });

    it('the needed type comes from the schema, not the received text first char', () => {
      expect(reason({ sections: '[{"technical":"x"}]', flow: [{ out: 'a' }] })).toContain('received text where an object is needed.');
      expect(reason({ sections: { technical: 'x' }, flow: '{"out":"a"}' })).toContain('received text where an array is needed.');
    });

    it('the reason and the fault line agree on the direct-send repair', () => {
      const input = { sections: '{"technical":"cut', flow: [{ out: 'a' }] };
      const rejection = rejectionFromZodError(schema.safeParse(input).error!, { code: 'invalid_input', input, schema });
      const served = [rejection.reason, ...renderFaults(rejection, () => schema)].join('\n');
      expect(served).toContain('received text where an object is needed.');
      expect(served).toContain('Send the object directly');
      expect(served).not.toContain('Send it again as one complete JSON');
    });
  });

});
