/** Tree shaping over a trace scope: L0 anchor, per-side levels, leaf grow checks. */
import Graph from 'graphology';
import { describe, expect, it } from 'vitest';
import { buildTraceTree, traceRemoveKind } from '../../../src/components/traceTreeModel';

function fixture(): Graph {
  const graph = new Graph({ type: 'directed', multi: false });
  // a → b → origin → c → d, plus origin → e (leaf) and a cycle edge d → b.
  for (const id of ['a', 'b', 'origin', 'c', 'd', 'e']) graph.addNode(id, {});
  graph.addEdgeWithKey('a→b', 'a', 'b', {});
  graph.addEdgeWithKey('b→origin', 'b', 'origin', {});
  graph.addEdgeWithKey('origin→c', 'origin', 'c', {});
  graph.addEdgeWithKey('c→d', 'c', 'd', {});
  graph.addEdgeWithKey('origin→e', 'origin', 'e', {});
  graph.addEdgeWithKey('d→b', 'd', 'b', {});
  return graph;
}

const allVisible = new Set(['a', 'b', 'origin', 'c', 'd', 'e']);
const nonePruned = new Set<string>();

describe('buildTraceTree', () => {
  it('anchors at L0 with upstream and downstream levels outward', () => {
    // The d→b cycle makes d (and through it, c) upstream-reachable too;
    // a node reachable from both directions appears on both sides.
    const tree = buildTraceTree({ originId: 'origin', visibleNodeIds: allVisible, prunedNodeIds: nonePruned }, fixture());
    expect(tree?.originId).toBe('origin');
    expect(tree?.upstream.map(level => level.nodeIds)).toEqual([['b'], ['a', 'd'], ['c']]);
    expect(tree?.downstream.map(level => level.nodeIds)).toEqual([['c', 'e'], ['d'], ['b']]);
    expect(tree?.totalUpstream).toBe(4);
    expect(tree?.totalDownstream).toBe(4);
  });

  it('restricts levels to the visible scope', () => {
    const visible = new Set(['origin', 'c']);
    const tree = buildTraceTree({ originId: 'origin', visibleNodeIds: visible, prunedNodeIds: nonePruned }, fixture());
    expect(tree?.downstream.map(level => level.nodeIds)).toEqual([['c']]);
    expect(tree?.upstream).toEqual([]);
  });

  it('returns null without an origin or when the origin is not visible', () => {
    const graph = fixture();
    expect(buildTraceTree({ originId: null, visibleNodeIds: allVisible, prunedNodeIds: nonePruned }, graph)).toBeNull();
    expect(buildTraceTree({ originId: 'origin', visibleNodeIds: new Set(['a']), prunedNodeIds: nonePruned }, graph)).toBeNull();
    expect(buildTraceTree({ originId: 'origin', visibleNodeIds: allVisible, prunedNodeIds: nonePruned }, null)).toBeNull();
  });

  it('offers out-of-scope neighbors as grow candidates and hides pruned ones', () => {
    const graph = fixture();
    graph.addNode('f', {});
    graph.addEdgeWithKey('e→f', 'e', 'f', {});
    const tree = buildTraceTree({ originId: 'origin', visibleNodeIds: allVisible, prunedNodeIds: new Set(['f']) }, graph);
    expect(tree?.leafGrow.get('e')).toEqual([]);
    const unpruned = buildTraceTree({ originId: 'origin', visibleNodeIds: allVisible, prunedNodeIds: nonePruned }, graph);
    expect(unpruned?.leafGrow.get('e')).toEqual(['f']);
    expect(unpruned?.leafGrow.get('d')).toEqual([]);
  });
});

describe('traceRemoveKind', () => {
  it('permits trace-prune only in editable trace modes', () => {
    expect(traceRemoveKind('applied')).toBe('trace-prune');
    expect(traceRemoveKind('filtered')).toBe('trace-prune');
    expect(traceRemoveKind('path-applied')).toBe('none');
    expect(traceRemoveKind('none')).toBe('none');
  });
});
