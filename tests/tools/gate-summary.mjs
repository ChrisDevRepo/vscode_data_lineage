/**
 * Short default report of a gate run: a verdict line, the first failed steps with the first
 * file:line of their output and a log path. A green gate is one line. `npm run gate -- --full`
 * prints every step's output and the full table instead.
 */

const MAX_FAILED_STEPS = 5;
/** @internal Lines of a red gate: verdict, MAX_FAILED_STEPS steps, "+N more", summary path. */
export const GATE_LINE_BUDGET = MAX_FAILED_STEPS + 3;

const LOCATION = /(?:[\w.-]+\/)+[\w.-]+\.\w+:\d+/;

/** The first file:line in a step's output, else its first non-empty line, cut to 120 characters. */
function detail(output) {
  const text = String(output ?? '');
  const location = text.match(LOCATION)?.[0];
  const first = text
    .split('\n')
    .find((l) => l.trim())
    ?.trim();
  return (location ?? first ?? 'no output').slice(0, 120);
}

/**
 * `results`: [{ name, ok, output?, logPath?, note? }]; `totals`: unit test counts or null.
 * Returns the report text, which ends with a newline.
 */
export function summarizeGate({ results, totals }) {
  const failed = results.filter((r) => !r.ok);
  const tests = totals ? `, ${totals.passed} tests` : '';
  if (failed.length === 0) {
    return `gate: PASSED ${results.length}/${results.length} steps${tests}, 0 model calls\n`;
  }
  const shown = failed
    .slice(0, MAX_FAILED_STEPS)
    .map(
      (r) =>
        `  FAIL ${r.name} - ${detail(r.output || r.note)}${r.logPath ? ` -> ${r.logPath}` : ''}`,
    );
  const more =
    failed.length > shown.length
      ? [`  +${failed.length - shown.length} more`]
      : [];
  return (
    [
      `gate: FAILED ${failed.length}/${results.length} steps failed${totals?.failed ? `, ${totals.failed} tests failed` : ''}`,
      ...shown,
      ...more,
      'summary: test-results/gate/summary.json',
    ].join('\n') + '\n'
  );
}
