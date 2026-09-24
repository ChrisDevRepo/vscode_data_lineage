// @vitest-environment jsdom
//
// Route view owned by the trace hook: a route holds every connecting path, routes resolve against
// the pre-route scope, a hidden node can be added, an empty list restores the trace, an unreachable route leaves the scope untouched.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Node as FlowNode } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useInteractiveTrace } from '../../../src/hooks/useInteractiveTrace';
import { buildGraphologyGraph } from '../../../src/engine/graphBuilder';
import { DEFAULT_CONFIG, type CustomNodeData, type DatabaseModel, type LineageEdge, type LineageNode } from '../../../src/engine/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const node = (name: string): LineageNode => ({ id: name, schema: 'dbo', name, fullName: `[dbo].[${name}]`, type: 'table' });
const edge = (source: string, target: string): LineageEdge => ({ source, target, type: 'body' });

/** b → o → c, o → d, a diamond o → m1|m2 → t, plus x → y unconnected to the origin. */
const model: DatabaseModel = {
  nodes: ['b', 'o', 'c', 'd', 'm1', 'm2', 't', 'x', 'y'].map(node),
  edges: [edge('b', 'o'), edge('o', 'c'), edge('o', 'd'), edge('o', 'm1'), edge('o', 'm2'), edge('m1', 't'), edge('m2', 't'), edge('x', 'y')],
  schemas: [],
  catalog: {},
  neighborIndex: {},
};
const graph = buildGraphologyGraph(model);
const flowNodes = model.nodes.map((n) => ({
  id: n.id,
  position: { x: 0, y: 0 },
  data: { label: n.name, schema: n.schema, objectType: n.type },
})) as unknown as FlowNode<CustomNodeData>[];
const flowEdges = model.edges.map((e) => ({ id: `${e.source}→${e.target}`, source: e.source, target: e.target }));

let latest: ReturnType<typeof useInteractiveTrace>;
function Harness() {
  latest = useInteractiveTrace(graph, flowNodes, flowEdges, DEFAULT_CONFIG, model);
  return null;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  root = createRoot(host);
  act(() => root.render(<Harness />));
  act(() => latest.startTraceImmediate('o'));
});

afterEach(() => {
  act(() => root.unmount());
});

describe('useInteractiveTrace route view', () => {
  it('shows only the checked route while the navigator keeps the full scope', () => {
    act(() => { expect(latest.setFocusTargets(['c'])).toBe(true); });
    expect([...latest.trace.tracedNodeIds].sort()).toEqual(['c', 'o']);
    expect(latest.isFocusPaths).toBe(true);
    expect(latest.focusTargetIds).toEqual(['c']);
    expect([...latest.navigatorTrace.tracedNodeIds].sort()).toEqual(['b', 'c', 'd', 'm1', 'm2', 'o', 't']);
  });

  it('keeps both branches of a diamond route', () => {
    act(() => { expect(latest.setFocusTargets(['t'])).toBe(true); });
    expect([...latest.trace.tracedNodeIds].sort()).toEqual(['m1', 'm2', 'o', 't']);
  });

  it('adds a route to a node the current routes hide', () => {
    act(() => { latest.setFocusTargets(['c']); });
    act(() => { expect(latest.setFocusTargets(['c', 'b'])).toBe(true); });
    expect([...latest.trace.tracedNodeIds].sort()).toEqual(['b', 'c', 'o']);
  });

  it('restores the trace when the last route is removed', () => {
    const before = latest.trace;
    act(() => { latest.setFocusTargets(['c']); });
    act(() => { latest.setFocusTargets([]); });
    expect(latest.isFocusPaths).toBe(false);
    expect(latest.trace).toBe(before);
    expect([...latest.trace.tracedNodeIds].sort()).toEqual(['b', 'c', 'd', 'm1', 'm2', 'o', 't']);
  });

  it('refuses a route outside the scope and leaves the trace untouched', () => {
    act(() => { expect(latest.setFocusTargets(['y'])).toBe(false); });
    expect(latest.isFocusPaths).toBe(false);
    expect([...latest.trace.tracedNodeIds].sort()).toEqual(['b', 'c', 'd', 'm1', 'm2', 'o', 't']);
  });
});
