/**
 * Deterministic production tool-error-envelope contract: the one rejection
 * record, native Ajv issue mapping and the one renderer. Tests assert paths,
 * issue codes, backend values and the stage; every rendered sentence is a
 * table string (see rejection-render.test.ts).
 */
import {
  COLUMN_REFERENCE_FALLBACK,
  ISSUES,
  makeRejection,
  combineToolRejections,
  renderProblem,
  type FeedbackStage,
  type ToolProblem,
  type ToolRejection,
} from '../../../src/ai/support/toolErrorEnvelope';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolDefinition } from '../../../src/ai/tools/registry';
import { validateToolCandidate } from '../../../src/ai/support/toolValidation';

type Shown = ToolProblem['errors'][number];
type Problem = ToolProblem;
const render = (
  rejection: ToolRejection,
  stage: FeedbackStage,
  input?: unknown,
  effect?: ToolDefinition['effect'],
): Problem => JSON.parse(renderProblem(rejection, stage, input, effect));
const schemaRejection = (schema: z.ZodType, input: unknown) => {
  const admitted = validateToolCandidate(schema, input);
  if (admitted.success) throw new Error('Expected schema faults');
  return admitted.rejection;
};
const shown = (problem: Problem): Shown[] => problem.errors;
const at = (problem: Problem, path: string) =>
  shown(problem).find((error) => error.path === path);

describe('tool-error-envelope', () => {
  // Backend invariant faults stop immediately, even beside independently decidable input faults.
  it.each([false, true])(
    'a backend fault dominates input faults without losing their fields (reversed=%s)',
    (reversed) => {
      const problems = [
        makeRejection({
          code: 'invalid_input',
          errors: [{ path: 'summary', code: 'type' }],
          resend: ['summary'],
        }),
        makeRejection({
          code: 'backend_fault',
          errors: [{ path: '', code: 'backend_fault' }],
        }),
      ];
      const result = combineToolRejections(
        reversed ? problems.reverse() : problems,
      );
      expect(result).toMatchObject({
        code: 'backend_fault',
        issuePaths: ['summary'],
        resend: ['summary'],
      });
      expect(result.errors).toHaveLength(2);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          { path: 'summary', code: 'type' },
          { path: '', code: 'backend_fault' },
        ]),
      );
    },
  );

  it('derives errors from native schema issues with schema values, never the submitted value', () => {
    const schema = z
      .object({
        mode: z.enum(['a', 'b']),
        items: z.array(z.object({ name: z.string() }).strict()),
        count: z.number(),
      })
      .strict();
    const input = {
      mode: 'zzz-sent',
      items: [{ name: 'ok', extra: 1 }],
      count: 'x'.repeat(200),
    };
    const rejection = schemaRejection(schema, input);
    expect(rejection.errors).toEqual(
      expect.arrayContaining([
        { path: 'mode', code: 'enum', values: ['a', 'b'] },
        { path: 'items.0.extra', code: 'unknown_key', values: ['name'] },
        expect.objectContaining({ path: 'count', code: 'type' }),
      ]),
    );
    for (const stage of [1, 2, 3] as const)
      expect(renderProblem(rejection, stage, input)).not.toMatch(
        /zzz-sent|xxxxx/,
      );
  });

  describe('Fallback: contextual reference and typed effect, only with the third rejection', () => {
    const fallbacks = [
      COLUMN_REFERENCE_FALLBACK,
      ...Object.values(ISSUES).flatMap((issue) =>
        'fallback' in issue ? [issue.fallback] : [],
      ),
    ];
    const hasFallback = (problem: Problem) =>
      problem.errors.some((error) =>
        fallbacks.some((fallback) => error.message.includes(fallback)),
      );
    it.each([
      ['column_out_of_scope', 'column_flow.0.out_node', 'hop_commit'],
      [
        'column_out_of_scope',
        'column_flow.0.upstream_columns.0.node',
        'hop_commit',
      ],
      ['result_out_of_scope', 'sections.0.node_ids.3', 'presentation_commit'],
      ['unknown_column', 'column_flow.0.upstream_columns.0.col', 'hop_commit'],
    ] as const)('%s at %s', (code, path, effect) => {
      for (const values of [[], ['x']]) {
        const rejection = makeRejection({
          code: 'invalid_input',
          errors: [{ path, code, values }],
        });
        for (const stage of [1, 2] as const)
          expect(hasFallback(render(rejection, stage, undefined, effect))).toBe(
            false,
          );
        const third = render(rejection, 3, undefined, effect);
        const own = (ISSUES[code] as { fallback?: string }).fallback;
        expect(at(third, path)?.message).toContain(
          own ?? COLUMN_REFERENCE_FALLBACK,
        );
        expect(third.resend).toContain('sections');
      }
    });
  });

  it('renders only the problem shape: reason and detail never reach the model', () => {
    const rejection = makeRejection({
      code: 'invalid_input',
      reason: 'REASON_SENTINEL',
      errors: [{ path: 'sections.0.label', code: 'missing' }],
      detail: [
        {
          input: 'RAW_INPUT_SENTINEL',
          held_draft: { sections: [{ text: 'HELD_BODY_SENTINEL' }] },
        },
      ],
    });
    for (const stage of [1, 2, 3] as const) {
      const content = renderProblem(rejection, stage);
      expect(Object.keys(JSON.parse(content)).sort()).toEqual([
        'attempt',
        'code',
        'errors',
        'resend',
      ]);
      expect(content).not.toMatch(/SENTINEL/);
    }
  });
});
