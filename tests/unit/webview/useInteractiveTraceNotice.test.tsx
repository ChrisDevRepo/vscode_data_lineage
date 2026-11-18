// @vitest-environment jsdom
/**
 * The "trace not visible" warning is posted once per computed trace view, from an effect, so a
 * StrictMode double render does not produce a second toast and `applyTraceToFlow` stays pure.
 */
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Node as FlowNode } from '@xyflow/react';
import { useInteractiveTrace } from '../../../src/hooks/useInteractiveTrace';
import { applyTraceToFlow, buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import { DEFAULT_CONFIG, type CustomNodeData, type DatabaseModel, type TraceState } from '../../../src/engine/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const model: DatabaseModel = {
  nodes: ['A', 'B', 'X'].map(id => ({ id, name: id, schema: 'dbo', fullName: id, type: 'table' })),
  edges: [{ source: 'A', target: 'B', type: 'body' }],
  schemas: [], catalog: {}, neighborIndex: {},
};
const graph = buildGraphologyGraph(model);
/** The rendered flow holds only `X`, so a trace over `A`/`B` projects to nothing. */
const flow = [{ id: 'X', position: { x: 0, y: 0 }, data: { label: 'X', schema: 'dbo', objectType: 'table' } }] as unknown as FlowNode<CustomNodeData>[];

const w = window as unknown as { vscode?: { postMessage: (m: unknown) => void } };
let posted: Array<{ type: string; text?: string }>;
let root: Root;
let host: HTMLDivElement;
let latest: ReturnType<typeof useInteractiveTrace>;

beforeEach(() => {
  posted = [];
  w.vscode = { postMessage: (m: unknown) => { posted.push(m as { type: string; text?: string }); } };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete w.vscode;
});

function Harness() {
  latest = useInteractiveTrace(graph, flow, [], DEFAULT_CONFIG, model);
  return null;
}

const warnings = () => posted.filter(m => m.type === 'show-warning' && m.text === 'Traced nodes are not visible in the current view.');

describe('trace visibility notice', () => {
  it('posts exactly one warning under StrictMode when a trace projects to nothing', () => {
    act(() => root.render(<StrictMode><Harness /></StrictMode>));
    act(() => latest.startTraceConfig('A'));
    act(() => latest.applyTrace(1, 1));
    expect([...latest.trace.tracedNodeIds].sort()).toEqual(['A', 'B']);
    expect(warnings()).toHaveLength(1);
  });

  it('posts again for a second trace that shows the same notice', () => {
    act(() => root.render(<StrictMode><Harness /></StrictMode>));
    act(() => latest.startTraceConfig('A'));
    act(() => latest.applyTrace(1, 1));
    act(() => latest.endTrace());
    act(() => latest.startTraceConfig('B'));
    act(() => latest.applyTrace(1, 1));
    expect(warnings()).toHaveLength(2);
  });

  it('posts exactly one "Trace produced no results." warning under StrictMode for an empty scope', () => {
    act(() => root.render(<StrictMode><Harness /></StrictMode>));
    act(() => latest.applyAnalysisSubset(new Set(), new Set(), undefined, 'orphans'));
    expect(latest.trace.mode).toBe('analysis');
    expect(posted.filter(m => m.type === 'show-warning' && m.text === 'Trace produced no results.')).toHaveLength(1);
  });

  it('applyTraceToFlow returns the notice and posts nothing itself', () => {
    const trace = { mode: 'applied', selectedNodeId: 'A', targetNodeId: null, upstreamLevels: 1, downstreamLevels: 1,
      tracedNodeIds: new Set(['A', 'B']), tracedEdgeIds: new Set<string>() } as unknown as TraceState;
    const result = applyTraceToFlow(flow, [], trace, DEFAULT_CONFIG, model);
    expect((result as { notice?: string }).notice).toBe('Traced nodes are not visible in the current view.');
    expect(posted).toEqual([]);
  });
});
