/** Scale correctness at the supported render ceiling; no machine-dependent latency threshold. */
import { expect, it } from 'vitest';
import { buildGraph } from '../../src/engine/graphBuilder';
import { DEFAULT_CONFIG } from '../../src/engine/types';
import { buildLargeModel } from '../unit/webview/largeGraphFixture';

it('lays out 1500 nodes without losing objects or reciprocal edge pairs', () => {
  const model = buildLargeModel(1500);
  const pairs = new Set(model.edges.map(e => [e.source, e.target].sort().join(' -> ')));
  const started = performance.now();
  const result = buildGraph(model, DEFAULT_CONFIG);
  expect(result.flowNodes).toHaveLength(1500);
  expect(result.graph.order).toBe(1500);
  expect(result.flowEdges).toHaveLength(pairs.size);
  expect(new Set(result.flowNodes.map(n => `${n.position.x},${n.position.y}`)).size).toBeGreaterThan(750);
  console.log(`scale correctness: 1500 nodes, ${model.edges.length} edges, ${Math.round(performance.now() - started)}ms; timing is descriptive`);
}, 300_000);
