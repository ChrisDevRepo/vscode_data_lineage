/** Structural contract of the one rejection renderer (D-103, D-105): every model-visible sentence is a category template or a static string of its issue code, and no submitted value reaches the model. */
import { ISSUE_CATEGORIES, ISSUES, LAST_CORRECTION, RESEND_RULES, makeRejection, renderProblem, type FeedbackStage, type ToolRejection } from '../../../src/ai/support/toolErrorEnvelope';
import { buildRouteValidationRejection } from '../../../src/ai/sm/smRouteValidation';
import { describe, expect, it } from 'vitest';

interface Guidance { category: keyof typeof ISSUE_CATEGORIES; instruction: string; errors: Array<{ path: string; fault: string; correction: string; allowed?: string[]; missing?: string[]; more?: number }>; more?: number; fallback?: string }
interface Rendered { code: string; attempt: string; notice?: string; guidance: Guidance[]; resend: string[]; resend_rule?: string }

const SENTINEL = 'zz_SUBMITTED_SENTINEL_zz';
const FALLBACK = (code: keyof typeof ISSUES): string | undefined => (ISSUES[code] as { fallback?: string }).fallback;

/** Every rendered sentence is a static template string: instructions are category texts, faults and corrections belong to one issue of that category, a fallback is the fallback of an issue code of its group and only at feedback 3, the notice and resend rule come from their tables. */
function assertStructural(rendered: Rendered): void {
  expect(Object.keys(rendered).every(key => ['code', 'attempt', 'notice', 'guidance', 'resend', 'resend_rule'].includes(key))).toBe(true);
  expect(rendered.attempt).toMatch(/^[123]\/3$/);
  if (rendered.notice !== undefined) expect(rendered.notice).toBe(LAST_CORRECTION);
  for (const group of rendered.guidance) {
    const category: { short: string; detailed: string } = ISSUE_CATEGORIES[group.category];
    expect([category.short, category.detailed]).toContain(group.instruction);
    for (const error of group.errors) {
      expect(Object.values(ISSUES).some(issue => issue.category === group.category && issue.label === error.fault && issue.correction === error.correction), error.fault).toBe(true);
    }
    if (group.fallback !== undefined) {
      expect(rendered.attempt).toBe('3/3');
      expect(Object.values(ISSUES).some(issue => issue.category === group.category && (issue as { fallback?: string }).fallback === group.fallback)).toBe(true);
      expect(rendered.resend).toContain('sections');
    }
  }
  if (rendered.resend_rule !== undefined) {
    let rest = rendered.resend_rule;
    for (const rule of Object.values(RESEND_RULES)) rest = rest.replace(rule, '');
    expect(rest.trim()).toBe('');
  }
  expect(JSON.stringify(rendered)).not.toContain(SENTINEL);
}

const render = (rejection: ToolRejection, stage: FeedbackStage, input?: unknown): Rendered =>
  JSON.parse(renderProblem(rejection, stage, input));

/** The R1 shape: a column supplier outside the approved scope, nothing in scope to name instead. */
const r1 = (): ToolRejection => buildRouteValidationRejection([{ kind: 'supplier_out_of_scope', id: SENTINEL, path: 'column_flow.0.upstream_columns.0.node',
  reason: `${SENTINEL} is outside the approved scope.`, allowed_values: [] }]);

