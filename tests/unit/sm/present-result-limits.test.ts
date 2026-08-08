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
    const { input, fixes } = autoFixPresentResult({
      name: longName,
      title: 't'.repeat(PRESENT_RESULT_TITLE_MAX - 5),
      summary: longSummary,
    } as never);
    assertEq(input.name, longName, 'name within tolerance is passed through unmodified');
    assertEq(input.summary, longSummary, 'summary is never truncated (content, not a GUI label)');
    assert(!fixes.some(f => /truncat/i.test(f)), 'no truncation fix is emitted');
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

// The failure this guards: a submission carrying a reuse defect AND a structural defect used to
// report only the reuse one, because reuse was checked ahead of validatePresentResult and returned
// early. The structural defect then surfaced a round later, and each masked defect cost its own
// semantic-failure charge — three of which end the phase.
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
    expect(result.errors.some(e => e.includes('linked to multiple section labels'))).toBe(true);
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
});
