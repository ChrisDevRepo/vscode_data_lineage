/**
 * Webview→host diagnostic and screen-state frames: the detail-panel diagnostic funnel, and the
 * `filter-changed` / `render-state` buffers the host walks — well-shaped passes with unknown extras
 * kept literally, a malformed buffer rejects at the boundary.
 */
import { describe, expect, it } from 'vitest';
import {
  DetailPanelToExtensionMsgSchema,
  MainPanelToExtensionMsgSchema,
} from '../../../src/engine/shared/bridgeContract';

describe('detail-panel diagnostics contract', () => {
  it.each([
    { type: 'error', error: 'render failed', source: 'error-boundary' },
    { type: 'show-warning', text: 'profiling is unavailable' },
  ])('accepts $type messages handled by the shared diagnostic funnel', (message) => {
    expect(DetailPanelToExtensionMsgSchema.safeParse(message).success).toBe(true);
  });

  it('still rejects unknown detail-panel messages', () => {
    expect(DetailPanelToExtensionMsgSchema.safeParse({ type: 'log', text: 'raw' }).success).toBe(false);
  });
});

const side = {
  add: ['dbo.a'],
  prune: [],
  addDisabledReason: '',
  pruneDisabledReason: 'nothing to prune',
  neighborCount: 1,
  visibleNeighborCount: 0,
};

function uiState(): Record<string, unknown> {
  return {
    filter: {
      schemas: ['dbo'],
      types: ['table'],
      hideIsolated: false,
      focusSchemas: [],
      showExternalRefs: true,
      externalRefTypes: [],
      exclusionPatterns: [],
    },
    expandedSchemaView: null,
    trace: {
      mode: 'applied',
      selectedNodeId: 'dbo.a',
      targetNodeId: null,
      upstreamLevels: 2,
      downstreamLevels: Number.MAX_SAFE_INTEGER,
      analysisType: undefined,
      autoPromoted: false,
    },
    graphMode: 'full',
    filteredCount: 12,
    renderLimitHit: 0,
    screenState: {
      analytics: { type: 'islands', activeGroupId: 'g1', groups: [{ id: 'g1', label: 'Island 1', nodeIds: ['dbo.a'] }] },
      bookmark: { id: 'b1', name: 'Sales', source: 'ai', allowlistNodeIds: ['dbo.a'] },
      detailOpen: true,
    },
  };
}

function renderState(): Record<string, unknown> {
  return {
    projectId: 'p1',
    sourceName: 'demo',
    graphMode: 'full',
    renderedNodeCount: 3,
    connectivity: { nodeCount: 3, edgeCount: 2, componentCount: 1, components: [{ size: 3, nodes: ['a', 'b', 'c'] }], isolatedNodes: [] },
    highlightedNodeId: 'dbo.a',
    affordances: { nodeId: 'dbo.a', in: side, out: side },
    traceScope: {
      mode: 'applied',
      origin: 'dbo.a',
      baseNodeIds: ['dbo.a'],
      manualAddedNodeIds: [],
      manualPrunedNodeIds: [],
      tracedNodeIds: ['dbo.a', 'dbo.b'],
    },
  };
}

describe('main-panel screen-state contract', () => {
  it('accepts the filter-changed ui-state the webview posts and keeps unknown fields literally', () => {
    const parsed = MainPanelToExtensionMsgSchema.safeParse({
      type: 'filter-changed',
      uiState: { ...uiState(), futureField: { nested: 1 } },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ uiState: { futureField: { nested: 1 }, graphMode: 'full' } });
  });

  it('accepts the render-state the webview posts and keeps unknown fields literally', () => {
    const parsed = MainPanelToExtensionMsgSchema.safeParse({
      type: 'render-state',
      renderState: { ...renderState(), futureField: 'x' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ renderState: { futureField: 'x', projectId: 'p1' } });
  });

  it.each([
    ['a non-object ui-state', () => 'broken'],
    ['a missing ui-state', () => undefined],
    ['a filter that is not a filter record', () => ({ ...uiState(), filter: 'dbo' })],
    ['an unknown graph mode', () => ({ ...uiState(), graphMode: 'sideways' })],
    ['a non-numeric filtered count', () => ({ ...uiState(), filteredCount: '12' })],
    ['analytics groups that are not a list', () => ({ ...uiState(), screenState: { analytics: { type: 'islands', activeGroupId: null, groups: 'g1' } } })],
    ['a bookmark allowlist that is not a list', () => ({ ...uiState(), screenState: { bookmark: { id: 'b', name: 'n', source: null, allowlistNodeIds: 'dbo.a' } } })],
  ])('rejects filter-changed carrying %s', (_label, build) => {
    expect(MainPanelToExtensionMsgSchema.safeParse({ type: 'filter-changed', uiState: build() }).success).toBe(false);
  });

  it.each([
    ['a non-object render-state', () => 42],
    ['traced ids that are not a list', () => ({ ...renderState(), traceScope: { ...(renderState().traceScope as object), tracedNodeIds: 'dbo.a' } })],
    ['a trace scope missing its id lists', () => ({ ...renderState(), traceScope: { mode: 'applied', origin: null } })],
    ['affordances whose add list is a string', () => ({ ...renderState(), affordances: { nodeId: 'dbo.a', in: { ...side, add: 'dbo.a' }, out: side } })],
    ['connectivity without its component list', () => ({ ...renderState(), connectivity: { nodeCount: 1 } })],
  ])('rejects render-state carrying %s', (_label, build) => {
    expect(MainPanelToExtensionMsgSchema.safeParse({ type: 'render-state', renderState: build() }).success).toBe(false);
  });
});
