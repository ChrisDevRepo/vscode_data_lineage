import { TaskLedger } from '../../../src/ai/sm/taskLedger';
import { describe, expect, it } from 'vitest';

describe("TaskLedger", () => {
  const leadInput = {
    taskId: 'task_1',
    nodeId: '[ext].[Target]',
    fromNodeId: '[dbo].[Source]',
    reason: 'schema_boundary' as const,
    valueToUser: 'first value',
    createdHop: 1,
  };
  it("same identity tuple returns the same lead", () => {
  const ledger = new TaskLedger();
  const first = ledger.ensureLead(leadInput);
  const again = ledger.ensureLead({ ...leadInput, valueToUser: 'refreshed value' });
  expect(first.id === again.id, 'same identity tuple returns the same lead').toBe(true);
  expect(again.valueToUser === 'refreshed value', 're-ensure refreshes valueToUser').toBe(true);
  expect(ledger.pendingLeads.length === 1, 'dedupe stores exactly one lead').toBe(true);

  // Case-insensitive node identity, matching the engine's lowercased ids.
  const cased = ledger.ensureLead({ ...leadInput, nodeId: '[EXT].[TARGET]' });
  expect(cased.id === first.id, 'node id casing does not split lead identity').toBe(true);
});

  it("a different reason is a different lead", () => {
  const ledger = new TaskLedger();
  const first = ledger.ensureLead(leadInput);
  const otherReason = ledger.ensureLead({ ...leadInput, reason: 'depth_boundary' as const });
  const otherFrom = ledger.ensureLead({ ...leadInput, fromNodeId: '[dbo].[Other]' });
  expect(first.id !== otherReason.id, 'a different reason is a different lead').toBe(true);
  expect(first.id !== otherFrom.id, 'a different fromNode is a different lead').toBe(true);
  expect(ledger.pendingLeads.length === 3, 'distinct identities store distinct leads').toBe(true);
});

  it("post-restore ensureLead resolves the restored identity", () => {
  const ledger = new TaskLedger();
  const original = ledger.ensureLead(leadInput);
  const snapshotLeads = ledger.pendingLeads;
  const restored = new TaskLedger();
  restored.restore([], snapshotLeads);
  // Restore must rebuild the identity map: a re-ensure of the same tuple dedupes to the
  // restored lead instead of throwing the fresh-id collision guard.
  const reEnsured = restored.ensureLead({ ...leadInput, valueToUser: 'post-restore value' });
  expect(reEnsured.id === original.id, 'post-restore ensureLead resolves the restored identity').toBe(true);
  expect(restored.pendingLeads.length === 1, 'post-restore dedupe stores no duplicate lead').toBe(true);
});

});
