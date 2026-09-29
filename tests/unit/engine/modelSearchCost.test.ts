/**
 * Pins the cost bound on `lineage_search_ddl` patterns: a backtracking-prone pattern is refused
 * at the contract with a rewrite hint, and a normal pattern still locates a match on a very long line.
 */
import { describe, expect, it } from 'vitest';
import {
  compileSearchRegex,
  regexRejectHint,
  scanBodyMatches,
  SEARCH_LINE_MAX_CHARS,
  type SearchableNode,
} from '../../../src/utils/modelSearch';

describe('search pattern cost on a long line', () => {
  const longNode: SearchableNode = {
    id: 'dbo.minified',
    name: 'Minified',
    schema: 'dbo',
    type: 'View' as SearchableNode['type'],
    bodyScript: `${'a'.repeat(50_000)} FROM dbo.Orders`,
  };

  it.each(['(a+)+x', '(.*a){12}x', '.*.*x', 'a*a*x'])('refuses %s at the contract with a rewrite hint', (pattern) => {
    const compiled = compileSearchRegex(pattern);
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(regexRejectHint(pattern, compiled)).toMatch(/nested quantifiers/);
  }, 20_000);

  it('still returns the locator for a normal pattern on the same line', () => {
    const compiled = compileSearchRegex('from\\s+dbo\\.orders');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const start = performance.now();
    const result = scanBodyMatches([longNode], compiled.regex, undefined, () => true);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(result.oversized[0].lines[0].length).toBeGreaterThan(SEARCH_LINE_MAX_CHARS);
  }, 20_000);
});
