/** Deterministic production tool-error-envelope contract: the one rejection record, native Ajv issue mapping and the one renderer (D-103, D-105). Tests assert paths, issue codes, backend values and the stage; every rendered sentence is a table string (see rejection-render.test.ts). */
import {
  ISSUES,
  readToolError,
  readToolErrorText,
  isConsentGateRejection,
  makeRejection,
  combineToolRejections,
  renderProblem,
  type FeedbackStage,
  type ToolProblem,
  type ToolRejection,
} from '../../../src/ai/support/toolErrorEnvelope';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import {
  makeGraph,
  makeIndexedModel,
  makeModel,
  makeNode,
} from '../helpers/modelFixtures';
import { draftWorld } from '../helpers/presentWorld';
import {
  presentResultSchemaForPhase,
  submitFindingsSchemaForMode,
} from '../../../src/ai/tools/toolSchemas';
import { AiSession } from '../../../src/ai/session/session';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
import { executePresentResult } from '../../../src/ai/tools/handlers/presentResult';
import { buildModel } from '../../../src/engine/modelBuilder';
import { buildAiToolRegistry } from '../../../src/ai/tools/toolProvider';
import { describe, expect, it, vi } from 'vitest';
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
const faults = (rejection: ToolRejection) =>
  rejection.errors.map((error) => [error.path, error.code]);

