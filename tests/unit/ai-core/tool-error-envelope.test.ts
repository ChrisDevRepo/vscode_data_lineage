/** Deterministic production tool-error-envelope contract: the one rejection record and its one renderer (D-103, D-105). Messages come from the issue-code table and are never pinned; tests assert paths, codes, allowed values and the stage. */
import { PROBLEM_MESSAGES, readToolError, isConsentGateRejection, makeRejection, rejectionFromZodError, renderProblem, type FeedbackStage } from '../../../src/ai/support/toolErrorEnvelope';
import { buildRouteValidationRejection } from '../../../src/ai/sm/smRouteValidation';
import type { InvalidRouteKind } from '../../../src/ai/sm/smTypes';
import { validatePresentResult } from '../../../src/ai/tools/presentResult';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

interface Problem { code: string; errors: Array<{ path: string; code: string; message: string; allowed?: string[] }>; resend: string[] }
const render = (rejection: Parameters<typeof renderProblem>[0], stage: FeedbackStage): Problem => JSON.parse(renderProblem(rejection, stage));
const zodRejection = (schema: z.ZodType, input: unknown, hint?: string) => {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error('Expected schema faults');
  return rejectionFromZodError(parsed.error, { code: 'invalid_input', input, schema, ...(hint ? { hint } : {}) });
};
const at = (problem: Problem, path: string) => problem.errors.find(error => error.path === path);

