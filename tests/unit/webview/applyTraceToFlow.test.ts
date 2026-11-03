/** Covers `applyTraceToFlow` — the projection from a BFS trace onto the rendered flow. */

import type { Edge as FlowEdge, Node as FlowNode } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { applyTraceToFlow } from '../../../src/engine/graphBuilder';
import { DEFAULT_CONFIG } from '../../../src/engine/shared/types';
import type { TraceState } from '../../../src/engine/shared/types';

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

const node = (id: string): FlowNode => ({
  id,
  position: { x: 0, y: 0 },
  data: { label: id },
});
const edge = (id: string, source: string, target: string): FlowEdge => ({
  id,
  source,
  target,
});

const nodes = [node('A'), node('B'), node('C')];
const edges = [edge('A→B', 'A', 'B'), edge('B→C', 'B', 'C')];

describe('applyTraceToFlow — passthrough', () => {
  it.each([
    ['none mode', traceState({ mode: 'none' })],
    ['configuring mode', traceState({ mode: 'configuring' })],
    ['pathfinding mode', traceState({ mode: 'pathfinding' })],
    ['a trace that produced no nodes', traceState()],
  ])('returns the unfiltered flow for %s', (_name, state) => {
    const result = applyTraceToFlow(nodes, edges, state);
    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
  });

  it('returns an empty view, without throwing, when no traced id is in the flow', () => {
    const result = applyTraceToFlow(
      nodes,
      edges,
      traceState({
        tracedNodeIds: new Set(['not-rendered']),
      }),
    );
    expect(result.nodes).toEqual([]);
    expect(result.notice).toBeDefined();
  });
});

describe('applyTraceToFlow — projection', () => {
  it('narrows the flow to the traced nodes and edges', () => {
    const result = applyTraceToFlow(
      nodes,
      edges,
      traceState({
        tracedNodeIds: new Set(['A', 'B']),
        tracedEdgeIds: new Set(['A→B']),
      }),
    );
    expect(result.nodes.map((entry) => entry.id)).toEqual(['A', 'B']);
    expect(result.edges.map((entry) => entry.id)).toEqual(['A→B']);
  });

  it.each([
    ['A→B', ['A↔B']],
    ['B→A', ['A↔B']],
    ['B→C', []],
  ])(
    'keeps the bidirectional edge A↔B only when the trace recorded it in either direction (recorded %s)',
    (recorded, expected) => {
      const result = applyTraceToFlow(
        nodes,
        [edge('A↔B', 'A', 'B')],
        traceState({
          tracedNodeIds: new Set(['A', 'B']),
          tracedEdgeIds: new Set([recorded]),
        }),
      );
      expect(result.edges.map((entry) => entry.id)).toEqual(expected);
    },
  );
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
    expect(
      Object.fromEntries(
        result.nodes.map((entry) => [entry.id, entry.data.highlighted]),
      ),
    ).toEqual({ A: true, B: false, C: 'yellow' });
  });

  it('thickens every surviving edge so the trace reads against the unfiltered graph', () => {
    expect(
      applyTraceToFlow(nodes, edges, traced).edges.map((traceEdge) => [
        traceEdge.id,
        traceEdge.style?.strokeWidth,
      ]),
    ).toEqual([
      ['A→B', 1.8],
      ['B→C', 1.8],
    ]);
  });

  it("leaves the caller's nodes unmutated", () => {
    applyTraceToFlow(nodes, edges, traced);
    expect(nodes).toEqual([node('A'), node('B'), node('C')]);
  });
});

describe('applyTraceToFlow — layout', () => {
  it('re-lays the surviving nodes rather than keeping their unfiltered positions', () => {
    const result = applyTraceToFlow(
      nodes,
      edges,
      traceState({
        tracedNodeIds: new Set(['A', 'B']),
        tracedEdgeIds: new Set(['A→B']),
      }),
    );
    const position = (id: string) =>
      result.nodes.find((entry) => entry.id === id)!.position;
    expect(result.nodes.map((entry) => entry.id).sort()).toEqual(['A', 'B']);
    // Every input node sits at the origin; a fresh layout separates A and B.
    expect(position('A')).not.toEqual(position('B'));
  });

  it('grids orphan analysis, which has no edges for dagre to rank', () => {
    const result = applyTraceToFlow(
      nodes,
      [],
      traceState({
        mode: 'analysis',
        analysisType: 'orphans',
        tracedNodeIds: new Set(['A', 'B', 'C']),
      }),
    );
    const placed = new Set(
      result.nodes.map((entry) => `${entry.position.x},${entry.position.y}`),
    );
    expect(placed.size).toBe(3);
  });
});

