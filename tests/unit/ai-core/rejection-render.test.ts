/** Approved08 / D-103 / D-105: one flat problem names every fault, stages metadata and report-reference fallback, and never echoes submitted values. */
import {
  ISSUES,
  makeRejection,
  renderProblem,
  type FeedbackStage,
  type IssueCode,
  type ToolProblem,
  type ToolRejection,
} from '../../../src/ai/support/toolErrorEnvelope';
import { buildRouteValidationRejection } from '../../../src/ai/sm/smRouteValidation';
import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../../../src/ai/tools/registry';
import { inspectTargetColumns } from '../../../src/ai/interaction/rules/startExplorationRules';
import { makeNode } from '../helpers/modelFixtures';

type Rendered = ToolProblem;

const SENTINEL = 'zz_SUBMITTED_SENTINEL_zz';
const fallbackOf = (code: IssueCode): string | undefined =>
  (ISSUES[code] as { fallback?: string }).fallback;
const render = (
  rejection: ToolRejection,
  stage: FeedbackStage,
  input?: unknown,
  effect?: ToolDefinition['effect'],
): Rendered => JSON.parse(renderProblem(rejection, stage, input, effect));

/** D-103: every error owns its path, code and table message; D-105 adds eligible fallback only at feedback 3. */
function assertStructural(rendered: Rendered): void {
  expect(Object.keys(rendered).sort()).toEqual(
    ['code', 'attempt', 'errors', 'resend'].sort(),
  );
  expect(rendered.attempt).toMatch(/^[123]\/3$/);
  expect(rendered.errors.length).toBeGreaterThan(0);
  for (const error of rendered.errors) {
    expect(Object.keys(error).sort()).toEqual(
      [
        'path',
        'code',
        'message',
        ...(error.allowed === undefined ? [] : ['allowed']),
      ].sort(),
    );
    const issue = ISSUES[error.code];
    expect(issue).toBeDefined();
    expect(error.message).toContain(issue.label);
    expect(error.message).toContain(issue.correction);
    const fallback = fallbackOf(error.code);
    if (fallback) {
      expect(error.message.includes(fallback)).toBe(rendered.attempt === '3/3');
      if (rendered.attempt === '3/3')
        expect(rendered.resend).toContain('sections');
    }
  }
  expect(JSON.stringify(rendered)).not.toContain(SENTINEL);
}

/** A supplier outside scope has no valid in-scope replacement. */
const r1 = (): ToolRejection =>
  buildRouteValidationRejection([
    {
      kind: 'column_out_of_scope',
      id: SENTINEL,
      path: 'column_flow.0.upstream_columns.0.node',
      reason: `${SENTINEL} is outside the approved scope.`,
      allowed_values: [],
    },
  ]);

