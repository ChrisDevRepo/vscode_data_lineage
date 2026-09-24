// @vitest-environment jsdom
/**
 * Lane for the drag re-render storm.
 *
 * React Flow emits a position change per drag frame, so `applyNodeChanges` hands back a new object
 * for the dragged node and keeps every other node's reference. A fresh `data` object for *every*
 * node on that array change would break the `React.memo` on the node renderers — dragging one node
 * would re-render all of them, at 1000 nodes, every frame.
 *
 * The counting assertions below are the lock: a position-only change must leave every other node's
 * `data` reference untouched. The React Flow helpers used here expect a DOM, so this runs under
 * jsdom.
 */

import { describe, expect, it } from 'vitest';
import { applyNodeChanges, type Node as FlowNode, type NodeChange } from '@xyflow/react';
import { buildGraphNoLayout } from '../../../src/engine/graphBuilder';
import {
  computeNodeDecoration,
  createNodeDecorationCache,
  decorateFlowNodes,
  createColumnNodeCache,
  projectColumnNodes,
  LIT_CLASS_NAME,
  type NodeDecorationInputs,
} from '../../../src/engine/nodeDecoration';
import { createEdgeDecorationCache, decorateFlowEdges } from '../../../src/engine/edgeDecoration';
import type { ColumnTraceViewNode } from '../../../src/engine/columnTraceView';
import type { ColumnTraceNodeData, CustomNodeData, SchemaNodeData, TraceNodeControls } from '../../../src/engine/types';
import { DEFAULT_CONFIG } from '../../../src/engine/types';
import { buildLargeModel } from './largeGraphFixture';

const NODE_COUNT = 1000;

function baseInputs(overrides: Partial<NodeDecorationInputs> = {}): NodeDecorationInputs {
  return {
    graphMode: 'full',
    highlightedNodeId: null,
    level1Neighbors: new Set<string>(),
    traceMode: 'none',
    traceSelectedNodeId: null,
    isBookmarkMode: false,
    canRemoveNodeFromScopedView: false,
    notesVisible: true,
    traceControlsByNode: new Map(),
    aiHighlightMap: new Map(),
    aiBadgeMap: new Map(),
    aiNoteMap: new Map(),
    ...overrides,
  };
}

function largeFlowNodes(): FlowNode[] {
  return buildGraphNoLayout(buildLargeModel(NODE_COUNT), DEFAULT_CONFIG).flowNodes as FlowNode[];
}

function largeFlowEdges() {
  return buildGraphNoLayout(buildLargeModel(NODE_COUNT), DEFAULT_CONFIG).flowEdges;
}

function dragOne(nodes: FlowNode[], index: number): FlowNode[] {
  const change: NodeChange = {
    id: nodes[index].id,
    type: 'position',
    position: { x: 123, y: 456 },
    dragging: true,
  };
  return applyNodeChanges([change], nodes);
}

describe('decorateFlowNodes — identity across a drag', () => {
  it('leaves every other node\'s data reference untouched when one node moves', () => {
    const nodes = largeFlowNodes();
    expect(nodes).toHaveLength(NODE_COUNT);

    const cache = createNodeDecorationCache();
    const inputs = baseInputs();
    const before = decorateFlowNodes(nodes, inputs, cache);
    const after = decorateFlowNodes(dragOne(nodes, 0), inputs, cache);

    const churned = after.filter((node, i) => node.data !== before[i].data);
    expect(churned).toHaveLength(0);

    const rebuilt = after.filter((node, i) => node !== before[i]);
    expect(rebuilt.map(n => n.id)).toEqual([nodes[0].id]);
  });

  it('moves the dragged node and only the dragged node', () => {
    const nodes = largeFlowNodes();
    const cache = createNodeDecorationCache();
    const inputs = baseInputs();
    decorateFlowNodes(nodes, inputs, cache);
    const after = decorateFlowNodes(dragOne(nodes, 500), inputs, cache);

    expect(after[500].position).toEqual({ x: 123, y: 456 });
    expect(after[499].position).toEqual(nodes[499].position);
  });
});

