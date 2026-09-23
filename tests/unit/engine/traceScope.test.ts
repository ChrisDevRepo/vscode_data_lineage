import { makeGraph } from '../helpers/testUtils';
import {
  buildVisibleTraceScope,
  canPruneTraceNode,
  collectScopeEdgeIds,
  isManualTraceScopeEdit,
} from '../../../src/engine/traceScope';
import {
  bfsReachable,
  findShortestPathOrdered,
  nodesCutByRemoval,
} from '../../../src/engine/graphGuards';
import type { TraceState } from '../../../src/engine/types';
import type { LineageEdge } from '../../../src/engine/types';
import { describe, expect, it } from 'vitest';

describe("Trace Scope Safety Tests", () => {
  function edges(...pairs: Array<[string, string]>): LineageEdge[] {
    return pairs.map(([source, target]) => ({ source, target, type: 'body' as const }));
  }
  it("buildVisibleTraceScope", () => {
  const base = new Set(['A', 'B', 'C']);
  const { nodeIds } = buildVisibleTraceScope(base, new Set(), new Set(), []);
  expect(nodeIds.has('A') && nodeIds.has('B') && nodeIds.has('C'), 'base only: all base nodes present').toBe(true);
  expect(nodeIds.size, 'base only: exact count 3').toBe(3);
});

  it("add: A B C all present", () => {
  const base = new Set(['A', 'B']);
  const added = new Set(['C']);
  const { nodeIds } = buildVisibleTraceScope(base, added, new Set(), []);
  expect(nodeIds.has('A') && nodeIds.has('B') && nodeIds.has('C'), 'add: A B C all present').toBe(true);
  expect(nodeIds.size, 'add: exact count 3').toBe(3);
});

  it("prune: A and C remain", () => {
  const base = new Set(['A', 'B', 'C']);
  const pruned = new Set(['B']);
  const { nodeIds } = buildVisibleTraceScope(base, new Set(), pruned, []);
  expect(nodeIds.has('A') && nodeIds.has('C'), 'prune: A and C remain').toBe(true);
  expect(!nodeIds.has('B'), 'prune: B is gone').toBe(true);
  expect(nodeIds.size, 'prune: exact count 2').toBe(2);
});

  it("add+prune: A present", () => {
  const base = new Set(['A', 'B']);
  const added = new Set(['C', 'D']);
  const pruned = new Set(['B', 'C']); // C added then pruned → absent
  const { nodeIds } = buildVisibleTraceScope(base, added, pruned, []);
  expect(nodeIds.has('A'), 'add+prune: A present').toBe(true);
  expect(nodeIds.has('D'), 'add+prune: D present (added, not pruned)').toBe(true);
  expect(!nodeIds.has('B'), 'add+prune: B absent (base then pruned)').toBe(true);
  expect(!nodeIds.has('C'), 'add+prune: C absent (added then pruned)').toBe(true);
  expect(nodeIds.size, 'add+prune: exact count 2').toBe(2);
});

  it("edge collection: 3 nodes", () => {
  const base = new Set(['A', 'B', 'C']);
  const edgeList = edges(['A', 'B'], ['B', 'C'], ['A', 'C'], ['B', 'D']);
  const { nodeIds, edgeIds } = buildVisibleTraceScope(base, new Set(), new Set(), edgeList);
  expect(nodeIds.size, 'edge collection: 3 nodes').toBe(3);
  expect(edgeIds.has('A→B'), 'edge collection: A→B included').toBe(true);
  expect(edgeIds.has('B→C'), 'edge collection: B→C included').toBe(true);
  expect(edgeIds.has('A→C'), 'edge collection: A→C included').toBe(true);
  expect(!edgeIds.has('B→D'), 'edge collection: B→D excluded (D not in scope)').toBe(true);
  expect(edgeIds.size, 'edge collection: exact 3 edges').toBe(3);
});

  it("empty node scope → 0 edges", () => {
  const result = collectScopeEdgeIds(edges(['A', 'B']), new Set());
  expect(result.size, 'empty node scope → 0 edges').toBe(0);
});

  it("self-loop included when node in scope", () => {
  const result = collectScopeEdgeIds(edges(['A', 'A']), new Set(['A']));
  expect(result.has('A→A'), 'self-loop included when node in scope').toBe(true);
});

  it("bfsReachable", () => {
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set());
  expect(reach.has('A') && reach.has('B') && reach.has('C'), 'chain: A B C reachable from A').toBe(true);
  expect(reach.size, 'chain: exact count 3').toBe(3);
});

  it("removed B: A still reachable from A (start)", () => {
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set(['B']));
  expect(reach.has('A'), 'removed B: A still reachable from A (start)').toBe(true);
  expect(!reach.has('B'), 'removed B: B not in result').toBe(true);
  expect(!reach.has('C'), 'removed B: C cut off').toBe(true);
});

  it("candidateId B excluded", () => {
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set(), 'B');
  expect(!reach.has('B'), 'candidateId B excluded').toBe(true);
  expect(!reach.has('C'), 'C cut off by candidateId exclusion').toBe(true);
});

  it("scope A+B: both reachable", () => {
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set(), undefined, new Set(['A', 'B']));
  expect(reach.has('A') && reach.has('B'), 'scope A+B: both reachable').toBe(true);
  expect(!reach.has('C'), 'scope A+B: C outside scope, not reached').toBe(true);
});

  it("missing start → empty set", () => {
  const g = makeGraph([{ id: 'A' }], []);
  const reach = bfsReachable(g, 'MISSING', new Set());
  expect(reach.size, 'missing start → empty set').toBe(0);
});

  it("nodesCutByRemoval: bridge removal cuts its subtree", () => {
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const cut = nodesCutByRemoval(g, 'A', new Set(), new Set(['B']));
  expect(cut, 'nodesCutByRemoval: C cut, B excluded as removedAfter').toEqual(['C']);
});

  it("nodesCutByRemoval: diamond keeps C reachable through the other branch", () => {
  const g = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
    [['A', 'B'], ['A', 'D'], ['B', 'C'], ['D', 'C']]
  );
  const cut = nodesCutByRemoval(g, 'A', new Set(), new Set(['B']));
  expect(cut, 'nodesCutByRemoval: C survives through D').toEqual([]);
});

  it("nodesCutByRemoval: keep set excludes an already-visited node from the cut", () => {
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const cut = nodesCutByRemoval(g, 'A', new Set(), new Set(['B']), undefined, new Set(['C']));
  expect(cut, 'nodesCutByRemoval: C kept even though it would otherwise be cut').toEqual([]);
});

  it("canPruneTraceNode", () => {
  const g = makeGraph([{ id: 'O' }, { id: 'A' }, { id: 'B' }], [['O', 'A'], ['A', 'B']]);
  const visible = new Set(['O', 'A', 'B']);
  const check = canPruneTraceNode(g, 'O', visible, 'O');
  expect(!check.safe, 'origin prune: not safe').toBe(true);
  expect(check.reason, "origin prune: reason='origin'").toBe('origin');
});

  it("not-visible prune: not safe", () => {
  const g = makeGraph([{ id: 'O' }, { id: 'A' }], [['O', 'A']]);
  const visible = new Set(['O', 'A']);
  const check = canPruneTraceNode(g, 'O', visible, 'HIDDEN');
  expect(!check.safe, 'not-visible prune: not safe').toBe(true);
  expect(check.reason, "not-visible prune: reason='not-visible'").toBe('not-visible');
});

  it("null origin: not safe", () => {
  const g = makeGraph([{ id: 'A' }], []);
  const check = canPruneTraceNode(g, null, new Set(['A']), 'A');
  expect(!check.safe, 'null origin: not safe').toBe(true);
  expect(check.reason, "null origin: reason='origin'").toBe('origin');
});

  it("bridge prune: self-prune, safe, takes C with it", () => {
  const g = makeGraph(
    [{ id: 'O' }, { id: 'B' }, { id: 'C' }],
    [['O', 'B'], ['B', 'C']]
  );
  const visible = new Set(['O', 'B', 'C']);
  const check = canPruneTraceNode(g, 'O', visible, 'B');
  expect(check.safe, 'bridge prune: self-prune is safe, never refused').toBe(true);
  expect(check.reason === undefined, 'bridge prune: no reason').toBe(true);
  expect(check.cutNodeIds, 'bridge prune: C leaves with B (its subtree)').toEqual(['C']);
});

  it("safe leaf prune: safe=true, nothing cut", () => {
  const g = makeGraph(
    [{ id: 'O' }, { id: 'A' }, { id: 'B' }],
    [['O', 'A'], ['O', 'B']]
  );
  const visible = new Set(['O', 'A', 'B']);
  const check = canPruneTraceNode(g, 'O', visible, 'A');
  expect(check.safe, 'safe leaf prune: safe=true').toBe(true);
  expect(check.reason === undefined, 'safe leaf prune: no reason').toBe(true);
  expect(check.cutNodeIds, 'safe leaf prune: no subtree').toEqual([]);
});

  it("diamond prune A: safe, nothing cut — C reachable via B", () => {
  const g = makeGraph(
    [{ id: 'O' }, { id: 'A' }, { id: 'B' }, { id: 'C' }],
    [['O', 'A'], ['O', 'B'], ['A', 'C'], ['B', 'C']]
  );
  const visible = new Set(['O', 'A', 'B', 'C']);
  const check = canPruneTraceNode(g, 'O', visible, 'A');
  expect(check.safe, 'diamond prune A: safe — C reachable via B').toBe(true);
  expect(check.cutNodeIds, 'diamond prune A: C survives, nothing cut').toEqual([]);
});

  it("diamond, second shape: pruning A cuts nothing — C survives through D", () => {
  const g = makeGraph(
    [{ id: 'O' }, { id: 'A' }, { id: 'D' }, { id: 'C' }],
    [['O', 'A'], ['A', 'C'], ['O', 'D'], ['D', 'C']]
  );
  const visible = new Set(['O', 'A', 'D', 'C']);
  const check = canPruneTraceNode(g, 'O', visible, 'A');
  expect(check.safe, 'diamond (second shape): safe').toBe(true);
  expect(check.cutNodeIds, 'diamond (second shape): C survives through D, nothing cut').toEqual([]);
});

  it("chain origin→A→B→C plus origin→D: pruning A cuts B and C, D survives", () => {
  const g = makeGraph(
    [{ id: 'O' }, { id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
    [['O', 'A'], ['A', 'B'], ['B', 'C'], ['O', 'D']]
  );
  const visible = new Set(['O', 'A', 'B', 'C', 'D']);
  const check = canPruneTraceNode(g, 'O', visible, 'A');
  expect(check.safe, 'chain prune A: safe').toBe(true);
  expect(new Set(check.cutNodeIds), 'chain prune A: cuts [B, C]').toEqual(new Set(['B', 'C']));
  expect(check.cutNodeIds?.length, 'chain prune A: exactly 2 cut').toBe(2);

  const remaining = new Set(visible);
  remaining.delete('A');
  for (const id of check.cutNodeIds ?? []) remaining.delete(id);
  const stillReachable = bfsReachable(g, 'O', new Set(['A', ...(check.cutNodeIds ?? [])]));
  for (const id of remaining) {
    expect(stillReachable.has(id), `no island: ${id} stays reachable from origin after prune+cut`).toBe(true);
  }
});

  it("origin not in visible: not safe", () => {
  const g = makeGraph([{ id: 'O' }, { id: 'A' }], [['O', 'A']]);
  const visible = new Set(['A']);
  const check = canPruneTraceNode(g, 'O', visible, 'A');
  expect(!check.safe, 'origin not in visible: not safe').toBe(true);
  expect(check.reason, "origin not in visible: reason='origin'").toBe('origin');
});

  it("no-path: disconnected → null", () => {
  const g = makeGraph([{ id: 'A' }, { id: 'B' }], []); // no edges
  const result = findShortestPathOrdered(g, 'A', 'B');
  expect(result === null, 'no-path: disconnected → null').toBe(true);
});

  it("missing endpoint → null", () => {
  const g = makeGraph([{ id: 'A' }], []);
  const result = findShortestPathOrdered(g, 'A', 'GHOST');
  expect(result === null, 'missing endpoint → null').toBe(true);
});

  it("forward path: result not null", () => {
  const g = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    [['A', 'B'], ['B', 'C']]
  );
  const result = findShortestPathOrdered(g, 'A', 'C');
  expect(result !== null, 'forward path: result not null').toBe(true);
  expect(result!.direction, "forward path: direction='source_to_target'").toBe('source_to_target');
  expect(result!.path[0], 'forward path: starts at A').toBe('A');
  expect(result!.path[result!.path.length - 1], 'forward path: ends at C').toBe('C');
  expect(result!.path.length, 'forward path: length=3 (A-B-C)').toBe(3);
});

  it("reverse path: result not null", () => {
  const g = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    [['C', 'B'], ['B', 'A']]
  );
  const result = findShortestPathOrdered(g, 'A', 'C');
  expect(result !== null, 'reverse path: result not null').toBe(true);
  expect(result!.direction, "reverse path: direction='target_to_source'").toBe('target_to_source');
  expect(result!.path[0], 'reverse path: starts at C (target)').toBe('C');
  expect(result!.path[result!.path.length - 1], 'reverse path: ends at A (source)').toBe('A');
});

  it("single hop: not null", () => {
  const g = makeGraph([{ id: 'A' }, { id: 'B' }], [['A', 'B']]);
  const result = findShortestPathOrdered(g, 'A', 'B');
  expect(result !== null, 'single hop: not null').toBe(true);
  expect(result!.path.length, 'single hop: path length=2').toBe(2);
  expect(result!.direction, "single hop: direction='source_to_target'").toBe('source_to_target');
});

});

