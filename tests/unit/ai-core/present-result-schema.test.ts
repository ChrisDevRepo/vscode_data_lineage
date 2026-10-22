/** Owns toolSchemas.ts presentation shape, JSON Schema projection and report-label constraints. */
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PresentResultModelSchema, normalizePresentSectionLabel, presentResultRepairPatchSchemaForFields } from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import type { PresentResultInput } from '../../../src/ai/tools/presentResult';

const nodeId = '[dbo].[Result]';

function resultWith(highlightGroups: unknown) {
  return {
    name: 'Result lineage',
    summary: 'Shows how the result is produced.',
    highlight_groups: highlightGroups,
    sections: [{ label: 'Result', node_ids: [nodeId], text: 'The requested result.' }],
  };
}

const upper = '[scope].[Object]', lower = '[scope].[object]';
const labelDraft = { name: 'Pair', summary: 'Distinct sources.', highlight_groups: [{ label: 'Sources', color: 'source', node_ids: [upper, lower] }], sections: [
  { label: 'Source   Alpha', text: 'Upper source.', node_ids: [upper] },
  { label: ' source alpha ', text: 'Lower source.', node_ids: [lower] },
] } as PresentResultInput;

describe('present-result schema and provider contract', () => {
  it('preserves authored whitespace instead of trimming valid content', () => {
    const payload = { ...resultWith([{ label: ' Sources ', color: 'source', node_ids: [nodeId] }]),
      name: ' Result ', summary: ' Summary. ', sections: [{ label: ' Detail ', text: ' Body. ', node_ids: [nodeId] }] };
    expect(PresentResultModelSchema.parse(payload)).toEqual(payload);
  });

  it('delivers every structurally valid group without a group-count cap', () => {
    const highlightGroups = Array.from({ length: 6 }, (_, index) => ({
      label: `Group ${index + 1}`,
      color: index % 2 === 0 ? 'source' : 'transform',
      node_ids: [nodeId],
    }));

    const parsed = PresentResultModelSchema.parse(resultWith(highlightGroups));

    expect(parsed.highlight_groups).toHaveLength(6);
    expect(parsed.highlight_groups.map(group => group.label)).toEqual(
      highlightGroups.map(group => group.label),
    );
  });

  it('accepts long section labels unchanged in final reports and repairs', () => {
    const text = 'x'.repeat(2000);
    const input = { ...resultWith([{ label: ` ${text} `, color: 'source', node_ids: [nodeId] }]), name: text, title: text };
    const wire = new Ajv({ strict: false }).compile(toModelJsonSchema(PresentResultModelSchema));
    expect(PresentResultModelSchema.parse(input)).toEqual(input);
    expect(wire(input)).toBe(true);
    const badge = { ...input, sections: [{ label: 'x'.repeat(91), node_ids: [nodeId], text }] };
    expect(PresentResultModelSchema.parse(badge)).toEqual(badge);
    expect(wire(badge)).toBe(true);
    const patch = { sections: badge.sections };
    const repair = presentResultRepairPatchSchemaForFields(['sections']);
    expect(repair.parse(patch)).toEqual(patch);
    expect(new Ajv({ strict: false }).compile(toModelJsonSchema(repair))(patch)).toBe(true);
  });

  it.each([
    ['a blank label', [{ label: '   ', color: 'source', node_ids: [nodeId] }]],
    ['an unknown color', [{ label: 'Result', color: 'unknown', node_ids: [nodeId] }]],
    ['a missing node_ids field', [{ label: 'Result', color: 'target' }]],
  ])('rejects %s', (_name, highlightGroups) => {
    expect(PresentResultModelSchema.safeParse(resultWith(highlightGroups)).success).toBe(false);
  });

  it('advertises an unbounded group count and legend text', () => {
    const schema = z.toJSONSchema(PresentResultModelSchema, { io: 'input' });
    const highlightGroups = schema.properties?.highlight_groups as {
      items?: { properties?: { label?: Record<string, unknown> } };
      maxItems?: number;
      minItems?: number;
    };

    expect(highlightGroups.minItems).toBe(1);
    expect(highlightGroups).not.toHaveProperty('maxItems');
    expect(highlightGroups.items?.properties?.label).not.toHaveProperty('maxLength');
  });

  it('preserves long legend text without a group cap on held-draft repairs', () => {
    const repairSchema = presentResultRepairPatchSchemaForFields(['highlight_groups']);
    const sixty = 'x'.repeat(60);
    const groups = Array.from({ length: 6 }, (_, index) => ({
      label: index === 0 ? sixty : `Group ${index + 1}`,
      color: 'source' as const,
      node_ids: [nodeId],
    }));

    const repaired = repairSchema.safeParse({ highlight_groups: groups });
    expect(repaired.success).toBe(true);
    if (repaired.success) {
      expect(repaired.data.highlight_groups?.map(group => group.label)).toEqual([
        sixty,
        ...groups.slice(1).map(group => group.label),
      ]);
    }
    expect(repairSchema.safeParse({
      highlight_groups: [{ label: 'x'.repeat(61), color: 'source', node_ids: [nodeId] }],
    }).success).toBe(true);

    const schema = z.toJSONSchema(repairSchema, { io: 'input' });
    const field = schema.properties?.highlight_groups as {
      items?: { properties?: { label?: Record<string, unknown> } };
      maxItems?: number;
    };
    expect(field).not.toHaveProperty('maxItems');
    expect(field.items?.properties?.label).not.toHaveProperty('maxLength');
  });

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
    expect(normalizePresentSectionLabel(labelDraft.sections![0]!.label)).toBe('source alpha');
    const parsed = PresentResultModelSchema.safeParse(labelDraft);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['sections', 1, 'label'], message: expect.stringContaining('Duplicate section label') })]));
  });
  it('advertises the same normalization in the indexed label repair schema', () => {
    const schema = presentResultRepairPatchSchemaForFields(['sections'], 'synthesis', 0, undefined, [{ index: 1, fields: ['label'] }]);
    const projected = toModelJsonSchema(schema) as { properties: { sections: { items: { properties: { label: { description: string } } } } } };
    const description = projected.properties.sections.items.properties.label.description;
    expect(description).toMatch(/lowercas|case.insensitive/i);
    expect(description).toMatch(/trimm/i);
    expect(description).toMatch(/whitespace.*collaps|collaps.*whitespace/i);
  });
  it('serves the text constraint on a repair section entry where the model decides the field', () => {
    const schema = presentResultRepairPatchSchemaForFields(['sections'], 'synthesis', 0);
    const projected = toModelJsonSchema(schema) as { properties: { sections: { items: { anyOf: Array<{ properties: { text?: { description: string } } }> } } } };
    const description = projected.properties.sections.items.anyOf[0]!.properties.text!.description;
    expect(description).toBe("Detail body for this section label. Required when the label is not a held label; omit to keep a held label's text.");
  });
});
