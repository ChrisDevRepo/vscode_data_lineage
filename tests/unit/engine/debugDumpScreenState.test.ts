import { describe, it, expect } from 'vitest';
import {
  formatScreenStateSections,
  type RenderStateSnapshot,
  type ScreenStateExtras,
} from '../../../src/bridge/debugDumpScreenState';
import type { DatabaseModel } from '../../../src/engine/types';

describe('Debug Dump Screen-State', () => {
  it('screen-state formatter (deterministic)', () => {
    // proc 'p' inbound: 'b' (origin, in-trace) + 'x' (off-trace). 'u' is the other downstream leaf.
    const model = {
      edges: [
        { source: 'b', target: 'p' },
        { source: 'b', target: 'u' },
        { source: 'x', target: 'p' },
      ],
    } as unknown as DatabaseModel;

    const renderState: RenderStateSnapshot = {
      highlightedNodeId: 'p',
      affordances: {
        nodeId: 'p',
        in: {
          add: ['x'],
          prune: [],
          addDisabledReason: 'All upstream neighbors are already shown',
          pruneDisabledReason: 'This is the trace source — it cannot be removed',
          neighborCount: 2,
          visibleNeighborCount: 1,
        },
        out: { add: [], prune: [], addDisabledReason: '', pruneDisabledReason: '', neighborCount: 0, visibleNeighborCount: 0 },
      },
      traceScope: {
        mode: 'applied',
        origin: 'b',
        baseNodeIds: ['b', 'u', 'p'],
        manualAddedNodeIds: [],
        manualPrunedNodeIds: [],
        tracedNodeIds: ['b', 'u', 'p'],
      },
    };
    const screenState: ScreenStateExtras = { analytics: null, bookmark: null, detailOpen: true };

    const out = formatScreenStateSections(renderState, screenState, model);

    expect(out.includes('SELECTION & AFFORDANCES'), 'has SELECTION & AFFORDANCES section').toBe(true);
    expect(out.includes('Highlighted node: p'), 'reports the highlighted node').toBe(true);
    expect(out.includes('+add [x]'), 'inbound add offers the off-trace neighbour x').toBe(true);
    expect(out.includes('prune grayed: This is the trace source'), 'inbound prune grayed with accurate origin reason').toBe(true);
    expect(out.includes('TRACE SCOPE'), 'has TRACE SCOPE section').toBe(true);
    expect(out.includes('Traced (3)'), 'trace scope reports 3 traced nodes').toBe(true);
    expect(out.includes('DETAIL PANEL'), 'has DETAIL PANEL section').toBe(true);
    expect(out.includes('x [off-trace]'), 'detail panel tags x as off-trace').toBe(true);
    expect(out.includes('b [in-trace]'), 'detail panel tags origin b as in-trace').toBe(true);
  });

  it('screen-state formatter (analytics + bookmark)', () => {
    const renderState: RenderStateSnapshot = { highlightedNodeId: null, affordances: null, traceScope: null };
    const screenState: ScreenStateExtras = {
      analytics: { type: 'hubs', activeGroupId: 'g1', groups: [{ id: 'g1', label: 'Top hubs', nodeIds: ['a', 'b'] }] },
      bookmark: { id: 'bm1', name: 'Sales core', source: 'ai', allowlistNodeIds: ['a', 'b', 'c'] },
      detailOpen: false,
    };

    const out = formatScreenStateSections(renderState, screenState, null);
    expect(out.includes('Affordances:      (none'), 'no-selection affordance note shown').toBe(true);
    expect(out.includes('ANALYTICS'), 'has ANALYTICS section when analytics active').toBe(true);
    expect(out.includes('▶ Top hubs (2)'), 'active analytics group marked and counted').toBe(true);
    expect(out.includes('BOOKMARK (active advanced view)'), 'has BOOKMARK section').toBe(true);
    expect(out.includes('Sales core [ai] — allowlist 3 node(s)'), 'bookmark name/source/allowlist size shown').toBe(true);
  });

});
