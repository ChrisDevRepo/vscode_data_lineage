/** Protects actual native-regexp isolation, cancellation and complete legitimate-search results. */
import { describe, expect, it, vi } from 'vitest';
import { compileSearchRegex } from '../../../src/utils/modelSearch';
import { executeIsolatedRegexSearch } from '../../../src/ai/support/isolatedRegexSearch';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';
import type { SearchableNode } from '../../../src/utils/modelSearch';

const nodes: SearchableNode[] = [{ id: 'dbo.Order', name: 'Order', schema: 'dbo', type: 'table', bodyScript: 'SELECT HeadToken FROM dbo.Order\n-- HeadToken\nTailToken' }];

describe('isolated regex execution', () => {
  it('keeps syntax compilation browser-safe without process CPU APIs', () => {
    vi.stubGlobal('process', undefined);
    try { expect(compileSearchRegex('SELECT|HeadToken').ok).toBe(true); }
    finally { vi.unstubAllGlobals(); }
  });

  it.each(['SELECT.*FROM.*Order', '(SELECT|DELETE)\\s+HeadToken', '(HeadToken){1,2}', '(?<=SELECT )HeadToken'])('preserves legitimate %s syntax and full DDL matches', async pattern => {
    const result = await executeIsolatedRegexSearch({ kind: 'ddl', pattern, nodes, budget: DEFAULT_TURN_TOKEN_BUDGET, rowChars: 60 });
    expect(result.ok && result.kind === 'ddl' && result.scan.matches[0].line).toBe(1);
  });

  it('preserves every match, comment attribution and counts', async () => {
    const result = await executeIsolatedRegexSearch({ kind: 'ddl', pattern: 'HeadToken|TailToken', nodes, budget: DEFAULT_TURN_TOKEN_BUDGET, rowChars: 60 });
    expect(result.ok && result.kind === 'ddl' && result.scan.total).toBe(3);
    if (!result.ok || result.kind !== 'ddl') throw new Error('DDL result required');
    expect(result.scan.matches.map(hit => [hit.line, hit.commented === true])).toEqual([[1, false], [2, true], [3, false]]);
  });

  it('cancels a running malicious expression without returning partial results', async () => {
    const controller = new AbortController();
    const pending = executeIsolatedRegexSearch({ kind: 'catalog', pattern: '(a+)+x', nodes: [{ ...nodes[0], name: 'a'.repeat(50_000) }], limit: 20 }, controller.signal);
    const alive = new Promise<void>(resolve => setTimeout(() => { controller.abort(); resolve(); }, 100));
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' });
    await alive;
  });

  it('rejects an already cancelled request before execution', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(executeIsolatedRegexSearch({ kind: 'catalog', pattern: 'Order', nodes, limit: 20 }, controller.signal)).rejects.toMatchObject({ reason: 'cancelled' });
  });
  it('reports a worker startup failure explicitly', async () => {
    const unclonable = { ...nodes[0], bodyScript: (() => {}) as unknown as string };
    await expect(executeIsolatedRegexSearch({ kind: 'ddl', pattern: 'Order', nodes: [unclonable], budget: DEFAULT_TURN_TOKEN_BUDGET, rowChars: 60 })).rejects.toMatchObject({ reason: 'worker' });
  });

  it('reports a running worker error explicitly', async () => {
    await expect(executeIsolatedRegexSearch({ kind: 'catalog', pattern: 'Order', nodes: undefined as unknown as SearchableNode[], limit: 20 })).rejects.toMatchObject({ reason: 'worker' });
  });

});
