/** Tree shaping over a trace scope: L0 anchor, per-side levels, Connected group, directional grow checks. */
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

  it('offers out-of-scope neighbors in the level direction and hides pruned ones', () => {
    const graph = fixture();
    graph.addNode('f', {});
    graph.addEdgeWithKey('e→f', 'e', 'f', {});
    graph.addNode('g', {});
    graph.addEdgeWithKey('g→e', 'g', 'e', {});
    const pruned = buildTraceTree({ originId: 'origin', visibleNodeIds: allVisible, prunedNodeIds: new Set(['f']) }, graph);
    expect(pruned?.downstream[0].grow.get('e')).toEqual([]);
    const tree = buildTraceTree({ originId: 'origin', visibleNodeIds: allVisible, prunedNodeIds: nonePruned }, graph);
    // e is downstream: its outbound f grows, its inbound g (a sibling feed) does not.
    expect(tree?.downstream[0].grow.get('e')).toEqual(['f']);
    expect(tree?.downstream[1].grow.get('d')).toEqual([]);
  });

  it('places visible nodes neither walk reaches in the Connected group', () => {
    const graph = fixture();
    graph.addNode('s', {});
    graph.addEdgeWithKey('s→c', 's', 'c', {});
    const visible = new Set(['origin', 'c', 's']);
    const tree = buildTraceTree({ originId: 'origin', visibleNodeIds: visible, prunedNodeIds: nonePruned }, graph);
    expect(tree?.connected?.nodeIds).toEqual(['s']);
    const listed = new Set([
      tree!.originId,
      ...[...tree!.upstream, ...tree!.downstream].flatMap(level => level.nodeIds),
      ...(tree!.connected?.nodeIds ?? []),
    ]);
    expect(listed).toEqual(visible);
  });

  it('omits the Connected group when every visible node is placed', () => {
    const tree = buildTraceTree({ originId: 'origin', visibleNodeIds: allVisible, prunedNodeIds: nonePruned }, fixture());
    expect(tree?.connected).toBeNull();
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
