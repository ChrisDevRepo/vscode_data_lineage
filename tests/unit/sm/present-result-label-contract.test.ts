/** Advertised report-label identity matches the enforced normalization without changing CS source identities. */
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { PresentResultModelSchema, normalizePresentSectionLabel, presentResultRepairPatchSchemaForFields } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { holdRejectedPresentResult, mergePresentResultRepairPatch, type PresentResultInput, type PresentResultRepairAuthorization } from '../../../src/ai/tools/presentResult';
import { RepairDraftStore } from '../../../src/ai/support/repairDraftStore';
const upper = '[scope].[Object]', lower = '[scope].[object]';
const draft = { name: 'Pair', summary: 'Distinct sources.', highlight_groups: [{ label: 'Sources', color: 'source', node_ids: [upper, lower] }], sections: [
  { label: 'Source   Alpha', text: 'Upper source.', node_ids: [upper] },
  { label: ' source alpha ', text: 'Lower source.', node_ids: [lower] },
] } as PresentResultInput;
describe('report-label normalization contract', () => {
  it.each(['synthesis', 'visual_preview'] as const)('serves exclusive delete or edit patches in %s', stage => {
    const schema = presentResultRepairPatchSchemaForFields(['sections'], stage, stage === 'visual_preview' ? 2 : 0);
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(schema));
    const edit = stage === 'visual_preview' ? { start: 'B1' } : { text: 'Corrected detail.' };
    for (const entry of [{ label: 'Source', remove: true }, { label: 'Source', ...edit }, { label: 'Source', node_ids: [upper] }]) {
      expect(schema.safeParse({ sections: [entry] }).success).toBe(true);
      expect(wire({ sections: [entry] })).toBe(true);
    }
    for (const entry of [{ label: 'Source', remove: true, ...edit }, { label: 'Source', remove: true, node_ids: [upper] }]) {
      expect(schema.safeParse({ sections: [entry] }).success).toBe(false);
      expect(wire({ sections: [entry] })).toBe(false);
    }
  });

  it('rejects the normalized duplicate at the exact second label path', () => {
    expect(normalizePresentSectionLabel(draft.sections![0]!.label)).toBe('source alpha');
    const parsed = PresentResultModelSchema.safeParse(draft);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['sections', 1, 'label'], message: expect.stringContaining('Duplicate section label') })]));
  });
  it('authorizes only the rejected indexed label, retaining source IDs and factual text', () => {
    const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
    holdRejectedPresentResult(store, draft, ['sections.1.label'], 'synthesis');
    const auth = store.getAuthorization()!;
    expect(auth.sectionTextLeaves).toEqual([{ index: 1, fields: ['label'] }]);
    const schema = presentResultRepairPatchSchemaForFields(auth.fields, 'synthesis', 0, auth.highlightLabelIndexes, auth.sectionTextLeaves);
    expect(schema.safeParse({ sections: [{ index: 0, label: 'Wrong' }] }).success).toBe(false);
    expect(schema.safeParse({ sections: [{ index: 1, label: 'Source Beta', text: 'Rewrite' }] }).success).toBe(false);
    const merged = mergePresentResultRepairPatch(store.get()!, schema.parse({ sections: [{ index: 1, label: 'Source Beta' }] }), auth);
    expect(merged.sections![0]).toEqual(draft.sections![0]);
    expect(merged.sections![1]).toEqual({ ...draft.sections![1], label: 'Source Beta' });
    expect(merged.sections!.map(section => section.node_ids)).toEqual([[upper], [lower]]);
    expect(PresentResultModelSchema.safeParse(merged).success).toBe(true);
  });
  it('advertises the same normalization in the indexed label repair schema', () => {
    const schema = presentResultRepairPatchSchemaForFields(['sections'], 'synthesis', 0, undefined, [{ index: 1, fields: ['label'] }]);
    const projected = toModelJsonSchema(schema) as { properties: { sections: { items: { properties: { label: { description: string } } } } } };
    const description = projected.properties.sections.items.properties.label.description;
    expect(description).toMatch(/lowercas|case.insensitive/i);
    expect(description).toMatch(/trimm/i);
    expect(description).toMatch(/whitespace.*collaps|collaps.*whitespace/i);
  });
});
