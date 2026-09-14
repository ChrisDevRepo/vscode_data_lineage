import {
  discoveryPreviewNarrative,
  findDiscoveryPreviewReuseViolations,
  orderAndAssemble,
  validatePresentResult,
} from '../../../src/ai/tools/presentResult';
import {
  PresentResultBoundarySchema,
  PresentResultModelSchema,
  PRESENT_RESULT_NAME_MAX,
  PRESENT_RESULT_TITLE_MAX,
  PRESENT_RESULT_SECTION_LABEL_MAX,
  PRESENT_RESULT_HIGHLIGHT_LABEL_MAX,
  PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX,
} from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { describe, expect, it } from 'vitest';

describe("present_result hard/soft text limits", () => {
  const parse = (input: unknown) => PresentResultBoundarySchema.safeParse(input);
  const base = {
    summary: 'One-line purpose.',
    sections: [{ label: 'Result', text: 'Grounded detail.' }],
  };
  /** A payload that validates end to end, so each case below changes exactly one label. */
  const validBase = {
    name: 'Import flow',
    summary: 'One-line purpose.',
    sections: [{ label: 'Result', text: 'Grounded detail.', node_ids: ['a'] }],
    highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
  };
  const validate = (payload: Record<string, unknown>) => {
    const assembled = orderAndAssemble(payload.sections as Parameters<typeof orderAndAssemble>[0]);
    return validatePresentResult(payload as never, ['a'], assembled.badges, assembled.description);
  };

  it("the boundary never truncates authored text", () => {
    const longName = 'n'.repeat(PRESENT_RESULT_NAME_MAX - 5);
    const longSummary = 's'.repeat(400);
    const result = parse({
      ...base,
      name: longName,
      title: 't'.repeat(PRESENT_RESULT_TITLE_MAX - 5),
      summary: longSummary,
    });
    expect(result.success, 'a payload within tolerance parses').toBe(true);
    expect(result.data!.name, 'name within tolerance is passed through unmodified').toBe(longName);
    expect(result.data!.summary, 'summary is never truncated (content, not a GUI label)').toBe(longSummary);
  });

  /**
   * The four GUI labels whose hard cap the MODEL-FACING schema advertises and
   * `validatePresentResult` — never the boundary parse — enforces. A Zod reject at the boundary
   * fails the whole call with no held draft, so an overrun would cost a full resend of an answer
   * that was otherwise correct; enforced in the validator it is a repairable, one-field patch.
   */
  const textLimitCases: Array<{
    name: string;
    max: number;
    char: string;
    field: string;
    path: string;
    payload: (value: string) => Record<string, unknown>;
  }> = [
    {
      name: 'name',
      max: PRESENT_RESULT_NAME_MAX,
      char: 'n',
      field: 'name',
      path: 'name',
      payload: value => ({ ...validBase, name: value }),
    },
    {
      name: 'title',
      max: PRESENT_RESULT_TITLE_MAX,
      char: 't',
      field: 'title',
      path: 'title',
      payload: value => ({ ...validBase, title: value }),
    },
    {
      name: 'section label',
      max: PRESENT_RESULT_SECTION_LABEL_MAX,
      char: 'L',
      field: 'sections',
      path: 'sections.0.label',
      payload: value => ({ ...validBase, sections: [{ label: value, text: 'Grounded detail.', node_ids: ['a'] }] }),
    },
    {
      name: 'highlight label',
      max: PRESENT_RESULT_HIGHLIGHT_LABEL_MAX,
      char: 'H',
      field: 'highlight_groups',
      path: 'highlight_groups.0.label',
      payload: value => ({ ...validBase, highlight_groups: [{ label: value, color: 'source', node_ids: ['a'] }] }),
    },
  ];

  it.each(textLimitCases)('no parse enforces the $name cap, so the validator sees the overrun', ({ name, max, char, payload }) => {
    // The model-facing schema is what the model port parses; a reject there carries no measured
    // size, no held draft, and no repairable classification, so the cap is advertised only.
    expect(PresentResultModelSchema.safeParse(payload(char.repeat(max + 1))).success,
      `${name} over the cap parses on the schema the model is offered`).toBe(true);
    expect(parse(payload(char.repeat(max + 1))).success,
      `${name} over the cap parses at the boundary, so the validator — not Zod — judges it`).toBe(true);
  });

  it.each(textLimitCases)('$name at exactly its hard cap validates', ({ name, max, char, payload }) => {
    expect(validate(payload(char.repeat(max))).success, `${name} at the hard cap is accepted verbatim`).toBe(true);
  });

  it.each(textLimitCases)('an over-long $name is a repairable single-field rejection naming the entry', ({ name, max, char, field, path, payload }) => {
    const result = validate(payload(char.repeat(max + 1)));
    if (result.success) throw new Error(`${name} over the hard cap should reject`);
    expect(result.repairable, `${name} over the cap is repairable`).toBe(true);
    expect(result.repairFields, `${name} authorizes only its own field for repair`).toEqual([field]);
    expect(result.detail?.map(entry => entry.path), `${name} names the offending entry path`).toEqual([path]);
    expect(result.errors.join(' '), 'the rejection states the measured length against the limit').toContain(`${max + 1} chars, limit ${max}`);
    expect(result.hint, 'the hint names the single field to resend').toContain(`Fix ${field} only.`);
  });

  it('names the exact section entry, not just the sections field', () => {
    const sections = [
      { label: 'One', text: 'First.', node_ids: ['a'] },
      { label: 'Two', text: 'Second.' },
      { label: 'L'.repeat(PRESENT_RESULT_SECTION_LABEL_MAX + 1), text: 'Third.' },
    ];
    const result = validate({ ...validBase, sections });
    if (result.success) throw new Error('an over-long section label should reject');
    expect(result.detail?.map(entry => entry.path)).toEqual(['sections.2.label']);
  });

  it('the model-facing JSON Schema carries each label ceiling as a typed constraint', () => {
    const projected = toModelJsonSchema(PresentResultModelSchema) as {
      properties?: {
        name?: { maxLength?: number };
        title?: { maxLength?: number };
        sections?: { items?: { properties?: { label?: { maxLength?: number } } } };
        highlight_groups?: { maxItems?: number; minItems?: number; items?: { properties?: { label?: { maxLength?: number } } } };
      };
    };
    expect(projected.properties?.name?.maxLength).toBe(PRESENT_RESULT_NAME_MAX);
    expect(projected.properties?.title?.maxLength).toBe(PRESENT_RESULT_TITLE_MAX);
    expect(projected.properties?.sections?.items?.properties?.label?.maxLength).toBe(PRESENT_RESULT_SECTION_LABEL_MAX);
    expect(projected.properties?.highlight_groups?.items?.properties?.label?.maxLength).toBe(PRESENT_RESULT_HIGHLIGHT_LABEL_MAX);
    expect(projected.properties?.highlight_groups?.maxItems).toBe(PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX);
    // The floor is structural (a new render needs at least one group), so it stays a real check.
    expect(projected.properties?.highlight_groups?.minItems).toBe(1);
  });

  it("a 400-char summary is accepted (was truncated at 300 before)", () => { expect(parse({ ...base, name: 'ok', summary: 's'.repeat(400) }).success, 'a 400-char summary is accepted (was truncated at 300 before)').toBe(true); });
});

