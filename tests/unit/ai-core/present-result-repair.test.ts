/** Owns presentResult.ts draft holding, repair authorization and pure keyed/indexed merges. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RepairDraftStore } from '../../../src/ai/support/repairDraftStore';
import { rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import { holdRejectedPresentResult, mergePresentResultRepairPatch, validatePresentResult,
  type PresentResultInput, type PresentResultRepairAuthorization, type PresentResultRepairPatch } from '../../../src/ai/tools/presentResult';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { PresentResultModelSchema, presentResultRepairPatchSchemaForFields, presentResultSchemaForPhase } from '../../../src/ai/tools/toolSchemas';

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
const render = {
  name: 'Orders lineage', summary: 'How Orders is produced.',
  highlight_groups: [{ label: 'Sources', color: 'source', node_ids: ['dbo.a'] }],
  sections: [{ label: 'Sources', node_ids: ['dbo.a'], text: 'Reads dbo.a.' }],
};

describe('held present_result fields', () => {
  it.each(['synthesis', 'completed', 'visual_preview'])('offers only authorized sections in %s repair', stage => {
    const schema = presentResultRepairPatchSchemaForFields(['sections'], stage, 1);
    expect(Object.keys((toModelJsonSchema(schema) as any).properties)).toEqual(['sections']);
    const correction = { sections: [{ label: 'Sources', node_ids: [nodeId], ...(stage === 'visual_preview' ? { start: 'B1' } : { text: 'Corrected body.' }) }] };
    expect(schema.safeParse(correction).success).toBe(true);
    for (const field of ['name', 'summary', 'title', 'intro', 'closing', 'layout_direction', 'highlight_groups', 'notes', 'is_update']) {
      expect(schema.safeParse({ ...correction, [field]: field === 'is_update' ? true : 'Unrequested' }).success, field).toBe(false);
    }
  });

  it('repairs malformed section links without resending large held bodies', () => {
    const body = 'SQL-supported explanation. '.repeat(5000);
    const report = { ...render, sections: [
      { label: 'Sources', node_ids: [42], text: body },
      { label: 'Operations', node_ids: [], text: body },
    ] };
    const parsed = PresentResultModelSchema.safeParse(report);
    expect(parsed.success).toBe(false);
    const rejection = rejectionFromZodError(parsed.error!, { code: 'invalid_input', input: report, schema: PresentResultModelSchema });
    const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
    const hint = holdRejectedPresentResult(store, report, rejection.issuePaths!, 'synthesis');
    expect(store.get()?.sections).toEqual(report.sections);
    const auth = store.getAuthorization()!;
    const schema = presentResultRepairPatchSchemaForFields(auth.fields, 'synthesis', 0, auth.highlightLabelIndexes, auth.sectionLeaves);
    const patch = { sections: [{ index: 0, node_ids: ['dbo.a'] }] };
    expect(schema.safeParse(patch).success).toBe(true);
    expect(schema.safeParse({ sections: [{ ...patch.sections[0], text: 'Unrequested rewrite' }] }).success).toBe(false);
    const merged = mergePresentResultRepairPatch(store.get()!, schema.parse(patch), auth);
    expect(merged.sections).toEqual([{ ...report.sections[0], node_ids: ['dbo.a'] }, report.sections[1]]);
    expect(PresentResultModelSchema.safeParse(merged).success).toBe(true);
    expect(hint).not.toContain(body);
    expect(JSON.stringify(patch).length * 100).toBeLessThan(JSON.stringify(report).length);
  });

  it.each([
    ['correcting the optional field', { title: 'Orders lineage' }],
    ['withdrawing the optional field with an empty patch', {}],
  ])('repairs a large held report by %s', (_label, patch) => {
    const report = {
      ...render,
      title: 42 as unknown as string,
      intro: 'Intro. '.repeat(200),
      closing: 'Closing. '.repeat(200),
      sections: Array.from({ length: 6 }, (_, index) => ({ label: `Section ${index}`, node_ids: ['dbo.a'], text: 'Body. '.repeat(5000) })),
      notes: [{ node_id: 'dbo.a', caption: 'A caption.' }],
    };
    const parsed = PresentResultModelSchema.safeParse(report);
    const rejection = rejectionFromZodError(parsed.error!, { code: 'invalid_input', input: report, schema: PresentResultModelSchema });
    expect(rejection.issuePaths).toEqual(['title']);
    const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
    const sentence = holdRejectedPresentResult(store, report, rejection.issuePaths ?? [], 'synthesis');
    expect(sentence).toContain('only these corrected fields: title');
    expect(sentence).not.toContain('Resend the full tool call');
    expect(sentence).not.toContain(report.sections[0].text);
    const authorization = store.getAuthorization()!;
    expect(presentResultRepairPatchSchemaForFields(authorization.fields, 'synthesis').safeParse(patch).success).toBe(true);
    const merged = mergePresentResultRepairPatch(store.get()!, patch, authorization);
    const { title: _invalidTitle, ...validReport } = report;
    expect(merged).toEqual({ ...validReport, ...patch });
    expect(PresentResultModelSchema.safeParse(merged).success).toBe(true);
  });
});

const source = '[stage].[orders]';
const target = '[mart].[orders]';

function holdGarbledCall() {
  const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
  const garbled = {
    name: 'Orders lineage', summary: 'Orders from stage to mart.', title: 'Orders', intro: 'How orders load.',
    sections: 'Stage <parameter name="text">Raw orders.',
    label: 'Stage', node_ids: [source],
  };
  const schema = presentResultSchemaForPhase('synthesis', null, false);
  const parsed = schema.safeParse(garbled);
  expect(parsed.success).toBe(false);
  const rejection = rejectionFromZodError(parsed.error!, { code: REJECTION_CODES.invalidInput, input: garbled, schema });
  const hint = holdRejectedPresentResult(store, garbled, rejection.issuePaths ?? [], 'synthesis');
  return { store, hint, issuePaths: rejection.issuePaths ?? [] };
}

it('holds the valid fields of a call that also carries keys the tool does not define', () => {
  const { store, hint, issuePaths } = holdGarbledCall();

  expect(issuePaths).toEqual(expect.arrayContaining(['label', 'node_ids', 'sections', 'highlight_groups']));
  expect(hint).not.toBeNull();
  expect(store.get()).toEqual({ name: 'Orders lineage', summary: 'Orders from stage to mart.', title: 'Orders', intro: 'How orders load.' });
  expect([...store.getAuthorization()!.fields].sort()).toEqual(['highlight_groups', 'sections']);
});

it('rejects unrequested report fields and merges only the authorized repair', () => {
  const { store } = holdGarbledCall();
  const authorization = store.getAuthorization()!;
  const repair = {
    highlight_groups: [{ label: 'Source', color: 'source' as const, node_ids: [source] }],
    sections: [
      { label: 'Stage', node_ids: [source], text: 'Raw orders.' },
      { label: 'Mart', node_ids: [target], text: 'Reporting orders.' },
    ],
    notes: [{ node_id: target, caption: 'Loaded nightly.' }],
    closing: 'Orders flow from stage to mart.',
  };

  const held = structuredClone(store.get());
  const schema = presentResultSchemaForPhase('synthesis', authorization.fields, false);
  expect(schema.safeParse(repair).success).toBe(false);
  expect(() => mergePresentResultRepairPatch(store.get()!, repair, authorization)).toThrow('Unauthorized present_result repair field: notes');
  expect(() => mergePresentResultRepairPatch(store.get()!, { is_update: true }, authorization)).toThrow('Unauthorized present_result repair field: is_update');
  expect(store.get()).toEqual(held);
  const { notes: _notes, closing: _closing, ...correction } = repair;
  const merged = mergePresentResultRepairPatch(store.get()!, schema.parse(correction) as PresentResultRepairPatch, authorization);
  expect(merged.name).toBe('Orders lineage');
  expect(merged.closing).toBeUndefined();
  expect(merged.notes).toBeUndefined();
  expect(merged.sections?.map(section => section.label)).toEqual(['Stage', 'Mart']);
  expect(merged.highlight_groups).toHaveLength(1);
});

it('still refuses a graph edit the rejection did not authorize', () => {
  const { store } = holdGarbledCall();
  const authorization = store.getAuthorization()!;
  const repair = {
    highlight_groups: [{ label: 'Source', color: 'source', node_ids: [source] }],
    sections: [{ label: 'Stage', node_ids: [source], text: 'Raw orders.' }],
    prune_node_ids: [target],
  };

  expect(presentResultSchemaForPhase('synthesis', authorization.fields, false).safeParse(repair).success).toBe(false);
  expect(() => mergePresentResultRepairPatch(store.get()!, repair as PresentResultRepairPatch, authorization)).toThrow('prune_node_ids');
});

it('holds nothing when only undefined keys failed', () => {
  const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();

  expect(holdRejectedPresentResult(store, { name: 'Orders lineage', label: 'Stage' }, ['label'], 'synthesis')).toBeNull();
  expect(store.get()).toBeFalsy();
});

it('merges a notes repair by node id: one missing caption is one resent entry', () => {
  const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
  const stale = '[mart].[retired]';
  store.hold({
    name: 'Orders lineage', summary: 'Orders from stage to mart.',
    highlight_groups: [{ label: 'Source', color: 'source', node_ids: [source] }],
    sections: [{ label: 'Stage', node_ids: [source], text: 'Raw orders.' }],
    notes: [{ node_id: source, caption: 'Landed hourly.' }, { node_id: stale, caption: 'Dropped object.' }],
  } as PresentResultInput, { fields: ['notes'] });
  const authorization = store.getAuthorization()!;
  const repair = { notes: [{ node_id: 'mart.orders', caption: 'Loaded nightly.' }, { node_id: stale, remove: true }] };

  const parsed = presentResultSchemaForPhase('synthesis', authorization.fields, false).safeParse(repair);
  expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);

  const merged = mergePresentResultRepairPatch(store.get()!, parsed.data as PresentResultRepairPatch, authorization);
  expect(merged.notes).toEqual([{ node_id: source, caption: 'Landed hourly.' }, { node_id: 'mart.orders', caption: 'Loaded nightly.' }]);
});

it('merges notes by case only when the model folds identifier case', () => {
  const draft = { name: 'n', summary: 's', notes: [{ node_id: '[mart].[Orders]', caption: 'Upper.' }] } as PresentResultInput;
  const patch = { notes: [{ node_id: '[mart].[orders]', caption: 'Lower.' }] } as PresentResultRepairPatch;
  const authorization = { fields: ['notes'] } as PresentResultRepairAuthorization;

  expect(mergePresentResultRepairPatch(draft, patch, authorization).notes)
    .toEqual([{ node_id: '[mart].[orders]', caption: 'Lower.' }]);
  expect(mergePresentResultRepairPatch(draft, patch, authorization, true).notes)
    .toEqual([{ node_id: '[mart].[Orders]', caption: 'Upper.' }, { node_id: '[mart].[orders]', caption: 'Lower.' }]);
});

it.each([
  ['[a.b].[c]', '[a].[b.c]'],
  ['[dbo].[ab]', '[dbo].[a[b]'],
])('keeps distinct quoted note identities %s and %s during repair', (heldId, repairedId) => {
  const held = { node_id: heldId, caption: 'Keep this caption.' };
  const repaired = { node_id: repairedId, caption: 'Corrected caption.' };
  const draft = { name: 'n', summary: 's', notes: [held] } as PresentResultInput;
  const patch = { notes: [repaired] } as PresentResultRepairPatch;
  expect(mergePresentResultRepairPatch(draft, patch, { fields: ['notes'] }).notes)
    .toEqual([held, repaired]);
});

it('names the list a flattened entry key belongs to', () => {
  const garbled = {
    name: 'Orders lineage', summary: 'Orders from stage to mart.',
    highlight_groups: [{ label: 'Source', color: 'source', node_ids: [source] }],
    sections: [{ label: 'Stage', node_ids: [source], text: 'Raw orders.' }],
    text: 'Raw orders.',
  };
  const schema = presentResultSchemaForPhase('synthesis', null, false);
  const rejection = rejectionFromZodError(schema.safeParse(garbled).error!, { code: REJECTION_CODES.invalidInput, input: garbled, schema });

  expect(rejection.hint).toContain('"text" is a field of a sections[] entry: send it there.');
});


describe('unknown repair keys', () => {
  it.each([
    ['a key with a space', 'node ids'],
    ['a key longer than the path grammar admits', 'k'.repeat(130)],
  ])('never holds %s across complete and missing-field calls', (_label, key) => {
    for (const complete of [true, false]) {
      const input = complete ? { ...render, title: 42 as unknown as string, [key]: ['dbo.a'] }
        : { name: 'Orders lineage', summary: 'Orders from stage to mart.', title: 42 as unknown as string, [key]: [source] };
      const schema = complete ? PresentResultModelSchema : presentResultSchemaForPhase('synthesis', null, false);
      const rejection = rejectionFromZodError(schema.safeParse(input).error!, { code: 'invalid_input', input, schema });
      expect(rejection.issuePaths ?? []).not.toContain(key);
      if (complete) expect(rejection.issuePaths).toEqual(['title']);
      const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
      const sentence = holdRejectedPresentResult(store, input, rejection.issuePaths ?? [], 'synthesis');
      expect(sentence).not.toBeNull();
      if (complete) {
        expect(sentence).toContain('every field except title');
        expect(Object.keys(store.get()!).sort()).toEqual(['highlight_groups', 'name', 'sections', 'summary']);
      } else expect(store.get()).toEqual({ name: 'Orders lineage', summary: 'Orders from stage to mart.' });
    }
  });
});

/** Builds only the supplied held transaction; expected authorization and results stay on each case. */
function indexedRepair(draft: PresentResultInput, paths: string[]) {
  const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
  const instruction = holdRejectedPresentResult(store, draft, paths, 'synthesis');
  const authorization = store.getAuthorization()!;
  const schema = presentResultRepairPatchSchemaForFields(authorization.fields, 'synthesis', 0,
    authorization.highlightLabelIndexes, authorization.sectionLeaves);
  return { store, instruction, authorization, schema };
}

