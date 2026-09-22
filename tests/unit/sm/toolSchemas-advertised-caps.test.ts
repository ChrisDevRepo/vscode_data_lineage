/**
 * Advertise-vs-parse contract for every content cap (`advertisedMax`, `toolSchemas.ts`).
 *
 * A content cap reaches the model as a typed JSON-Schema constraint and is enforced by
 * `validatePresentResult` / `NavigationEngine.submitFindings`, never by a parse. Parsed at the
 * model port instead, an overrun fails the whole call with no held draft, no measured size, and no
 * repairable classification — and a model cannot count characters, so the recorded outcome was a
 * regeneration that overran again. These tests pin both halves: the projection a `.max()` would
 * have produced is unchanged, and no schema on the dispatch path rejects an over-size value.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import {
  COLUMN_FLOW_NOTE_MAX,
  PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX,
  PRESENT_RESULT_HIGHLIGHT_LABEL_MAX,
  PRESENT_RESULT_NAME_MAX,
  PRESENT_RESULT_SECTION_LABEL_MAX,
  PRESENT_RESULT_TITLE_MAX,
  PresentResultModelSchema,
  PresentResultSynthesisModelSchema,
  SUBMIT_FINDINGS_BADGE_LABEL_MAX,
  SubmitFindingsBbInputSchema,
  SubmitFindingsCtInputSchema,
  SubmitFindingsModelSchema,
  presentResultRepairPatchSchemaForFields,
} from '../../../src/ai/tools/toolSchemas';

type Node = Record<string, unknown>;

/** Walks a projected JSON Schema by property path, stepping into `items` for an array segment. */
function at(schema: Node, path: readonly string[]): Node {
  let node = schema;
  for (const segment of path) {
    if (segment === '[]') {
      node = node.items as Node;
      continue;
    }
    node = (node.properties as Record<string, Node>)[segment];
    expect(node, `projection has ${path.join('.')}`).toBeDefined();
  }
  return node;
}

/** Every content cap, with the `.max()` form its projection must stay identical to. */
const CAPPED_FIELDS: Array<{
  name: string;
  path: readonly string[];
  keyword: 'maxLength' | 'maxItems';
  limit: number;
  /** The pre-`advertisedMax` declaration, rebuilt here as the parity reference. */
  reference: z.ZodType;
}> = [
  { name: 'present_result name', path: ['name'], keyword: 'maxLength', limit: PRESENT_RESULT_NAME_MAX, reference: z.string().max(PRESENT_RESULT_NAME_MAX).describe('Short name for the generated lineage view — aim for ~60 chars.') },
  { name: 'present_result title', path: ['title'], keyword: 'maxLength', limit: PRESENT_RESULT_TITLE_MAX, reference: z.string().max(PRESENT_RESULT_TITLE_MAX).describe('Optional report heading.') },
  { name: 'present_result sections[].label', path: ['sections', '[]', 'label'], keyword: 'maxLength', limit: PRESENT_RESULT_SECTION_LABEL_MAX, reference: z.string().max(PRESENT_RESULT_SECTION_LABEL_MAX).describe('Section heading and graph badge for every linked node.') },
  { name: 'present_result highlight_groups[].label', path: ['highlight_groups', '[]', 'label'], keyword: 'maxLength', limit: PRESENT_RESULT_HIGHLIGHT_LABEL_MAX, reference: z.string().max(PRESENT_RESULT_HIGHLIGHT_LABEL_MAX).describe('Short legend label describing the shared graph role or status; length target: see the `highlights` output template.') },
];