// T-1 (tooltext sweep): `highlight_groups` advertised `min(1)` but hid the hard `max` that
// `validatePresentResult` (presentResult.ts) rejects on, so a model could only learn the ceiling
// by being rejected. The ceiling is now stated in the JSON schema the model reads, asserted here
// against the exported constant rather than a literal 5 copied into the test — a future change to
// PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX moves this test with it. It is advertised, not parsed: the
// validator owns the rejection so an over-long list is repaired as a `highlight_groups` patch
// against the held draft rather than failing the whole render at the model port.
describe('present_result highlight_groups model-facing cap (T-1)', () => {
  const buildGroups = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ label: `g${i}`, color: 'source' as const, node_ids: ['a'] }));
  const base = {
    name: 'ok',
    summary: 'One-line purpose.',
    sections: [{ label: 'Result', text: 'Grounded detail.' }],
  };

  it('accepts exactly the cap', () => {
    const result = PresentResultModelSchema.safeParse({ ...base, highlight_groups: buildGroups(PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX) });
    expect(result.success, 'the model-facing schema accepts highlight_groups at the cap').toBe(true);
  });

  it('leaves one group over the cap to the validator instead of failing the parse', () => {
    // The section links the highlighted node, so the count is the only rule this payload breaks.
    const overCap = {
      ...base,
      sections: [{ label: 'Result', text: 'Grounded detail.', node_ids: ['a'] }],
      highlight_groups: buildGroups(PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX + 1),
    };
    expect(PresentResultModelSchema.safeParse(overCap).success,
      'the schema the model port parses does not reject an over-long list').toBe(true);

    const assembled = orderAndAssemble(overCap.sections);
    const result = validatePresentResult(overCap as never, ['a'], assembled.badges, assembled.description);
    if (result.success) throw new Error('one group over the cap must reject');
    expect(result.errors.some(message => message.includes(`maximum of ${PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX}`)),
      'the validator states the ceiling it enforced').toBe(true);
    expect(result.repairable, 'an over-long list is repairable').toBe(true);
    expect(result.repairFields, 'the repair is scoped to highlight_groups').toEqual(['highlight_groups']);
  });

  it('the model-facing JSON Schema carries the advertised ceiling as a typed constraint', () => {
    const projected = toModelJsonSchema(PresentResultModelSchema) as {
      properties?: { highlight_groups?: { description?: string; maxItems?: number; minItems?: number } };
    };
    const field = projected.properties?.highlight_groups;
    expect(field?.maxItems, 'JSON Schema maxItems matches the exported constant').toBe(PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX);
    expect(field?.minItems, 'the floor is still advertised').toBe(1);
    expect(field?.description ?? '', 'the prose also states the range so a model reading only text still learns it').toMatch(/1-5/);
  });
});

