/** Owns toolSchemas.ts presentation shape, JSON Schema projection and report-label constraints. */
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PresentResultModelSchema, normalizePresentSectionLabel, presentResultSchemaForPhase } from '../../../src/ai/tools/toolSchemas';
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

  it('rejects the normalized duplicate at the exact second label path', () => {
    expect(normalizePresentSectionLabel(labelDraft.sections![0]!.label)).toBe('source alpha');
    const parsed = PresentResultModelSchema.safeParse(labelDraft);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['sections', 1, 'label'], message: expect.stringContaining('Duplicate section label') })]));
  });
  it.each(['synthesis', 'visual_preview', 'completed'])('keeps full stage shape and excludes retired repair grammar in %s (D-098/D-101)', stage => {
    const schema = presentResultSchemaForPhase(stage, false, 2);
    const projected = toModelJsonSchema(schema) as { properties: Record<string, unknown> };
    expect(Object.keys(projected.properties)).toEqual(expect.arrayContaining(['name', 'sections', 'highlight_groups', 'notes']));
    const entry = stage === 'visual_preview' ? { start: 'B1' } : { text: 'Full section body.' };
    const payload = { ...resultWith([{ label: 'Source', color: 'source', node_ids: [nodeId] }]), sections: [{ label: 'Source', node_ids: [nodeId], ...entry }] };
    if (stage === 'visual_preview') delete (payload as Record<string, unknown>).summary;
    expect(schema.safeParse(payload).success).toBe(true);
    expect(schema.safeParse({ ...payload, sections: [{ ...payload.sections[0], index: 0, remove: true }] }).success).toBe(false);
  });
});