describe('decorateFlowNodes — decoration correctness', () => {
  it('rebuilds only the nodes a highlight change affects', () => {
    const nodes = largeFlowNodes();
    const cache = createNodeDecorationCache();
    const target = nodes[10].id;
    const neighbour = nodes[11].id;

    const before = decorateFlowNodes(nodes, baseInputs(), cache);
    const after = decorateFlowNodes(nodes, baseInputs({
      highlightedNodeId: target,
      level1Neighbors: new Set([neighbour]),
    }), cache);

    expect(after[10].data.highlighted).toBe('yellow');
    expect(after[10].className).toBe(LIT_CLASS_NAME);
    expect(after[11].className).toBe(LIT_CLASS_NAME);
    expect(after[12].className).toBeUndefined();

    // The dim itself is a CSS class on the outer node, not a `data` field (see LIT_CLASS_NAME), so
    // only the node whose lit status actually flips gets a new node object — everything outside the
    // selected node and its neighbours, including the far, never-lit node 12, keeps identity.
    const rebuilt = after.filter((node, i) => node !== before[i]);
    expect(rebuilt.map(n => n.id).sort()).toEqual([neighbour, target].sort());
    const unchangedData = after.filter((node, i) => node.data === before[i].data);
    expect(unchangedData.map(n => n.id)).toContain(nodes[12].id);
  });

  it('keeps the trace origin highlighted and lit rather than dimming it', () => {
    const nodes = largeFlowNodes();
    const cache = createNodeDecorationCache();
    const origin = nodes[3].id;

    const decorated = decorateFlowNodes(nodes, baseInputs({
      highlightedNodeId: nodes[80].id,
      traceMode: 'applied',
      traceSelectedNodeId: origin,
    }), cache);

    expect(decorated[3].data.highlighted).toBe(true);
    expect(decorated[3].className).toBe(LIT_CLASS_NAME);
  });

  it('lights exactly the override set and dims the rest', () => {
    const nodes = largeFlowNodes();
    const cache = createNodeDecorationCache();
    const path = new Set([nodes[5].id, nodes[6].id]);

    const decorated = decorateFlowNodes(nodes, baseInputs({ litOverride: path }), cache);

    expect(decorated[5].className).toBe(LIT_CLASS_NAME);
    expect(decorated[6].className).toBe(LIT_CLASS_NAME);
    expect(decorated[7].className).toBeUndefined();
  });

  it('keeps the trace origin lit under an override that omits it', () => {
    const nodes = largeFlowNodes();
    const cache = createNodeDecorationCache();
    const origin = nodes[3].id;

    const decorated = decorateFlowNodes(nodes, baseInputs({
      traceMode: 'applied',
      traceSelectedNodeId: origin,
      litOverride: new Set([nodes[9].id]),
    }), cache);

    expect(decorated[3].className).toBe(LIT_CLASS_NAME);
    expect(decorated[9].className).toBe(LIT_CLASS_NAME);
  });

  it('treats an empty override as no override', () => {
    const nodes = largeFlowNodes();
    const cache = createNodeDecorationCache();

    const decorated = decorateFlowNodes(nodes, baseInputs({ litOverride: new Set() }), cache);

    expect(decorated.every(node => node.className !== LIT_CLASS_NAME)).toBe(true);
  });

  it('drops AI notes when the zoom hides them and restores them when it does not', () => {
    const nodes = largeFlowNodes();
    const cache = createNodeDecorationCache();
    const noted = nodes[7].id;
    const aiNoteMap = new Map([[noted, { text: 'note' }]]);

    const shown = decorateFlowNodes(nodes, baseInputs({ aiNoteMap }), cache);
    expect(shown[7].data.aiNote).toEqual({ text: 'note' });

    const hidden = decorateFlowNodes(nodes, baseInputs({ aiNoteMap, notesVisible: false }), cache);
    expect(hidden[7].data.aiNote).toBeUndefined();

    const restored = decorateFlowNodes(nodes, baseInputs({ aiNoteMap }), cache);
    expect(restored[7].data.aiNote).toEqual({ text: 'note' });
  });

  it('releases cache entries for nodes a filter removed', () => {
    const nodes = largeFlowNodes();
    const cache = createNodeDecorationCache();
    decorateFlowNodes(nodes, baseInputs(), cache);
    expect(cache.size).toBe(NODE_COUNT);

    decorateFlowNodes(nodes.slice(0, 10), baseInputs(), cache);
    expect(cache.size).toBe(10);
  });
});