describe('discovery preview prose reuse', () => {
  const source = discoveryPreviewNarrative('# Import flow\n\nSource rows are validated.\n\nFailures go to ErrorLog.');

  it('accepts lossless regrouping and verbatim captions', () => {
    expect(findDiscoveryPreviewReuseViolations(source.body, {
      sections: [
        { label: 'Validation', text: 'Source rows are validated.' },
        { label: 'Failures', text: 'Failures go to ErrorLog.' },
      ],
      notes: [{ node_id: '[ai].[ErrorLog]', text: 'Failures go to ErrorLog.' }],
    })).toEqual([]);
  });

  it('authorizes repair only for rewritten fields', () => {
    const violations = findDiscoveryPreviewReuseViolations(source.body, {
      sections: [{ label: 'Summary', text: 'The model rewrote the answer.' }],
      notes: [{ node_id: '[ai].[ErrorLog]', text: 'Invented caption.' }],
    });
    expect(violations.flatMap(v => v.repairFields)).toEqual(['sections', 'notes']);
  });

  // A caption whose every word appears in the answer but never contiguously is a new claim about
  // adjacency, which is what verbatim reuse exists to prevent.
  it('rejects a caption stitched from separated fragments and names the offending index', () => {
    // Three paragraphs, so joining the first and the last skips the middle one — every word is
    // present, the span is not.
    const gapped = discoveryPreviewNarrative(
      '# Import flow\n\nSource rows are validated.\n\nDuplicates are removed.\n\nFailures go to ErrorLog.',
    );
    const violations = findDiscoveryPreviewReuseViolations(gapped.body, {
      sections: [
        { label: 'Validation', text: 'Source rows are validated.' },
        { label: 'Dedup', text: 'Duplicates are removed.' },
        { label: 'Failures', text: 'Failures go to ErrorLog.' },
      ],
      notes: [
        { node_id: '[ai].[Ok]', text: 'Source rows are validated.' },
        { node_id: '[ai].[ErrorLog]', text: 'Source rows are validated. Failures go to ErrorLog.' },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].field).toBe('notes');
    expect(violations[0].paths).toEqual(['notes.1']);
  });
});

// A submission carrying a reuse defect AND a structural defect must report both in one rejection.
// Reuse is checked ahead of validatePresentResult; an early return there would mask the structural
// defect, which would then surface a round later — and each masked defect costs its own
// semantic-failure charge, three of which end the phase.
describe('present_result reports every defect class in one rejection', () => {
  const source = discoveryPreviewNarrative(
    '# Import flow\n\nSource rows are validated.\n\nDuplicates are removed.\n\nFailures go to ErrorLog.',
  );
  const nodeIds = ['[ai].[raw]', '[ai].[errorlog]'];

  const submission = {
    name: 'Import flow',
    summary: 'One-line purpose.',
    sections: [
      { label: 'Validation', text: 'Source rows are validated.', node_ids: ['[ai].[raw]'] },
      { label: 'Dedup', text: 'Duplicates are removed.' },
      // `[ai].[ghost]` is in no result graph — the structural defect.
      { label: 'Failures', text: 'Failures go to ErrorLog.', node_ids: ['[ai].[ghost]', '[ai].[errorlog]'] },
    ],
    // Skips the middle paragraph — the reuse defect.
    notes: [{ node_id: '[ai].[errorlog]', text: 'Source rows are validated. Failures go to ErrorLog.' }],
    highlight_groups: [{ label: 'Target', color: 'target', node_ids: ['[ai].[errorlog]'] }],
  } as never;

  it('reports the reuse defect and the structural defect together', () => {
    const result = validatePresentResult(
      submission,
      nodeIds,
      [],
      'assembled',
      false,
      findDiscoveryPreviewReuseViolations(source.body, submission),
    );
    if (result.success) throw new Error('a payload with two defect classes must not validate');
    expect(result.errors.some(e => e.includes('unbroken span'))).toBe(true);
    expect(result.errors.some(e => e.includes('[ai].[ghost]'))).toBe(true);
  });

  it('names the offending entries so a repair need not re-derive them', () => {
    const result = validatePresentResult(
      submission,
      nodeIds,
      [],
      'assembled',
      false,
      findDiscoveryPreviewReuseViolations(source.body, submission),
    );
    if (result.success) throw new Error('a payload with two defect classes must not validate');
    expect(result.detail?.map(d => d.path)).toEqual(expect.arrayContaining(['notes.0', 'sections.2']));
  });

  it('names the section holding the unlinkable id so a repair need not re-derive it', () => {
    const result = validatePresentResult(
      submission,
      nodeIds,
      [],
      'assembled',
      false,
      findDiscoveryPreviewReuseViolations(source.body, submission),
    );
    if (result.success) throw new Error('a payload with two defect classes must not validate');
    const message = result.errors.find(e => e.includes('[ai].[ghost]'));
    expect(message).toBeDefined();
    // The offending section label is a runtime value, not hardcoded trace text.
    expect(message).toContain('Failures');
  });

  // An unknown-node-id rejection used to name the rule and nothing else. Several distinct rules
  // share the `validation` code, so a trace consumer could not tell them apart, and the model was
  // told a field was wrong without being told which entry held it.
  it('names the offending entry for every unknown-node-id class', () => {
    const unknown = {
      name: 'Import flow',
      summary: 'One-line purpose.',
      sections: [
        { label: 'Validation', text: 'Source rows are validated.' },
        { label: 'Failures', text: 'Failures go to ErrorLog.', node_ids: ['[ai].[missing]'] },
      ],
      notes: [{ node_id: '[ai].[gone]', text: 'Failures go to ErrorLog.' }],
      highlight_groups: [
        { label: 'Target', color: 'target', node_ids: ['[ai].[errorlog]'] },
        { label: 'Source', color: 'source', node_ids: ['[ai].[absent]'] },
      ],
    } as never;

    const result = validatePresentResult(unknown, nodeIds, [], 'assembled', false, []);

    if (result.success) throw new Error('unknown node ids must not validate');
    expect(result.detail?.map(d => d.path)).toEqual(
      expect.arrayContaining(['sections.1', 'notes.0', 'highlight_groups.1']),
    );
  });

  // An unquoted id can render identically to a correct one (trailing spaces, near-identical
  // glyphs), so the rejection delimits every offender with backticks.
  it('quotes offending ids in the unknown-IDs rejection', () => {
    const misspelled = {
      name: 'Import flow',
      summary: 'One-line purpose.',
      sections: [{ label: 'Failures', text: 'Failures go to ErrorLog.', node_ids: ['[ai].[erorlog]'] }],
      highlight_groups: [{ label: 'Target', color: 'target', node_ids: ['[ai].[errorlog]'] }],
    } as never;

    const result = validatePresentResult(misspelled, nodeIds, [], 'assembled', false, []);

    if (result.success) throw new Error('an id absent from the result graph must not validate');
    const message = result.errors.find(e => e.includes('unknown IDs'));
    expect(message).toContain('`[ai].[erorlog]`');
  });

  // Invisible-character defects are settled at the Zod boundary, before the validator can ever see
  // them: format characters are stripped from a real id, and an id that is nothing but format
  // characters rejects with the exact array index instead of an unknown-IDs rejection naming an
  // offender no one can see.
  it('strips Unicode format characters from node ids at the boundary and rejects Cf-only ids', () => {
    const parsed = PresentResultBoundarySchema.safeParse({
      name: 'Import flow',
      summary: 'One-line purpose.',
      sections: [{ label: 'Failures', text: 'Failures go to ErrorLog.', node_ids: ['[ai].[errorlog]​'] }],
      highlight_groups: [{ label: 'Target', color: 'target', node_ids: ['﻿[ai].[errorlog]‎'] }],
    });
    if (!parsed.success) throw new Error('a Cf-padded real id must parse');
    expect(parsed.data.sections[0].node_ids).toEqual(['[ai].[errorlog]']);
    expect(parsed.data.highlight_groups?.[0]?.node_ids).toEqual(['[ai].[errorlog]']);

    const cfOnly = PresentResultBoundarySchema.safeParse({
      name: 'Import flow',
      summary: 'One-line purpose.',
      sections: [{ label: 'Failures', text: 'Failures go to ErrorLog.', node_ids: ['​'] }],
      highlight_groups: [{ label: 'Target', color: 'target', node_ids: ['[ai].[errorlog]'] }],
    });
    if (cfOnly.success) throw new Error('a zero-width-only id must reject at the boundary');
    expect(cfOnly.error.issues.some((issue) => issue.path.join('.') === 'sections.0.node_ids.0')).toBe(true);
  });

  it('applies the same node-id boundary to notes and follow-up add/prune lists', () => {
    const parsed = PresentResultBoundarySchema.safeParse({
      name: 'Import flow',
      summary: 'One-line purpose.',
      sections: [{ label: 'Failures', text: 'Failures go to ErrorLog.' }],
      highlight_groups: [{ label: 'Target', color: 'target', node_ids: ['[ai].[errorlog]'] }],
      notes: [{ node_id: '[ai].[errorlog]​', text: 'Caption.' }],
      add_node_ids: ['​'],
    });
    if (parsed.success) throw new Error('a zero-width-only add_node_ids entry must reject');
    expect(parsed.error.issues.some((issue) => issue.path.join('.') === 'add_node_ids.0')).toBe(true);

    const notesOnly = PresentResultBoundarySchema.safeParse({
      name: 'Import flow',
      summary: 'One-line purpose.',
      sections: [{ label: 'Failures', text: 'Failures go to ErrorLog.' }],
      highlight_groups: [{ label: 'Target', color: 'target', node_ids: ['[ai].[errorlog]'] }],
      notes: [{ node_id: '[ai].[errorlog]​', text: 'Caption.' }],
    });
    if (!notesOnly.success) throw new Error('a Cf-padded real note id must parse');
    expect(notesOnly.data.notes?.[0]?.node_id).toBe('[ai].[errorlog]');
  });
});