describe('advertised caps — the JSON schema the model reads', () => {
  const presentResult = toModelJsonSchema(PresentResultModelSchema) as Node;
  const submitFindings = toModelJsonSchema(SubmitFindingsBbInputSchema) as Node;
  const submitFindingsCt = toModelJsonSchema(SubmitFindingsCtInputSchema) as Node;

  it.each(CAPPED_FIELDS)('$name projects its ceiling exactly as .max() did', ({ path, keyword, limit, reference }) => {
    const projected = at(presentResult, path);
    expect(projected[keyword], 'the ceiling matches the exported constant').toBe(limit);
    // Same keywords and same values as the `.max()` declaration produced. Key ORDER differs —
    // `.meta()` merges after the type keywords — which JSON Schema does not distinguish.
    expect(projected).toEqual(toModelJsonSchema(reference));
  });

  it('present_result highlight_groups projects maxItems exactly as .max() did, and keeps its structural floor', () => {
    const projected = presentResult.properties as Record<string, Node>;
    const field = projected.highlight_groups;
    expect(field.maxItems).toBe(PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX);
    expect(field.minItems, 'the floor is structural and stays a real parse-time check').toBe(1);
  });

  it('submit_findings badge_label and column_flow note project their ceilings', () => {
    expect(at(submitFindings, ['badge_label']).maxLength).toBe(SUBMIT_FINDINGS_BADGE_LABEL_MAX);
    expect(at(submitFindings, ['badge_label']).minLength, 'the non-empty floor is structural').toBe(1);
    expect(at(submitFindingsCt, ['column_flow', '[]', 'upstream_columns', '[]', 'note']).maxLength).toBe(COLUMN_FLOW_NOTE_MAX);
    expect(at(toModelJsonSchema(SubmitFindingsModelSchema) as Node, ['badge_label']).maxLength,
      'the registered union advertises the same ceiling').toBe(SUBMIT_FINDINGS_BADGE_LABEL_MAX);
  });

  it('a cap projects the same keyword and value whether declared with .max() or advertised', () => {
    // The mechanism itself, isolated, for both projected types.
    expect(toModelJsonSchema(z.string().meta({ maxLength: 90 }))).toEqual(toModelJsonSchema(z.string().max(90)));
    expect(toModelJsonSchema(z.array(z.string()).meta({ maxItems: 5 }))).toEqual(toModelJsonSchema(z.array(z.string()).max(5)));
  });
});

describe('advertised caps — no schema on the dispatch path parses one', () => {
  const presentPayload = (over: Record<string, unknown>) => ({
    name: 'ok',
    summary: 'One-line purpose.',
    sections: [{ label: 'Result', text: 'Grounded detail.' }],
    highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
    ...over,
  });
  const hopPayload = (over: Record<string, unknown>) => ({
    focus_node_id: 'origin',
    sections: [{ angle: 'business', text: 'Grounded.' }],
    summary: 'One line.',
    verdict: 'analyze',
    ...over,
  });

  it('every present_result stage projection accepts an over-size value', () => {
    const overSize = presentPayload({
      name: 'n'.repeat(PRESENT_RESULT_NAME_MAX + 1),
      title: 't'.repeat(PRESENT_RESULT_TITLE_MAX + 1),
      sections: [{ label: 'L'.repeat(PRESENT_RESULT_SECTION_LABEL_MAX + 1), text: 'x' }],
      highlight_groups: Array.from({ length: PRESENT_RESULT_HIGHLIGHT_GROUPS_MAX + 1 }, () => ({
        label: 'H'.repeat(PRESENT_RESULT_HIGHLIGHT_LABEL_MAX + 1), color: 'source', node_ids: ['a'],
      })),
    });
    expect(PresentResultModelSchema.safeParse(overSize).success, 'the completed-stage schema').toBe(true);
    expect(PresentResultSynthesisModelSchema.safeParse(overSize).success, 'the synthesis-stage schema').toBe(true);
    const { summary: _prose, ...repairable } = overSize;
    expect(presentResultRepairPatchSchemaForFields(['name', 'title', 'sections', 'highlight_groups'])
      .safeParse({ is_update: true, ...repairable }).success,
      'the held-draft repair patch, so a repair turn is never rejected for the size it is repairing').toBe(true);
  });

  it('every submit_findings mode form accepts an over-size value', () => {
    const longLabel = 'b'.repeat(SUBMIT_FINDINGS_BADGE_LABEL_MAX + 1);
    const longNote = 'n'.repeat(COLUMN_FLOW_NOTE_MAX + 1);
    expect(SubmitFindingsBbInputSchema.safeParse(hopPayload({ badge_label: longLabel })).success, 'BB').toBe(true);
    expect(SubmitFindingsModelSchema.safeParse(hopPayload({ badge_label: longLabel })).success, 'the registered union').toBe(true);
    expect(SubmitFindingsCtInputSchema.safeParse(hopPayload({
      badge_label: longLabel,
      column_flow: [{ out_col: 'amount', upstream_columns: [{ node: 'n', col: 'c', note: longNote }] }],
    })).success, 'CT').toBe(true);
  });

  it('structural constraints still reject: an empty or whitespace-only badge_label', () => {
    expect(SubmitFindingsBbInputSchema.safeParse(hopPayload({ badge_label: '' })).success).toBe(false);
    expect(SubmitFindingsBbInputSchema.safeParse(hopPayload({ badge_label: '   ' })).success).toBe(false);
  });
});
