/** The "omit sections" call named by the unheld-section rejection hint passes the repair schema served in that state. */
import { expect, it } from 'vitest';
import { RepairDraftStore } from '../../../src/ai/support/repairDraftStore';
import { holdRejectedPresentResult, type PresentResultInput, type PresentResultRepairAuthorization } from '../../../src/ai/tools/presentResult';
import { presentResultSchemaForPhase } from '../../../src/ai/tools/toolSchemas';

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
