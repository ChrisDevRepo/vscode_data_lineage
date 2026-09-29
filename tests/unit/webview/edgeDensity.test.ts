// Edge density: full-strength lines on a small graph, the floor on a large one, log-linear and
// step-rounded between.
import { describe, expect, it } from 'vitest';
import { edgeDensity } from '../../../src/engine/edgeDecoration';

describe('edgeDensity', () => {
  it('keeps a small graph at zero density', () => {
    expect(edgeDensity(0)).toBe(0);
    expect(edgeDensity(100)).toBe(0);
  });

  it('reaches full density on a large graph', () => {
    expect(edgeDensity(2000)).toBe(1);
    expect(edgeDensity(20000)).toBe(1);
  });

  it('rises log-linearly between, rounded to one step', () => {
    const mid = edgeDensity(Math.round(Math.sqrt(100 * 2000)));
    expect(mid).toBeCloseTo(0.5, 5);
    expect(edgeDensity(500)).toBeLessThan(edgeDensity(1000));
    expect(edgeDensity(1000)).toBe(edgeDensity(1001));
  });
});
