/**
 * `lineage_search_ddl` refuses a hit count in the main thread and the regex-search worker stops
 * building rows at the same count: both price a hit row with the one o200k counter, so a budget
 * the chars/4 guess would still admit is over budget in both places.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RegexSearchReply } from '../../../src/ai/support/regexSearch.worker';

const replies: RegexSearchReply[] = [];
vi.mock('../../../src/ai/support/isolatedRegexSearch', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/ai/support/isolatedRegexSearch')>();
  return {
    ...actual,
    executeIsolatedRegexSearch: async (...args: Parameters<typeof actual.executeIsolatedRegexSearch>) => {
      const reply = await actual.executeIsolatedRegexSearch(...args);
      replies.push(reply);
      return reply;
    },
  };
});

import { REJECTION_CODES } from '../../../src/ai/support/rejectionCodes';
import { createTurnTokenBudget } from '../../../src/ai/support/tokenBudget';
import { countTokens } from '../../../src/ai/support/tokenCount';
import { searchDdl } from '../../../src/ai/tools/tools';
import type { DatabaseModel } from '../../../src/engine/types';

const HITS = 200;
const HIT_ROW = JSON.stringify({ line: 0, context: '' });

describe('search_ddl hit-row pricing', () => {
  it('stops the worker and refuses in the main thread at a count the chars/4 guess admits', async () => {
    const budget = Math.ceil((HITS * HIT_ROW.length) / 4);
    expect(budget, 'above the budget floor').toBeGreaterThanOrEqual(1000);
    expect(HITS * countTokens(HIT_ROW), 'the counted rows exceed what chars/4 admits').toBeGreaterThan(budget);

    const nodes = [{ id: 'dbo.Lines', name: 'Lines', schema: 'dbo', type: 'procedure', bodyScript: Array(HITS).fill('Tok').join('\n') }];
    const reply = await searchDdl({ nodes, edges: [] } as unknown as DatabaseModel, new Set(), 'Tok', createTurnTokenBudget({ discoveryTokenBudget: budget }));

    expect(reply).toMatchObject({ code: REJECTION_CODES.overDiscoveryBudget, results_omitted: true });
    const worker = replies.at(-1);
    if (!worker?.ok || worker.kind !== 'ddl') throw new Error('the worker did not answer the DDL scan');
    expect(worker.scan.total).toBe(HITS);
    expect(worker.scan.matches.length, 'the worker stopped building rows before the last hit').toBeLessThan(HITS);
  });
});
