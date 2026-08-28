// @vitest-environment jsdom
/**
 * Covers `applyTraceToFlow` — the projection from a BFS trace onto the rendered flow.
 *
 * Lives under webview/ because it is reached only from `useInteractiveTrace`, and its
 * warning path posts through `window.vscode`. Nothing named this export before, so the
 * whole projection — filtering, bidirectional-edge aliasing, highlight assignment and
 * re-layout — shipped on a green suite. A defect here renders a correct trace wrongly.
 */

import type { Edge as FlowEdge, Node as FlowNode } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { applyTraceToFlow } from '../../../src/engine/graphBuilder';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import type { TraceState } from '../../../src/engine/types';

function traceState(overrides: Partial<TraceState> = {}): TraceState {
  return {
    mode: 'applied',
    selectedNodeId: null,
    targetNodeId: null,
    upstreamLevels: 1,
    downstreamLevels: 1,
    tracedNodeIds: new Set<string>(),
    tracedEdgeIds: new Set<string>(),
    ...overrides,
  } as TraceState;
}

const node = (id: string): FlowNode => ({ id, position: { x: 0, y: 0 }, data: { label: id } });
const edge = (id: string, source: string, target: string): FlowEdge => ({ id, source, target });

const nodes = [node('A'), node('B'), node('C')];
const edges = [edge('A→B', 'A', 'B'), edge('B→C', 'B', 'C')];

describe('applyTraceToFlow — passthrough', () => {
  it.each(['none', 'configuring', 'pathfinding'] as const)(
    'returns the unfiltered flow in %s mode',
    (mode) => {
      const result = applyTraceToFlow(nodes, edges, traceState({ mode }));
      expect(result.nodes).toBe(nodes);
      expect(result.edges).toBe(edges);
    },
  );

  it('returns the unfiltered flow when the trace produced no nodes', () => {
    const result = applyTraceToFlow(nodes, edges, traceState({ tracedNodeIds: new Set() }));
    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
  });

  it('returns an empty view, without throwing, when no traced id is in the flow', () => {
    const result = applyTraceToFlow(nodes, edges, traceState({
      tracedNodeIds: new Set(['not-rendered']),
    }));
    expect(result.nodes).toEqual([]);
  });
});

describe('applyTraceToFlow — projection', () => {
  it('narrows the flow to the traced nodes and edges', () => {
    const result = applyTraceToFlow(nodes, edges, traceState({
      tracedNodeIds: new Set(['A', 'B']),
      tracedEdgeIds: new Set(['A→B']),
    }));
    expect(result.nodes.map(entry => entry.id)).toEqual(['A', 'B']);
    expect(result.edges.map(entry => entry.id)).toEqual(['A→B']);
  });

  it.each(['A→B', 'B→A'])(
    'keeps the bidirectional edge A↔B when the trace recorded it as %s',
    (recorded) => {
      const result = applyTraceToFlow(nodes, [edge('A↔B', 'A', 'B')], traceState({
        tracedNodeIds: new Set(['A', 'B']),
        tracedEdgeIds: new Set([recorded]),
      }));
      expect(result.edges.map(entry => entry.id)).toEqual(['A↔B']);
    },
  );

  it('drops an edge the trace never recorded, in either direction', () => {
    const result = applyTraceToFlow(nodes, [edge('A↔B', 'A', 'B')], traceState({
      tracedNodeIds: new Set(['A', 'B']),
      tracedEdgeIds: new Set(['B→C']),
    }));
    expect(result.edges).toEqual([]);
  });
});

describe('applyTraceToFlow — decoration', () => {
  const traced = traceState({
    tracedNodeIds: new Set(['A', 'B', 'C']),
    tracedEdgeIds: new Set(['A→B', 'B→C']),
    selectedNodeId: 'A',
    targetNodeId: 'C',
  });

  it('marks the origin highlighted and the pathfinding target yellow', () => {
    const result = applyTraceToFlow(nodes, edges, traced);
    const highlight = (id: string) => result.nodes.find(entry => entry.id === id)!.data.highlighted;
    expect(highlight('A')).toBe(true);
    expect(highlight('C')).toBe('yellow');
    expect(highlight('B')).toBe(false);
  });

  it('thickens every surviving edge so the trace reads against the unfiltered graph', () => {
    for (const traceEdge of applyTraceToFlow(nodes, edges, traced).edges) {
      expect(traceEdge.style?.strokeWidth).toBe(1.8);
    }
  });

  it('leaves the caller\'s nodes unmutated', () => {
    applyTraceToFlow(nodes, edges, traced);
    expect(nodes.every(entry => entry.position.x === 0 && entry.position.y === 0)).toBe(true);
    expect(nodes[0].data.highlighted).toBeUndefined();
  });
});

