/** Rendered-graph connectivity guard. */

import { describe, it, expect } from 'vitest';
import { formatRenderConnectivity, summarizeRenderedConnectivity } from '../../../src/engine/renderConnectivity';

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

  it('debug text reports counts without member names', () => {
    const conn = summarizeRenderedConnectivity(
      [{ id: 'a', label: 'alpha' }, { id: 'b', label: 'beta' }],
      [],
    );
    const text = formatRenderConnectivity(conn);
    expect(text).toContain('Rendered: 2 nodes, 0 edges');
    expect(text).toContain('Components: 2');
    expect(text).toContain('Isolated: 2');
    expect(text).not.toContain('alpha');
    expect(text).not.toContain('beta');
  });
});