describe('decorateFlowNodes — cheap clicks: a click only touches the click, not the crowd', () => {
  it('moving the highlight from node X to node Y only rebuilds X, Y and their neighbours', () => {
    const nodes = largeFlowNodes();
    const cache = createNodeDecorationCache();
    const x = nodes[10].id;
    const xNeighbour = nodes[11].id;
    const y = nodes[600].id;
    const yNeighbour = nodes[601].id;

    decorateFlowNodes(nodes, baseInputs(), cache);
    const afterX = decorateFlowNodes(nodes, baseInputs({
      highlightedNodeId: x,
      level1Neighbors: new Set([xNeighbour]),
    }), cache);
    const afterY = decorateFlowNodes(nodes, baseInputs({
      highlightedNodeId: y,
      level1Neighbors: new Set([yNeighbour]),
    }), cache);

    const rebuiltData = afterY.filter((node, i) => node.data !== afterX[i].data);
    expect(rebuiltData.map(n => n.id).sort()).toEqual([x, xNeighbour, y, yNeighbour].sort());

    const rebuiltNode = afterY.filter((node, i) => node !== afterX[i]);
    expect(rebuiltNode.map(n => n.id).sort()).toEqual([x, xNeighbour, y, yNeighbour].sort());
  });
});

/**
 * Lane for the column view's measurement loop.
 *
 * React Flow adopts any node whose object identity changed: it clears that node's handle bounds and
 * re-measures it. The column branch keeps node identity stable across renders, because rebuilding
 * the whole array would make every hover or drag frame re-measure the entire canvas — a
 * ResizeObserver loop, hover flicker and a blank minimap. Declared dimensions close the same loop
 * from the other side: without them a node is never "initialized" and the minimap skips it.
 */
/**
 * Lane for the decoration itself.
 *
 * The eight nodes below cover every axis {@link decorateFlowNodes} reads — plain, click-highlighted,
 * level-1 neighbour, dimmed, trace origin, AI overlay, removable-with-trace-controls, and a schema
 * cluster — so the snapshot below pins the emitted `data` for the whole matrix. It is the guard that
 * the decoration itself is unchanged by how often it is computed.
 */
