/** A held `present_result` draft carries only the fields the tool defines. */
import { describe, expect, it } from 'vitest';
import { RepairDraftStore } from '../../../src/ai/support/repairDraftStore';
import { rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';
import { holdRejectedPresentResult, mergePresentResultRepairPatch, type PresentResultInput, type PresentResultRepairAuthorization } from '../../../src/ai/tools/presentResult';
import { PresentResultModelSchema, presentResultRepairPatchSchemaForFields } from '../../../src/ai/tools/toolSchemas';

const render = {
  name: 'Orders lineage', summary: 'How Orders is produced.',
  highlight_groups: [{ label: 'Sources', color: 'source', node_ids: ['dbo.a'] }],
  sections: [{ label: 'Sources', node_ids: ['dbo.a'], text: 'Reads dbo.a.' }],
};

describe('held present_result fields', () => {
  it('a large report rejected on one field is repaired by resending that field alone', () => {
    const report = {
      ...render,
      title: 't'.repeat(500),
      intro: 'Intro. '.repeat(200),
      closing: 'Closing. '.repeat(200),
      sections: Array.from({ length: 6 }, (_, index) => ({ label: `Section ${index}`, node_ids: ['dbo.a'], text: 'Body. '.repeat(150) })),
      notes: [{ node_id: 'dbo.a', caption: 'A caption.' }],
    };
    const parsed = PresentResultModelSchema.safeParse(report);
    const rejection = rejectionFromZodError(parsed.error!, { code: 'invalid_input', input: report, schema: PresentResultModelSchema });
    expect(rejection.issuePaths).toEqual(['title']);
    const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
    const sentence = holdRejectedPresentResult(store, report, rejection.issuePaths ?? [], 'synthesis');
    expect(sentence).toContain('only these corrected fields: title');
    const patch = { title: 'Orders lineage' };
    const authorization = store.getAuthorization()!;
    expect(presentResultRepairPatchSchemaForFields(authorization.fields, 'synthesis').safeParse(patch).success).toBe(true);
    const merged = mergePresentResultRepairPatch(store.get()!, patch, authorization);
    expect(merged).toEqual({ ...report, title: 'Orders lineage' });
    expect(PresentResultModelSchema.safeParse(merged).success).toBe(true);
  });

  it.each([
    ['a key with a space', 'node ids'],
    ['a key longer than the path grammar admits', 'k'.repeat(130)],
  ])('never holds %s, whether or not the rejection names it by path', (_label, key) => {
    const input = { ...render, title: 't'.repeat(500), [key]: ['dbo.a'] };
    const parsed = PresentResultModelSchema.safeParse(input);
    const rejection = rejectionFromZodError(parsed.error!, { code: 'invalid_input', input, schema: PresentResultModelSchema });
    expect(rejection.issuePaths).toEqual(['title']);
    const store = new RepairDraftStore<PresentResultInput, PresentResultRepairAuthorization>();
    const sentence = holdRejectedPresentResult(store, input, rejection.issuePaths ?? [], 'synthesis');
    expect(sentence).toContain('every field except title');
    expect(Object.keys(store.get()!).sort()).toEqual(['highlight_groups', 'name', 'sections', 'summary']);
  });
});
