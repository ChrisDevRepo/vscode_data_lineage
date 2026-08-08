import type { PendingLead } from '../sm/smTypes';
import { pluralize } from './text';

/** Builds accurate informational chat messages for unresolved exploration leads. */
export function buildPendingLeadMessages(leads: ReadonlyArray<PendingLead>): string[] {
  const pending = leads.filter(lead => lead.status === 'pending');
  const contractedNodeCount = new Set(
    pending.filter(lead => lead.reason === 'contracted_scope').map(lead => lead.nodeId),
  ).size;
  const boundaryCount = pending.filter(
    lead => lead.reason === 'schema_boundary' || lead.reason === 'depth_boundary',
  ).length;
  const followUpCount = pending.length
    - pending.filter(lead => lead.reason === 'contracted_scope').length
    - boundaryCount;
  const messages: string[] = [];

  if (contractedNodeCount > 0) {
    messages.push(
      `Retained ${contractedNodeCount} supporting in-scope ${pluralize(contractedNodeCount, 'object')} without separate hop analysis.`,
    );
  }
  if (boundaryCount > 0) {
    messages.push(
      `Found ${boundaryCount} related ${pluralize(boundaryCount, 'path')} beyond the approved scope.`,
    );
  }
  if (followUpCount > 0) {
    messages.push(
      `Deferred ${followUpCount} related ${pluralize(followUpCount, 'path')} for follow-up.`,
    );
  }

  return messages;
}