describe('decorateFlowNodes — emitted data matrix', () => {
  const HIGHLIGHTED = 'n1';
  const NEIGHBOUR = 'n2';
  const TRACE_ORIGIN = 'n4';
  const OVERLAID = 'n5';
  const CONTROLLED = 'n6';

  function objectNode(id: string): FlowNode {
    return {
      id,
      type: 'lineageNode',
      position: { x: 0, y: 0 },
      data: {
        label: id,
        schema: 'dbo',
        fullName: `dbo.${id}`,
        objectType: 'table',
        inDegree: 1,
        outDegree: 2,
      } satisfies CustomNodeData,
    };
  }

  function matrixNodes(): FlowNode[] {
    const objects = ['n0', HIGHLIGHTED, NEIGHBOUR, 'n3', TRACE_ORIGIN, OVERLAID, CONTROLLED].map(objectNode);
    const cluster: FlowNode = {
      id: '__schema__dbo',
      type: 'schemaNode',
      position: { x: 0, y: 0 },
      data: {
        schemaName: 'dbo',
        objectCount: 7,
        typeBreakdown: { table: 7 },
        color: '#123456',
      } satisfies SchemaNodeData,
    };
    return [...objects, cluster];
  }

  const traceControls: TraceNodeControls = {
    in: { add: [], prune: [], addDisabledReason: '', pruneDisabledReason: '', neighborCount: 0, visibleNeighborCount: 0 },
    out: { add: [], prune: [], addDisabledReason: '', pruneDisabledReason: '', neighborCount: 0, visibleNeighborCount: 0 },
    onAdd: () => {},
    onPrune: () => {},
  };
  const onRemoveFromView = (): void => {};
  const onExpandSchema = (): void => {};
  const onMakeSchemaCenter = (): void => {};

  function matrixInputs(): NodeDecorationInputs {
    return baseInputs({
      graphMode: 'overview',
      highlightedNodeId: HIGHLIGHTED,
      level1Neighbors: new Set([NEIGHBOUR]),
      traceMode: 'applied',
      traceSelectedNodeId: TRACE_ORIGIN,
      isBookmarkMode: true,
      canRemoveNodeFromScopedView: true,
      onRemoveFromView,
      traceControlsByNode: new Map([[CONTROLLED, traceControls]]),
      aiHighlightMap: new Map([[OVERLAID, { color: '#f00', glow: '#f00', shadow: '0 0 2px #f00' }]]),
      aiBadgeMap: new Map([[OVERLAID, { text: 'origin' }]]),
      aiNoteMap: new Map([[OVERLAID, { text: 'note' }]]),
      onExpandSchema,
      onMakeSchemaCenter,
    });
  }

  /** The serialisable half of a decorated node's `data`; callbacks are asserted by identity. */
  function plainData(node: FlowNode): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(node.data).filter(([, value]) => typeof value !== 'function'),
    );
  }

  it('emits the same data for every axis of the matrix', () => {
    const decorated = decorateFlowNodes(matrixNodes(), matrixInputs(), createNodeDecorationCache());

    // The dim itself is the `.ln-lit` className, not a `data` field — see LIT_CLASS_NAME. Lit:
    // the highlighted node (n1), its neighbour (n2), and the trace origin (n4). Not lit: a plain
    // node (n0), a second plain node (n3), the AI-overlaid node (n5, AI highlight alone does not
    // exempt from dim), the trace-controlled node (n6), and the schema cluster (dim is object-only).
    expect(decorated.map(n => n.className)).toEqual([
      undefined, LIT_CLASS_NAME, LIT_CLASS_NAME, undefined, LIT_CLASS_NAME, undefined, undefined, undefined,
    ]);

    expect(decorated.map(plainData)).toMatchInlineSnapshot(`
      [
        {
          "aiBadge": undefined,
          "aiHighlight": undefined,
          "aiNote": undefined,
          "fullName": "dbo.n0",
          "highlighted": undefined,
          "inDegree": 1,
          "label": "n0",
          "objectType": "table",
          "outDegree": 2,
          "schema": "dbo",
          "showRemoveButton": true,
          "traceControls": undefined,
        },
        {
          "aiBadge": undefined,
          "aiHighlight": undefined,
          "aiNote": undefined,
          "fullName": "dbo.n1",
          "highlighted": "yellow",
          "inDegree": 1,
          "label": "n1",
          "objectType": "table",
          "outDegree": 2,
          "schema": "dbo",
          "showRemoveButton": true,
          "traceControls": undefined,
        },
        {
          "aiBadge": undefined,
          "aiHighlight": undefined,
          "aiNote": undefined,
          "fullName": "dbo.n2",
          "highlighted": undefined,
          "inDegree": 1,
          "label": "n2",
          "objectType": "table",
          "outDegree": 2,
          "schema": "dbo",
          "showRemoveButton": true,
          "traceControls": undefined,
        },
        {
          "aiBadge": undefined,
          "aiHighlight": undefined,
          "aiNote": undefined,
          "fullName": "dbo.n3",
          "highlighted": undefined,
          "inDegree": 1,
          "label": "n3",
          "objectType": "table",
          "outDegree": 2,
          "schema": "dbo",
          "showRemoveButton": true,
          "traceControls": undefined,
        },
        {
          "aiBadge": undefined,
          "aiHighlight": undefined,
          "aiNote": undefined,
          "fullName": "dbo.n4",
          "highlighted": true,
          "inDegree": 1,
          "label": "n4",
          "objectType": "table",
          "outDegree": 2,
          "schema": "dbo",
          "showRemoveButton": true,
          "traceControls": undefined,
        },
        {
          "aiBadge": {
            "text": "origin",
          },
          "aiHighlight": {
            "color": "#f00",
            "glow": "#f00",
            "shadow": "0 0 2px #f00",
          },
          "aiNote": {
            "text": "note",
          },
          "fullName": "dbo.n5",
          "highlighted": undefined,
          "inDegree": 1,
          "label": "n5",
          "objectType": "table",
          "outDegree": 2,
          "schema": "dbo",
          "showRemoveButton": true,
          "traceControls": undefined,
        },
        {
          "aiBadge": undefined,
          "aiHighlight": undefined,
          "aiNote": undefined,
          "fullName": "dbo.n6",
          "highlighted": undefined,
          "inDegree": 1,
          "label": "n6",
          "objectType": "table",
          "outDegree": 2,
          "schema": "dbo",
          "showRemoveButton": true,
          "traceControls": {
            "in": {
              "add": [],
              "addDisabledReason": "",
              "neighborCount": 0,
              "prune": [],
              "pruneDisabledReason": "",
              "visibleNeighborCount": 0,
            },
            "onAdd": [Function],
            "onPrune": [Function],
            "out": {
              "add": [],
              "addDisabledReason": "",
              "neighborCount": 0,
              "prune": [],
              "pruneDisabledReason": "",
              "visibleNeighborCount": 0,
            },
          },
        },
        {
          "color": "#123456",
          "objectCount": 7,
          "schemaName": "dbo",
          "typeBreakdown": {
            "table": 7,
          },
        },
      ]
    `);
  });

  it('returns the identical nodes on a second pass over unchanged inputs', () => {
    const nodes = matrixNodes();
    const cache = createNodeDecorationCache();
    const inputs = matrixInputs();
    const first = decorateFlowNodes(nodes, inputs, cache);
    const second = decorateFlowNodes(nodes, inputs, cache);

    expect(second.every((node, i) => node === first[i])).toBe(true);
  });

  it('keeps every data reference across a drag frame, the moved node included', () => {
    const nodes = matrixNodes();
    const cache = createNodeDecorationCache();
    const inputs = matrixInputs();
    const before = decorateFlowNodes(nodes, inputs, cache);
    const after = decorateFlowNodes(dragOne(nodes, 3), inputs, cache);

    expect(after.filter((node, i) => node.data !== before[i].data)).toHaveLength(0);
    expect(after.filter((node, i) => node !== before[i]).map(n => n.id)).toEqual([nodes[3].id]);
  });

  it('carries the callbacks through by identity', () => {
    const decorated = decorateFlowNodes(matrixNodes(), matrixInputs(), createNodeDecorationCache());
    expect(decorated[0].data.onRemoveFromView).toBe(onRemoveFromView);
    expect(decorated[6].data.traceControls).toBe(traceControls);
    expect(decorated[7].data.onExpandSchema).toBe(onExpandSchema);
    expect(decorated[7].data.onMakeSchemaCenter).toBe(onMakeSchemaCenter);
  });
});

