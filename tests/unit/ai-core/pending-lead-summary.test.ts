import { describe, expect, it } from 'vitest';
import { buildPendingLeadMessages } from '../../../src/ai/support/pendingLeadMessages';
import type { PendingLead } from '../../../src/ai/sm/smTypes';

function lead(
  id: string,
  nodeId: string,
  reason: PendingLead['reason'],
): PendingLead {
  return {
    id,
    taskId: `task-${id}`,
    nodeId,
    fromNodeId: 'origin',
    reason,
    valueToUser: 'Follow-up value',
    status: 'pending',
    createdHop: 1,
  };
}

describe('pending lead messages', () => {
  it('reports contracted-scope leads as unique supporting in-scope objects', () => {
    const messages = buildPendingLeadMessages([
      lead('1', 'table-a', 'contracted_scope'),
      lead('2', 'table-a', 'contracted_scope'),
      lead('3', 'table-b', 'contracted_scope'),
    ]);

    expect(messages).toEqual([
      'Retained 2 supporting in-scope objects without separate hop analysis.',
    ]);
  });

  it('reserves beyond-scope wording for schema and depth boundaries', () => {
    const messages = buildPendingLeadMessages([
      lead('1', 'table-a', 'schema_boundary'),
      lead('2', 'table-b', 'depth_boundary'),
      lead('3', 'table-c', 'budget'),
    ]);

    expect(messages).toEqual([
      'Found 2 related paths beyond the approved scope.',
      'Deferred 1 related path for follow-up.',
    ]);
  });
});
