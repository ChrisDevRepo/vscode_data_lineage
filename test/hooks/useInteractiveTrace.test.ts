/**
 * useInteractiveTrace state machine tests.
 *
 * Suite A — Initial state
 * Suite B — startTraceConfig
 * Suite C — startTraceImmediate
 * Suite D — applyTrace
 * Suite E — startPathFinding
 * Suite F — applyPath
 * Suite G — applyAnalysisSubset
 * Suite H — endTrace / clearTrace
 * Suite I — tracedNodes/tracedEdges memoization
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Graph from 'graphology';
import type { Node as FlowNode } from '@xyflow/react';
import { useInteractiveTrace } from '../../src/hooks/useInteractiveTrace';
import type { CustomNodeData } from '../../src/components/CustomNode';
import { DEFAULT_CONFIG } from '../../src/engine/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGraph(nodes: string[], edges: [string, string][]): Graph {
  const g = new Graph({ type: 'directed', multi: false });
  for (const id of nodes) g.addNode(id, { schema: 'dbo', name: id, type: 'table' });
  for (const [s, t] of edges) g.addEdgeWithKey(`${s}→${t}`, s, t, { type: 'body' });
  return g;
}

function makeFlowNodes(ids: string[]): FlowNode<CustomNodeData>[] {
  return ids.map(id => ({
    id,
    type: 'lineageNode',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      schema: 'dbo',
      fullName: `[dbo].[${id}]`,
      objectType: 'table' as const,
      inDegree: 1,
      outDegree: 1,
    },
  }));
}

// Linear chain used by most tests: A → B → C
const CHAIN_NODES = ['A', 'B', 'C'];
const CHAIN_EDGES: [string, string][] = [['A', 'B'], ['B', 'C']];

// ─── Suite A — Initial state ──────────────────────────────────────────────────

describe('Suite A — initial state', () => {
  it('mode starts as none', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    expect(result.current.trace.mode).toBe('none');
  });

  it('selectedNodeId is null', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    expect(result.current.trace.selectedNodeId).toBeNull();
  });

  it('targetNodeId is null', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    expect(result.current.trace.targetNodeId).toBeNull();
  });

  it('tracedNodeIds is empty', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    expect(result.current.trace.tracedNodeIds.size).toBe(0);
  });

  it('levels match config defaults', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], [], DEFAULT_CONFIG));
    expect(result.current.trace.upstreamLevels).toBe(DEFAULT_CONFIG.trace.defaultUpstreamLevels);
    expect(result.current.trace.downstreamLevels).toBe(DEFAULT_CONFIG.trace.defaultDownstreamLevels);
  });

  it('tracedNodes returns all flowNodes when mode is none', () => {
    const nodes = makeFlowNodes(['A', 'B']);
    const { result } = renderHook(() => useInteractiveTrace(null, nodes, []));
    expect(result.current.tracedNodes).toEqual(nodes);
  });
});

// ─── Suite B — startTraceConfig ──────────────────────────────────────────────

describe('Suite B — startTraceConfig', () => {
  it('sets mode to configuring', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => { result.current.startTraceConfig('A'); });
    expect(result.current.trace.mode).toBe('configuring');
  });

  it('sets selectedNodeId', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => { result.current.startTraceConfig('node-42'); });
    expect(result.current.trace.selectedNodeId).toBe('node-42');
  });

  it('resets tracedNodeIds to empty', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => { result.current.startTraceConfig('A'); });
    expect(result.current.trace.tracedNodeIds.size).toBe(0);
  });

  it('does not require a graph — no early return', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    expect(() => act(() => { result.current.startTraceConfig('A'); })).not.toThrow();
    expect(result.current.trace.mode).toBe('configuring');
  });

  it('tracedNodes still returns all flow nodes in configuring mode', () => {
    const nodes = makeFlowNodes(['A', 'B', 'C']);
    const { result } = renderHook(() => useInteractiveTrace(null, nodes, []));
    act(() => { result.current.startTraceConfig('B'); });
    expect(result.current.tracedNodes).toEqual(nodes);
  });
});

// ─── Suite C — startTraceImmediate ───────────────────────────────────────────

describe('Suite C — startTraceImmediate', () => {
  it('stays in none mode when graph is null', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => { result.current.startTraceImmediate('A'); });
    expect(result.current.trace.mode).toBe('none');
  });

  it('sets mode to filtered when graph is available', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startTraceImmediate('B'); });
    expect(result.current.trace.mode).toBe('filtered');
  });

  it('always includes the origin node in tracedNodeIds', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startTraceImmediate('B'); });
    expect(result.current.trace.tracedNodeIds.has('B')).toBe(true);
  });

  it('traces neighbors (tracedNodeIds > 1 for a connected node)', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startTraceImmediate('B'); });
    expect(result.current.trace.tracedNodeIds.size).toBeGreaterThan(1);
  });

  it('sets selectedNodeId to the traced node', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startTraceImmediate('C'); });
    expect(result.current.trace.selectedNodeId).toBe('C');
  });

  it('an isolated node produces tracedNodeIds of size 1', () => {
    const graph = makeGraph(['X'], []);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startTraceImmediate('X'); });
    expect(result.current.trace.tracedNodeIds.size).toBe(1);
  });
});

// ─── Suite D — applyTrace ─────────────────────────────────────────────────────

describe('Suite D — applyTrace', () => {
  it('does not change mode when no selectedNodeId (no config phase first)', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.applyTrace(2, 2); });
    expect(result.current.trace.mode).toBe('none');
  });

  it('does not change mode when graph is null (even with selectedNodeId set)', () => {
    // No graph → startTraceConfig sets selectedNodeId without needing graph
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => { result.current.startTraceConfig('B'); });
    act(() => { result.current.applyTrace(2, 2); });
    expect(result.current.trace.mode).toBe('configuring'); // unchanged from configuring
  });

  it('sets mode to applied after startTraceConfig + graph', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startTraceConfig('B'); });
    act(() => { result.current.applyTrace(1, 1); });
    expect(result.current.trace.mode).toBe('applied');
  });

  it('stores the upstream and downstream level arguments', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startTraceConfig('B'); });
    act(() => { result.current.applyTrace(5, 2); });
    expect(result.current.trace.upstreamLevels).toBe(5);
    expect(result.current.trace.downstreamLevels).toBe(2);
  });

  it('populates tracedNodeIds after apply', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startTraceConfig('B'); });
    act(() => { result.current.applyTrace(3, 3); });
    expect(result.current.trace.tracedNodeIds.size).toBeGreaterThan(0);
  });

  it('upstream-only (downstreamLevels=0) does not include downstream-only nodes', () => {
    // A → B → C: trace from B upstream=1, downstream=0 → {A, B}, not C
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startTraceConfig('B'); });
    act(() => { result.current.applyTrace(1, 0); });
    expect(result.current.trace.tracedNodeIds.has('C')).toBe(false);
    expect(result.current.trace.tracedNodeIds.has('B')).toBe(true);
    expect(result.current.trace.tracedNodeIds.has('A')).toBe(true);
  });

  it('downstream-only (upstreamLevels=0) does not include upstream-only nodes', () => {
    // A → B → C: trace from B upstream=0, downstream=1 → {B, C}, not A
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startTraceConfig('B'); });
    act(() => { result.current.applyTrace(0, 1); });
    expect(result.current.trace.tracedNodeIds.has('A')).toBe(false);
    expect(result.current.trace.tracedNodeIds.has('B')).toBe(true);
    expect(result.current.trace.tracedNodeIds.has('C')).toBe(true);
  });
});

// ─── Suite E — startPathFinding ───────────────────────────────────────────────

describe('Suite E — startPathFinding', () => {
  it('sets mode to pathfinding', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => { result.current.startPathFinding('A'); });
    expect(result.current.trace.mode).toBe('pathfinding');
  });

  it('sets selectedNodeId to the source node', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => { result.current.startPathFinding('A'); });
    expect(result.current.trace.selectedNodeId).toBe('A');
  });

  it('resets both levels to 0', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => { result.current.startPathFinding('A'); });
    expect(result.current.trace.upstreamLevels).toBe(0);
    expect(result.current.trace.downstreamLevels).toBe(0);
  });

  it('targetNodeId is null', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => { result.current.startPathFinding('A'); });
    expect(result.current.trace.targetNodeId).toBeNull();
  });

  it('tracedNodes returns all flow nodes in pathfinding mode', () => {
    const nodes = makeFlowNodes(['A', 'B', 'C']);
    const { result } = renderHook(() => useInteractiveTrace(null, nodes, []));
    act(() => { result.current.startPathFinding('A'); });
    expect(result.current.tracedNodes).toEqual(nodes);
  });
});

// ─── Suite F — applyPath ──────────────────────────────────────────────────────

describe('Suite F — applyPath', () => {
  it('returns false when graph is null', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => { result.current.startPathFinding('A'); });
    let found = false;
    act(() => { found = result.current.applyPath('C'); });
    expect(found).toBe(false);
  });

  it('returns false when no path exists between disconnected nodes', () => {
    // A → B   C (isolated)
    const graph = makeGraph(['A', 'B', 'C'], [['A', 'B']]);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startPathFinding('A'); });
    let found = false;
    act(() => { found = result.current.applyPath('C'); });
    expect(found).toBe(false);
  });

  it('mode stays pathfinding when no path found', () => {
    const graph = makeGraph(['A', 'B', 'C'], [['A', 'B']]);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startPathFinding('A'); });
    act(() => { result.current.applyPath('C'); });
    expect(result.current.trace.mode).toBe('pathfinding');
  });

  it('returns true when a path exists', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startPathFinding('A'); });
    let found = false;
    act(() => { found = result.current.applyPath('C'); });
    expect(found).toBe(true);
  });

  it('sets mode to path-applied on success', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startPathFinding('A'); });
    act(() => { result.current.applyPath('C'); });
    expect(result.current.trace.mode).toBe('path-applied');
  });

  it('sets targetNodeId on success', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startPathFinding('A'); });
    act(() => { result.current.applyPath('C'); });
    expect(result.current.trace.targetNodeId).toBe('C');
  });

  it('path nodes are in tracedNodeIds', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startPathFinding('A'); });
    act(() => { result.current.applyPath('C'); });
    expect(result.current.trace.tracedNodeIds.has('A')).toBe(true);
    expect(result.current.trace.tracedNodeIds.has('C')).toBe(true);
  });

  it('upstream path also works (C → A via reverse)', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    // computeShortestPath tries both directions
    act(() => { result.current.startPathFinding('C'); });
    let found = false;
    act(() => { found = result.current.applyPath('A'); });
    expect(found).toBe(true);
  });
});

// ─── Suite G — applyAnalysisSubset ───────────────────────────────────────────

describe('Suite G — applyAnalysisSubset', () => {
  it('sets mode to analysis', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => {
      result.current.applyAnalysisSubset(new Set(['A', 'B']), new Set(['A→B']), 'A', 'hubs');
    });
    expect(result.current.trace.mode).toBe('analysis');
  });

  it('stores analysisType', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => {
      result.current.applyAnalysisSubset(new Set(['A']), new Set(), 'A', 'orphans');
    });
    expect(result.current.trace.analysisType).toBe('orphans');
  });

  it('origin is stored as selectedNodeId', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => {
      result.current.applyAnalysisSubset(new Set(['B']), new Set(), 'B', 'hubs');
    });
    expect(result.current.trace.selectedNodeId).toBe('B');
  });

  it('undefined origin → selectedNodeId is null', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => {
      result.current.applyAnalysisSubset(new Set(['A', 'B']), new Set(), undefined, 'islands');
    });
    expect(result.current.trace.selectedNodeId).toBeNull();
  });

  it('stores the exact nodeIds set', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    const nodeIds = new Set(['X', 'Y', 'Z']);
    act(() => {
      result.current.applyAnalysisSubset(nodeIds, new Set(), undefined, 'islands');
    });
    expect(result.current.trace.tracedNodeIds).toEqual(nodeIds);
  });

  it('works without a graph', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    expect(() => act(() => {
      result.current.applyAnalysisSubset(new Set(['A']), new Set(), 'A', 'cycles');
    })).not.toThrow();
  });
});

// ─── Suite H — endTrace / clearTrace ─────────────────────────────────────────

describe('Suite H — endTrace / clearTrace', () => {
  it('endTrace resets mode to none from filtered', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startTraceImmediate('B'); });
    expect(result.current.trace.mode).toBe('filtered');
    act(() => { result.current.endTrace(); });
    expect(result.current.trace.mode).toBe('none');
  });

  it('endTrace clears selectedNodeId', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startTraceImmediate('B'); });
    act(() => { result.current.endTrace(); });
    expect(result.current.trace.selectedNodeId).toBeNull();
  });

  it('endTrace clears tracedNodeIds', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startTraceImmediate('B'); });
    expect(result.current.trace.tracedNodeIds.size).toBeGreaterThan(0);
    act(() => { result.current.endTrace(); });
    expect(result.current.trace.tracedNodeIds.size).toBe(0);
  });

  it('clearTrace is equivalent to endTrace', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startTraceImmediate('B'); });
    act(() => { result.current.clearTrace(); });
    expect(result.current.trace.mode).toBe('none');
    expect(result.current.trace.selectedNodeId).toBeNull();
  });

  it('resets from configuring mode', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => { result.current.startTraceConfig('A'); });
    act(() => { result.current.endTrace(); });
    expect(result.current.trace.mode).toBe('none');
  });

  it('resets from analysis mode', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => { result.current.applyAnalysisSubset(new Set(['A']), new Set(), 'A', 'hubs'); });
    act(() => { result.current.endTrace(); });
    expect(result.current.trace.mode).toBe('none');
  });

  it('resets from pathfinding mode', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, [], []));
    act(() => { result.current.startPathFinding('A'); });
    act(() => { result.current.endTrace(); });
    expect(result.current.trace.mode).toBe('none');
  });

  it('resets from path-applied mode', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, [], []));
    act(() => { result.current.startPathFinding('A'); });
    act(() => { result.current.applyPath('C'); });
    expect(result.current.trace.mode).toBe('path-applied');
    act(() => { result.current.endTrace(); });
    expect(result.current.trace.mode).toBe('none');
    expect(result.current.trace.targetNodeId).toBeNull();
  });
});

// ─── Suite I — tracedNodes / tracedEdges memoization ─────────────────────────

describe('Suite I — tracedNodes/tracedEdges memoization', () => {
  const FLOW_NODES = makeFlowNodes(['A', 'B', 'C']);
  const FLOW_EDGES = [
    { id: 'A→B', source: 'A', target: 'B', type: 'lineageEdge' },
    { id: 'B→C', source: 'B', target: 'C', type: 'lineageEdge' },
  ];

  it('in none mode returns all flow nodes unchanged', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, FLOW_NODES, FLOW_EDGES));
    expect(result.current.tracedNodes).toEqual(FLOW_NODES);
    expect(result.current.tracedEdges).toEqual(FLOW_EDGES);
  });

  it('in configuring mode returns all flow nodes unchanged', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, FLOW_NODES, FLOW_EDGES));
    act(() => { result.current.startTraceConfig('B'); });
    expect(result.current.tracedNodes).toEqual(FLOW_NODES);
  });

  it('in pathfinding mode returns all flow nodes unchanged', () => {
    const { result } = renderHook(() => useInteractiveTrace(null, FLOW_NODES, FLOW_EDGES));
    act(() => { result.current.startPathFinding('A'); });
    expect(result.current.tracedNodes).toEqual(FLOW_NODES);
  });

  it('in filtered mode returns a subset — upstream-1 from C excludes A', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() =>
      useInteractiveTrace(graph, FLOW_NODES, FLOW_EDGES, {
        ...DEFAULT_CONFIG,
        trace: { defaultUpstreamLevels: 1, defaultDownstreamLevels: 0 },
      })
    );
    act(() => { result.current.startTraceImmediate('C'); });
    // upstream 1 from C: {B, C}; downstream 0: none extra
    expect(result.current.tracedNodes.some(n => n.id === 'A')).toBe(false);
    expect(result.current.tracedNodes.some(n => n.id === 'C')).toBe(true);
  });

  it('after endTrace tracedNodes returns all flow nodes again', () => {
    const graph = makeGraph(CHAIN_NODES, CHAIN_EDGES);
    const { result } = renderHook(() => useInteractiveTrace(graph, FLOW_NODES, FLOW_EDGES));
    act(() => { result.current.startTraceImmediate('B'); });
    act(() => { result.current.endTrace(); });
    expect(result.current.tracedNodes).toEqual(FLOW_NODES);
  });
});
