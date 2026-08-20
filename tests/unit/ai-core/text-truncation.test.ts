/**
 * Regression tests for `longestPrefixFitting` (`src/ai/support/textTruncation.ts`), the shared
 * surrogate-pair-safe truncation primitive consolidated out of `agent/toolAttempt.ts`'s
 * `capUtf8Text`/`truncateObservationResult` and `session/session.ts`'s `truncateDiscoveryText`.
 *
 * @remarks
 * The prior `truncateObservationResult` decremented a UTF-16 code-unit index directly and could
 * return a prefix ending in a lone (unpaired) surrogate when the byte budget landed exactly at a
 * surrogate-pair split — this is the one behavior this consolidation is allowed to change. Every
 * other budget shape must match byte-for-byte.
 */

import { describe, expect, it } from 'vitest';
import { longestPrefixFitting } from '../../../src/ai/support/textTruncation';

/** Reference (buggy) behavior of the old `truncateObservationResult` decrement loop, for comparison. */
function decrementByCodeUnit(text: string, targetBytes: number): string {
  let keep = Math.min(text.length, targetBytes);
  while (keep > 0 && Buffer.byteLength(text.slice(0, keep)) > targetBytes) keep--;
  return text.slice(0, keep);
}

const astral = '\u{1F600}'; // U+1F600, a single astral code point = 2 UTF-16 units, 4 UTF-8 bytes
const straddle = `a${astral}b`; // 'a' + full emoji + 'b'

describe('longestPrefixFitting (shared truncation primitive)', () => {
  it('(a) ASCII content: matches the plain byte-budget slice', () => {
    const ascii = 'a'.repeat(100);
    for (const budget of [0, 1, 50, 99, 100, 200]) {
      const got = longestPrefixFitting(ascii, candidate => Buffer.byteLength(candidate) <= budget);
      const want = ascii.slice(0, Math.min(ascii.length, budget));
      expect(got, `ascii budget=${budget} matches direct slice`).toBe(want);
    }
  });

  it('(b) multi-byte BMP content: never exceeds the byte budget', () => {
    const bmp = 'é'.repeat(50); // 2 bytes each in UTF-8
    for (const budget of [0, 1, 3, 4, 5, 100, 200]) {
      const got = longestPrefixFitting(bmp, candidate => Buffer.byteLength(candidate) <= budget);
      expect(Buffer.byteLength(got) <= budget, `bmp budget=${budget} result fits within budget`).toBe(true);
      // Adding one more full character must not still fit — else the prefix wasn't maximal.
      const oneMore = bmp.slice(0, got.length + 1);
      if (oneMore.length > got.length) {
        expect(Buffer.byteLength(oneMore) > budget, `bmp budget=${budget} prefix is maximal`).toBe(true);
      }
    }
  });

  it('(c) surrogate pair straddling the budget: never splits the pair', () => {
    for (let budget = 0; budget <= 6; budget++) {
      const got = longestPrefixFitting(straddle, candidate => Buffer.byteLength(candidate) <= budget);
      // A valid result never ends with a lone high surrogate.
      const lastCode = got.length > 0 ? got.charCodeAt(got.length - 1) : 0;
      expect(!(lastCode >= 0xD800 && lastCode <= 0xDBFF), `budget=${budget} never ends on a lone high surrogate`).toBe(true);
      expect(Buffer.byteLength(got) <= budget, `budget=${budget} result respects the byte budget`).toBe(true);
    }
  });

  it('(d) fixes the old decrement-loop bug: budget=4 on "a"+emoji+"b"', () => {
    // With budget=4, the old per-code-unit decrement stopped at keep=2 ("a" + lone high surrogate),
    // because Buffer.byteLength of the lone surrogate (replaced with U+FFFD) is 3 bytes <= 4.
    const buggyResult = decrementByCodeUnit(straddle, 4);
    const buggyLastCode = buggyResult.charCodeAt(buggyResult.length - 1);
    expect(buggyLastCode >= 0xD800 && buggyLastCode <= 0xDBFF, 'sanity: the old algorithm really did produce a lone surrogate here').toBe(true);
    const fixedResult = longestPrefixFitting(straddle, candidate => Buffer.byteLength(candidate) <= 4);
    expect(fixedResult, 'the shared primitive backs off to the last complete code point instead').toBe('a');
  });

  it('(e) empty text and never-fits predicate', () => {
    expect(longestPrefixFitting('', () => true), 'empty input returns empty').toBe('');
    expect(longestPrefixFitting('hello', () => false), 'a predicate that never fits returns empty string').toBe('');
    expect(longestPrefixFitting('hello', () => true), 'a predicate that always fits returns the full text').toBe('hello');
  });
});