describe('applyTraceToFlow — out-of-filter synthesis', () => {
  const modelNode = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    schema: 'dbo',
    name: id,
    fullName: `[dbo].[${id}]`,
    type: 'table' as const,
    columns: [],
    ...extra,
  });

  const hiddenModel = {
    nodes: [modelNode('A'), modelNode('B'), modelNode('HIDDEN')],
    edges: [],
    schemas: [],
    catalog: {},
    neighborIndex: {},
  } as unknown as Parameters<typeof applyTraceToFlow>[4];

  const pathTrace = () =>
    traceState({
      mode: 'path-applied',
      tracedNodeIds: new Set(['A', 'HIDDEN', 'B']),
      tracedEdgeIds: new Set(['A→HIDDEN', 'HIDDEN→B']),
    });

  it('reconnects a hidden traced object with synthesized edges and degrees', () => {
    const result = applyTraceToFlow(
      [node('A'), node('B')],
      [],
      pathTrace(),
      DEFAULT_CONFIG,
      hiddenModel,
    );
    expect(result.nodes.map((entry) => entry.id).sort()).toEqual([
      'A',
      'B',
      'HIDDEN',
    ]);
    expect(result.edges.map((entry) => entry.id).sort()).toEqual([
      'A→HIDDEN',
      'HIDDEN→B',
    ]);
    expect(
      result.nodes.find((entry) => entry.id === 'HIDDEN')?.data,
    ).toMatchObject({ inDegree: 1, outDegree: 1 });
  });

  it("carries an external reference's own attributes onto the injected node", () => {
    const externalModel = {
      ...hiddenModel,
      nodes: [
        modelNode('A'),
        modelNode('EXT', {
          externalType: 'db',
          externalDatabase: 'Other',
          externalUrl: 'x://y',
        }),
      ],
    } as unknown as Parameters<typeof applyTraceToFlow>[4];
    const result = applyTraceToFlow(
      [node('A')],
      [],
      traceState({
        mode: 'path-applied',
        tracedNodeIds: new Set(['A', 'EXT']),
        tracedEdgeIds: new Set(['A→EXT']),
      }),
      DEFAULT_CONFIG,
      externalModel,
    );
    expect(
      result.nodes.find((entry) => entry.id === 'EXT')?.data,
    ).toMatchObject({ externalType: 'db', externalDatabase: 'Other' });
  });

  it('skips a traced id the model does not know, instead of injecting a blank node', () => {
    const result = applyTraceToFlow(
      [node('A')],
      [],
      traceState({
        mode: 'path-applied',
        tracedNodeIds: new Set(['A', 'GHOST']),
        tracedEdgeIds: new Set<string>(),
      }),
      DEFAULT_CONFIG,
      hiddenModel,
    );
    expect(result.nodes.map((entry) => entry.id)).toEqual(['A']);
  });

  it('does not synthesize in applied mode unless the caller asks for it', () => {
    const applied = traceState({
      mode: 'applied',
      tracedNodeIds: new Set(['A', 'HIDDEN']),
      tracedEdgeIds: new Set(['A→HIDDEN']),
    });
    expect(
      applyTraceToFlow(
        [node('A')],
        [],
        applied,
        DEFAULT_CONFIG,
        hiddenModel,
      ).nodes.map((e) => e.id),
    ).toEqual(['A']);
    expect(
      applyTraceToFlow(
        [node('A')],
        [],
        applied,
        DEFAULT_CONFIG,
        hiddenModel,
        true,
      )
        .nodes.map((e) => e.id)
        .sort(),
    ).toEqual(['A', 'HIDDEN']);
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
    expect(result.edges.map((entry) => entry.id)).toEqual(['A↔B']);
  });
});