describe('indexed repair transactions', () => {
  it('repairs only rejected label leaves and preserves held group identity', () => {
    const draft = resultWith([
      { label: '   ', color: 'source', node_ids: ['source'] },
      { label: 'Transforms', color: 'transform', node_ids: ['middle'] },
      { label: '', color: 'target', node_ids: ['target'] },
    ]) as PresentResultInput;
    const { store, instruction, authorization, schema } = indexedRepair(draft, ['highlight_groups.0.label', 'highlight_groups.2.label']);
    const servedSchema = z.toJSONSchema(schema, { io: 'input' });
    const servedItems = (servedSchema.properties?.highlight_groups as {
      items?: {
        anyOf?: Array<{
          properties?: { index?: { const?: number } };
          required?: string[];
        }>;
      };
    }).items;

    expect(instruction).toContain('replace only the named defective fields');
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
      ...resultWith([{ label: '   ', color: 'source', node_ids: [nodeId] }]),
      title: 42 as unknown as string,
    } as PresentResultInput;
    const { store, authorization, schema } = indexedRepair(draft, ['title', 'highlight_groups.0.label']);

    expect(store.get()?.highlight_groups).toEqual(draft.highlight_groups);
    expect(store.get()?.title).toBeUndefined();
    // A shape-rejected optional field may be withdrawn by omission; the indexed label leaf may not.
    expect(schema.safeParse({ highlight_groups: [{ index: 0, label: 'Sources' }] }).success).toBe(true);
    expect(schema.safeParse({ title: 'Result lineage' }).success).toBe(false);
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
    const { store, instruction, authorization, schema } = indexedRepair(draft, ['sections.0.text']);

    expect(instruction).toContain('sections: send {index, corrected fields} for 0 (text)');
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
        { label: '   ', color: 'source', node_ids: ['source'] },
        { label: 'Target', color: 'target', node_ids: ['target'] },
      ]),
      sections: [
        { label: '   ', node_ids: ['source'], text: '   ' },
        { label: 'Target', node_ids: ['target'], text: 'Existing target detail.' },
      ],
    } as PresentResultInput;
    const { store, authorization, schema } = indexedRepair(draft, ['highlight_groups.0.label', 'sections.0.label', 'sections.0.text']);

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
    expect(malformed.getAuthorization()?.sectionLeaves).toBeUndefined();
    expect(malformed.get()?.sections).toBeUndefined();
    expect(holdRejectedPresentResult(outOfRange, draft, ['highlight_groups.9.label'], 'synthesis')).toContain('every field except highlight_groups');
    expect(outOfRange.getAuthorization()?.highlightLabelIndexes).toBeUndefined();
    expect(outOfRange.get()?.highlight_groups).toBeUndefined();
  });
  it('authorizes only the rejected indexed label, retaining source IDs and factual text', () => {
    const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
    holdRejectedPresentResult(store, labelDraft, ['sections.1.label'], 'synthesis');
    const auth = store.getAuthorization()!;
    expect(auth.sectionLeaves).toEqual([{ index: 1, fields: ['label'] }]);
    const schema = presentResultRepairPatchSchemaForFields(auth.fields, 'synthesis', 0, auth.highlightLabelIndexes, auth.sectionLeaves);
    expect(schema.safeParse({ sections: [{ index: 0, label: 'Wrong' }] }).success).toBe(false);
    expect(schema.safeParse({ sections: [{ index: 1, label: 'Source Beta', text: 'Rewrite' }] }).success).toBe(false);
    const merged = mergePresentResultRepairPatch(store.get()!, schema.parse({ sections: [{ index: 1, label: 'Source Beta' }] }), auth);
    expect(merged.sections![0]).toEqual(labelDraft.sections![0]);
    expect(merged.sections![1]).toEqual({ ...labelDraft.sections![1], label: 'Source Beta' });
    expect(merged.sections!.map(section => section.node_ids)).toEqual([[upper], [lower]]);
    expect(PresentResultModelSchema.safeParse(merged).success).toBe(true);
  });
});

