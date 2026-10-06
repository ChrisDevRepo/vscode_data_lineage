/** A repair that leaves a held `present_result` draft without `highlight_groups` is rejected with a repair, not a thrown error. */
import { expect, it } from 'vitest';
import { RepairDraftStore } from '../../../src/ai/support/repairDraftStore';
import {
  holdRejectedPresentResult, mergePresentResultRepairPatch, validatePresentResult,
  type PresentResultInput, type PresentResultRepairAuthorization,
} from '../../../src/ai/tools/presentResult';

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
