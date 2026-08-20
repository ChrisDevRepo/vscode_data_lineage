/**
 * Rendered-graph connectivity guard.
 *
 * Verifies the debug-dump "what the user sees" summary: an expanded schema's
 * connected objects form one component while collapsed clusters with no bridge
 * edge are reported as isolated — and a single bridge edge joins a cluster into
 * its neighbour's component.
 */

import { describe, it, expect } from 'vitest';
import { summarizeRenderedConnectivity } from '../../../src/engine/renderConnectivity';

describe('Rendered Connectivity', () => {
  it('expanded ai (connected) + two orphan clusters', () => {
    const nodes = [
      { id: 'ai.a', label: 'a' }, { id: 'ai.b', label: 'b' }, { id: 'ai.c', label: 'c' },
      { id: '__schema__Production', label: 'Production' },
      { id: '__schema__Sales', label: 'Sales' },
    ];
    const edges = [
      { source: 'ai.a', target: 'ai.b' },
      { source: 'ai.b', target: 'ai.c' },
    ];
    const conn = summarizeRenderedConnectivity(nodes, edges);

    expect(conn.componentCount, 'three components: ai cluster + two orphan schema clusters').toBe(3);
    expect(conn.isolatedNodes.includes('Production'), 'Production cluster reported isolated').toBe(true);
    expect(conn.isolatedNodes.includes('Sales'), 'Sales cluster reported isolated').toBe(true);
    expect(conn.components[0].size, 'largest component has the 3 connected ai objects').toBe(3);
  });

  it('a bridge edge joins Production into the ai component', () => {
    const nodes = [
      { id: 'ai.a', label: 'a' }, { id: 'ai.b', label: 'b' },
      { id: '__schema__Production', label: 'Production' },
      { id: '__schema__Sales', label: 'Sales' },
    ];
    const edges = [
      { source: 'ai.a', target: 'ai.b' },
      { source: 'ai.b', target: '__schema__Production' }, // bridge to cluster
    ];
    const conn = summarizeRenderedConnectivity(nodes, edges);

    expect(conn.componentCount, 'Production joins ai; only Sales stays orphaned').toBe(2);
    expect(conn.isolatedNodes.includes('Sales'), 'Sales still isolated').toBe(true);
    expect(conn.isolatedNodes.includes('Production'), 'Production no longer isolated').toBe(false);
  });
});
