/**
 * The scope-too-large reroute and notice read the budget refusal by its `code`, in both shapes the
 * catalog serves: the rejection envelope (whose `reason` is prose) and `lineage_search_ddl`'s partial reply.
 */
import { describe, expect, it, vi } from 'vitest';
import { detectOverBudgetFromResult, queueDiscoveryBudgetNotice } from '../../../src/ai/agent/discoveryCapture';
import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import { checkScopeBudget, createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import { searchDdl } from '../../../src/ai/tools/tools';
import type { DatabaseModel } from '../../../src/engine/types';

const budget = createTurnTokenBudget();
const envelope = JSON.stringify(checkScopeBudget(budget, 1_000_000, 0));

describe('over-budget refusal readers', () => {
  it('reads the rejection envelope by its code, whatever its reason says', () => {
    const refusal = JSON.parse(envelope) as { code: string; reason: string };
    expect(refusal.code).toBe(REJECTION_CODES.overDiscoveryBudget);
    expect(refusal.reason).not.toBe(refusal.code);
    expect(detectOverBudgetFromResult('lineage_get_scope_bundle', envelope)).toBe(true);
    const queueClosingNotice = vi.fn();
    queueDiscoveryBudgetNotice({ queueClosingNotice }, 'lineage_get_object_detail', envelope);
    expect(queueClosingNotice).toHaveBeenCalledOnce();
  });

  it('reads search_ddl\'s partial reply by its code', async () => {
    const nodes = [{ id: 'dbo.Lines', name: 'Lines', schema: 'dbo', type: 'procedure', bodyScript: Array(120).fill('Tok').join('\n') }];
    const reply = await searchDdl({ nodes, edges: [] } as unknown as DatabaseModel, new Set(), 'Tok', createTurnTokenBudget({ discoveryTokenBudget: 1 }));
    expect(reply).toMatchObject({ code: REJECTION_CODES.overDiscoveryBudget, results_omitted: true });
    const queueClosingNotice = vi.fn();
    queueDiscoveryBudgetNotice({ queueClosingNotice }, 'lineage_search_ddl', JSON.stringify(reply));
    expect(queueClosingNotice).toHaveBeenCalledOnce();
  });
});