describe('computeNodeDecoration — the one per-id rule both canvas views read', () => {
  it('applies the trace-origin override, the click highlight and the node\'s own fallback', () => {
    const inputs = baseInputs({ highlightedNodeId: 'clicked', traceMode: 'applied', traceSelectedNodeId: 'origin' });
    expect(computeNodeDecoration('origin', undefined, inputs)).toMatchObject({ highlighted: true, dimmed: false });
    expect(computeNodeDecoration('clicked', undefined, inputs)).toMatchObject({ highlighted: 'yellow', dimmed: false });
    expect(computeNodeDecoration('other', undefined, inputs)).toMatchObject({ highlighted: undefined, dimmed: true });
    expect(computeNodeDecoration('other', true, inputs).highlighted).toBe(true);
  });

  it('attaches the remove control and the AI overlay by id, dropping notes while hidden', () => {
    const onRemoveFromView = (): void => {};
    const aiHighlight = { color: 'c', glow: 'g', shadow: 's' };
    const aiBadge = { label: 'B', color: 'c' } as never;
    const inputs = baseInputs({
      isBookmarkMode: true,
      canRemoveNodeFromScopedView: true,
      onRemoveFromView,
      aiHighlightMap: new Map([['n', aiHighlight]]),
      aiBadgeMap: new Map([['n', aiBadge]]),
      aiNoteMap: new Map([['n', { text: 'note' }]]),
    });
    expect(computeNodeDecoration('n', undefined, inputs)).toMatchObject({
      removable: true, onRemoveFromView, aiHighlight, aiBadge, aiNote: { text: 'note' },
    });
    expect(computeNodeDecoration('n', undefined, { ...inputs, notesVisible: false }).aiNote).toBeUndefined();
  });
});

describe('projectColumnNodes', () => {
  function views(count: number): ColumnTraceViewNode[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `n${i}`,
      label: `t${i}`,
      schema: 'dbo',
      objectType: 'table',
      isTransformNode: false,
      rows: [{ name: 'Col' }],
      width: 214,
      height: 50,
      position: { x: i * 300, y: 0 },
    }));
  }

  function dataFor(nodes: ColumnTraceViewNode[]): Map<string, ColumnTraceNodeData> {
    return new Map(nodes.map(view => [view.id, { view, rowLineStates: {} }]));
  }

  it('declares the view box so the node counts as measured', () => {
    const nodes = views(2);
    const projected = projectColumnNodes(nodes, dataFor(nodes), {}, createColumnNodeCache());
    expect(projected[0].width).toBe(214);
    expect(projected[0].height).toBe(50);
    expect(projected[0].position).toEqual({ x: 0, y: 0 });
  });

  it('returns the same node objects when nothing changed', () => {
    const nodes = views(3);
    const data = dataFor(nodes);
    const cache = createColumnNodeCache();
    const before = projectColumnNodes(nodes, data, {}, cache);
    const after = projectColumnNodes(nodes, data, {}, cache);
    expect(after.every((node, i) => node === before[i])).toBe(true);
  });

  it('rebuilds only the node a drag moved', () => {
    const nodes = views(3);
    const data = dataFor(nodes);
    const cache = createColumnNodeCache();
    const before = projectColumnNodes(nodes, data, {}, cache);
    const after = projectColumnNodes(nodes, data, { n1: { x: 40, y: 80 } }, cache);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1].position).toEqual({ x: 40, y: 80 });
  });

  it('skips a view whose data map has no entry instead of projecting undefined', () => {
    const nodes = views(2);
    const data = dataFor(nodes.slice(0, 1));
    const projected = projectColumnNodes(nodes, data, {}, createColumnNodeCache());
    expect(projected.map(node => node.id)).toEqual(['n0']);
  });

  it('releases cache entries for nodes a new relation set removed', () => {
    const nodes = views(4);
    const cache = createColumnNodeCache();
    projectColumnNodes(nodes, dataFor(nodes), {}, cache);
    expect(cache.size).toBe(4);

    const fewer = nodes.slice(0, 2);
    projectColumnNodes(fewer, dataFor(fewer), {}, cache);
    expect(cache.size).toBe(2);
  });
});

