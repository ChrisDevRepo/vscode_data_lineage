import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateScorecard, runMetrics, spreadFindings } from './trace-metrics.mjs';

/** Empty-trace metrics with the given overrides, shaped like {@link runMetrics} output. */
function run({ rejectedCalls = 0, resent = 0, cited = 0, ...rest } = {}) {
  const base = runMetrics([]);
  return {
    ...base,
    outcome: 'ok',
    repair: { ...base.repair, rejectedCalls, resendTokens: { rejected: 0, resent } },
    synthesis: { offered: cited, cited },
    ...rest,
  };
}

const rules = findings => findings.map(item => item.rule);

test('fewer rejections or resend tokens in the candidate is not a regression', () => {
  assert.deepEqual(rules(spreadFindings([run({ rejectedCalls: 3, resent: 40 }), run()])), []);
});

test('more rejections or new resend tokens in the candidate is a regression', () => {
  const found = rules(spreadFindings([run(), run({ rejectedCalls: 2, resent: 40 })]));
  assert.ok(found.includes('rejections_regressed_between_runs'));
  assert.ok(found.includes('resend_tokens_regressed_between_runs'));
});

test('citations falling to zero are reported', () => {
  assert.ok(rules(spreadFindings([run({ cited: 20 }), run({ cited: 0 })])).includes('snippet_citations_differ_between_runs'));
});

test('a much slower candidate rates duration red', () => {
  assert.equal(generateScorecard(run({ durationMs: 1000 }), run({ durationMs: 100000 })).durationSec.rag, 'RED');
});

test('an empty candidate answer keeps the length row and rates it red', () => {
  const card = generateScorecard(run({ chars: 1000 }), run({ chars: 0 }));
  assert.equal(card.previewChars.candidate, 0);
  assert.equal(card.previewChars.rag, 'RED');
});
