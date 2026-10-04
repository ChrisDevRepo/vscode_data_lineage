/** Pins present-result highlight groups as complete, structurally validated presentation data. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PresentResultModelSchema,
  presentResultRepairPatchSchemaForFields,
} from '../../../src/ai/tools/toolSchemas';
import {
  holdRejectedPresentResult,
  mergePresentResultRepairPatch,
  type PresentResultInput,
  type PresentResultRepairAuthorization,
} from '../../../src/ai/tools/presentResult';
import { RepairDraftStore } from '../../../src/ai/support/repairDraftStore';

const nodeId = '[dbo].[Result]';

function resultWith(highlightGroups: unknown) {
  return {
    name: 'Result lineage',
    summary: 'Shows how the result is produced.',
    highlight_groups: highlightGroups,
    sections: [{ label: 'Result', node_ids: [nodeId], text: 'The requested result.' }],
  };
}

describe('present-result highlight schema', () => {
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

  it('accepts 60 trimmed characters whole and rejects 61', () => {
    const sixty = 'x'.repeat(60);
    const accepted = PresentResultModelSchema.parse(resultWith([
      { label: `  ${sixty}  `, color: 'source', node_ids: [nodeId] },
    ]));

    expect(accepted.highlight_groups[0]?.label).toBe(sixty);
    expect(PresentResultModelSchema.safeParse(resultWith([
      { label: 'x'.repeat(61), color: 'source', node_ids: [nodeId] },
    ])).success).toBe(false);
  });

  it.each([
    ['an empty group list', []],
    ['a blank label', [{ label: '   ', color: 'source', node_ids: [nodeId] }]],
    ['an unknown color', [{ label: 'Result', color: 'unknown', node_ids: [nodeId] }]],
    ['a missing node_ids field', [{ label: 'Result', color: 'target' }]],
  ])('rejects %s', (_name, highlightGroups) => {
    expect(PresentResultModelSchema.safeParse(resultWith(highlightGroups)).success).toBe(false);
  });

  it('advertises an unbounded group count and the readable label boundary', () => {
    const schema = z.toJSONSchema(PresentResultModelSchema, { io: 'input' });
    const highlightGroups = schema.properties?.highlight_groups as {
      items?: { properties?: { label?: Record<string, unknown> } };
      maxItems?: number;
      minItems?: number;
    };

    expect(highlightGroups.minItems).toBe(1);
    expect(highlightGroups).not.toHaveProperty('maxItems');
    expect(highlightGroups.items?.properties?.label).toHaveProperty('maxLength', 60);
  });

  it('serves the same label boundary without a group cap on held-draft repairs', () => {
    const repairSchema = presentResultRepairPatchSchemaForFields(['highlight_groups']);
    const sixty = 'x'.repeat(60);
    const groups = Array.from({ length: 6 }, (_, index) => ({
      label: index === 0 ? ` ${sixty} ` : `Group ${index + 1}`,
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
    }).success).toBe(false);

    const schema = z.toJSONSchema(repairSchema, { io: 'input' });
    const field = schema.properties?.highlight_groups as {
      items?: { properties?: { label?: Record<string, unknown> } };
      maxItems?: number;
    };
    expect(field).not.toHaveProperty('maxItems');
    expect(field.items?.properties?.label).toHaveProperty('maxLength', 60);
  });

  it('repairs only rejected label leaves and preserves held group identity', () => {
    const draft = resultWith([
      { label: 'x'.repeat(61), color: 'source', node_ids: ['source'] },
      { label: 'Transforms', color: 'transform', node_ids: ['middle'] },
      { label: 'y'.repeat(62), color: 'target', node_ids: ['target'] },
    ]) as PresentResultInput;
    const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
    const instruction = holdRejectedPresentResult(
      store,
      draft,
      ['highlight_groups.0.label', 'highlight_groups.2.label'],
      'synthesis',
    );
    const authorization = store.getAuthorization()!;
    const schema = presentResultRepairPatchSchemaForFields(
      authorization.fields,
      'synthesis',
      0,
      authorization.highlightLabelIndexes,
    );
    const servedSchema = z.toJSONSchema(schema, { io: 'input' });
    const servedItems = (servedSchema.properties?.highlight_groups as {
      items?: {
        anyOf?: Array<{
          properties?: { index?: { const?: number } };
          required?: string[];
        }>;
      };
    }).items;

    expect(instruction).toContain('only the offending text is replaceable');
    expect(servedItems?.anyOf?.map(item => item.properties?.index?.const)).toEqual([0, 2]);
    expect(servedItems?.anyOf?.map(item => item.required)).toEqual([
      ['index', 'label'],
      ['index', 'label'],
    ]);
    expect(schema.safeParse({ highlight_groups: draft.highlight_groups }).success).toBe(false);
    expect(schema.safeParse({ highlight_groups: [
      { index: 0, label: 'Sources' },
      { index: 1, label: 'Unauthorized' },
    ] }).success).toBe(false);
    const patch = schema.parse({ highlight_groups: [
      { index: 0, label: 'Sources' },
      { index: 2, label: 'Target' },
    ] });
    const merged = mergePresentResultRepairPatch(store.get()!, patch, authorization);

    expect(merged.highlight_groups).toEqual([
      { label: 'Sources', color: 'source', node_ids: ['source'] },
      { label: 'Transforms', color: 'transform', node_ids: ['middle'] },
      { label: 'Target', color: 'target', node_ids: ['target'] },
    ]);
    expect(merged.sections).toBe(draft.sections);
  });

  it('keeps label leaves narrow when another text field also needs repair', () => {
    const draft = {
      ...resultWith([{ label: 'x'.repeat(61), color: 'source', node_ids: [nodeId] }]),
      title: 't'.repeat(121),
    } as PresentResultInput;
    const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
    holdRejectedPresentResult(store, draft, ['title', 'highlight_groups.0.label'], 'synthesis');
    const authorization = store.getAuthorization()!;
    const schema = presentResultRepairPatchSchemaForFields(
      authorization.fields,
      'synthesis',
      0,
      authorization.highlightLabelIndexes,
    );

    expect(store.get()?.highlight_groups).toEqual(draft.highlight_groups);
    expect(store.get()?.title).toBeUndefined();
    expect(schema.safeParse({ highlight_groups: [{ index: 0, label: 'Sources' }] }).success).toBe(false);
    const patch = schema.parse({
      title: 'Result lineage',
      highlight_groups: [{ index: 0, label: 'Sources' }],
    });
    expect(mergePresentResultRepairPatch(store.get()!, patch, authorization)).toMatchObject({
      title: 'Result lineage',
      highlight_groups: [{ label: 'Sources', color: 'source', node_ids: [nodeId] }],
    });
  });

  it('repairs only rejected section text leaves and preserves section identity', () => {
    const draft = {
      ...resultWith([{ label: 'Sources', color: 'source', node_ids: [nodeId] }]),
      sections: [
        { label: 'Sources', node_ids: ['source'], text: '   ' },
        { label: 'Transformations', node_ids: ['middle'], text: 'Existing detail.' },
      ],
    } as PresentResultInput;
    const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
    const instruction = holdRejectedPresentResult(store, draft, ['sections.0.text'], 'synthesis');
    const authorization = store.getAuthorization()!;
    const schema = presentResultRepairPatchSchemaForFields(
      authorization.fields,
      'synthesis',
      0,
      authorization.highlightLabelIndexes,
      authorization.sectionTextLeaves,
    );

    expect(instruction).toContain('one indexed object containing exactly the listed replacement field or fields');
    expect(instruction).not.toContain('resend every section');
    expect(store.get()?.sections).toEqual(draft.sections);
    expect(schema.safeParse({ sections: draft.sections }).success).toBe(false);
    expect(schema.safeParse({ sections: [{ index: 1, text: 'Wrong index.' }] }).success).toBe(false);
    const patch = schema.parse({ sections: [{ index: 0, text: 'Source detail.' }] });
    const merged = mergePresentResultRepairPatch(store.get()!, patch, authorization);
    expect(merged.sections).toEqual([
      { label: 'Sources', node_ids: ['source'], text: 'Source detail.' },
      draft.sections?.[1],
    ]);
    expect(merged.sections?.[1]).toBe(draft.sections?.[1]);
    expect(merged.highlight_groups).toBe(draft.highlight_groups);
    expect(draft.sections?.[0]?.text).toBe('   ');
  });

  it('repairs mixed rejected leaves in one transaction without exposing either full list', () => {
    const draft = {
      ...resultWith([
        { label: 'x'.repeat(61), color: 'source', node_ids: ['source'] },
        { label: 'Target', color: 'target', node_ids: ['target'] },
      ]),
      sections: [
        { label: 'z'.repeat(91), node_ids: ['source'], text: '   ' },
        { label: 'Target', node_ids: ['target'], text: 'Existing target detail.' },
      ],
    } as PresentResultInput;
    const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
    holdRejectedPresentResult(
      store,
      draft,
      ['highlight_groups.0.label', 'sections.0.label', 'sections.0.text'],
      'synthesis',
    );
    const authorization = store.getAuthorization()!;
    const schema = presentResultRepairPatchSchemaForFields(
      authorization.fields,
      'synthesis',
      0,
      authorization.highlightLabelIndexes,
      authorization.sectionTextLeaves,
    );

    expect(schema.safeParse({
      highlight_groups: [{ index: 0, label: 'Sources' }],
      sections: [{ index: 0, label: 'Sources' }],
    }).success).toBe(false);
    expect(schema.safeParse({
      highlight_groups: draft.highlight_groups,
      sections: draft.sections,
    }).success).toBe(false);
    const patch = schema.parse({
      highlight_groups: [{ index: 0, label: 'Sources' }],
      sections: [{ index: 0, label: 'Sources', text: 'Source detail.' }],
    });
    const merged = mergePresentResultRepairPatch(store.get()!, patch, authorization);

    expect(merged.highlight_groups).toEqual([
      { label: 'Sources', color: 'source', node_ids: ['source'] },
      draft.highlight_groups?.[1],
    ]);
    expect(merged.sections).toEqual([
      { label: 'Sources', node_ids: ['source'], text: 'Source detail.' },
      draft.sections?.[1],
    ]);
    expect(merged.highlight_groups?.[1]).toBe(draft.highlight_groups?.[1]);
    expect(merged.sections?.[1]).toBe(draft.sections?.[1]);
  });

  it('does not authorize a leaf transaction from malformed or out-of-range issue paths', () => {
    const draft = resultWith([{ label: 'Sources', color: 'source', node_ids: [nodeId] }]) as PresentResultInput;
    const malformed = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
    const outOfRange = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();

    expect(holdRejectedPresentResult(malformed, draft, ['sections.bad.text'], 'synthesis')).toContain('resend every section');
    expect(malformed.getAuthorization()?.sectionTextLeaves).toBeUndefined();
    expect(malformed.get()?.sections).toBeUndefined();
    expect(holdRejectedPresentResult(outOfRange, draft, ['highlight_groups.9.label'], 'synthesis')).toContain('every field except highlight_groups');
    expect(outOfRange.getAuthorization()?.highlightLabelIndexes).toBeUndefined();
    expect(outOfRange.get()?.highlight_groups).toBeUndefined();
  });
});