describe("tool-error-envelope", () => {
  it('retains typed correction alternatives on every rejection', () => {
    const rejection = makeRejection({ code: 'invalid_regex', issuePaths: ['query'], resend: ['mode'] });
    expect(rejection.resend).toEqual(['mode']);
    expect(readToolError(JSON.parse(JSON.stringify(rejection)))?.resend).toEqual(['mode']);
    expect(render(rejection, 1).resend).toEqual(['mode']);
  });

  it('renders an owner rejection: the fault at its path from feedback 1, allowed values from detail from feedback 2, the record unchanged', () => {
    const rejection = makeRejection({ code: 'contributor_col_not_on_source',
      reason: 'Column does not exist on the contributor.',
      hint: 'Correct this column reference or remove this supplier.',
      issuePaths: ['column_flow.0.upstream_columns.1.col'],
      detail: [{ kind: 'bad_contributor_col', path: 'column_flow.0.upstream_columns.1.col', id: '[d].[Source]',
        allowed_values: ['Amount', 'Rate'], when: { node: '[d].[Source]' } }],
    });
    const original = structuredClone(rejection);
    const first = render(rejection, 1);
    expect(Object.keys(first).sort()).toEqual(['code', 'errors', 'resend']);
    expect(first.errors).toEqual([
      { path: 'column_flow.0.upstream_columns.1.col', code: rejection.code, message: rejection.reason },
      { path: '', code: rejection.code, message: rejection.hint },
    ]);
    expect(at(render(rejection, 2), 'column_flow.0.upstream_columns.1.col')?.allowed).toEqual(['Amount', 'Rate']);
    expect(rejection, 'rendering leaves the local record unchanged').toEqual(original);
    for (const stage of [1, 2, 3] as const) {
      const guidanceOnly = makeRejection({ code: 'invalid_input', hint: 'Supply the required tool call.' });
      expect(render(guidanceOnly, stage).errors).toEqual([{ path: '', code: 'invalid_input', message: guidanceOnly.hint }]);
      expect(render({ ...rejection, hint: rejection.reason }, stage).errors.filter(error => error.path === '')).toEqual([]);
    }
  });

  it.each([0, 3, 12])('reserves all %i allowed values for feedback 2 and keeps every fault from feedback 1', count => {
    const allowed = Array.from({ length: count }, (_, index) => `C${index}`);
    const rejection = makeRejection({ code: 'invalid_input', reason: 'diagnostic prose', detail: [{ kind: 'x' }],
      errors: [{ path: 'column_flow.0.upstream_columns.0.col', code: 'enum', message: 'Unknown column.', allowed },
        { path: 'badge_label', code: 'size', message: 'Too long.' }],
      resend: ['column_flow', 'badge_label'] });
    expect(readToolError(JSON.parse(JSON.stringify(rejection)))).toEqual(rejection);
    expect(render(rejection, 1)).toEqual({ code: 'invalid_input', resend: ['column_flow', 'badge_label'],
      errors: [{ path: 'column_flow.0.upstream_columns.0.col', code: 'enum', message: 'Unknown column.' },
        { path: 'badge_label', code: 'size', message: 'Too long.' }] });
    expect(render(rejection, 2)).toEqual({ code: 'invalid_input', resend: ['column_flow', 'badge_label'],
      errors: [{ path: 'column_flow.0.upstream_columns.0.col', code: 'enum', message: 'Unknown column.', allowed },
        { path: 'badge_label', code: 'size', message: 'Too long.' }] });
  });

  it('derives errors from Zod issues: allowed values from the issue, a submitted value never echoed (D-102)', () => {
    const schema = z.object({ mode: z.enum(['a', 'b']), items: z.array(z.object({ name: z.string() }).strict()), count: z.number() }).strict();
    const input = { mode: 'zzz-sent', items: [{ name: 'ok', extra: 1 }], count: 'x'.repeat(200) };
    const rejection = zodRejection(schema, input);
    expect(rejection.hint).toBeUndefined();
    expect(rejection.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'mode', code: 'enum', allowed: ['a', 'b'] }),
      expect.objectContaining({ path: 'items.0.extra', code: 'unknown_key', allowed: ['name'] }),
      expect.objectContaining({ path: 'count', code: 'type' }),
    ]));
    for (const stage of [1, 2, 3] as const) expect(renderProblem(rejection, stage)).not.toMatch(/zzz-sent|xxxxx/);
  });

  it.each([z.number(), z.number().int()])('reports a numeric type fault without choosing or echoing a value: %s', owner => {
    const schema = z.object({ value: owner });
    for (const value of [null, 'three']) {
      const rejection = zodRejection(schema, { value });
      expect(rejection.issuePaths).toEqual(['value']);
      expect(rejection.errors).toEqual([expect.objectContaining({ path: 'value', code: 'type' })]);
      expect(rejection.errors![0].message).not.toContain('three');
    }
  });

  it.each([false, true])('names an unknown key from feedback 1 and its allowed fields from feedback 2 (nested=%s)', nested => {
    const schema = z.object({ entry: z.object({ value: z.string() }).strict() }).strict();
    const input = nested ? { entry: { value: 'Keep this text.', extra: 'Move or remove me.' } }
      : { entry: { value: 'Keep this text.' }, extra: 'Move or remove me.' };
    const before = structuredClone(input);
    const rejection = zodRejection(schema, input);
    const path = nested ? 'entry.extra' : 'extra';
    expect(render(rejection, 1).errors).toEqual([{ path, code: 'unknown_key', message: expect.any(String) }]);
    expect(render(rejection, 2).errors[0].allowed).toEqual([nested ? 'value' : 'entry']);
    expect(input).toEqual(before);
  });

  it('keeps the empty allowed set of a native never fault', () => {
    const schema = z.object({ items: z.array(z.object({ id: z.never() }).strict()) }).strict();
    const rejection = zodRejection(schema, { items: [{ id: 'invalid' }] });
    expect(render(rejection, 1).errors).toEqual([{ path: 'items.0.id', code: 'never', message: expect.any(String) }]);
    expect(render(rejection, 2).errors).toEqual([expect.objectContaining({ path: 'items.0.id', code: 'never', allowed: [] })]);
  });

  describe('D-105 feedback 3: the fallback guidance only on faults at reference leaves', () => {
    const fault = (path: string, code: string) => makeRejection({ code: 'invalid_input', reason: 'Fault.', errors: [{ path, code, message: 'Fault.' }] });
    const submit = 'lineage_submit_findings', present = 'lineage_present_result';
    it.each([
      { tool: submit, path: 'column_flow.0.out_col', code: 'enum' },
      { tool: submit, path: 'column_flow.1.writes_to.node', code: 'column_out_of_scope' },
      { tool: submit, path: 'column_flow.0.writes_to.col', code: 'enum' },
      { tool: submit, path: 'column_flow.0.upstream_columns.2', code: 'self_loop_column' },
      { tool: submit, path: 'column_flow.0.upstream_columns.0.node', code: 'enum' },
      { tool: submit, path: 'column_flow.0.upstream_columns.0.col', code: 'contributor_col_not_on_source' },
      { tool: present, path: 'sections.0.node_ids', code: 'invalid' },
      { tool: present, path: 'sections.0.node_ids.3', code: 'enum' },
      { tool: present, path: 'notes.1.node_id', code: 'enum' },
      { tool: present, path: 'highlight_groups.0.node_ids', code: 'invalid' },
      { tool: present, path: 'highlight_groups.0.node_ids.1', code: 'enum' },
    ])('$tool $path ($code): guidance at feedback 3 only', ({ tool, path, code }) => {
      for (const stage of [1, 2] as const) expect(renderProblem(fault(path, code), stage, tool)).not.toContain(PROBLEM_MESSAGES.fallback);
      expect(at(JSON.parse(renderProblem(fault(path, code), 3, tool)), path)!.message).toContain(PROBLEM_MESSAGES.fallback);
    });
    it.each([
      { tool: submit, path: 'summary', code: 'type' },
      { tool: submit, path: 'badge_label', code: 'size' },
      { tool: submit, path: 'sections.technical', code: 'type' },
      { tool: submit, path: 'column_flow.0.upstream_columns.0.transforms.0', code: 'enum' },
      { tool: submit, path: 'prune_neighbors.0.id', code: 'enum' },
      { tool: submit, path: 'questions.0.nodeId', code: 'enum' },
      { tool: submit, path: 'sections.business', code: 'unknown_key' },
      { tool: submit, path: 'column_flow.0.out_col', code: 'missing' },
      { tool: submit, path: '[dbo].[Source]', code: 'neighbor_outcome_missing' },
      { tool: present, path: 'sections.0.text', code: 'size' },
      { tool: present, path: 'highlight_groups.0.color', code: 'enum' },
      { tool: 'lineage_search_objects', path: 'column_flow.0.out_col', code: 'enum' },
      { tool: 'lineage_start_exploration', path: 'origin', code: 'enum' },
      { tool: undefined, path: 'column_flow.0.out_col', code: 'enum' },
    ])('$tool $path ($code): no guidance at any feedback', ({ tool, path, code }) => {
      for (const stage of [1, 2, 3] as const) expect(renderProblem(fault(path, code), stage, tool)).not.toContain(PROBLEM_MESSAGES.fallback);
    });
    it('the guidance moves the information to the detail memory with a callout and never frames leaving the value out as the remedy', () => {
      const message = at(JSON.parse(renderProblem(fault('column_flow.0.out_col', 'enum'), 3, submit)), 'column_flow.0.out_col')!.message;
      expect(message).toMatch(/detail memory/);
      expect(message).toMatch(/callout/);
      expect(message).not.toMatch(/omit|leave (it )?out|null|\[\]|remove|withdraw|do not send|don't send/i);
    });
  });

  describe('D-105: no model-visible message offers a leave-out remedy (drop, omit, null, [], remove, withdraw, do not send)', () => {
    const LEAVE_OUT = /\b(drop|omit|remove|withdraw)\b|leave (it )?out|do not send|don't send|\bnull\b|\[\]/i;
    // Every route fault kind, at the path the engine reports it on (exhaustive by type).
    const ROUTE_PATHS: Record<InvalidRouteKind, string> = {
      absent_contributor: 'column_flow.0.upstream_columns.0.node', bad_out_col: 'column_flow.0.out_col',
      bad_contributor_col: 'column_flow.0.upstream_columns.0.col', self_loop_column: 'column_flow.0.upstream_columns.1',
      bad_return_target: 'column_flow.0.returns_to', bad_write_target: 'column_flow.0.writes_to.node',
      bad_caller_context: 'questions.0.caller_context.col', pruned_contributor: 'column_flow.0.upstream_columns.0.node',
      column_out_of_scope: 'column_flow.0.writes_to.node', prune_absent: 'prune_neighbors.0.id', prune_noop_removed: 'prune_neighbors.0.id',
      prune_noop_visited: 'prune_neighbors.0.id', prune_noop_analyzed: 'prune_neighbors.0.id', prune_noop_queued: 'prune_neighbors.0.id',
      prune_noop_out_of_scope: 'prune_neighbors.0.id', prune_unsupported: 'prune_neighbors.0.id', prune_question_conflict: 'questions.0.nodeId',
      question_not_neighbor: 'questions.0.nodeId', question_closed: 'questions.0.nodeId', neighbor_outcome_missing: '[dbo].[X]',
    };
    const messages = (content: string, fieldsOnly = false): string[] => (JSON.parse(content) as Problem).errors
      .filter(error => !fieldsOnly || error.path !== '').map(error => error.message);
    it.each(Object.entries(ROUTE_PATHS))('route fault %s at %s, feedback 1-3', (kind, path) => {
      const routes = [{ kind: kind as InvalidRouteKind, id: '[dbo].[X]', path, reason: 'Fault.' }];
      // A refused prune of the same neighbor selects the other conflict directive.
      const variants = kind === 'prune_question_conflict' ? [routes, [...routes, { kind: 'prune_unsupported' as const, id: '[dbo].[X]', path: 'prune_neighbors.0.id', reason: 'Fault.' }]] : [routes];
      for (const variant of variants) for (const stage of [1, 2, 3] as const) {
        for (const message of messages(renderProblem(buildRouteValidationRejection(variant), stage, 'lineage_submit_findings'))) expect(message).not.toMatch(LEAVE_OUT);
      }
    });
    it('every issue-code message but the key texts (unknown_key, never), and the fallback', () => {
      for (const [code, message] of Object.entries(PROBLEM_MESSAGES)) if (code !== 'unknown_key' && code !== 'never') expect(message).not.toMatch(LEAVE_OUT);
    });
    // Field messages and the node-id hint; the held-draft patch syntax of the call-level repair instruction is MW-4/MW-5's.
    it.each(['completed', 'synthesis', 'visual_preview'] as const)('present_result unknown node id at %s, feedback 1-3', stage => {
      const result = validatePresentResult({ name: 'Reports', summary: 'Reports lineage.', highlight_groups: [{ label: 'Out', color: 'target', node_ids: ['[dbo].[x]'] }],
        sections: [{ label: 'Report', node_ids: ['[dbo].[a]', '[dbo].[x]'], text: 'Report output.' }] }, ['[dbo].[a]'], undefined, undefined, [], stage, () => 'out_of_scope');
      if (result.success) throw new Error('Expected a node-id rejection');
      for (const feedback of [1, 2, 3] as const) {
        for (const message of messages(renderProblem(result.rejection, feedback, 'lineage_present_result'), true)) expect(message).not.toMatch(LEAVE_OUT);
        expect(result.rejection.hint).toBeDefined();
        expect(result.rejection.hint!.split('Call lineage_present_result')[0]).not.toMatch(LEAVE_OUT);
      }
    });
  });

  it('renders only the problem shape: diagnostic fields and held report bodies never reach the model', () => {
    const rejection = makeRejection({ code: 'invalid_input', reason: 'Label is required.',
      issuePaths: ['sections.0.label'], detail: [
        { kind: 'too_small', path: 'sections.0.label', minimum: 1, reason: 'Label is required.', input: 'RAW_INPUT_SENTINEL', stack: 'STACK_SENTINEL' },
        { held_draft: { sections: [{ label: 'HELD_LABEL_SENTINEL', start: 'B1', text: 'HELD_BODY_SENTINEL' }] }, debug: 'DEBUG_SENTINEL' },
      ] });
    for (const stage of [1, 2, 3] as const) {
      const content = renderProblem(rejection, stage);
      expect(Object.keys(JSON.parse(content)).sort()).toEqual(['code', 'errors', 'resend']);
      expect(JSON.parse(content).errors).toEqual([{ path: 'sections.0.label', code: 'invalid_input', message: expect.stringContaining(rejection.reason) }]);
      expect(content).not.toMatch(/RAW_INPUT_SENTINEL|STACK_SENTINEL|HELD_BODY_SENTINEL|HELD_LABEL_SENTINEL|DEBUG_SENTINEL/);
    }
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

  describe('rejectionFromZodError: invalid_union', () => {
    it('a field missing in every variant is one missing fault, not one per branch', () => {
      const levelsSchema = z.union([z.number().int().min(0), z.literal('all')]);
      const sideSchema = z.object({ levels: levelsSchema, exactness: z.enum(['exact', 'approximate']) }).strict();
      const depth = z.object({ upstream: sideSchema, downstream: sideSchema }).strict();
      const provider = z.union([
        z.object({ analysisMode: z.literal('bb'), depth }).strict(),
        z.object({ analysisMode: z.literal('ct'), depth, targetColumns: z.array(z.string()) }).strict(),
      ]);
      const payload = { analysisMode: 'bb', depth: { upstream: { exactness: 'exact' }, downstream: { levels: 2, exactness: 'exact' } } };
      const rejection = zodRejection(provider, payload);
      expect(rejection.errors!.filter(error => error.path === 'depth.upstream.levels')).toEqual([expect.objectContaining({ code: 'missing' })]);
    });

    it('an empty call names every field the variants require', () => {
      const bbVariant = z.object({ origin: z.string(), classification: z.string(), analysisMode: z.literal('bb') }).strict();
      const ctVariant = z.object({ origin: z.string(), classification: z.string(), analysisMode: z.literal('ct'), targetColumns: z.array(z.string()) }).strict();
      const rejection = zodRejection(z.union([bbVariant, ctVariant]), {});
      expect(rejection.errors!.map(error => error.path)).toEqual(expect.arrayContaining(['origin', 'classification', 'analysisMode']));
      for (const path of ['origin', 'classification']) expect(rejection.errors!.filter(error => error.path === path)).toHaveLength(1);
    });
  });

  describe('rejectionFromZodError: a present value outside its enum', () => {
    const flowSchema = z.object({
      verdict: z.enum(['pass', 'fail']),
      flow: z.array(z.object({ out: z.literal('Qty'), src: z.string() }).strict()).optional(),
    }).strict();

    it('names each offending entry from feedback 1 and holds the allowed values for feedback 2', () => {
      const rejection = zodRejection(flowSchema, { verdict: 'pass', flow: [{ out: 'Qty', src: 'x' }, { out: 'Other', src: 'y' }, { out: 'More', src: 'z' }] });
      const first = render(rejection, 1);
      expect(first.errors.map(error => [error.path, error.code])).toEqual([['flow.1.out', 'enum'], ['flow.2.out', 'enum']]);
      expect(JSON.stringify(first)).not.toMatch(/Qty|Other|More/);
      expect(render(rejection, 2).errors.map(error => error.allowed)).toEqual([['Qty'], ['Qty']]);
    });

    it('a top-level required enum field: allowed values from feedback 2, never echoed before', () => {
      const rejection = zodRejection(flowSchema, { verdict: 'maybe' });
      expect(renderProblem(rejection, 1)).not.toMatch(/"pass"|"fail"|maybe/);
      expect(render(rejection, 2).errors).toEqual([expect.objectContaining({ path: 'verdict', code: 'enum', allowed: ['pass', 'fail'] })]);
    });

    it('the first and the repeated rejection of the same call render identically', () => {
      const payload = { verdict: 'pass', flow: [{ out: 'Other', src: 'y' }] };
      for (const stage of [1, 2, 3] as const)
        expect(renderProblem(zodRejection(flowSchema, payload), stage)).toBe(renderProblem(zodRejection(flowSchema, structuredClone(payload)), stage));
    });

    it('a caller-supplied hint is the call-level error; the structured choices stay staged', () => {
      const rejection = zodRejection(flowSchema, { verdict: 'maybe' }, 'Own hint.');
      expect(rejection.hint).toBe('Own hint.');
      expect(render(rejection, 1).errors).toEqual([expect.objectContaining({ path: 'verdict', code: 'enum' }), { path: '', code: 'invalid_input', message: 'Own hint.' }]);
      expect(at(render(rejection, 1), 'verdict')).not.toHaveProperty('allowed');
    });

    it('an absent enum field is missing, not an invalid value', () => {
      expect(zodRejection(flowSchema, {}).errors).toEqual([expect.objectContaining({ path: 'verdict', code: 'missing' })]);
    });
  });

  describe('rejectionFromZodError: a value of the wrong type under a size bound', () => {
    const schema = z.object({ notes: z.array(z.string()).max(8).optional(), title: z.string().max(8).optional() });

    it.each([undefined, 'nine char'])('a string sent for a bounded array is a type fault, an independent text limit a size fault (%s)', title => {
      const rejection = zodRejection(schema, { notes: 'Ignore logging-related objects', ...(title === undefined ? {} : { title }) });
      expect(rejection.errors).toEqual([expect.objectContaining({ path: 'notes', code: 'type' }),
        ...(title === undefined ? [] : [expect.objectContaining({ path: 'title', code: 'size' })])]);
      expect(rejection.issuePaths).toEqual(title === undefined ? ['notes'] : ['notes', 'title']);
    });

    it('a size violation on a value of the right type is still reported', () => {
      const rejection = zodRejection(schema, { notes: Array.from({ length: 9 }, () => 'n'), title: 'nine char' });
      expect(rejection.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'notes', code: 'size' }), expect.objectContaining({ path: 'title', code: 'size' })]));
    });
  });

  describe('rejectionFromZodError: a string or number outside its bound', () => {
    const schema = z.object({
      name: z.string().max(8).trim().min(1, 'name is required'),
      revision: z.number().int().positive().optional(),
    });

    it('a string over its cap is one size fault', () => {
      expect(zodRejection(schema, { name: 'x'.repeat(20) }).errors).toEqual([expect.objectContaining({ path: 'name', code: 'size' })]);
    });

    it('a blank string keeps the schema-authored message', () => {
      const rejection = zodRejection(schema, { name: '   ' });
      expect(rejection.errors).toEqual([expect.objectContaining({ path: 'name', code: 'size', message: expect.stringContaining('name is required') })]);
    });

    it('an exclusive numeric bound is a size fault', () => {
      expect(zodRejection(schema, { name: 'ok', revision: 0 }).errors).toEqual([expect.objectContaining({ path: 'revision', code: 'size' })]);
    });
  });

  describe('rejectionFromZodError: a key misplaced on a column_flow entry', () => {
    const ref = z.object({ node: z.string(), col: z.string(), note: z.string().optional() }).strict();
    const entry = z.object({ out_col: z.string(), writes_to: z.object({ node: z.string(), col: z.string() }).strict().nullish(), upstream_columns: z.array(ref) }).strict();
    const schema = z.object({ column_flow: z.array(entry) }).strict();
    const ok = { out_col: 'a', writes_to: null, upstream_columns: [] };

    it('stays rejected and names the concrete path with schema-derived allowed fields', () => {
      const rejection = zodRejection(schema, { column_flow: [ok, ok, ok, ok, { ...ok, note: 'misplaced' }] });
      expect(rejection.issuePaths).toEqual(['column_flow.4.note']);
      expect(render(rejection, 2).errors).toEqual([expect.objectContaining({ path: 'column_flow.4.note', code: 'unknown_key',
        allowed: ['out_col', 'writes_to', 'upstream_columns'] })]);
    });
  });
});
