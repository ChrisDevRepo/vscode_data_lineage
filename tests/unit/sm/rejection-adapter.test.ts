/**
 * Unit tests for the central AI-runtime reject-messaging funnel foundation
 * (`src/ai/support/toolErrorEnvelope.ts`): `makeRejection`'s fail-closed empty-reason invariant,
 * `rejectionFromZodError`'s Zod-message-preserving formatting, and `readToolError`'s widened
 * sibling-key/full-`errors[]` folding into `detail` so a multi-issue reject surfaces every offender
 * in one round instead of one-per-retry.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeRejection, readToolError, rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';

describe('rejection-adapter', () => {
  describe('makeRejection', () => {
    it('fails closed on an empty reason', () => {
      expect(() => makeRejection({ code: 'x', reason: '' })).toThrow();
      expect(() => makeRejection({ code: 'x', reason: '   ' })).toThrow();
    });

    it('trims and normalizes', () => {
      const made = makeRejection({ code: 'bad_input', reason: '  correct the field  ', hint: 'fix it', detail: { a: 1 }, issuePaths: ['a.b'] });
      expect(made.code, 'makeRejection preserves code').toBe('bad_input');
      expect(made.reason, 'makeRejection trims reason').toBe('correct the field');
      expect(made.hint, 'makeRejection preserves hint').toBe('fix it');
      expect(JSON.stringify(made.detail), 'makeRejection preserves detail').toBe(JSON.stringify({ a: 1 }));
      expect(JSON.stringify(made.issuePaths), 'makeRejection preserves issuePaths').toBe(JSON.stringify(['a.b']));
    });
  });

  describe('rejectionFromZodError', () => {
    it('single issue: preserves the Zod message and the dotted path', () => {
      const singleSchema = z.object({ name: z.string().min(1, 'name must not be empty') });
      const singleResult = singleSchema.safeParse({ name: '' });
      expect(singleResult.success, 'single-issue schema fails as expected').toBe(false);
      if (!singleResult.success) {
        const rejection = rejectionFromZodError(singleResult.error, { code: 'validation', hint: 'retry with a valid name' });
        expect(rejection.code, 'rejectionFromZodError preserves code').toBe('validation');
        expect(rejection.reason.includes('name must not be empty'), 'rejectionFromZodError reason contains the Zod message').toBe(true);
        expect(rejection.reason.startsWith('name:'), 'rejectionFromZodError reason includes the dotted path prefix').toBe(true);
        expect(rejection.hint, 'rejectionFromZodError preserves hint').toBe('retry with a valid name');
        expect(JSON.stringify(rejection.issuePaths), 'rejectionFromZodError captures dotted issuePaths').toBe(JSON.stringify(['name']));
      }
    });

    it('multiple issues: first-issue-first ordering', () => {
      const multiSchema = z.object({
        name: z.string().min(1, 'name must not be empty'),
        count: z.number().min(1, 'count must be at least 1'),
      });
      const multiResult = multiSchema.safeParse({ name: '', count: 0 });
      expect(multiResult.success, 'multi-issue schema fails as expected').toBe(false);
      if (!multiResult.success) {
        const rejection = rejectionFromZodError(multiResult.error, { code: 'validation' });
        const parts = rejection.reason.split('; ');
        expect(parts.length, 'rejectionFromZodError joins all issues').toBe(2);
        expect(parts[0].includes('name must not be empty'), 'first issue (name) appears first in the joined reason').toBe(true);
        expect(parts[1].includes('count must be at least 1'), 'second issue (count) appears second in the joined reason').toBe(true);
        expect(JSON.stringify(rejection.issuePaths), 'rejectionFromZodError preserves dotted issuePaths in issue order').toBe(JSON.stringify(['name', 'count']));
      }
    });

    it('root-level issue (empty path) omits the dotted prefix', () => {
      const refineSchema = z.object({ a: z.number(), b: z.number() }).refine(v => v.a < v.b, { message: 'a must be less than b' });
      const refineResult = refineSchema.safeParse({ a: 5, b: 1 });
      expect(refineResult.success, 'refine schema fails as expected').toBe(false);
      if (!refineResult.success) {
        const rejection = rejectionFromZodError(refineResult.error, { code: 'validation' });
        expect(rejection.reason, 'root-level issue reason omits the empty dotted path').toBe('a must be less than b');
        expect(JSON.stringify(rejection.issuePaths), 'root-level issue contributes no issuePaths entry').toBe(JSON.stringify([]));
      }
    });

    it('root-level unrecognized_keys issue (empty path) still yields the Zod message', () => {
      const strictSchema = z.object({ id: z.string() }).strict();
      const strictResult = strictSchema.safeParse({ id: 'x', unexpected: true });
      expect(strictResult.success, 'strict schema rejects an unrecognized key').toBe(false);
      if (!strictResult.success) {
        const rejection = rejectionFromZodError(strictResult.error, { code: 'provider_invalid_tool_input' });
        expect(/unrecognized key/i.test(rejection.reason), 'root-level unrecognized_keys reason carries the Zod message, not a path-only stub').toBe(true);
        expect(rejection.reason !== 'invalid tool input', 'root-level unrecognized_keys reason is never the generic last-resort string').toBe(true);
      }
    });

    describe('input enrichment (measured size + scalar echo)', () => {
      const sizeSchema = z.object({
        badge_label: z.string().max(50),
        sections: z.array(z.object({ text: z.string() })).max(2),
      });

      it('too_big string: measured chars, the limit, and the verbatim sent value', () => {
        const input = { badge_label: 'x'.repeat(61), sections: [] };
        const result = sizeSchema.safeParse(input);
        expect(result.success).toBe(false);
        if (!result.success) {
          const rejection = rejectionFromZodError(result.error, { code: 'invalid_tool_input', input });
          expect(rejection.reason, 'measured size and limit replace the uncountable stock message')
            .toContain('badge_label: 61 chars, limit 50');
          expect(rejection.reason, 'scalar leaf is echoed verbatim so the model can edit, not regenerate')
            .toContain(`sent: "${'x'.repeat(61)}"`);
        }
      });

      it('too_big array: measured items and limit, but NEVER an echo of the array', () => {
        const input = { badge_label: 'ok', sections: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] };
        const result = sizeSchema.safeParse(input);
        expect(result.success).toBe(false);
        if (!result.success) {
          const rejection = rejectionFromZodError(result.error, { code: 'invalid_tool_input', input });
          expect(rejection.reason).toContain('sections: 3 items, limit 2');
          expect(rejection.reason, 'arrays are structural, not scalar — echoing one would re-open full-payload re-echo')
            .not.toContain('"text"');
        }
      });

      it('over-long scalar echo is hard-capped with an ellipsis', () => {
        const input = { badge_label: 'y'.repeat(500), sections: [] };
        const result = sizeSchema.safeParse(input);
        expect(result.success).toBe(false);
        if (!result.success) {
          const rejection = rejectionFromZodError(result.error, { code: 'invalid_tool_input', input });
          expect(rejection.reason).toContain('badge_label: 500 chars, limit 50');
          expect(rejection.reason).toContain('…');
          expect(rejection.reason.includes('y'.repeat(200)), 'echo never exceeds its cap').toBe(false);
        }
      });

      it('non-size issue on a scalar leaf appends the sent value after the stock message', () => {
        const enumSchema = z.object({ verdict: z.enum(['analyze', 'passthrough', 'prune']) });
        const input = { verdict: 'analyse' };
        const result = enumSchema.safeParse(input);
        expect(result.success).toBe(false);
        if (!result.success) {
          const rejection = rejectionFromZodError(result.error, { code: 'invalid_tool_input', input });
          expect(rejection.reason).toContain('sent: "analyse"');
        }
      });

      it('without input the stock Zod message is unchanged (callers not passing input are unaffected)', () => {
        const result = sizeSchema.safeParse({ badge_label: 'x'.repeat(61), sections: [] });
        expect(result.success).toBe(false);
        if (!result.success) {
          const rejection = rejectionFromZodError(result.error, { code: 'invalid_tool_input' });
          expect(rejection.reason).toContain('Too big: expected string to have <=50 characters');
          expect(rejection.reason).not.toContain('sent:');
        }
      });
    });
  });

  describe('readToolError', () => {
    it('folds a sibling key into detail', () => {
      const siblingKeyResult = readToolError({ error: 'unknown_node_ids', hint: 'x', offending_values: ['a', 'b'] });
      expect(siblingKeyResult !== null, 'readToolError recognizes the engine-rejection shape').toBe(true);
      if (siblingKeyResult) {
        expect(siblingKeyResult.code, 'readToolError preserves code').toBe('unknown_node_ids');
        expect(siblingKeyResult.hint, 'readToolError preserves hint').toBe('x');
        const detail = siblingKeyResult.detail as Record<string, unknown> | undefined;
        expect(!!detail, 'readToolError folds sibling keys into detail').toBe(true);
        expect(JSON.stringify(detail?.offending_values), 'readToolError detail carries the sibling offender array').toBe(JSON.stringify(['a', 'b']));
      }
    });

    it('folds the full errors[] array when length > 1', () => {
      const multiErrorsResult = readToolError({ success: false, errors: ['first problem', 'second problem', 'third problem'] });
      expect(multiErrorsResult !== null, 'readToolError recognizes the validation-failure shape').toBe(true);
      if (multiErrorsResult) {
        expect(multiErrorsResult.reason, 'readToolError reason stays errors[0]').toBe('first problem');
        const detail = multiErrorsResult.detail as Record<string, unknown> | undefined;
        expect(!!detail, 'readToolError attaches detail when errors.length > 1').toBe(true);
        expect(JSON.stringify(detail?.errors), 'readToolError detail carries the full errors[] array').toBe(JSON.stringify(['first problem', 'second problem', 'third problem']));
      }
    });

    it('single error stays lean (no synthetic detail.errors)', () => {
      const singleErrorResult = readToolError({ success: false, errors: ['only problem'] });
      expect(singleErrorResult !== null, 'readToolError recognizes a single-error validation shape').toBe(true);
      if (singleErrorResult) {
        expect(singleErrorResult.detail, 'readToolError omits detail.errors when only one error is present and no other siblings exist').toBe(undefined);
      }
    });

    it('preserves existing detail alongside folded siblings', () => {
      const existingDetailResult = readToolError({ error: 'bad_route', detail: { field: 'x' }, extra_fact: 42 });
      expect(existingDetailResult !== null, 'readToolError recognizes error shape with existing detail').toBe(true);
      if (existingDetailResult) {
        const detail = existingDetailResult.detail as Record<string, unknown> | undefined;
        expect(detail?.field, 'readToolError preserves the existing detail.field').toBe('x');
        expect(detail?.extra_fact, 'readToolError folds the unrecognized sibling key alongside existing detail').toBe(42);
      }
    });
  });

  describe('rejectionFromZodError: invalid_union expansion', () => {
    const BbVariant = z.object({ origin: z.string(), classification: z.string(), analysisMode: z.literal('bb') }).strict();
    const CtVariant = z.object({ origin: z.string(), classification: z.string(), analysisMode: z.literal('ct'), targetColumns: z.array(z.string()) }).strict();
    const modeUnion = z.union([BbVariant, CtVariant]);

    it('empty-object args name every required field of both variants', () => {
      const emptyUnionResult = modeUnion.safeParse({});
      expect(emptyUnionResult.success, 'empty-object args fail the union as expected').toBe(false);
      if (!emptyUnionResult.success) {
        const rejection = rejectionFromZodError(emptyUnionResult.error, { code: 'invalid_tool_input' });
        expect(rejection.reason.includes('input matched no variant'), 'union reason states the mechanical no-match verdict').toBe(true);
        expect(rejection.reason.includes('variant 1: origin, classification, analysisMode'), 'union reason names variant 1 required fields').toBe(true);
        expect(rejection.reason.includes('variant 2: origin, classification, analysisMode, targetColumns'), 'union reason names variant 2 required fields').toBe(true);
        expect(
          JSON.stringify(rejection.issuePaths),
          'issuePaths flatten every branch field path, first-branch-first, deduped',
        ).toBe(JSON.stringify(['origin', 'classification', 'analysisMode', 'targetColumns']));
      }
    });

    it('partial args name only the still-missing fields per branch', () => {
      const partialUnionResult = modeUnion.safeParse({ origin: 'node1' });
      expect(partialUnionResult.success, 'partial args still fail the union').toBe(false);
      if (!partialUnionResult.success) {
        const rejection = rejectionFromZodError(partialUnionResult.error, { code: 'invalid_tool_input' });
        expect(rejection.reason.includes('variant 1: classification, analysisMode'), 'partial-args reason omits the already-satisfied origin field for variant 1').toBe(true);
        expect(rejection.reason.includes('variant 2: classification, analysisMode, targetColumns'), 'partial-args reason omits the already-satisfied origin field for variant 2').toBe(true);
        expect(rejection.reason.includes('variant 1: origin'), 'partial-args reason does not re-list a field the input already satisfied').toBe(false);
      }
    });

    it('nested union carries the full dotted path from the payload root', () => {
      const nestedUnionResult = z.object({ column_flow: z.array(modeUnion) }).safeParse({ column_flow: [{}] });
      expect(nestedUnionResult.success, 'nested union under an array element fails as expected').toBe(false);
      if (!nestedUnionResult.success) {
        const rejection = rejectionFromZodError(nestedUnionResult.error, { code: 'invalid_tool_input' });
        expect(rejection.reason.startsWith('column_flow.0: input matched no variant'), 'nested union reason is prefixed with the full path to the union field').toBe(true);
        expect(rejection.issuePaths?.includes('column_flow.0.origin'), 'nested union issuePaths carry the full dotted path from the payload root').toBe(true);
      }
    });

    it('present-but-wrong scalar names the defect of every variant when input is supplied', () => {
      // Class: a scalar union (number | literal) receiving a quoted JSON number. Both branches
      // name the same single field, so a bare field listing collapses to "variant N: field"
      // twice — the model regenerates the identical call blind. The reason must carry each
      // branch's own expected-vs-received defect plus the bounded verbatim echo.
      const limitUnion = z.object({ limit: z.union([z.number().int().min(1), z.literal('all')]) });
      const quotedResult = limitUnion.safeParse({ limit: '1' });
      expect(quotedResult.success, 'quoted number fails the scalar union as expected').toBe(false);
      if (!quotedResult.success) {
        const rejection = rejectionFromZodError(quotedResult.error, { code: 'invalid_tool_input', input: { limit: '1' } });
        expect(rejection.reason.includes('limit: input matched no variant'), 'scalar-union reason keeps the no-match verdict and path prefix').toBe(true);
        expect(rejection.reason.includes('expected number, received string'), 'variant 1 prose states the string-vs-number defect').toBe(true);
        expect(rejection.reason.includes('expected "all"'), 'variant 2 prose states the literal alternative').toBe(true);
        expect(rejection.reason.includes('sent: "1"'), 'scalar-union prose echoes the sent value verbatim').toBe(true);
      }
    });

    it('a wrapper-nested union (nullable) flattens to leaf variants that name their defects', () => {
      // Class: Zod wrappers (`.nullable()`, `.optional()`) compile to a union whose first branch is
      // the authored union itself. Unflattened, the nested level renders a bare `"Invalid input"`
      // variant that names no field and no defect, and hides the authored alternatives entirely.
      const wrappedUnion = z.object({ limit: z.union([z.number().int().min(1), z.literal('all'), z.object({ a: z.string() })]).nullable().optional() });
      const quotedResult = wrappedUnion.safeParse({ limit: '1' });
      expect(quotedResult.success, 'quoted number fails the wrapper-nested union as expected').toBe(false);
      if (!quotedResult.success) {
        const rejection = rejectionFromZodError(quotedResult.error, { code: 'invalid_tool_input', input: { limit: '1' } });
        expect(rejection.reason.includes('variant 3: limit: Invalid input: expected object, received string'), 'flattened variant 3 is the leaf object alternative with its defect').toBe(true);
        expect(rejection.reason.includes('expected number, received string'), 'flattened variant 1 states the string-vs-number defect').toBe(true);
        expect(rejection.reason.includes('expected "all"'), 'flattened variant 2 states the literal alternative').toBe(true);
        expect(rejection.reason.match(/Invalid input;/g)?.length ?? 0, 'no bare wrapper-variant "Invalid input" descriptors remain').toBe(0);
      }
    });

    it('absent fields keep their bare-name listing even when input is supplied', () => {
      const emptyUnionResult = modeUnion.safeParse({});
      expect(emptyUnionResult.success, 'empty-object args fail the union as expected').toBe(false);
      if (!emptyUnionResult.success) {
        const rejection = rejectionFromZodError(emptyUnionResult.error, { code: 'invalid_tool_input', input: {} });
        expect(rejection.reason.includes('variant 1: origin, classification, analysisMode'), 'absent fields stay bare — the missing name is the defect').toBe(true);
        expect(rejection.reason.includes('received undefined'), 'absent fields do not add noise from the received-undefined type message').toBe(false);
      }
    });

    it('without input the union expansion keeps the bare field listing', () => {
      const limitUnion = z.object({ limit: z.union([z.number().int().min(1), z.literal('all')]) });
      const quotedResult = limitUnion.safeParse({ limit: '1' });
      expect(quotedResult.success, 'quoted number fails the scalar union as expected').toBe(false);
      if (!quotedResult.success) {
        const rejection = rejectionFromZodError(quotedResult.error, { code: 'invalid_structured_output' });
        expect(rejection.reason.includes('variant 1: limit'), 'no input → no enrichment, bare field listing').toBe(true);
        expect(rejection.reason.includes('sent:'), 'no input → no verbatim echo').toBe(false);
      }
    });

    it('a nested union on a named field keeps that field in the prose, the echo, and issuePaths', () => {
      // Class: the shipped `depth` schema — an outer union whose object branch carries a per-side
      // union (`{upstream: number | "all"}`). Splicing the nested level must rebase its leaves onto
      // the field it sits on: collapsed to the parent name, the reason blames `depth`, the echo
      // resolves to the whole object (so no `sent:` at all), and `issuePaths` never names the one
      // side the model has to change.
      const sideUnion = z.union([z.number().int().min(0), z.literal('all')]);
      const depthUnion = z.object({
        depth: z.union([z.number().int().min(1), z.object({ upstream: sideUnion, downstream: sideUnion })]),
      });
      const input = { depth: { upstream: 'two', downstream: 1 } };
      const nestedResult = depthUnion.safeParse(input);
      expect(nestedResult.success, 'a bad per-side value fails the nested union as expected').toBe(false);
      if (!nestedResult.success) {
        const rejection = rejectionFromZodError(nestedResult.error, { code: 'invalid_tool_input', input });
        expect(rejection.reason.includes('depth.upstream:'), 'the nested leaf names the offending side, not its parent').toBe(true);
        expect(rejection.reason.includes('sent: "two"'), 'the echo resolves at the rebased path, not the parent object').toBe(true);
        expect(rejection.issuePaths?.includes('depth.upstream'), 'issuePaths name the offending side').toBe(true);
      }
    });

    it('regression pin: a non-union error keeps the "<path>: <message>" format untouched', () => {
      const nonUnionResult = z.object({ name: z.string() }).strict().safeParse({});
      expect(nonUnionResult.success, 'non-union schema fails as expected').toBe(false);
      if (!nonUnionResult.success) {
        const rejection = rejectionFromZodError(nonUnionResult.error, { code: 'invalid_tool_input' });
        expect(rejection.reason, 'non-union reason format is unchanged by the invalid_union branch').toBe('name: Invalid input: expected string, received undefined');
        expect(rejection.reason.includes('variant'), 'non-union reason never mentions union variants').toBe(false);
      }
    });
  });
});
