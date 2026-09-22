/**
 * Checkpoint restore tolerance for keys a current build no longer declares.
 *
 * The snapshot boundary is `.strict()`, so a key removed from the engine is a restore failure for
 * every record an older build already wrote to `globalState` — silent loss of the user's stored
 * exploration. A removed key is therefore retired the way `qualityGuards` was: still accepted,
 * transformed away before restore, never written again.
 */
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import type { DatabaseModel, LineageNode } from '../../../src/engine/types';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from './helpers/fixtures';
import { describe, expect, it } from 'vitest';

describe('Navigation checkpoint — retired keys', () => {
  const nodes: LineageNode[] = [
    makeNode({ id: 'origin', schema: 'ai', name: 'FactSalesReport', type: 'procedure' }),
    makeNode({ id: 'src', schema: 'ai', name: 'vwConsolidatedSales', type: 'view' }),
  ];
  const edges: Array<[string, string]> = [['src', 'origin']];
  const model: DatabaseModel = makeModel(nodes, edges, ['ai']);
  const graph = makeGraph(nodes, edges);

  function snapshot(): ReturnType<NavigationEngine['toJSON']> {
    const engine = new NavigationEngine(model, graph, () => {}, {});
    engine.init({ origin: 'origin', question: 'trace', direction: 'upstream', depthIntent: { kind: 'explicit', levels: 1 } });
    return engine.toJSON();
  }

  it('a record still carrying the retired extendedDepthCap restores', () => {
    const legacy = snapshot() as unknown as { engineInternals: Record<string, unknown> };
    legacy.engineInternals.extendedDepthCap = 3;

    const restored = NavigationEngine.fromJSON(legacy as never, model, graph, () => {});

    expect(restored.scopeSize, 'the restored engine carries the checkpoint scope').toBe(snapshot().scopeSize);
    expect('extendedDepthCap' in (restored.toJSON().engineInternals as unknown as Record<string, unknown>),
      'the retired key is never written back').toBe(false);
  });

  it('a record written by this build declares no extendedDepthCap at all', () => {
    expect('extendedDepthCap' in (snapshot().engineInternals as unknown as Record<string, unknown>),
      'the current write path declares only current keys').toBe(false);
  });
});
