import { makeGraph } from '../helpers/testUtils';
import {
  buildVisibleTraceScope,
  canPruneTraceNode,
  collectScopeEdgeIds,
  isManualTraceScopeEdit,
} from '../../../src/engine/traceScope';
import {
  bfsReachable,
  firstDisconnectedRequiredNode,
  findShortestPathOrdered,
} from '../../../src/engine/graphGuards';
import type { TraceState } from '../../../src/engine/types';
import type { LineageEdge } from '../../../src/engine/types';
import { describe, expect, it } from 'vitest';

describe("Trace Scope Safety Tests", () => {
  function edges(...pairs: Array<[string, string]>): LineageEdge[] {
    return pairs.map(([source, target]) => ({ source, target, type: 'body' as const }));
  }
  it("buildVisibleTraceScope", () => {
  // Base only — no add, no prune
  const base = new Set(['A', 'B', 'C']);
  const { nodeIds } = buildVisibleTraceScope(base, new Set(), new Set(), []);
  expect(nodeIds.has('A') && nodeIds.has('B') && nodeIds.has('C'), 'base only: all base nodes present').toBe(true);
  expect(nodeIds.size, 'base only: exact count 3').toBe(3);
});

  it("add: A B C all present", () => {
  // Add a node not in base
  const base = new Set(['A', 'B']);
  const added = new Set(['C']);
  const { nodeIds } = buildVisibleTraceScope(base, added, new Set(), []);
  expect(nodeIds.has('A') && nodeIds.has('B') && nodeIds.has('C'), 'add: A B C all present').toBe(true);
  expect(nodeIds.size, 'add: exact count 3').toBe(3);
});

  it("prune: A and C remain", () => {
  // Prune a node from base
  const base = new Set(['A', 'B', 'C']);
  const pruned = new Set(['B']);
  const { nodeIds } = buildVisibleTraceScope(base, new Set(), pruned, []);
  expect(nodeIds.has('A') && nodeIds.has('C'), 'prune: A and C remain').toBe(true);
  expect(!nodeIds.has('B'), 'prune: B is gone').toBe(true);
  expect(nodeIds.size, 'prune: exact count 2').toBe(2);
});

  it("add+prune: A present", () => {
  // Add AND prune — pruned wins over added when the same id is in both
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
  // Edge collection: only edges whose endpoints are BOTH in the visible set
  const base = new Set(['A', 'B', 'C']);
  const edgeList = edges(['A', 'B'], ['B', 'C'], ['A', 'C'], ['B', 'D']);
  const { nodeIds, edgeIds } = buildVisibleTraceScope(base, new Set(), new Set(), edgeList);
  expect(nodeIds.size, 'edge collection: 3 nodes').toBe(3);
  // A→B, B→C, A→C all within scope; B→D excluded (D not in scope)
  expect(edgeIds.has('A→B'), 'edge collection: A→B included').toBe(true);
  expect(edgeIds.has('B→C'), 'edge collection: B→C included').toBe(true);
  expect(edgeIds.has('A→C'), 'edge collection: A→C included').toBe(true);
  expect(!edgeIds.has('B→D'), 'edge collection: B→D excluded (D not in scope)').toBe(true);
  expect(edgeIds.size, 'edge collection: exact 3 edges').toBe(3);
});

  it("empty node scope → 0 edges", () => {
  // Empty scope → no edges
  const result = collectScopeEdgeIds(edges(['A', 'B']), new Set());
  expect(result.size, 'empty node scope → 0 edges').toBe(0);
});

  it("self-loop included when node in scope", () => {
  // Self-loop edge — both endpoints are the same node, which is in scope
  const result = collectScopeEdgeIds(edges(['A', 'A']), new Set(['A']));
  expect(result.has('A→A'), 'self-loop included when node in scope').toBe(true);
});

  it("bfsReachable", () => {
  // Linear chain A→B→C: from A, all reachable (undirected BFS)
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set());
  expect(reach.has('A') && reach.has('B') && reach.has('C'), 'chain: A B C reachable from A').toBe(true);
  expect(reach.size, 'chain: exact count 3').toBe(3);
});

  it("removed B: A still reachable from A (start)", () => {
  // B removed → from A: A reachable, B and C not (undirected BFS blocked at B)
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set(['B']));
  expect(reach.has('A'), 'removed B: A still reachable from A (start)').toBe(true);
  expect(!reach.has('B'), 'removed B: B not in result').toBe(true);
  expect(!reach.has('C'), 'removed B: C cut off').toBe(true);
});

  it("candidateId B excluded", () => {
  // candidateId excluded — equivalent to removing it without adding to removedSet
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set(), 'B');
  expect(!reach.has('B'), 'candidateId B excluded').toBe(true);
  expect(!reach.has('C'), 'C cut off by candidateId exclusion').toBe(true);
});

  it("scope A+B: both reachable", () => {
  // Scope restriction: A→B→C but scope only allows A and B
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set(), undefined, new Set(['A', 'B']));
  expect(reach.has('A') && reach.has('B'), 'scope A+B: both reachable').toBe(true);
  expect(!reach.has('C'), 'scope A+B: C outside scope, not reached').toBe(true);
});

  it("missing start → empty set", () => {
  // Start node not in graph → empty set
  const g = makeGraph([{ id: 'A' }], []);
  const reach = bfsReachable(g, 'MISSING', new Set());
  expect(reach.size, 'missing start → empty set').toBe(0);
});

  it("empty required set → null", () => {
  // No required nodes → always null
  const g = makeGraph([{ id: 'A' }, { id: 'B' }], [['A', 'B']]);
  const result = firstDisconnectedRequiredNode(g, 'A', new Set(['B']), new Set());
  expect(result === null, 'empty required set → null').toBe(true);
});

  it("removing bridge B disconnects required C", () => {
  // A→B→C: remove B. Required = {C}. C becomes disconnected from A.
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const result = firstDisconnectedRequiredNode(g, 'A', new Set(['B']), new Set(['C']));
  expect(result, 'removing bridge B disconnects required C').toBe('C');
});

  it("removing B when C has direct path from A → no disconnection", () => {
  // A→B, A→C (two paths from A). Removing B leaves C still reachable.
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['A', 'C']]);
  const result = firstDisconnectedRequiredNode(g, 'A', new Set(['B']), new Set(['C']));
  expect(result === null, 'removing B when C has direct path from A → no disconnection').toBe(true);
});

  it("required node already in removedSet is skipped", () => {
  // removedSet includes a required node — skipped (already removed, not flagged)
  const g = makeGraph([{ id: 'A' }, { id: 'B' }], [['A', 'B']]);
  const result = firstDisconnectedRequiredNode(g, 'A', new Set(['B']), new Set(['B']));
  expect(result === null, 'required node already in removedSet is skipped').toBe(true);
});

  it("canPruneTraceNode", () => {
  // Pruning the origin is always rejected with reason 'origin'
  const g = makeGraph([{ id: 'O' }, { id: 'A' }, { id: 'B' }], [['O', 'A'], ['A', 'B']]);
  const visible = new Set(['O', 'A', 'B']);
  const check = canPruneTraceNode(g, 'O', visible, 'O');
  expect(!check.safe, 'origin prune: not safe').toBe(true);
  expect(check.reason, "origin prune: reason='origin'").toBe('origin');
});

  it("not-visible prune: not safe", () => {
  // Pruning a node that is not in the visible set → reason 'not-visible'
  const g = makeGraph([{ id: 'O' }, { id: 'A' }], [['O', 'A']]);
  const visible = new Set(['O', 'A']);
  const check = canPruneTraceNode(g, 'O', visible, 'HIDDEN');
  expect(!check.safe, 'not-visible prune: not safe').toBe(true);
  expect(check.reason, "not-visible prune: reason='not-visible'").toBe('not-visible');
});

  it("null origin: not safe", () => {
  // null origin always returns reason 'origin'
  const g = makeGraph([{ id: 'A' }], []);
  const check = canPruneTraceNode(g, null, new Set(['A']), 'A');
  expect(!check.safe, 'null origin: not safe').toBe(true);
  expect(check.reason, "null origin: reason='origin'").toBe('origin');
});

  it("bridge prune: not safe", () => {
  // Bridge topology: O→B→C. Pruning B disconnects C → reason 'disconnected'
  //   O is origin, B is bridge, C is downstream leaf.
  //   graph is undirected for BFS, so: neighbors(O)={B}, neighbors(B)={O,C}, neighbors(C)={B}.
  //   After removing B, C is only reachable via B which is gone → disconnected.
  const g = makeGraph(
    [{ id: 'O' }, { id: 'B' }, { id: 'C' }],
    [['O', 'B'], ['B', 'C']]
  );
  const visible = new Set(['O', 'B', 'C']);
  const check = canPruneTraceNode(g, 'O', visible, 'B');
  expect(!check.safe, 'bridge prune: not safe').toBe(true);
  expect(check.reason, "bridge prune: reason='disconnected'").toBe('disconnected');
  expect(check.disconnectedNodeId, 'bridge prune: disconnectedNodeId=C').toBe('C');
});

  it("safe leaf prune: safe=true", () => {
  // Safe prune: O→A, O→B, A→C. Prune A: C still reachable? No — C only via A.
  // So instead test a safe leaf: O→A, O→B. Prune A (leaf) — B still reachable.
  const g = makeGraph(
    [{ id: 'O' }, { id: 'A' }, { id: 'B' }],
    [['O', 'A'], ['O', 'B']]
  );
  const visible = new Set(['O', 'A', 'B']);
  const check = canPruneTraceNode(g, 'O', visible, 'A');
  expect(check.safe, 'safe leaf prune: safe=true').toBe(true);
  expect(check.reason === undefined, 'safe leaf prune: no reason').toBe(true);
});

  it("diamond prune A: safe — C reachable via B", () => {
  // Safe prune in diamond: O→A, O→B, A→C, B→C. Pruning A leaves C reachable via B.
  const g = makeGraph(
    [{ id: 'O' }, { id: 'A' }, { id: 'B' }, { id: 'C' }],
    [['O', 'A'], ['O', 'B'], ['A', 'C'], ['B', 'C']]
  );
  const visible = new Set(['O', 'A', 'B', 'C']);
  const check = canPruneTraceNode(g, 'O', visible, 'A');
  expect(check.safe, 'diamond prune A: safe — C reachable via B').toBe(true);
});

  it("origin not in visible: not safe", () => {
  // Origin is not in visible set → reason 'origin' (guard at line 143)
  const g = makeGraph([{ id: 'O' }, { id: 'A' }], [['O', 'A']]);
  // visible does NOT contain O
  const visible = new Set(['A']);
  const check = canPruneTraceNode(g, 'O', visible, 'A');
  expect(!check.safe, 'origin not in visible: not safe').toBe(true);
  expect(check.reason, "origin not in visible: reason='origin'").toBe('origin');
});

  it("no-path: disconnected → null", () => {
  // No-path: disconnected graph → null
  const g = makeGraph([{ id: 'A' }, { id: 'B' }], []); // no edges
  const result = findShortestPathOrdered(g, 'A', 'B');
  expect(result === null, 'no-path: disconnected → null').toBe(true);
});

  it("missing endpoint → null", () => {
  // Missing endpoint → null
  const g = makeGraph([{ id: 'A' }], []);
  const result = findShortestPathOrdered(g, 'A', 'GHOST');
  expect(result === null, 'missing endpoint → null').toBe(true);
});

  it("forward path: result not null", () => {
  // Forward directed path A→B→C: direction='source_to_target', correct order
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
  // Reverse path: edges go C→B→A; calling with (A, C) must find it via reverse retry
  // → direction='target_to_source', path is C-B-A
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
  // Direct single-hop path A→B
  const g = makeGraph([{ id: 'A' }, { id: 'B' }], [['A', 'B']]);
  const result = findShortestPathOrdered(g, 'A', 'B');
  expect(result !== null, 'single hop: not null').toBe(true);
  expect(result!.path.length, 'single hop: path length=2').toBe(2);
  expect(result!.direction, "single hop: direction='source_to_target'").toBe('source_to_target');
});

});

describe("isManualTraceScopeEdit", () => {
  // Baseline: both editable mode, all compared scalar/set fields identical, no manual delta.
  // Overrides layer on top per case so each test isolates exactly one field.
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
  // Both modes pass isEditableTraceMode individually; the function never compares mode
  // equality between previous and next, only editability of each side.
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
  // undefined === undefined passes the strict comparison; only manualAdded/Pruned decide the result.
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
