/** Deterministic production tool-error-envelope contract. */
import { readToolError, isConsentGateRejection, makeRejection, rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';
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

});
