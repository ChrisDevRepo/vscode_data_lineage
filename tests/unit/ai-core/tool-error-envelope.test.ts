/**
 * Deterministic production tool-error-envelope contract: the one rejection
 * record, native Ajv issue mapping and the one renderer. Tests assert paths,
 * issue codes, backend values and the stage; every rendered sentence is a
 * table string.
 */
import {
  COLUMN_REFERENCE_FALLBACK,
  ISSUES,
  makeRejection,
  combineToolRejections,
  renderProblem,
  renderProblemReport,
  type FeedbackStage,
  type ToolProblem,
  type ToolRejection,
} from '../../../src/ai/support/toolErrorEnvelope';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolDefinition } from '../../../src/ai/tools/registry';
import { validateToolCandidate } from '../../../src/ai/support/toolValidation';
import { ColumnTracer } from '../../../src/ai/sm/columnTracer';
import { buildRouteValidationRejection } from '../../../src/ai/sm/smRouteValidation';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { getAllowedLmToolNames } from '../../../src/ai/tools/toolPolicy';
import { makeGraph, makeModel, makeNode } from '../helpers/modelFixtures';

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

  it('derives errors and corrections from the producing checks, with schema values, never the submitted value', () => {
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

    // A correction states the fact the producing check tested, so the one served text must hold
    // for every check that produces its code (the same text serves stages 1-3).
    const closeCauses = { pruned: /prun/i, visited: /visit/i } as const;
    const closeCauseWords = (text: string) =>
      Object.entries(closeCauses)
        .filter(([, word]) => word.test(text))
        .map(([cause]) => cause);

    const source = makeNode({
      id: '[dbo].[Source]',
      schema: 'dbo',
      name: 'Source',
      type: 'table',
      columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }],
    });
    const focus = makeNode({
      id: '[dbo].[Seen]',
      schema: 'dbo',
      name: 'Seen',
      type: 'view',
      bodyScript: 'SELECT Value FROM dbo.Source;',
      columns: [{ name: 'Value', type: 'int', nullable: 'NULL', extra: '' }],
    });
    const nodeMap = new Map([
      [source.id, source],
      [focus.id, focus],
    ]);
    // The column check refuses a pruned contributor and accepts the same node while it stays.
    const tracer = new ColumnTracer(['Value']);
    const check = (removed: ReadonlySet<string>) =>
      tracer.validateColumnSupplier(
        focus.id,
        { node: source.id, col: 'Value' },
        'indirect_columns.0.node',
        nodeMap,
        ['Value'],
        removed,
        new Set([source.id]),
      );
    const prunedCheck = check(new Set([source.id]));
    if (!('invalidRoute' in prunedCheck))
      throw new Error('Expected the pruned contributor fault');
    expect(prunedCheck.invalidRoute.kind).toBe('pruned_contributor');
    expect('neighbor' in check(new Set())).toBe(true);
    // Its producer maps to the served code; the producer tests pruning, never a visit.
    expect(
      buildRouteValidationRejection([prunedCheck.invalidRoute]).errors,
    ).toEqual([
      { path: 'indirect_columns.0.node.node', code: 'closed_neighbor' },
    ]);

    // The question check refuses a visited neighbor and a pruned one.
    const report = makeNode({
      id: '[dbo].[Report]',
      schema: 'dbo',
      name: 'Report',
      type: 'view',
      bodyScript: 'SELECT Value FROM dbo.Seen;',
    });
    const nodes = [source, focus, report];
    const edges: Array<[string, string]> = [
      [source.id, focus.id],
      [source.id, report.id],
      [focus.id, report.id],
    ];
    const engine = new NavigationEngine(
      makeModel(nodes, edges, ['dbo']),
      makeGraph(nodes, edges),
      () => {},
      {},
    );
    expect(
      engine.init({
        origin: report.id,
        question: 'Trace Value.',
        direction: 'upstream',
        analysisMode: 'bb',
        depthIntent: {
          upstream: { levels: 'all', exactness: 'exact' },
          downstream: { levels: 0, exactness: 'exact' },
        },
      }),
    ).toHaveProperty('ok', true);
    engine.classification = 'technical';
    engine.getHopContext();
    expect(
      engine.submitModelFindings({
        focus_node_id: report.id,
        summary: 'Report reads Seen.',
        sections: { technical: 'Report selects Value from Seen.' },
        questions: [{ nodeId: focus.id, question: 'Which column feeds it?' }],
        prune_neighbors: [{ id: source.id, reason: 'Supplies no value.' }],
      } as never),
    ).toHaveProperty('ok', true);
    engine.getHopContext();
    const closed = (nodeId: string) => {
      const result = engine.submitModelFindings({
        focus_node_id: focus.id,
        summary: 'Seen selects Value from Source.',
        sections: { technical: 'Seen selects Value from Source.' },
        questions: [{ nodeId, question: 'Which column feeds it?' }],
      } as never);
      if ('ok' in result) throw new Error(`Expected ${nodeId} to be closed`);
      return result;
    };
    // The question producer refuses a visited neighbor with the shared code.
    expect(closed(report.id).errors).toEqual([
      expect.objectContaining({
        path: 'questions.0.nodeId',
        code: 'closed_neighbor',
      }),
    ]);

    // The one text serves both producers, so it may name only a cause true of every fault.
    const served = `${ISSUES.closed_neighbor.label}. ${ISSUES.closed_neighbor.correction}`;
    for (const state of ['pruned', 'visited'] as const)
      expect(
        closeCauseWords(served).filter((cause) => cause !== state),
        `closed_neighbor on a ${state} fault`,
      ).toEqual([]);

    // `present_result` produces this fault on add_node_ids at the completed stage.
    const offered = getAllowedLmToolNames({ kind: 'completed' });
    expect(
      [...offered].filter((tool) =>
        ISSUES.out_of_scope.correction.includes(tool),
      ),
    ).not.toHaveLength(0);
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
      ['not_found', 'notes.0.node_id', 'presentation_commit'],
      ['unknown_column', 'column_flow.0.out_node', 'hop_commit'],
      ['not_found', 'sections.0.node_ids.0', 'presentation_commit'],
    ] as const)('%s at %s', (code, path, effect) => {
      for (const values of [[], ['x']]) {
        // A held draft's list: the fallback's field joins it, and no list is made without one.
        const rejection = {
          ...makeRejection({
            code: 'invalid_input',
            errors: [{ path, code, values }],
          }),
          resend: [path.split('.')[0]],
        };
        for (const stage of [1, 2] as const)
          expect(hasFallback(render(rejection, stage, undefined, effect))).toBe(
            false,
          );
        const { text, fallback } = renderProblemReport(
          rejection,
          3,
          undefined,
          effect,
        );
        expect(fallback).toBe(true);
        const third = JSON.parse(text) as Problem;
        const own = (ISSUES[code] as { fallback?: string }).fallback;
        const message = at(third, path)!.message;
        expect(message).toContain(own ?? COLUMN_REFERENCE_FALLBACK);
        expect(third.resend).toContain('sections');
        // A fault without its own fallback serves the shared text, which names every field it
        // adds to resend in the message itself.
        const added = third.resend!.filter(
          (field) => !rejection.resend!.includes(field),
        );
        if (!own) for (const field of added) expect(message).toContain(field);
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
      ]);
      expect(content).not.toMatch(/SENTINEL/);
    }
  });
});