describe("isManualTraceScopeEdit", () => {
  function baseState(overrides: Partial<TraceState> = {}): TraceState {
    return {
      mode: 'applied',
      selectedNodeId: 'ORIGIN',
      targetNodeId: null,
      upstreamLevels: 2,
      downstreamLevels: 2,
      baseNodeIds: new Set(['ORIGIN', 'A', 'B']),
      baseEdgeIds: new Set(['ORIGIN→A', 'A→B']),
      manualAddedNodeIds: new Set(),
      manualPrunedNodeIds: new Set(),
      tracedNodeIds: new Set(['ORIGIN', 'A', 'B']),
      tracedEdgeIds: new Set(['ORIGIN→A', 'A→B']),
      autoPromoted: false,
      ...overrides,
    };
  }

  it("identical states, no manual delta: false (nothing to preserve viewport for)", () => {
  const previous = baseState();
  const next = baseState();
  expect(isManualTraceScopeEdit(previous, next), 'identical states: false').toBe(false);
});

  it("previous.mode='none': false (non-editable previous mode short-circuits)", () => {
  const previous = baseState({ mode: 'none' });
  const next = baseState({ manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), "previous.mode='none': false").toBe(false);
});

  it("previous.mode='configuring': false (non-editable previous mode)", () => {
  const previous = baseState({ mode: 'configuring' });
  const next = baseState({ manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), "previous.mode='configuring': false").toBe(false);
});

  it("previous.mode='pathfinding': false (non-editable previous mode)", () => {
  const previous = baseState({ mode: 'pathfinding' });
  const next = baseState({ mode: 'pathfinding', manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), "previous.mode='pathfinding': false").toBe(false);
});

  it("previous.mode='path-applied': false (non-editable previous mode)", () => {
  const previous = baseState({ mode: 'path-applied' });
  const next = baseState({ mode: 'path-applied', manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), "previous.mode='path-applied': false").toBe(false);
});

  it("previous.mode='analysis': false (non-editable previous mode)", () => {
  const previous = baseState({ mode: 'analysis' });
  const next = baseState({ mode: 'analysis', manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), "previous.mode='analysis': false").toBe(false);
});

  it("next.mode='none': false (non-editable next mode short-circuits)", () => {
  const previous = baseState();
  const next = baseState({ mode: 'none', manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), "next.mode='none': false").toBe(false);
});

  it("next.mode='analysis': false (non-editable next mode)", () => {
  const previous = baseState();
  const next = baseState({ mode: 'analysis', manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), "next.mode='analysis': false").toBe(false);
});

  it("mode 'applied' -> 'filtered', otherwise identical: false (both editable, no manual delta)", () => {
  const previous = baseState({ mode: 'applied' });
  const next = baseState({ mode: 'filtered' });
  expect(isManualTraceScopeEdit(previous, next), "mode transition, no manual delta: false").toBe(false);
});

  it("mode 'filtered' -> 'applied', with manual add delta: true (both editable)", () => {
  const previous = baseState({ mode: 'filtered' });
  const next = baseState({ mode: 'applied', manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), "mode transition, with manual delta: true").toBe(true);
});

  it("selectedNodeId differs: false (origin change is not a manual scope edit)", () => {
  const previous = baseState({ selectedNodeId: 'ORIGIN' });
  const next = baseState({ selectedNodeId: 'OTHER', manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), 'selectedNodeId differs: false').toBe(false);
});

  it("selectedNodeId null vs non-null: false", () => {
  const previous = baseState({ selectedNodeId: null });
  const next = baseState({ selectedNodeId: 'ORIGIN' });
  expect(isManualTraceScopeEdit(previous, next), 'selectedNodeId null vs non-null: false').toBe(false);
});

  it("targetNodeId differs: false (pathfinding target change is not a manual scope edit)", () => {
  const previous = baseState({ targetNodeId: null });
  const next = baseState({ targetNodeId: 'TARGET', manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), 'targetNodeId differs: false').toBe(false);
});

  it("upstreamLevels differs: false (depth change is not a manual scope edit)", () => {
  const previous = baseState({ upstreamLevels: 2 });
  const next = baseState({ upstreamLevels: 3, manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), 'upstreamLevels differs: false').toBe(false);
});

  it("downstreamLevels differs: false (depth change is not a manual scope edit)", () => {
  const previous = baseState({ downstreamLevels: 2 });
  const next = baseState({ downstreamLevels: 3, manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), 'downstreamLevels differs: false').toBe(false);
});

  it("autoPromoted differs (false -> true): false (promotion is a fresh scope, not a manual edit)", () => {
  const previous = baseState({ autoPromoted: false });
  const next = baseState({ autoPromoted: true, manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), 'autoPromoted false->true: false').toBe(false);
});

  it("autoPromoted differs (undefined -> true): false (strict !== treats missing as distinct from true)", () => {
  const previous = baseState({ autoPromoted: undefined });
  const next = baseState({ autoPromoted: true, manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), 'autoPromoted undefined->true: false').toBe(false);
});

  it("autoPromoted same on both sides (undefined): true when manual delta present", () => {
  const previous = baseState({ autoPromoted: undefined });
  const next = baseState({ autoPromoted: undefined, manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), 'autoPromoted undefined on both sides: true').toBe(true);
});

  it("baseNodeIds differs (fresh BFS scope): false, even with a manual delta present", () => {
  const previous = baseState({ baseNodeIds: new Set(['ORIGIN', 'A', 'B']) });
  const next = baseState({
    baseNodeIds: new Set(['ORIGIN', 'A', 'B', 'D']),
    manualAddedNodeIds: new Set(['C']),
  });
  expect(isManualTraceScopeEdit(previous, next), 'baseNodeIds differs: false').toBe(false);
});

  it("baseNodeIds same size, different membership: false (sameIdSet checks membership, not just size)", () => {
  const previous = baseState({ baseNodeIds: new Set(['ORIGIN', 'A', 'B']) });
  const next = baseState({
    baseNodeIds: new Set(['ORIGIN', 'A', 'D']),
    manualAddedNodeIds: new Set(['C']),
  });
  expect(isManualTraceScopeEdit(previous, next), 'baseNodeIds same size, different membership: false').toBe(false);
});

  it("baseEdgeIds differs (fresh BFS scope): false, even with a manual delta present", () => {
  const previous = baseState({ baseEdgeIds: new Set(['ORIGIN→A', 'A→B']) });
  const next = baseState({
    baseEdgeIds: new Set(['ORIGIN→A']),
    manualAddedNodeIds: new Set(['C']),
  });
  expect(isManualTraceScopeEdit(previous, next), 'baseEdgeIds differs: false').toBe(false);
});

  it("manualAddedNodeIds differs, manualPrunedNodeIds identical: true", () => {
  const previous = baseState({ manualAddedNodeIds: new Set() });
  const next = baseState({ manualAddedNodeIds: new Set(['C']) });
  expect(isManualTraceScopeEdit(previous, next), 'manualAddedNodeIds differs: true').toBe(true);
});

  it("manualPrunedNodeIds differs, manualAddedNodeIds identical: true", () => {
  const previous = baseState({ manualPrunedNodeIds: new Set() });
  const next = baseState({ manualPrunedNodeIds: new Set(['A']) });
  expect(isManualTraceScopeEdit(previous, next), 'manualPrunedNodeIds differs: true').toBe(true);
});

  it("manualAddedNodeIds AND manualPrunedNodeIds both differ: true", () => {
  const previous = baseState({ manualAddedNodeIds: new Set(), manualPrunedNodeIds: new Set() });
  const next = baseState({
    manualAddedNodeIds: new Set(['C']),
    manualPrunedNodeIds: new Set(['A']),
  });
  expect(isManualTraceScopeEdit(previous, next), 'manualAdded and manualPruned both differ: true').toBe(true);
});

  it("manualAddedNodeIds same size, different membership: true (sameIdSet checks membership)", () => {
  const previous = baseState({ manualAddedNodeIds: new Set(['C']) });
  const next = baseState({ manualAddedNodeIds: new Set(['D']) });
  expect(isManualTraceScopeEdit(previous, next), 'manualAddedNodeIds same size, different membership: true').toBe(true);
});

  it("all compared fields identical (both manual sets non-empty but unchanged): false", () => {
  const previous = baseState({
    manualAddedNodeIds: new Set(['C']),
    manualPrunedNodeIds: new Set(['A']),
  });
  const next = baseState({
    manualAddedNodeIds: new Set(['C']),
    manualPrunedNodeIds: new Set(['A']),
  });
  expect(isManualTraceScopeEdit(previous, next), 'no manual delta despite non-empty sets: false').toBe(false);
});

});
