import { describe, expect, it } from 'vitest';
import { createStreamRepetitionObserver } from '../../../src/ai/model/modelPort';

/**
 * The degenerate-repeat counter behind the stream repetition stop: the 3rd identical substantial
 * line is a loop, the 2nd is not (PM 2026-09-16). Calibration over the 341 archived wire responses
 * of 2026-09-16: 9 trips, all degenerate loop bodies, zero on tool-bearing or `stop` finishes.
 */

/** A substantial line at the counted floor (32 normalized chars). */
const FLOOR_LINE = 'x'.repeat(32);
/** Longest repeated noise unit in any recorded body is 12 chars; well under the floor. */
const NOISE_LINE = '</parameter>';

function cycle(times: number): string {
  return `${FLOOR_LINE}\n${NOISE_LINE}\n`.repeat(times);
}

describe('createStreamRepetitionObserver', () => {
  it('strikes on the 3rd identical substantial line and reports it exactly once', () => {
    const observer = createStreamRepetitionObserver();
    expect(observer.observe(cycle(1))).toBeNull();
    expect(observer.observe(cycle(1))).toBeNull();
    const strike = observer.observe(cycle(1));
    expect(strike).toEqual({ repeats: 3, line: FLOOR_LINE });
    // The strike is returned once; a 4th occurrence is never re-reported.
    expect(observer.observe(cycle(1))).toBeNull();
  });

  it('never strikes on two repeats of the same line', () => {
    const observer = createStreamRepetitionObserver();
    expect(observer.observe(cycle(2))).toBeNull();
    expect(observer.observe('a different substantial line entirely, long enough to count\n')).toBeNull();
  });

  it('ignores short noise lines no matter how often they repeat', () => {
    const observer = createStreamRepetitionObserver();
    expect(observer.observe(`${NOISE_LINE}\n`.repeat(9))).toBeNull();
  });

  it('treats 31 normalized characters as below the counted floor', () => {
    const observer = createStreamRepetitionObserver();
    const short = 'y'.repeat(31);
    expect(observer.observe(`${short}\n`.repeat(5))).toBeNull();
  });

  it('normalizes whitespace, so cosmetic drift never masks a repeat', () => {
    const observer = createStreamRepetitionObserver();
    const base = 'Route to the three upstream tables to verify the Discount computation.';
    expect(observer.observe(`${base}\n`)).toBeNull();
    expect(observer.observe(`${base}   \r\n`)).toBeNull();
    // Leading spaces and an internal tab run collapse to the same key: 3rd occurrence strikes.
    const tabbed = `  ${base.replace('the three', 'the\tthree')}`;
    expect(observer.observe(`${tabbed}\n`)).toEqual({ repeats: 3, line: base });
    // A fourth cosmetic variant stays silent after the single strike.
    expect(observer.observe(`${base.replace(' ', '  ')}\n`)).toBeNull();
  });

  it('survives arbitrary chunk boundaries splitting every line', () => {
    const observer = createStreamRepetitionObserver();
    const body = cycle(3);
    let strike: { repeats: number; line: string } | null = null;
    for (let i = 0; i < body.length && strike === null; i += 7) {
      strike = observer.observe(body.slice(i, i + 7));
    }
    expect(strike).toEqual({ repeats: 3, line: FLOOR_LINE });
  });

  it('counts distinct lines independently', () => {
    const observer = createStreamRepetitionObserver();
    const other = 'z'.repeat(40);
    expect(observer.observe(`${FLOOR_LINE}\n${other}\n`)).toBeNull();
    expect(observer.observe(`${other}\n${FLOOR_LINE}\n`)).toBeNull();
    // Two occurrences of each so far; each line's third occurrence strikes on its own.
    expect(observer.observe(`${FLOOR_LINE}\n`)).toEqual({ repeats: 3, line: FLOOR_LINE });
    expect(observer.observe(`${other}\n`)).toEqual({ repeats: 3, line: other });
  });

  it('still counts an early line after the tracked set is full, but admits no new one', () => {
    const observer = createStreamRepetitionObserver();
    expect(observer.observe(`${FLOOR_LINE}\n`)).toBeNull();
    const filler = Array.from(
      { length: 2048 },
      (_, i) => `filler-${String(i).padStart(4, '0')}-${'f'.repeat(32)}`,
    ).join('\n');
    expect(observer.observe(`${filler}\n`)).toBeNull();
    expect(observer.observe(`${FLOOR_LINE}\n`)).toBeNull();
    // Admitted before the set filled, so it keeps counting and strikes.
    expect(observer.observe(`${FLOOR_LINE}\n`)).toEqual({ repeats: 3, line: FLOOR_LINE });

    const capped = createStreamRepetitionObserver();
    expect(capped.observe(`${filler}\n`)).toBeNull();
    const late = `late-line-never-admitted-${'l'.repeat(32)}`;
    expect(capped.observe(`${late}\n`)).toBeNull();
    expect(capped.observe(`${late}\n`)).toBeNull();
    // The set is full and this line was never admitted, so it cannot strike.
    expect(capped.observe(`${late}\n`)).toBeNull();
  });

  it('counts a newline-less paragraph once it passes the buffered-line bound', () => {
    const observer = createStreamRepetitionObserver();
    const paragraph = 'p'.repeat(8193);
    expect(observer.observe(paragraph)).toBeNull();
    expect(observer.observe(paragraph)).toBeNull();
    expect(observer.observe(paragraph)).toEqual({ repeats: 3, line: paragraph });
  });
});
