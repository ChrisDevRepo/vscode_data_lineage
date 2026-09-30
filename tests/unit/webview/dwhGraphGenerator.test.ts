/**
 * Loose sanity checks for the seeded, asymmetric graph generator: same seed reproduces the
 * identical model, a different seed diverges, edges per node land in the 2.5-3.5 band at 2k/10k,
 * and at least one hub object exists. A .dacpac round-trip through the real extractor proves the
 * generated graph is not just an in-memory shape.
 */

import { describe, expect, it } from 'vitest';
import { generateDwhModel, formatDwhStats } from '../helpers/dwhGraphGenerator';
import { buildSyntheticDacpac } from '../helpers/syntheticDacpac';
import { extractDacpac } from '../../../src/engine/dacpacExtractor';
import { loadParseRules } from '../helpers/testUtils';

describe('generateDwhModel — determinism', () => {
  it('reproduces an identical model for the same seed', () => {
    const a = generateDwhModel({ objectCount: 500, seed: 42 });
    const b = generateDwhModel({ objectCount: 500, seed: 42 });
    expect(JSON.stringify(a.model)).toBe(JSON.stringify(b.model));
    expect(a.stats).toEqual(b.stats);
  });

  it('produces a different model for a different seed', () => {
    const a = generateDwhModel({ objectCount: 500, seed: 42 });
    const b = generateDwhModel({ objectCount: 500, seed: 43 });
    expect(JSON.stringify(a.model)).not.toBe(JSON.stringify(b.model));
  });

  it('generates exactly objectCount real nodes plus externalRefCount external nodes', () => {
    const { model, stats } = generateDwhModel({ objectCount: 800, seed: 7, profile: { externalRefCount: 12 } });
    const real = model.nodes.filter(n => n.type !== 'external');
    const external = model.nodes.filter(n => n.type === 'external');
    expect(real).toHaveLength(800);
    expect(external).toHaveLength(12);
    expect(stats.nodeCount).toBe(812);
  });
});

describe.each([2000, 10000])('generateDwhModel — asymmetry sanity at %i objects', (objectCount) => {
  const { model, stats } = generateDwhModel({ objectCount, seed: 1234 });

  it('logs the stats table', () => {
    console.log(`\n[dwh ${objectCount}]\n${formatDwhStats(stats)}`);
    expect(model.nodes.length).toBeGreaterThan(0);
  });

  it('edges per node land within the 2.5-3.5 band', () => {
    expect(stats.edgesPerNode).toBeGreaterThanOrEqual(2.5);
    expect(stats.edgesPerNode).toBeLessThanOrEqual(3.5);
  });

  it('at least one hub object exists with above-average degree', () => {
    const avgDegree = (stats.edgeCount * 2) / stats.nodeCount;
    expect(stats.hubs.length).toBeGreaterThan(0);
    expect(stats.hubs.some(h => h.total > avgDegree)).toBe(true);
  });
});

describe('generateDwhModel — dacpac round-trip', () => {
  loadParseRules();

  it('round-trips a 2k-object generated dacpac through the real extractor to the same node and edge counts', async () => {
    const gt = await buildSyntheticDacpac({ objectCount: 2000, schemaCount: 40, externalRefCount: 20 });
    const model = await extractDacpac(gt.buffer, undefined, undefined, { externalRefsEnabled: true });

    expect(model.nodes).toHaveLength(gt.totalNodeCount);
    expect(model.edges).toHaveLength(gt.edgeCount + gt.externalRefCount);
  });
});
