/**
 * Unit tests for `searchDdl`'s regex-rejection hint.
 *
 * Guards the fix where an invalid or ReDoS-budget-exceeding pattern returned a hardcoded
 * hint naming a single fixed cause ("avoid nested quantifiers") for every rejection. The
 * hint must now be derived per-pattern via `regexRejectHint`: a pattern that fails to
 * compile gets a compile-specific repair, and a pattern that compiles but blows the ReDoS
 * budget gets the nested-quantifier repair.
 */

import { describe, expect, it } from 'vitest';
import { searchDdl } from '../../../src/ai/tools/tools';
import { compileSearchRegex, regexRejectHint } from '../../../src/utils/modelSearch';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';

function makeModel(): DatabaseModel {
  const nodes: LineageNode[] = [
    {
      id: '[ai].[vwsales]',
      schema: 'ai',
      name: 'vwSales',
      fullName: '[ai].[vwSales]',
      type: 'view',
      columns: [],
      bodyScript: 'SELECT * FROM ai.ArchiveOrders',
    },
  ];
  return {
    nodes,
    edges: [],
    schemas: [{ name: 'ai', nodeCount: 1, types: { table: 0, view: 1, procedure: 0, function: 0, external: 0 } }],
    catalog: {},
    neighborIndex: {},
    dbPlatform: 'SQL Server',
  };
}

describe('search-ddl-regex-hint', () => {
  const model = makeModel();

  it('a compile-failing pattern gets a compile-specific repair, not the hardcoded quantifier hint', () => {
    const res = searchDdl(model, '(?P<name>foo)') as Record<string, unknown>;
    expect(res.error, 'compile failure rejects as invalid_regex').toBe('invalid_regex');
    expect(res.hint, 'named-group syntax gets the JS-syntax repair').toBe(
      'Rename the named group from "(?P<name>...)" to "(?<name>...)" — that is the JavaScript syntax.',
    );
    expect(res.hint, 'no longer returns the hardcoded wrong-cause hint').not.toBe(
      'Simplify the pattern — avoid nested quantifiers.',
    );
  });

  it('the hint is derived per-pattern, matching regexRejectHint directly, not a fixed string', () => {
    // Exercises a second, differently-shaped compile failure to confirm the tool boundary
    // forwards whatever regexRejectHint derives for the given pattern, rather than special
    // -casing one message. The ReDoS-timeout branch (pattern compiles but exceeds
    // REDOS_BUDGET_MS) is covered directly against regexRejectHint in
    // tests/unit/engine/modelSearch.test.ts — a real catastrophic-backtracking pattern takes
    // seconds to minutes of wall time on a 200-char sample (there is no "just barely over 5ms"
    // case, only "fast" or "explodes"), so it is not re-triggered here at the tool boundary.
    const pattern = 'foo(bar';
    const rejection = compileSearchRegex(pattern);
    if (rejection.ok) throw new Error(`expected ${pattern} to be rejected`);
    const res = searchDdl(model, pattern) as Record<string, unknown>;
    expect(res.error).toBe('invalid_regex');
    expect(res.hint).toBe(regexRejectHint(pattern, rejection));
    expect(res.hint).toContain('closing ")"');
  });

  it('a valid, well-behaved pattern is not rejected', () => {
    const res = searchDdl(model, 'ArchiveOrders') as Record<string, unknown>;
    expect('error' in res, 'a normal pattern does not reject').toBe(false);
  });
});
