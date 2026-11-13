import assert from 'node:assert/strict';
import test from 'node:test';
import { GATE_LINE_BUDGET, summarizeGate } from './gate-summary.mjs';

const step = (name, ok, output = '') => ({
  name,
  ok,
  output,
  logPath: ok ? '' : `test-results/gate/${name}.log`,
});
const lines = (text) => text.trimEnd().split('\n');

test('a green gate prints one line with step and test counts', () => {
  const text = summarizeGate({
    results: [step('lint', true), step('build', true)],
    totals: { passed: 40, failed: 0, skipped: 0 },
  });
  assert.deepEqual(lines(text), [
    'gate: PASSED 2/2 steps, 40 tests, 0 model calls',
  ]);
});

test('a red gate names each failed step with file:line and its log, within the line budget', () => {
  const results = [step('lint', true)];
  for (let i = 0; i < 9; i += 1) {
    results.push(
      step(`step ${i}`, false, `noise\n  at src/mod${i}.ts:${10 + i}:3 boom\n`),
    );
  }
  const out = lines(summarizeGate({ results, totals: null }));
  assert.ok(out.length <= GATE_LINE_BUDGET, `${out.length} lines`);
  assert.equal(out[0], 'gate: FAILED 9/10 steps failed');
  assert.match(out[1], /FAIL step 0 - src\/mod0\.ts:10 .*step 0\.log/);
  assert.ok(out.includes('  +4 more'));
});

test('a failed step without a file location shows its first output line', () => {
  const out = lines(
    summarizeGate({
      results: [step('docs', false, '\nbroken link in README\nmore\n')],
      totals: null,
    }),
  );
  assert.match(out[1], /FAIL docs - broken link in README/);
});