describe('decorateFlowEdges', () => {
  it('leaves every edge not incident to the highlighted node at the same object identity', () => {
    const edges = largeFlowEdges();
    const cache = createEdgeDecorationCache();
    const connectedTo = edges[0].source;

    const before = decorateFlowEdges(edges, null, true, cache);
    const after = decorateFlowEdges(edges, connectedTo, true, cache);

    const incident = edges.filter(e => e.source === connectedTo || e.target === connectedTo).map(e => e.id);
    expect(incident.length).toBeGreaterThan(0);

    const changed = after.filter((edge, i) => edge !== before[i]);
    expect(changed.map(e => e.id).sort()).toEqual([...incident].sort());
    for (const edge of changed) {
      expect(edge.className).toBe(LIT_CLASS_NAME);
      expect(edge.animated).toBe(true);
    }

    const unchanged = after.filter((edge, i) => edge === before[i]);
    expect(unchanged.length).toBe(edges.length - incident.length);
  });

  it('moving the highlight from one node to another only touches the old and new incident edges', () => {
    const edges = largeFlowEdges();
    const cache = createEdgeDecorationCache();
    const nodeX = edges[0].source;
    const nodeY = edges[edges.length - 1].target;

    const afterX = decorateFlowEdges(edges, nodeX, true, cache);
    const afterY = decorateFlowEdges(edges, nodeY, true, cache);

    const incidentX = new Set(edges.filter(e => e.source === nodeX || e.target === nodeX).map(e => e.id));
    const incidentY = new Set(edges.filter(e => e.source === nodeY || e.target === nodeY).map(e => e.id));
    const expectedChurn = new Set([...incidentX, ...incidentY]);

    const changed = afterY.filter((edge, i) => edge !== afterX[i]).map(e => e.id);
    expect(new Set(changed)).toEqual(expectedChurn);
  });

  it('lights only route edges when a route is given, in either stored direction', () => {
    const edges = [
      { id: 'a→b', source: 'a', target: 'b' },
      { id: 'b→c', source: 'b', target: 'c' },
      { id: 'b→x', source: 'b', target: 'x' },
      { id: 'c→b2', source: 'c', target: 'b2' },
    ];
    const route = new Set(['a→b', 'c→b']);
    const lit = decorateFlowEdges(edges, 'b', true, createEdgeDecorationCache(), route)
      .filter(edge => edge.className === LIT_CLASS_NAME)
      .map(edge => edge.id);
    expect(lit).toEqual(['a→b', 'b→c']);
  });

  it('lights and animates every route edge with no node selected', () => {
    const edges = [
      { id: 'a→b', source: 'a', target: 'b' },
      { id: 'b→c', source: 'b', target: 'c' },
      { id: 'c→a', source: 'c', target: 'a' },
    ];
    const lit = decorateFlowEdges(edges, null, true, createEdgeDecorationCache(), new Set(['a→b', 'b→c']))
      .filter(edge => edge.className === LIT_CLASS_NAME && edge.animated)
      .map(edge => edge.id);
    expect(lit).toEqual(['a→b', 'b→c']);
  });

  it('releases cache entries for edges a filter removed', () => {
    const edges = largeFlowEdges();
    const cache = createEdgeDecorationCache();
    decorateFlowEdges(edges, null, true, cache);
    expect(cache.size).toBe(edges.length);

    decorateFlowEdges(edges.slice(0, 5), null, true, cache);
    expect(cache.size).toBe(5);
  });
});