describe('rejection renderer structure', () => {
  it('renders only static table strings, never a submitted value', () => {
    for (const stage of [1, 2, 3] as const) {
      const rendered = render(r1(), stage, { column_flow: [{ upstream_columns: [{ node: SENTINEL }] }] });
      assertStructural(rendered);
      expect(rendered.notice !== undefined).toBe(stage === 3);
    }
  });

  it('states a fault tersely at feedback 1, in detail with an empty allowed set at feedback 2, and the fallback only with the third rejection', () => {
    for (const stage of [1, 2] as const) {
      const rendered = render(r1(), stage);
      const reference = rendered.guidance.find(group => group.category === 'reference');
      expect(reference?.instruction).toBe(stage === 1 ? ISSUE_CATEGORIES.reference.short : ISSUE_CATEGORIES.reference.detailed);
      expect(reference?.errors).toEqual([{ path: 'column_flow.0.upstream_columns.0.node', fault: ISSUES.supplier_out_of_scope.label, correction: ISSUES.supplier_out_of_scope.correction, ...(stage === 2 ? { allowed: [] } : {}) }]);
      expect(reference?.fallback).toBeUndefined();
      expect(rendered.resend).not.toContain('sections');
    }
    const third = render(r1(), 3);
    expect(third.guidance.find(group => group.category === 'reference')?.fallback).toBe(FALLBACK('supplier_out_of_scope'));
    expect(third.resend).toContain('sections');
  });

  it('withholds a non-empty allowed set until feedback 2', () => {
    const rejection = makeRejection({ code: 'invalid_input', errors: [{ path: 'column_flow.0.upstream_columns.0.node', code: 'supplier_out_of_scope', values: ['[dbo].[b]', '[dbo].[a]'] }] });
    const input = { column_flow: [{ upstream_columns: [{ node: '[dbo].[b]x' }] }] };
    const [one, two] = ([1, 2] as const).map(stage => render(rejection, stage, input));
    expect(one.guidance[0].errors[0]).not.toHaveProperty('allowed');
    expect(two.guidance[0].errors[0].allowed).toEqual(['[dbo].[b]', '[dbo].[a]']);
  });

  it('attaches a fallback per issue code: only codes whose fact no structured field can hold carry one', () => {
    expect(Object.entries(ISSUES).filter(([, issue]) => 'fallback' in issue).map(([code]) => code).sort()).toEqual(['result_out_of_scope', 'supplier_out_of_scope']);
    // A write target outside the scope has a schema-defined form, so its third rejection ends without a fallback.
    const write = render(makeRejection({ code: 'invalid_input', errors: [{ path: 'column_flow.0.writes_to.node', code: 'out_of_scope', values: [] }] }), 3);
    expect(write.guidance[0].fallback).toBeUndefined();
    expect(write.resend).toEqual([]);
    const present = render(makeRejection({ code: 'invalid_input', errors: [{ path: 'sections.0.node_ids.1', code: 'result_out_of_scope', values: ['[dbo].[a]'] }] }), 3);
    assertStructural(present);
    expect(present.guidance[0].fallback).toBe(FALLBACK('result_out_of_scope'));
  });

  it('renders required values as missing from stage 1', () => {
    const rendered = render(makeRejection({ code: 'invalid_input', errors: [{ path: 'sections.*.node_ids', code: 'slot_unplaced', values: ['slot_2', 'slot_1'] }] }), 1);
    expect(rendered.guidance).toEqual([expect.objectContaining({ category: 'required', errors: [{ path: 'sections.*.node_ids', fault: ISSUES.slot_unplaced.label, correction: ISSUES.slot_unplaced.correction, missing: ['slot_1', 'slot_2'] }] })]);
  });

  it('states a category instruction once for three faults of that category, each with its correction', () => {
    const rejection = makeRejection({ code: 'invalid_input', errors: [0, 1, 2].map(index => ({ path: `column_flow.${index}.out_col`, code: 'unknown_column' as const, values: ['a'] })) });
    const rendered = render(rejection, 1);
    expect(JSON.stringify(rendered).split(ISSUE_CATEGORIES.reference.short).length - 1).toBe(1);
    expect(rendered.guidance[0].errors.map(error => error.path)).toEqual(['column_flow.0.out_col', 'column_flow.1.out_col', 'column_flow.2.out_col']);
    expect(rendered.guidance[0].errors.map(error => error.correction)).toEqual(Array(3).fill(ISSUES.unknown_column.correction));
  });

  it('orders categories and suppresses only descendants of a missing parent', () => {
    const rejection = makeRejection({ code: 'invalid_input', errors: [
      { path: 'summary', code: 'enum', values: ['x'] },
      { path: 'column_flow', code: 'missing' },
      { path: 'column_flow.0.out_col', code: 'unknown_column' },
      { path: 'sections', code: 'type' },
      { path: 'sections.business', code: 'missing' },
    ] });
    const rendered = render(rejection, 1);
    expect(rendered.guidance.map(group => group.category)).toEqual(['shape', 'required', 'value']);
    expect(rendered.guidance[1].errors.map(error => error.path)).toEqual(['column_flow', 'sections.business']);
  });
});