describe('tool-error-envelope', () => {
  // Approved08: backend invariant faults stop immediately, even beside independently decidable input faults.
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

  it('retains resend fields through JSON and the renderer (D-103)', () => {
    const rejection = makeRejection({
      code: 'invalid_regex',
      errors: [{ path: 'query', code: 'invalid_regex' }],
      resend: ['sections'],
    });
    expect(readToolError(JSON.parse(JSON.stringify(rejection)))).toEqual(
      rejection,
    );
    expect(render(rejection, 1)).toMatchObject({ resend: ['sections'] });
  });

  it('keeps the fault at its path from feedback 1, its allowed values from feedback 2, and the record unchanged', () => {
    const rejection = makeRejection({
      code: 'invalid_input',
      reason: 'Column does not exist on the contributor.',
      errors: [
        {
          path: 'column_flow.0.upstream_columns.1.col',
          code: 'unknown_column',
          values: ['Rate', 'Amount'],
        },
      ],
    });
    const original = structuredClone(rejection);
    expect(
      at(render(rejection, 1), 'column_flow.0.upstream_columns.1.col'),
    ).toEqual({
      path: 'column_flow.0.upstream_columns.1.col',
      code: 'unknown_column',
      message: expect.stringContaining(ISSUES.unknown_column.correction),
    });
    expect(
      at(render(rejection, 2), 'column_flow.0.upstream_columns.1.col')?.allowed,
    ).toEqual(['Amount', 'Rate']);
    expect(rejection).toEqual(original);
  });

  it('ranks allowed values by distance to the sent value, alphabetical on ties, and retains the complete metadata set', () => {
    const values = Array.from(
      { length: 20 },
      (_, index) => `Col${String(index).padStart(2, '0')}`,
    );
    const rejection = makeRejection({
      code: 'invalid_input',
      errors: [
        { path: 'column_flow.0.out_col', code: 'unknown_column', values },
      ],
    });
    const error = at(
      render(rejection, 2, { column_flow: [{ out_col: 'Col17x' }] }),
      'column_flow.0.out_col',
    )!;
    expect(error.allowed?.[0]).toBe('Col17');
    expect([...error.allowed!].sort()).toEqual([...values].sort());
    expect(error).not.toHaveProperty('more');
    expect(JSON.stringify(error)).not.toContain('Col17x');
  });

  it('derives errors from native schema issues with schema values, never the submitted value (D-102)', () => {
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

  it.each([z.number(), z.number().int()])(
    'reports a numeric type fault without choosing or echoing a value: %s',
    (owner) => {
      for (const value of [null, 'three']) {
        const rejection = schemaRejection(z.object({ value: owner }), {
          value,
        });
        expect(rejection.issuePaths).toEqual(['value']);
        expect(faults(rejection)).toEqual([['value', 'type']]);
      }
    },
  );

  it('reads a JSON string sent for an object as json_text', () => {
    expect(
      faults(
        schemaRejection(z.object({ sections: z.object({ a: z.string() }) }), {
          sections: '{"a":"x"}',
        }),
      ),
    ).toEqual([['sections', 'json_text']]);
  });

  it.each([false, true])(
    'names an unknown key and its declared fields (nested=%s)',
    (nested) => {
      const schema = z
        .object({ entry: z.object({ value: z.string() }).strict() })
        .strict();
      const input = nested
        ? { entry: { value: 'Keep this text.', extra: 'x' } }
        : { entry: { value: 'Keep this text.' }, extra: 'x' };
      const rejection = schemaRejection(schema, input);
      const path = nested ? 'entry.extra' : 'extra';
      expect(rejection.errors).toEqual([
        { path, code: 'unknown_key', values: [nested ? 'value' : 'entry'] },
      ]);
      expect(at(render(rejection, 1), path)?.allowed).toBeUndefined();
      expect(at(render(rejection, 2), path)?.allowed).toEqual([
        nested ? 'value' : 'entry',
      ]);
    },
  );

  it('states a native never fault without values', () => {
    const rejection = schemaRejection(
      z
        .object({ items: z.array(z.object({ id: z.never() }).strict()) })
        .strict(),
      { items: [{ id: 'invalid' }] },
    );
    expect(faults(rejection)).toEqual([['items.0.id', 'never']]);
  });

  it('classifies the native served identifier enum and retains its independent sibling schema fault (D-126)', () => {
    const schema = z.object({
      col: z
        .string()
        .meta({ enum: ['A'], toolIdentifier: { issue: 'unknown_column' } }),
      free: z.string().regex(/^B$/),
    });
    const result = validateToolCandidate(schema, { col: 'x', free: 'z' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected both native faults');
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instancePath: '/col',
          keyword: 'enum',
          params: { allowedValues: ['A'] },
        }),
        expect.objectContaining({ instancePath: '/free', keyword: 'pattern' }),
      ]),
    );
    expect(result.rejection.errors).toEqual([
      { path: 'col', code: 'unknown_column', values: ['A'] },
      { path: 'free', code: 'invalid' },
    ]);
  });

  describe('D-105 fallback: contextual reference and typed effect, only with the third rejection', () => {
    const fallbacks = Object.values(ISSUES).flatMap((issue) =>
      'fallback' in issue ? [issue.fallback] : [],
    );
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
        expect(at(third, path)?.message).toContain(
          (ISSUES[code] as { fallback?: string }).fallback,
        );
        expect(third.resend).toContain('sections');
      }
    });
    // Approved08 D-105 permits these report-reference families, never structural/control/text faults.
    const reportReferenceCodes = new Set<keyof typeof ISSUES>([
      'column_out_of_scope',
      'result_out_of_scope',
      'unknown_column',
      'report_not_found',
      'not_in_result',
      'addable_to_result',
    ]);
    const negativePaths: Record<string, string> = {
      out_of_scope: 'add_node_ids.0',
      not_found: 'origin',
      unknown_target_column: 'targetColumns.0',
      missing: 'summary',
    };
    it.each(
      (Object.keys(ISSUES) as Array<keyof typeof ISSUES>).filter(
        (code) => !reportReferenceCodes.has(code),
      ),
    )('%s: no fallback at any feedback (Approved08 D-105)', (code) => {
      const path = negativePaths[code] ?? 'field';
      const effect =
        path === 'origin' || path.startsWith('targetColumns.')
          ? 'session_start'
          : path.startsWith('add_node_ids.')
            ? 'presentation_commit'
            : 'hop_commit';
      for (const values of [[], ['AllowedValue']])
        for (const stage of [1, 2, 3] as const) {
          const rejection = makeRejection({
            code: 'invalid_input',
            errors: [
              {
                path,
                code,
                values,
                ...(path.startsWith('add_node_ids.')
                  ? { category: 'value' as const }
                  : {}),
              },
            ],
            resend: ['field'],
          });
          for (const owner of [effect, 'read'] as const) {
            const problem = render(rejection, stage, undefined, owner);
            expect(hasFallback(problem)).toBe(false);
            expect(problem.resend).not.toContain('sections');
          }
        }
    });
  });

  it('states the expected focus as an allowed value, never the sent id', () => {
    const origin = '[dbo].[A]',
      sent = '[dbo].[Sent]';
    const node = makeNode({
      id: origin,
      schema: 'dbo',
      name: 'A',
      type: 'view',
    });
    const engine = new NavigationEngine(
      makeModel([node], [], ['dbo']),
      makeGraph([node], []),
      () => {},
      {},
    );
    engine.init({
      origin,
      question: 'Q',
      direction: 'upstream',
      analysisMode: 'bb',
      depthIntent: {
        upstream: { levels: 1, exactness: 'exact' },
        downstream: { levels: 0, exactness: 'exact' },
      },
    });
    engine.getHopContext();
    const rejection = engine.pruneCurrent(sent, 'Off path.') as ToolRejection;
    expect(rejection.errors).toEqual([
      { path: 'focus_node_id', code: 'not_current_object', values: [origin] },
    ]);
    for (const stage of [1, 2, 3] as const)
      expect(
        renderProblem(rejection, stage, { focus_node_id: sent }),
      ).not.toContain(sent);
  });

  it('present_result unknown node ids: each at its element path with the result ids, no echo (D-102)', async () => {
    for (const stage of ['completed', 'synthesis', 'visual_preview'] as const) {
      const { session, ids, report, send } = draftWorld({
        synthesis: stage === 'synthesis',
      });
      const [origin, source, sentId] = ids,
        sentLabel = 'LabelSentinel';
      const highlight_groups = [
        { label: 'Out', color: 'target' as const, node_ids: [origin, sentId] },
      ];
      const sections = [
        { label: sentLabel, node_ids: [origin, source, sentId] },
      ];
      if (stage === 'visual_preview') {
        session.activeLmStage = { kind: 'visual_preview' };
        session.lastDiscoveryAnswer =
          'Report summary.\n\nSource feeds the report.';
        session.storeDiscoveryScope(
          {
            turnEpoch: session.turnEpoch,
            origin,
            direction: 'upstream',
            nodeIds: [origin, source],
            edges: [[source, origin, 'read']],
          },
          session.turnEpoch,
        );
      }
      const input = {
        name: report.name,
        highlight_groups,
        sections: sections.map((section) =>
          stage === 'visual_preview'
            ? { ...section, start: 'B1' }
            : { ...section, text: 'Report output.' },
        ),
        ...(stage === 'visual_preview' ? {} : { summary: report.summary }),
      };
      const rejection = await send(input);
      expect(rejection.errors).toEqual(
        expect.arrayContaining([
          {
            path: 'sections.0.node_ids.2',
            code: 'result_out_of_scope',
            values: [origin, source],
          },
          {
            path: 'highlight_groups.0.node_ids.1',
            code: 'result_out_of_scope',
            values: [origin, source],
          },
        ]),
      );
      for (const feedback of [1, 2, 3] as const)
        expect(renderProblem(rejection, feedback, input)).not.toMatch(
          /\[dbo\]\.\[Outside\]|LabelSentinel/,
        );
    }
  });

  it('a node id given two captions is one duplicate fault at the later caption', () => {
    const admitted = validateToolCandidate(
      presentResultSchemaForPhase('completed'),
      {
        name: 'Reports',
        summary: 'Reports lineage.',
        highlight_groups: [
          { label: 'Out', color: 'target', node_ids: ['[dbo].[b]'] },
        ],
        sections: [
          { label: 'Report', node_ids: ['[dbo].[b]'], text: 'Report output.' },
        ],
        notes: [
          { node_id: '[dbo].[S]', caption: 'First.' },
          { node_id: '[dbo].[b]', caption: 'Other.' },
          { node_id: '[dbo].[S]', caption: 'Second.' },
        ],
      },
    );
    if (admitted.success) throw new Error('Conflicting note captions admitted');
    const rejection = admitted.rejection;
    expect(rejection.errors.map((error) => error.path)).toEqual([
      'notes.2.caption',
    ]);
    expect(renderProblem(rejection, 3)).not.toContain('[dbo].[S]');
  });

  it.each([
    {
      name: 'invalid first caption',
      notes: [
        { node_id: 'source', caption: ' ' },
        { node_id: 'source', caption: 'First.' },
        { node_id: 'source', caption: 'Second.' },
      ],
      native: ['notes.0.caption'],
      conflicts: ['notes.2.caption'],
    },
    {
      name: 'invalid middle caption',
      notes: [
        { node_id: 'source', caption: 'First.' },
        { node_id: 'source', caption: ' ' },
        { node_id: 'source', caption: 'First.' },
      ],
      native: ['notes.1.caption'],
      conflicts: [],
    },
    {
      name: 'invalid node identities',
      notes: [
        { node_id: ' ', caption: 'First.' },
        { node_id: ' ', caption: 'Second.' },
      ],
      native: ['notes.0.node_id', 'notes.1.node_id'],
      conflicts: [],
    },
  ])(
    'uses validated note paths while retaining independent faults: $name',
    ({ notes, native, conflicts }) => {
      const input = {
        name: 'Reports',
        summary: 42,
        highlight_groups: [
          { label: 'Out', color: 'target', node_ids: ['source'] },
        ],
        sections: [
          { label: 'Source', node_ids: ['source'], text: 'First body.' },
          { label: ' source ', node_ids: ['source'], text: 'Second body.' },
        ],
        notes,
      };
      const before = structuredClone(input);
      const admitted = validateToolCandidate(
        presentResultSchemaForPhase('completed'),
        input,
      );
      if (admitted.success) throw new Error('Malformed report admitted');
      expect(admitted.errors.map((error) => error.instancePath).sort()).toEqual(
        [
          ...native.map((path) => '/' + path.replaceAll('.', '/')),
          '/summary',
        ].sort(),
      );
      expect(
        admitted.rejection.errors.map((error) => error.path).sort(),
      ).toEqual(
        [...native, ...conflicts, 'summary', 'sections.1.label'].sort(),
      );
      expect(input).toEqual(before);
    },
  );

  it('does not compare invalid section labels while retaining a valid sibling conflict', () => {
    const admitted = validateToolCandidate(
      presentResultSchemaForPhase('completed'),
      {
        name: 'Report',
        summary: 'Authored summary.',
        highlight_groups: [
          { label: 'Out', color: 'target', node_ids: ['source'] },
        ],
        sections: [' ', ' ', 'Source', ' source '].map((label) => ({
          label,
          node_ids: ['source'],
          text: 'Authored body.',
        })),
      },
    );
    if (admitted.success) throw new Error('Malformed section labels admitted');
    expect(faults(admitted.rejection)).toEqual([
      ['sections.0.label', 'invalid'],
      ['sections.1.label', 'invalid'],
      ['sections.3.label', 'duplicate'],
    ]);
  });

  it('reports a malformed finding body and independent blank summary without inventing an absent sections fault', () => {
    const admitted = validateToolCandidate(
      submitFindingsSchemaForMode('bb', 'technical', true),
      { summary: ' ', sections: { technical: 42 } },
    );
    if (admitted.success) throw new Error('Malformed finding admitted');
    expect(faults(admitted.rejection)).toEqual([
      ['sections.technical', 'type'],
      ['summary', 'missing'],
    ]);
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
      expect(Object.keys(JSON.parse(content)).sort()).toEqual(
        [
          'attempt',
          'code',
          'errors',
          'resend',
          ...(stage === 3 ? ['notice'] : []),
        ].sort(),
      );
      expect(content).not.toMatch(/SENTINEL/);
    }
  });

  it('readToolError: the rejection round-trips; reason falls back to the issue codes', () => {
    const made = makeRejection({
      code: 'invalid_input',
      errors: [
        { path: 'focus_node_id', code: 'not_current_object', values: ['a'] },
      ],
      detail: { expected: 'a' },
    });
    expect(readToolError(JSON.parse(JSON.stringify(made)))).toEqual(made);
    expect(made.reason).toBe('not_current_object');
  });

  it('readToolError: unknown keys, issue codes outside the table, an empty error list and retired shapes are not rejections', () => {
    expect(
      readToolError({
        code: 'x',
        reason: 'y',
        errors: [{ path: '', code: 'missing' }],
        extra: 1,
      }),
    ).toBeNull();
    expect(
      readToolError({
        code: 'x',
        reason: 'y',
        errors: [{ path: '', code: 'no_such_code' }],
      }),
    ).toBeNull();
    expect(readToolError({ code: 'x', reason: 'y', errors: [] })).toBeNull();
    expect(
      readToolError({
        code: 'x',
        reason: 'y',
        errors: [{ path: '', code: 'missing', message: 'prose' }],
      }),
    ).toBeNull();
    expect(readToolError({ error: 'focus_mismatch', hint: 'h' })).toBeNull();
    expect(
      readToolError({ ok: false, reason: 'over_discovery_budget' }),
    ).toBeNull();
    for (const value of [{ ok: true, nodes: [] }, {}, null, 'a string'])
      expect(readToolError(value)).toBeNull();
  });

  it('makeRejection: requires an error and moves a path outside the grammar to the call', () => {
    expect(() => makeRejection({ code: 'x', errors: [] })).toThrow();
    const made = makeRejection({
      code: 'invalid_input',
      errors: [
        { path: 'not a path!', code: 'invalid' },
        { path: 'sections.0.text', code: 'missing' },
      ],
    });
    expect(faults(made)).toEqual([
      ['', 'invalid'],
      ['sections.0.text', 'missing'],
    ]);
    expect(made.issuePaths).toEqual(['sections.0.text']);
  });

  it('the consent gate is separable from a real rejection', () => {
    expect(
      isConsentGateRejection(
        makeRejection({
          code: 'action_required',
          errors: [{ path: '', code: 'awaiting_approval' }],
        }).code,
      ),
    ).toBe(true);
    expect(
      isConsentGateRejection(
        makeRejection({
          code: 'invalid_input',
          errors: [{ path: '', code: 'invalid' }],
        }).code,
      ),
    ).toBe(false);
  });

  describe('schema rejection: a union', () => {
    it('a field missing in every variant is one missing fault, not one per branch', () => {
      const levelsSchema = z.union([z.number().int().min(0), z.literal('all')]);
      const sideSchema = z
        .object({
          levels: levelsSchema,
          exactness: z.enum(['exact', 'approximate']),
        })
        .strict();
      const depth = z
        .object({ upstream: sideSchema, downstream: sideSchema })
        .strict();
      const provider = z.union([
        z.object({ analysisMode: z.literal('bb'), depth }).strict(),
        z
          .object({
            analysisMode: z.literal('ct'),
            depth,
            targetColumns: z.array(z.string()),
          })
          .strict(),
      ]);
      const rejection = schemaRejection(provider, {
        analysisMode: 'bb',
        depth: {
          upstream: { exactness: 'exact' },
          downstream: { levels: 2, exactness: 'exact' },
        },
      });
      expect(
        rejection.errors.filter(
          (error) => error.path === 'depth.upstream.levels',
        ),
      ).toEqual([{ path: 'depth.upstream.levels', code: 'missing' }]);
    });

    it('an empty call names every field the variants require once', () => {
      const bbVariant = z
        .object({
          origin: z.string(),
          classification: z.string(),
          analysisMode: z.literal('bb'),
        })
        .strict();
      const ctVariant = z
        .object({
          origin: z.string(),
          classification: z.string(),
          analysisMode: z.literal('ct'),
          targetColumns: z.array(z.string()),
        })
        .strict();
      const rejection = schemaRejection(z.union([bbVariant, ctVariant]), {});
      expect(rejection.errors.map((error) => error.path)).toEqual(
        expect.arrayContaining(['origin', 'classification', 'analysisMode']),
      );
      for (const path of ['origin', 'classification'])
        expect(
          rejection.errors.filter((error) => error.path === path),
        ).toHaveLength(1);
    });
  });

  it.each(['abc', true])(
    'a number-or-literal union given %s keeps the number type fault beside the literal',
    (depth) => {
      const schema = z
        .object({ depth: z.union([z.number().int().min(0), z.literal('all')]) })
        .strict();
      expect(schemaRejection(schema, { depth }).errors).toEqual([
        { path: 'depth', code: 'type', values: ['integer'] },
        { path: 'depth', code: 'enum', values: ['all'] },
      ]);
    },
  );

  it('a wrong-typed enum value is one enum fault; JSON text where a list or object belongs is json_text without values', () => {
    const schema = z
      .object({
        action: z.enum(['approve', 'cancel']),
        mode: z.literal('bb'),
        list: z.array(z.string()).nullable(),
        node: z.object({ id: z.string() }),
      })
      .strict();
    expect(
      schemaRejection(schema, {
        action: 1,
        mode: null,
        list: '["a"',
        node: '{"id":',
      }).errors,
    ).toEqual([
      { path: 'action', code: 'enum', values: ['approve', 'cancel'] },
      { path: 'mode', code: 'enum', values: ['bb'] },
      { path: 'list', code: 'json_text' },
      { path: 'node', code: 'json_text' },
    ]);
  });

  describe('schema rejection: a present value outside its enum', () => {
    const flowSchema = z
      .object({
        verdict: z.enum(['pass', 'fail']),
        flow: z
          .array(z.object({ out: z.literal('Qty'), src: z.string() }).strict())
          .optional(),
      })
      .strict();

    it('names each offending entry with the schema values', () => {
      const rejection = schemaRejection(flowSchema, {
        verdict: 'pass',
        flow: [
          { out: 'Qty', src: 'x' },
          { out: 'Other', src: 'y' },
          { out: 'More', src: 'z' },
        ],
      });
      expect(rejection.errors).toEqual([
        { path: 'flow.1.out', code: 'enum', values: ['Qty'] },
        { path: 'flow.2.out', code: 'enum', values: ['Qty'] },
      ]);
    });

    it('an absent enum field is missing, not an invalid value', () => {
      expect(faults(schemaRejection(flowSchema, {}))).toEqual([
        ['verdict', 'missing'],
      ]);
    });
  });

  describe('schema rejection: size bounds', () => {
    const schema = z.object({
      notes: z.array(z.string()).max(8).optional(),
      title: z.string().max(8).optional(),
      name: z.string().min(1).optional(),
      revision: z.number().int().positive().optional(),
    });
    it('a string sent for a bounded array is a type fault, an independent text limit a size fault', () => {
      expect(
        faults(
          schemaRejection(schema, {
            notes: 'Ignore logging-related objects',
            title: 'nine char',
          }),
        ),
      ).toEqual([
        ['notes', 'type'],
        ['title', 'size'],
      ]);
    });
    it('array, empty-string and exclusive numeric bounds are size faults', () => {
      expect(
        faults(
          schemaRejection(schema, {
            notes: Array.from({ length: 9 }, () => 'n'),
            name: '',
            revision: 0,
          }),
        ),
      ).toEqual([
        ['notes', 'size'],
        ['name', 'size'],
        ['revision', 'size'],
      ]);
    });
  });

  it('a key misplaced on a column_flow entry names the concrete path with the declared fields', () => {
    const ref = z
      .object({
        node: z.string(),
        col: z.string(),
        note: z.string().optional(),
      })
      .strict();
    const entry = z
      .object({
        out_col: z.string(),
        out_node: z.string().optional(),
        upstream_columns: z.array(ref),
      })
      .strict();
    const ok = { out_col: 'a', upstream_columns: [] };
    const rejection = schemaRejection(
      z.object({ column_flow: z.array(entry) }).strict(),
      { column_flow: [ok, ok, ok, ok, { ...ok, note: 'misplaced' }] },
    );
    expect(rejection.errors).toEqual([
      {
        path: 'column_flow.4.note',
        code: 'unknown_key',
        values: ['out_col', 'out_node', 'upstream_columns'],
      },
    ]);
  });
});

