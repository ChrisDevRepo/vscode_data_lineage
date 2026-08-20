import {
  autoFixPresentResult,
  discoveryPreviewNarrative,
  findDiscoveryPreviewReuseViolations,
  validatePresentResult,
} from '../../../src/ai/tools/presentResult';
import {
  PresentResultBoundarySchema,
  PRESENT_RESULT_NAME_MAX,
  PRESENT_RESULT_TITLE_MAX,
  PRESENT_RESULT_SECTION_LABEL_MAX,
  PRESENT_RESULT_HIGHLIGHT_LABEL_MAX,
} from '../../../src/ai/tools/toolSchemas';
import { assert, assertEq } from '../helpers/testUtils';
import { describe, expect, it } from 'vitest';

describe("present_result hard/soft text limits", () => {
  const parse = (input: unknown) => PresentResultBoundarySchema.safeParse(input);
  const base = {
    summary: 'One-line purpose.',
    sections: [{ label: 'Result', text: 'Grounded detail.' }],
  };

  it("autoFix does not truncate", () => {
    const longName = 'n'.repeat(PRESENT_RESULT_NAME_MAX - 5);
    const longSummary = 's'.repeat(400);
    const input = autoFixPresentResult({
      name: longName,
      title: 't'.repeat(PRESENT_RESULT_TITLE_MAX - 5),
      summary: longSummary,
    } as never);
    assertEq(input.name, longName, 'name within tolerance is passed through unmodified');
    assertEq(input.summary, longSummary, 'summary is never truncated (content, not a GUI label)');
  });

  it("Regression: autoFix's double-escaped-newline unescape leaves a $$...$$ KaTeX macro like \\not intact", () => {
    const mathBlock =
      '$$IsValidated := 1 \\quad \\text{when } ValidationMessage \\text{ is NULL } '
      + '\\lor ValidationMessage \\not\\text{ LIKE } \\%Unknown\\ region\\%$$';
    const input = autoFixPresentResult({
      ...base,
      sections: [{ label: 'Result', text: `Prose line one.\\nProse line two.\n\n${mathBlock}` }],
    } as never);
    const text = input.sections![0].text;
    assert(text.includes(mathBlock), 'the $$...$$ block round-trips byte-identical, no dropped `n`');
    assert(text.startsWith('Prose line one.\nProse line two.'), 'a genuine double-escaped newline in prose is still unescaped');
  });

  const textLimitCases: Array<{
    name: string;
    max: number;
    char: string;
    path: string;
    input: (value: string) => unknown;
  }> = [
    {
      name: 'name',
      max: PRESENT_RESULT_NAME_MAX,
      char: 'n',
      path: 'name',
      input: value => ({ ...base, name: value }),
    },
    {
      name: 'title',
      max: PRESENT_RESULT_TITLE_MAX,
      char: 't',
      path: 'title',
      input: value => ({ ...base, name: 'ok', title: value }),
    },
    {
      name: 'section label',
      max: PRESENT_RESULT_SECTION_LABEL_MAX,
      char: 'L',
      path: 'sections',
      input: value => ({ ...base, name: 'ok', sections: [{ label: value, text: 'x' }] }),
    },
    {
      name: 'highlight label',
      max: PRESENT_RESULT_HIGHLIGHT_LABEL_MAX,
      char: 'H',
      path: 'highlight_groups',
      input: value => ({
        ...base,
        name: 'ok',
        highlight_groups: [{ label: value, color: 'source', node_ids: ['a'] }],
      }),
    },
  ];

  it.each(textLimitCases)('$name accepts its hard cap', ({ name, max, char, input }) => {
    assert(parse(input(char.repeat(max))).success, `${name} at the hard cap is accepted`);
  });

  it.each(textLimitCases)('$name rejects one character over its hard cap', ({ name, max, char, path, input }) => {
    const result = parse(input(char.repeat(max + 1)));
    if (result.success) throw new Error(`${name} over the hard cap should reject`);
    assert(result.error.issues.some(issue => issue.path[0] === path), `${name} rejection points at ${path}`);
  });

  it("a 400-char summary is accepted (was truncated at 300 before)", () => { assert(parse({ ...base, name: 'ok', summary: 's'.repeat(400) }).success, 'a 400-char summary is accepted (was truncated at 300 before)'); });
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
      // `[ai].[raw]` is linked twice — the structural defect.
      { label: 'Validation', text: 'Source rows are validated.', node_ids: ['[ai].[raw]'] },
      { label: 'Dedup', text: 'Duplicates are removed.' },
      { label: 'Failures', text: 'Failures go to ErrorLog.', node_ids: ['[ai].[raw]', '[ai].[errorlog]'] },
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
    expect(result.errors.some(e => e.includes('already appears in section'))).toBe(true);
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

  it('names the canonical section and the editable index for a node linked to two sections', () => {
    const result = validatePresentResult(
      submission,
      nodeIds,
      [],
      'assembled',
      false,
      findDiscoveryPreviewReuseViolations(source.body, submission),
    );
    if (result.success) throw new Error('a payload with two defect classes must not validate');
    const message = result.errors.find(e => e.includes('already appears in section'));
    expect(message).toBeDefined();
    // First-seen section ('Validation') is canonical; the later section ('Failures', sections[2])
    // is the one the repair must edit — both are runtime values, not hardcoded trace text.
    // Labels render through normalizePresentSectionLabel (lowercased) in this hint.
    expect(message).toContain('already appears in section "validation"');
    expect(message).toContain('remove it from section "failures"');
    expect(message).toContain('sections[2].node_ids');
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
