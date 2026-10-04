/** Natural text boundaries apply only to the visible hop-status preview. */
import { describe, expect, it } from 'vitest';
import { truncAtWordBoundary } from '../../../src/ai/support/text';

describe('hop-status text preview', () => {
 it.each(['', 'Short summary.', 'x'.repeat(135)])('keeps text within the inclusive budget unchanged', text => {
  expect(truncAtWordBoundary(text,135)).toBe(text);
 });
 it('ends at the last complete sentence', () => {
  expect(truncAtWordBoundary('First sentence. Then a longer sentence that does not fit.',35)).toBe('First sentence...');
 });
 it('ends at the last comma clause', () => {
  expect(truncAtWordBoundary('Reads orders, joins customers, then computes the complete report.',40)).toBe('Reads orders, joins customers...');
 });
 it('falls back to a whole word without punctuation', () => {
  expect(truncAtWordBoundary('reads orders before computing totals',24)).toBe('reads orders before...');
 });
 it.each(['and','but','or'])('does not end on a dangling %s', conjunction => {
  expect(truncAtWordBoundary(`Reads orders ${conjunction} continues with a longer unfinished clause`, 22)).not.toMatch(/(?:and|but|or)\.\.\.$/);
 });
 it('never splits a surrogate pair at the token fallback', () => {
  expect(truncAtWordBoundary('x'.repeat(131)+'😀'+'x'.repeat(100),135)).toBe('...');
 });
 it('bounds a long unbroken token', () => {
  expect(truncAtWordBoundary('x'.repeat(200),135)).toBe('...');
 });
});