/** A present_result call with one unknown section id and detail slots that reached no section, rejected by the real handler. */
describe('renderProblem over a real present_result rejection: an unknown section id and unplaced detail slots', () => {
  const ids = ['[ai].[a]', '[ai].[b]', '[ai].[c]', '[ai].[d]'];
  async function rejectR3(verifyRepair = false): Promise<ToolRejection> {
    const model = buildModel(
      ids.map((id) => ({
        fullName: id,
        type: 'view' as const,
        bodyScript: 'SELECT 1 AS Qty',
        columns: [{ name: 'Qty', type: 'int', nullable: 'NULL', extra: '' }],
      })),
      [],
      undefined,
      undefined,
      true,
      undefined,
      false,
    );
    const session = new AiSession();
    const epoch = session.beginTurn();
    session.resultGraph = {
      nodeIds: ids,
      edges: ids
        .slice(1)
        .map((id, i) => [id, ids[i]!, 'read'] as [string, string, string]),
      source: 'column_trace',
      originNodeId: ids[0]!,
    };
    for (const id of ids.slice(1)) {
      const node = (
        model as unknown as { nodes: Array<{ id: string }> }
      ).nodes.find((n) => n.id === id);
      session.memory.storeDetail(
        node as never,
        [{ angle: 'technical', text: 'Captured finding.' }],
        'Summary.',
      );
    }
    session.enterCompleted(epoch);
    const services = {
      getSession: () => session,
      turnEpoch: () => epoch,
      requireModel: () => model,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      budget: DEFAULT_TURN_TOKEN_BUDGET,
      deliverPreview: vi.fn().mockResolvedValue('delivered'),
      logAndReturn: (_n: string, data: object) => JSON.stringify(data),
      toolError: (_n: string, error: unknown) => {
        throw error;
      },
    } as never;
    const rejected = readToolErrorText(
      await executePresentResult(
        {
          name: 'Lineage',
          summary: 'How it flows.',
          layout_direction: 'LR',
          highlight_groups: [
            { label: 'All', color: 'source', node_ids: [ids[0]] },
          ],
          sections: [
            { label: 'Origin', node_ids: [ids[0]], text: 'The origin.' },
            {
              label: 'Cleaning',
              node_ids: ['[placeholder]'],
              text: 'Cleans rows.',
            },
          ],
        },
        services,
      ),
    );
    if (!rejected) throw new Error('Expected a present_result rejection');
    if (verifyRepair) {
      const sections = [
        { label: 'Origin', node_ids: [ids[0]], text: 'The origin.' },
        {
          label: 'Captured findings',
          node_ids: ids.slice(1),
          text: 'Captured finding.',
        },
      ];
      const repaired = JSON.parse(
        await executePresentResult({ sections }, services),
      );
      expect(repaired).toHaveProperty('success', true);
      expect(session.resultGraph?.sections).toEqual(sections);
      expect(session.resultGraph?.nodeIds).toEqual(ids);
    }
    return rejected;
  }
  const problem = async (stage: FeedbackStage) =>
    render(await rejectR3(), stage, undefined, 'presentation_commit');

  it('states each fault at its element path with its code and never echoes the sent id or label', async () => {
    const rejection = await rejectR3();
    expect(faults(rejection).sort()).toEqual([
      ['sections.*.node_ids', 'slot_unplaced'],
      ['sections.1.node_ids.0', 'report_not_found'],
    ]);
    for (const stage of [1, 2, 3] as const)
      expect(renderProblem(rejection, stage)).not.toMatch(
        /\[placeholder\]|Cleaning/,
      );
  });

  it('lists owed slots in allowed metadata from feedback 1 and replacement result ids from feedback 2', async () => {
    expect(at(await problem(1), 'sections.*.node_ids')?.allowed).toEqual(
      ids.slice(1),
    );
    expect(at(await problem(2), 'sections.1.node_ids.0')?.allowed).toEqual(ids);
  });

  it('accepts a complete sections replacement correcting every listed fault (Approved08 D-099)', async () => {
    const shown = render(await rejectR3(true), 1);
    expect(shown.resend).toEqual(['sections']);
    expect(shown).not.toHaveProperty('resend_rule');
  });
});