describe('applyTraceToFlow — layout', () => {
  it('re-lays the surviving nodes rather than keeping their unfiltered positions', () => {
    const result = applyTraceToFlow(nodes, edges, traceState({
      tracedNodeIds: new Set(['A', 'B']),
      tracedEdgeIds: new Set(['A→B']),
    }));
    expect(result.nodes.some(entry => entry.position.x !== 0 || entry.position.y !== 0)).toBe(true);
  });

  it('grids orphan analysis, which has no edges for dagre to rank', () => {
    const result = applyTraceToFlow(nodes, [], traceState({
      mode: 'analysis',
      analysisType: 'orphans',
      tracedNodeIds: new Set(['A', 'B', 'C']),
    }));
    const placed = new Set(result.nodes.map(entry => `${entry.position.x},${entry.position.y}`));
    expect(placed.size).toBe(3);
  });
});

// ─── Out-of-filter synthesis ─────────────────────────────────────────────────

describe('applyTraceToFlow — out-of-filter synthesis', () => {
  // A path trace may run through objects the active filter hides. Those must be injected into the
  // rendered flow rather than dropped, or the path is drawn with a gap where a real object sits.
  const modelNode = (id: string, extra: Record<string, unknown> = {}) => ({
    id, schema: 'dbo', name: id, fullName: `[dbo].[${id}]`, type: 'table' as const, columns: [], ...extra,
  });

  const hiddenModel = {
    nodes: [modelNode('A'), modelNode('B'), modelNode('HIDDEN')],
    edges: [],
    schemas: [],
    catalog: {},
    neighborIndex: {},
  } as unknown as Parameters<typeof applyTraceToFlow>[4];

  const pathTrace = () => traceState({
    mode: 'path-applied',
    tracedNodeIds: new Set(['A', 'HIDDEN', 'B']),
    tracedEdgeIds: new Set(['A→HIDDEN', 'HIDDEN→B']),
  });

  it('injects a traced object the current filter hid', () => {
    const result = applyTraceToFlow([node('A'), node('B')], [], pathTrace(), DEFAULT_CONFIG, hiddenModel);
    expect(result.nodes.map(entry => entry.id).sort()).toEqual(['A', 'B', 'HIDDEN']);
  });

  it('injects the edges that reconnect the injected object', () => {
    const result = applyTraceToFlow([node('A'), node('B')], [], pathTrace(), DEFAULT_CONFIG, hiddenModel);
    expect(result.edges.map(entry => entry.id).sort()).toEqual(['A→HIDDEN', 'HIDDEN→B']);
  });

  it('gives an injected object its degrees from the synthesized edges, not zero', () => {
    const result = applyTraceToFlow([node('A'), node('B')], [], pathTrace(), DEFAULT_CONFIG, hiddenModel);
    const injected = result.nodes.find(entry => entry.id === 'HIDDEN');
    expect(injected?.data.inDegree).toBe(1);
    expect(injected?.data.outDegree).toBe(1);
  });

  it('carries an external reference\'s own attributes onto the injected node', () => {
    const externalModel = {
      ...hiddenModel,
      nodes: [modelNode('A'), modelNode('EXT', { externalType: 'db', externalDatabase: 'Other', externalUrl: 'x://y' })],
    } as unknown as Parameters<typeof applyTraceToFlow>[4];
    const result = applyTraceToFlow([node('A')], [], traceState({
      mode: 'path-applied',
      tracedNodeIds: new Set(['A', 'EXT']),
      tracedEdgeIds: new Set(['A→EXT']),
    }), DEFAULT_CONFIG, externalModel);
    const injected = result.nodes.find(entry => entry.id === 'EXT');
    expect(injected?.data.externalType).toBe('db');
    expect(injected?.data.externalDatabase).toBe('Other');
  });

  it('skips a traced id the model does not know, instead of injecting a blank node', () => {
    const result = applyTraceToFlow([node('A')], [], traceState({
      mode: 'path-applied',
      tracedNodeIds: new Set(['A', 'GHOST']),
      tracedEdgeIds: new Set<string>(),
    }), DEFAULT_CONFIG, hiddenModel);
    expect(result.nodes.map(entry => entry.id)).toEqual(['A']);
  });

  it('does not synthesize in applied mode unless the caller asks for it', () => {
    const applied = traceState({
      mode: 'applied',
      tracedNodeIds: new Set(['A', 'HIDDEN']),
      tracedEdgeIds: new Set(['A→HIDDEN']),
    });
    expect(applyTraceToFlow([node('A')], [], applied, DEFAULT_CONFIG, hiddenModel).nodes.map(e => e.id))
      .toEqual(['A']);
    expect(applyTraceToFlow([node('A')], [], applied, DEFAULT_CONFIG, hiddenModel, true).nodes.map(e => e.id).sort())
      .toEqual(['A', 'HIDDEN']);
  });

  it('leaves an already-rendered bidirectional edge alone rather than adding a duplicate', () => {
    const result = applyTraceToFlow(
      [node('A'), node('B')],
      [edge('A↔B', 'A', 'B')],
      traceState({
        mode: 'path-applied',
        tracedNodeIds: new Set(['A', 'B']),
        tracedEdgeIds: new Set(['A→B']),
      }),
      DEFAULT_CONFIG,
      hiddenModel,
    );
    expect(result.edges.map(entry => entry.id)).toEqual(['A↔B']);
  });
});
