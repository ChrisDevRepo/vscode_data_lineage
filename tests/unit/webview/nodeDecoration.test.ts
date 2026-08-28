// @vitest-environment jsdom
/**
 * Lane for the drag re-render storm.
 *
 * React Flow emits a position change per drag frame, so `applyNodeChanges` hands back a new object
 * for the dragged node and keeps every other node's reference. The canvas previously rebuilt a fresh
 * `data` object for *every* node on that array change, breaking the `React.memo` on the node
 * renderers — dragging one node re-rendered all of them, at 1000 nodes, every frame.
 *
 * The counting assertions below are the lock: a position-only change must leave every other node's
 * `data` reference untouched. `buildGraphologyGraph` posts through `window.vscode`, so this runs
 * under jsdom for the same reason graphologyGraph-guards.test.ts does.
 */

import { describe, expect, it } from 'vitest';
import { applyNodeChanges, type Node as FlowNode, type NodeChange } from '@xyflow/react';
import { buildGraphNoLayout } from '../../../src/engine/graphBuilder';
import {
  createNodeDecorationCache,
  decorateFlowNodes,
  type NodeDecorationInputs,
} from '../../../src/engine/nodeDecoration';
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

    // Not "all but the dragged node" — every node keeps its data, the dragged one included, so its
    // own renderer skips too and React Flow only moves the transform.
    const churned = after.filter((node, i) => node.data !== before[i].data);
    expect(churned).toHaveLength(0);

    // Only the dragged node is a new object at all, and only because its position moved.
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
    expect(after[10].data.dimmed).toBe(false);
    expect(after[11].data.dimmed).toBe(false);
    expect(after[12].data.dimmed).toBe(true);

    // The cache must not suppress a real change: the highlighted node and every node the highlight
    // dims are rebuilt. The level-1 neighbour is the one node whose decoration genuinely did not
    // change, so keeping its reference is correct rather than stale.
    expect(after[10].data).not.toBe(before[10].data);
    expect(after[12].data).not.toBe(before[12].data);
    const unchanged = after.filter((node, i) => node.data === before[i].data);
    expect(unchanged.map(n => n.id)).toEqual([neighbour]);
  });

  it('keeps the trace origin highlighted rather than dimming it', () => {
    const nodes = largeFlowNodes();
    const cache = createNodeDecorationCache();
    const origin = nodes[3].id;

    const decorated = decorateFlowNodes(nodes, baseInputs({
      highlightedNodeId: nodes[80].id,
      traceMode: 'applied',
      traceSelectedNodeId: origin,
    }), cache);

    expect(decorated[3].data.highlighted).toBe(true);
    expect(decorated[3].data.dimmed).toBe(false);
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