/** A CT procedure hop whose supplier lies beyond the approved depth, rejected by the real registry. */
describe('renderProblem over a real submit_findings rejection: a supplier beyond the approved depth', () => {
  const id = (name: string) => `[ai].[${name}]`;
  const cols = (...names: string[]) =>
    names.map((name) => ({ name, type: 'int', nullable: 'NULL', extra: '' }));
  async function world() {
    const nodes = [
      makeNode({
        id: id('report'),
        schema: 'ai',
        name: 'report',
        type: 'view',
        columns: cols('Discount'),
        bodyScript: 'SELECT Amount AS Discount FROM [ai].[staging]',
      }),
      makeNode({
        id: id('staging'),
        schema: 'ai',
        name: 'staging',
        type: 'table',
        columns: cols('Amount', 'Region'),
      }),
      makeNode({
        id: id('loader'),
        schema: 'ai',
        name: 'loader',
        type: 'procedure',
        columns: [],
        bodyScript:
          'CREATE PROCEDURE [ai].[loader] AS BEGIN INSERT INTO [ai].[staging] (Amount, Region) SELECT v.Amount, v.Region FROM [ai].[raw] v; END',
      }),
      makeNode({
        id: id('raw'),
        schema: 'ai',
        name: 'raw',
        type: 'view',
        columns: cols('Amount', 'Region'),
        bodyScript: 'SELECT 1 AS Amount, 2 AS Region',
      }),
      makeNode({
        id: id('archive'),
        schema: 'ai',
        name: 'archive',
        type: 'table',
        columns: cols('Amount'),
      }),
    ];
    const pairs: Array<[string, string]> = [
      [id('staging'), id('report')],
      [id('loader'), id('staging')],
      [id('raw'), id('loader')],
      [id('loader'), id('archive')],
    ];
    const model = makeIndexedModel(nodes, pairs);
    const graph = makeGraph(nodes, pairs);
    const session = new AiSession();
    session.model = model;
    session.graph = graph;
    session.classification = 'technical';
    session.beginTurn();
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.classification = 'technical';
    expect(
      engine.init({
        origin: id('report'),
        question: 'Trace.',
        analysisMode: 'ct',
        targetColumns: ['Discount'],
        direction: 'upstream',
        depthIntent: {
          upstream: { levels: 2, exactness: 'exact' },
          downstream: { levels: 0, exactness: 'exact' },
        },
      } as never),
    ).toMatchObject({ ok: true });
    engine.getHopContext();
    session.stateMachine = engine;
    session.enterExploring(session.turnEpoch);
    const noop = () => {};
    const registry = buildAiToolRegistry(
      () => session,
      { info: noop, debug: noop, warn: noop, error: noop } as never,
      () => undefined,
    );
    const first = JSON.parse(
      String(
        await registry.invoke('lineage_submit_findings', {
          focus_node_id: id('report'),
          summary: 'Discount derives from staging.',
          sections: { technical: 'Reads staging.Amount.' },
          column_flow: [
            {
              out_col: 'Discount',
              upstream_columns: [{ node: id('staging'), col: 'Amount' }],
            },
          ],
        }),
      ),
    );
    expect(first).toMatchObject({ ok: true, next_focus: id('loader') });
    return registry;
  }
  const flow = (col: string) => ({
    out_node: id('staging'),
    out_col: col,
    upstream_columns: [{ node: id('raw'), col }],
  });

  it('rejects any out_node when the hop offers no destination', () => {
    const schema = submitFindingsSchemaForMode('ct', 'technical', false, {
      outCols: null,
      outNode: true,
      columnSourceNodeIds: [],
    });
    const result = validateToolCandidate(schema, {
      summary: 'Recorded findings.',
      column_flow: [
        { out_node: id('archive'), out_col: 'Amount', upstream_columns: [] },
      ],
    });
    if (result.success)
      throw new Error('Expected an unavailable out_node to reject');
    expect(result.rejection.errors).toContainEqual({
      path: 'column_flow.0.out_node',
      code: 'never',
    });
    expect(
      validateToolCandidate(schema, {
        summary: 'Recorded findings.',
        column_flow: [],
      }).success,
    ).toBe(true);
  });

  it('states the scope alternative from the first supplier rejection without declaring a born value', async () => {
    const registry = await world();
    const rejection = readToolErrorText(
      String(
        await registry.invoke('lineage_submit_findings', {
          summary: 'Loads staging from raw.',
          sections: { technical: 'Copies raw into staging.' },
          column_flow: [flow('Amount')],
        }),
      ),
    );
    if (!rejection) throw new Error('Expected outside supplier rejection');
    expect(render(rejection, 1, undefined, 'hop_commit').resend.sort()).toEqual(
      ['column_flow', 'questions', 'sections'],
    );
    const first = at(
      render(rejection, 1, undefined, 'hop_commit'),
      'column_flow.0.upstream_columns.0.node',
    );
    expect(first?.allowed).toBeUndefined();
    expect(rejection.errors).toContainEqual(
      expect.objectContaining({
        path: 'column_flow.0.upstream_columns.0.node',
        code: 'column_out_of_scope',
      }),
    );
    const repaired = JSON.parse(
      String(
        await registry.invoke('lineage_submit_findings', {
          column_flow: [],
          questions: [
            {
              nodeId: id('raw'),
              question: 'What supplies Amount outside the approved depth?',
            },
          ],
          sections: {
            technical:
              '⚠️ raw.Amount supplies staging.Amount beyond the approved depth.',
          },
        }),
      ),
    );
    expect(repaired).toHaveProperty('ok', true);
  });

  it('offers the report-reference fallback for an out-of-scope out_node, without changing control references (Approved08)', async () => {
    const registry = await world();
    const rejection = readToolErrorText(
      String(
        await registry.invoke('lineage_submit_findings', {
          summary: 'Loads staging and archive.',
          sections: { technical: 'Copies values to both destinations.' },
          column_flow: [
            {
              out_node: id('archive'),
              out_col: 'Amount',
              upstream_columns: [{ node: id('staging'), col: 'Region' }],
            },
          ],
        }),
      ),
    );
    if (!rejection) throw new Error('Expected an out-of-scope write rejection');
    expect(render(rejection, 1, undefined, 'hop_commit').resend.sort()).toEqual(
      ['column_flow', 'questions', 'sections'],
    );
    expect(rejection.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'column_flow.0.out_node' }),
      ]),
    );
    const writePath = 'column_flow.0.out_node';
    for (const stage of [1, 2] as const)
      expect(
        at(render(rejection, stage, undefined, 'hop_commit'), writePath)
          ?.message,
      ).not.toContain(ISSUES.column_out_of_scope.fallback);
    expect(
      at(render(rejection, 3, undefined, 'hop_commit'), writePath),
    ).toMatchObject({
      code: 'column_out_of_scope',
      message: expect.stringContaining(ISSUES.column_out_of_scope.fallback),
    });
    expect(render(rejection, 3, undefined, 'hop_commit').resend).toContain(
      'sections',
    );
    const control = makeRejection({
      code: 'invalid_input',
      errors: [
        { path: 'add_node_ids.0', code: 'out_of_scope', category: 'value' },
      ],
    });
    expect(
      render(control, 3, undefined, 'presentation_commit').errors.some(
        (error) => error.message.includes(ISSUES.column_out_of_scope.fallback),
      ),
    ).toBe(false);
    const repaired = JSON.parse(
      String(
        await registry.invoke('lineage_submit_findings', {
          column_flow: [],
          questions: [
            {
              nodeId: id('archive'),
              question: 'What receives the outside write?',
            },
          ],
          sections: {
            technical:
              '⚠️ The archive.Amount write is outside the approved direction.',
          },
        }),
      ),
    );
    expect(repaired).toHaveProperty('ok', true);
  });

  it('keeps same-table supplier choices and accepts a different-column correction (Approved08)', async () => {
    const registry = await world();
    const rejection = readToolErrorText(
      String(
        await registry.invoke('lineage_submit_findings', {
          focus_node_id: id('loader'),
          summary: 'Loads staging from raw.',
          sections: { technical: 'Copies raw into staging.' },
          column_flow: [
            flow('Amount'),
            { ...flow('Region'), out_col: 'Amount' },
          ],
        }),
      ),
    );
    if (!rejection) throw new Error('Expected a rejection');
    expect(
      rejection.errors.filter(
        (error) => error.path === 'column_flow.0.upstream_columns.0.node',
      ),
    ).toEqual([
      {
        path: 'column_flow.0.upstream_columns.0.node',
        code: 'column_out_of_scope',
        values: [id('loader'), id('staging')],
      },
    ]);
    // Object choices stay metadata-complete; the existing tracer checks identical column endpoints.
    expect(
      at(
        render(rejection, 1, undefined, 'hop_commit'),
        'column_flow.0.upstream_columns.0.node',
      ),
    ).not.toHaveProperty('allowed');
    expect(
      at(
        render(rejection, 2, undefined, 'hop_commit'),
        'column_flow.0.upstream_columns.0.node',
      )?.allowed,
    ).toEqual([id('loader'), id('staging')]);
    expect(
      render(rejection, 2, undefined, 'hop_commit').errors.some((error) =>
        error.message.includes(ISSUES.column_out_of_scope.fallback),
      ),
    ).toBe(false);
    expect(
      at(
        render(rejection, 3, undefined, 'hop_commit'),
        'column_flow.0.upstream_columns.0.node',
      )?.message,
    ).toContain(ISSUES.column_out_of_scope.fallback);
    // Region and Amount are distinct endpoints on the same table; metadata, not SQL inference, decides eligibility.
    expect(
      at(
        render(rejection, 2, undefined, 'hop_commit'),
        'column_flow.1.upstream_columns.0.node',
      )?.allowed,
    ).toEqual([id('loader'), id('staging')]);
    const repaired = JSON.parse(
      String(
        await registry.invoke('lineage_submit_findings', {
          focus_node_id: id('loader'),
          column_flow: [
            {
              out_node: id('staging'),
              out_col: 'Amount',
              upstream_columns: [{ node: id('staging'), col: 'Region' }],
            },
          ],
        }),
      ),
    );
    expect(repaired).toHaveProperty('ok', true);
  });
});