it('names highlight_groups as the field to resend when a two-field repair returns only the other field', () => {
  const id = '[dbo].[report]';
  const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
  const rejected = {
    name: 'Report', summary: '', highlight_groups: [],
    sections: [{ label: 'Report', node_ids: [id], text: 'Report output.' }],
  };
  expect(holdRejectedPresentResult(store, rejected, ['summary', 'highlight_groups'], 'synthesis')).toContain('highlight_groups');
  const authorization = store.getAuthorization()!;
  expect(authorization.fields).toEqual(['summary', 'highlight_groups']);

  const merged = mergePresentResultRepairPatch(store.get()!, { summary: 'Report lineage.' }, authorization);
  expect(merged.highlight_groups).toBeUndefined();

  const result = validatePresentResult(merged, [id], undefined, undefined, [], 'synthesis');
  expect(result.success).toBe(false);
  if (result.success === false) {
    expect(result.rejection.issuePaths).toEqual(['highlight_groups']);
    expect(result.rejection.reason).toContain('highlight_groups[] is required');
    expect(result.rejection.hint).toContain('highlight_groups');
  }
});

it('accepts the call without sections that the unheld-section hint tells the model to send', () => {
  const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
  const committed = [{ label: 'Report', text: 'Committed body.' }];
  const rejected = {
    name: 'Report', summary: 'Report lineage.',
    highlight_groups: [{ label: 'Source', color: 'source', node_ids: ['[dbo].[report]'] }],
    sections: [{ label: 'Brand new', node_ids: [' '] }],
  };

  const retainingSchema = presentResultSchemaForPhase('synthesis', null, true);
  const first = retainingSchema.safeParse(rejected);
  expect(first.success).toBe(false);
  const failedPaths = first.success ? [] : first.error.issues.map(issue => issue.path.join('.'));

  const hint = holdRejectedPresentResult(store, rejected, failedPaths, 'synthesis', committed);
  expect(hint).toContain('omit sections to keep the committed report');
  const authorization = store.getAuthorization()!;
  expect(authorization.fields).toContain('sections');

  const hintedCall = {};
  const served = presentResultSchemaForPhase('synthesis', authorization.fields, true);
  const result = served.safeParse(hintedCall);
  expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true);
});
