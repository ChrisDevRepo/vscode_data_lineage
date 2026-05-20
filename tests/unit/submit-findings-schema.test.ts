/**
 * Unit tests for mode-dispatched submit_findings Zod schemas.
 *
 * Verifies BB/CT contract separation:
 * - BB allows prune semantics and rejects CT-only fields.
 * - CT requires column_flow and rejects BB-only fields/verdict.
 */

import {
  SubmitFindingsBbInputSchema,
  SubmitFindingsCtInputSchema,
} from '../../src/ai/tools/tools';
import { assert, resetCounters, printSummary } from './helpers/testUtils';

console.log('Submit Findings Schema');
console.log('='.repeat(40));
resetCounters();

{
  const parsed = SubmitFindingsBbInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'prune',
    prune_neighbors: ['[dbo].[vStaging]'],
  });
  assert(parsed.success, 'BB accepts prune verdict + prune_neighbors');
}

{
  const parsed = SubmitFindingsBbInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [],
  });
  assert(!parsed.success, 'BB rejects CT-only column_flow field');
}

{
  const parsed = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [],
  });
  assert(parsed.success, 'CT accepts explicit column_flow (including empty array)');
}

{
  const parsed = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'prune',
    column_flow: [],
  });
  assert(!parsed.success, 'CT rejects prune verdict at schema boundary');
}

{
  const parsed = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'pass',
    prune_neighbors: ['[dbo].[vStaging]'],
    column_flow: [],
  });
  assert(!parsed.success, 'CT rejects BB-only prune_neighbors');
}

{
  const parsed = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'pass',
  });
  assert(!parsed.success, 'CT requires column_flow field');
}

// ── route_requests[].columns is CT-only (Component C — mode-pure schema) ──
{
  const parsed = SubmitFindingsBbInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    route_requests: [{ nodeId: '[dbo].[vStaging]', question: 'trace', columns: ['amount'] }],
  });
  assert(!parsed.success, 'BB rejects CT-only route_requests[].columns');
}

{
  const parsed = SubmitFindingsBbInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    route_requests: [{ nodeId: '[dbo].[vStaging]', question: 'trace' }],
  });
  assert(parsed.success, 'BB accepts route_requests without columns');
}

{
  const parsed = SubmitFindingsCtInputSchema.safeParse({
    focus_node_id: '[dbo].[vSales]',
    sections: [{ angle: 'business', text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [],
    route_requests: [{ nodeId: '[dbo].[vStaging]', question: 'trace', columns: ['amount'] }],
  });
  assert(parsed.success, 'CT accepts route_requests[].columns');
}

printSummary('Submit Findings Schema');