describe('flat rejection renderer contract (D-103)', () => {
  it('offers the final fallback for report columns and excludes start target controls (Approved08)', () => {
    const report = makeRejection({
      code: 'invalid_input',
      resend: ['column_flow'],
      errors: [
        {
          path: 'column_flow.0.out_col',
          code: 'unknown_column',
          values: ['Known'],
        },
      ],
    });
    const start = inspectTargetColumns(
      makeNode({
        id: '[dbo].[Source]',
        schema: 'dbo',
        name: 'Source',
        type: 'view',
      }),
      ['Known'],
      ['Missing'],
    ).rejection!;
    const fallback = fallbackOf('unknown_column')!;
    for (const stage of [1, 2, 3] as const) {
      const shownReport = render(report, stage, undefined, 'hop_commit'),
        shownStart = render(start, stage, undefined, 'session_start');
      assertStructural(shownReport);
      assertStructural(shownStart);
      expect(shownReport.errors[0].message.includes(fallback)).toBe(
        stage === 3,
      );
      expect(shownReport.resend).toEqual(
        stage === 3 ? ['column_flow', 'sections'] : ['column_flow'],
      );
      expect(shownStart.errors[0].message).not.toContain(fallback);
      expect(shownStart.resend).toEqual(['analysisMode']);
      expect(shownStart.errors[0].code).toBe('unknown_target_column');
      expect(shownReport.errors[0].code).toBe('unknown_column');
      expect(shownStart.errors[0].allowed).toEqual(
        stage === 1 ? undefined : ['Known'],
      );
      expect(shownReport.errors[0].allowed).toEqual(
        stage === 1 ? undefined : ['Known'],
      );
    }
  });

  it('reports every independent path and every owed subject together (Approved08 D-099)', () => {
    const paths = Array.from(
      { length: 12 },
      (_, index) => `sections.${index}.text`,
    );
    const missing = Array.from(
      { length: 20 },
      (_, index) => `[dbo].[Node${index}]`,
    );
    const rejection = makeRejection({
      code: 'invalid_input',
      errors: [
        ...paths.map((path) => ({ path, code: 'missing' as const })),
        { path: 'sections.*.node_ids', code: 'slot_unplaced', values: missing },
      ],
    });
    const shown = render(rejection, 1).errors;
    expect(shown.map((error) => error.path).sort()).toEqual(
      [...paths, 'sections.*.node_ids'].sort(),
    );
    expect(
      shown.find((error) => error.path === 'sections.*.node_ids')?.allowed,
    ).toEqual([...missing].sort((a, b) => a.localeCompare(b)));
  });

  it('renders only issue-table messages, never a submitted value', () => {
    for (const stage of [1, 2, 3] as const) {
      const rendered = render(
        r1(),
        stage,
        { column_flow: [{ upstream_columns: [{ node: SENTINEL }] }] },
        'hop_commit',
      );
      assertStructural(rendered);
    }
  });

  it('adds the complete empty allowed set at feedback 2 and the fallback only with feedback 3 (D-105)', () => {
    for (const stage of [1, 2, 3] as const) {
      const rendered = render(r1(), stage, undefined, 'hop_commit');
      assertStructural(rendered);
      expect(rendered.errors).toEqual([
        expect.objectContaining({
          path: 'column_flow.0.upstream_columns.0.node',
          code: 'column_out_of_scope',
        }),
      ]);
      expect(rendered.errors[0].allowed).toEqual(stage === 1 ? undefined : []);
      expect(
        rendered.errors[0].message.includes(fallbackOf('column_out_of_scope')!),
      ).toBe(stage === 3);
      expect(rendered.resend.includes('sections')).toBe(stage === 3);
    }
  });

  it('withholds a non-empty allowed set until feedback 2', () => {
    const rejection = makeRejection({
      code: 'invalid_input',
      errors: [
        {
          path: 'column_flow.0.upstream_columns.0.node',
          code: 'column_out_of_scope',
          values: ['[dbo].[b]', '[dbo].[a]'],
        },
      ],
    });
    const input = {
      column_flow: [{ upstream_columns: [{ node: '[dbo].[b]x' }] }],
    };
    const [one, two] = ([1, 2] as const).map((stage) =>
      render(rejection, stage, input),
    );
    expect(one.errors[0]).not.toHaveProperty('allowed');
    expect(two.errors[0].allowed).toEqual(['[dbo].[b]', '[dbo].[a]']);
  });

  it('attaches fallback to each eligible report error and leaves a sibling control error unchanged (D-105)', () => {
    const rejection = makeRejection({
      code: 'invalid_input',
      errors: [
        { path: 'sections.0.node_ids.0', code: 'not_in_result', values: [] },
        {
          path: 'sections.0.node_ids.1',
          code: 'result_out_of_scope',
          values: ['[dbo].[a]'],
        },
        {
          path: 'add_node_ids.0',
          code: 'out_of_scope',
          category: 'value',
          values: [],
        },
      ],
    });
    for (const stage of [1, 2, 3] as const) {
      const rendered = render(
        rejection,
        stage,
        undefined,
        'presentation_commit',
      );
      assertStructural(rendered);
      for (const code of ['not_in_result', 'result_out_of_scope'] as const)
        expect(
          rendered.errors
            .find((error) => error.code === code)
            ?.message.includes(fallbackOf(code)!),
        ).toBe(stage === 3);
      expect(
        rendered.errors.find((error) => error.code === 'out_of_scope')?.message,
      ).not.toContain(fallbackOf('not_in_result')!);
      expect(rendered.resend).toEqual(stage === 3 ? ['sections'] : []);
    }
  });

  it('states owed subjects in the flat allowed metadata from feedback 1', () => {
    const rendered = render(
      makeRejection({
        code: 'invalid_input',
        errors: [
          {
            path: 'sections.*.node_ids',
            code: 'slot_unplaced',
            values: ['slot_2', 'slot_1'],
          },
        ],
      }),
      1,
    );
    expect(rendered.errors).toEqual([
      expect.objectContaining({
        path: 'sections.*.node_ids',
        code: 'slot_unplaced',
        allowed: ['slot_1', 'slot_2'],
      }),
    ]);
    assertStructural(rendered);
  });

  it('gives each independent fault its own code and correction (D-099, D-103)', () => {
    const rejection = makeRejection({
      code: 'invalid_input',
      errors: [0, 1, 2].map((index) => ({
        path: `column_flow.${index}.out_col`,
        code: 'unknown_column' as const,
        values: ['a'],
      })),
    });
    const rendered = render(rejection, 1);
    assertStructural(rendered);
    expect(
      rendered.errors.map((error) => ({ path: error.path, code: error.code })),
    ).toEqual(
      [0, 1, 2].map((index) => ({
        path: `column_flow.${index}.out_col`,
        code: 'unknown_column',
      })),
    );
  });

  it('suppresses only descendants of a missing parent, preserving independent mistyped-parent faults (D-099)', () => {
    const rejection = makeRejection({
      code: 'invalid_input',
      errors: [
        { path: 'summary', code: 'enum', values: ['x'] },
        { path: 'column_flow', code: 'missing' },
        { path: 'column_flow.0.out_col', code: 'unknown_column' },
        { path: 'sections', code: 'type' },
        { path: 'sections.business', code: 'missing' },
      ],
    });
    const rendered = render(rejection, 1);
    expect(
      rendered.errors.map((error) => [error.path, error.code]).sort(),
    ).toEqual(
      [
        ['summary', 'enum'],
        ['column_flow', 'missing'],
        ['sections', 'type'],
        ['sections.business', 'missing'],
      ].sort(),
    );
  });
});
