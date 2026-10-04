// @vitest-environment jsdom
// The real Trace View removal control invokes the hook and shares its preview's directed policy.
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Node as FlowNode } from '@xyflow/react';
import { NodeContextMenu } from '../../../src/components/NodeContextMenu';
import { useInteractiveTrace } from '../../../src/hooks/useInteractiveTrace';
import { TRACE_ALL_LEVELS } from '../../../src/engine/shared/bridgeContract';
import { canPruneTraceNode, traceRemovalSides } from '../../../src/engine/traceScope';
import { buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import { DEFAULT_CONFIG, type CustomNodeData, type DatabaseModel } from '../../../src/engine/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let latest: ReturnType<typeof useInteractiveTrace>;
let setCandidate: (id: string) => void;

function mount(pairs: Array<[string, string]>, origin: string, up: number, down: number) {
  const model: DatabaseModel = {
    nodes: [...new Set(pairs.flat())].map(id => ({ id, name: id, schema: 'dbo', fullName: id, type: 'table' })),
    edges: pairs.map(([source, target]) => ({ source, target, type: 'body' })),
    schemas: [], catalog: {}, neighborIndex: {},
  };
  const graph = buildGraphologyGraph(model);
  const nodes = model.nodes.map(n => ({
    id: n.id, position: { x: 0, y: 0 }, data: { label: n.name, schema: n.schema, objectType: n.type },
  })) as unknown as FlowNode<CustomNodeData>[];
  function Harness() {
    latest = useInteractiveTrace(graph, nodes, [], DEFAULT_CONFIG, model);
    const [candidate, changeCandidate] = useState('C');
    setCandidate = changeCandidate;
    return <NodeContextMenu x={10} y={10} nodeId={candidate} nodeName={candidate} schema="dbo"
      objectType="table" isTracing removeAction={{ kind: 'trace-prune' }}
      onClose={() => {}} onTrace={() => {}} onFindPath={() => {}} onViewDdl={() => {}} onShowDetails={() => {}}
      onTracePruneNode={latest.pruneTraceNode} />;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Harness />));
  act(() => latest.startTraceConfig(origin));
  act(() => latest.applyTrace(up, down));
  return graph;
}

function clickRemove(candidate = 'C') {
  act(() => setCandidate(candidate));
  const button = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Remove from trace'));
  if (!button) throw new Error('Trace View remove control missing');
  act(() => button.click());
}
const visible = () => [...latest.trace.tracedNodeIds].sort();

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove(); root = undefined; host = undefined;
});

describe('Trace View directed prune', () => {
  it('button removes C and its exclusive D in A→B↔C→D', () => {
    mount([['A', 'B'], ['B', 'C'], ['C', 'B'], ['C', 'D']], 'A', 0, TRACE_ALL_LEVELS);
    clickRemove();
    expect(visible()).toEqual(['A', 'B']);
    expect([...latest.trace.manualPrunedNodeIds].sort()).toEqual(['C', 'D']);
  });

  it('preview and button cannot retain D via a sideways downstream connection', () => {
    const graph = mount([['A', 'B'], ['B', 'C'], ['C', 'D'], ['A', 'X'], ['D', 'X']], 'A', 0, TRACE_ALL_LEVELS);
    const check = canPruneTraceNode(graph, 'A', latest.trace.tracedNodeIds, 'C',
      traceRemovalSides(latest.trace.upstreamLevels, latest.trace.downstreamLevels));
    expect(check.cutNodeIds).toEqual(['D']);
    clickRemove();
    expect(visible()).toEqual(['A', 'B', 'X']);
    expect([...latest.trace.manualPrunedNodeIds].sort()).toEqual(['C', 'D']);
  });

  it('keeps a shared D when the B/C cycle has another surviving path to D', () => {
    mount([['A', 'B'], ['B', 'C'], ['C', 'B'], ['C', 'D'], ['B', 'X'], ['X', 'D']], 'A', 0, TRACE_ALL_LEVELS);
    clickRemove();
    expect(visible()).toEqual(['A', 'B', 'D', 'X']);
    expect([...latest.trace.manualPrunedNodeIds]).toEqual(['C']);
  });

  it('sequential diamond button actions cut D/E only after the last arm', () => {
    mount([['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['B', 'X'], ['X', 'D']], 'A', 0, TRACE_ALL_LEVELS);
    clickRemove();
    expect(visible()).toEqual(['A', 'B', 'D', 'E', 'X']);
    clickRemove('X');
    expect(visible()).toEqual(['A', 'B']);
    expect([...latest.trace.manualPrunedNodeIds].sort()).toEqual(['C', 'D', 'E', 'X']);
  });

  it('uses the same upstream cut while the downstream level is zero', () => {
    mount([['B', 'A'], ['C', 'B'], ['B', 'C'], ['D', 'C']], 'A', TRACE_ALL_LEVELS, 0);
    clickRemove();
    expect(visible()).toEqual(['A', 'B']);
  });

  it('cycle removal terminates and removes only the unsupported open cycle', () => {
    mount([['A', 'C'], ['C', 'D'], ['D', 'E'], ['E', 'D']], 'A', 0, TRACE_ALL_LEVELS);
    clickRemove();
    expect(visible()).toEqual(['A']);
    expect([...latest.trace.manualPrunedNodeIds].sort()).toEqual(['C', 'D', 'E']);
  });

  it('ignores a prune click on the protected origin', () => {
    mount([['A', 'B'], ['B', 'C']], 'A', 0, TRACE_ALL_LEVELS);
    const before = latest.trace;
    clickRemove('A');
    expect(latest.trace).toBe(before);
    expect(visible()).toEqual(['A', 'B', 'C']);
  });

  it('cuts only the finite visible scope and reset restores the initial trace', () => {
    mount([['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E']], 'A', 0, 2);
    clickRemove();
    expect(visible()).toEqual(['A', 'B']);
    expect([...latest.trace.manualPrunedNodeIds]).toEqual(['C']);
    act(() => latest.resetTraceToStart());
    expect(visible()).toEqual(['A', 'B', 'C']);
    expect(latest.trace.manualPrunedNodeIds.size).toBe(0);
  });
});
