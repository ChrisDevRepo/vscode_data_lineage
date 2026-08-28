import { assert, assertEq, makeGraph } from '../helpers/testUtils';
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
import { describe, it } from 'vitest';

describe("Trace Scope Safety Tests", () => {
  function edges(...pairs: Array<[string, string]>): LineageEdge[] {
    return pairs.map(([source, target]) => ({ source, target, type: 'body' as const }));
  }
  it("buildVisibleTraceScope", () => {
  // Base only — no add, no prune
  const base = new Set(['A', 'B', 'C']);
  const { nodeIds } = buildVisibleTraceScope(base, new Set(), new Set(), []);
  assert(nodeIds.has('A') && nodeIds.has('B') && nodeIds.has('C'), 'base only: all base nodes present');
  assertEq(nodeIds.size, 3, 'base only: exact count 3');
});

  it("add: A B C all present", () => {
  // Add a node not in base
  const base = new Set(['A', 'B']);
  const added = new Set(['C']);
  const { nodeIds } = buildVisibleTraceScope(base, added, new Set(), []);
  assert(nodeIds.has('A') && nodeIds.has('B') && nodeIds.has('C'), 'add: A B C all present');
  assertEq(nodeIds.size, 3, 'add: exact count 3');
});

  it("prune: A and C remain", () => {
  // Prune a node from base
  const base = new Set(['A', 'B', 'C']);
  const pruned = new Set(['B']);
  const { nodeIds } = buildVisibleTraceScope(base, new Set(), pruned, []);
  assert(nodeIds.has('A') && nodeIds.has('C'), 'prune: A and C remain');
  assert(!nodeIds.has('B'), 'prune: B is gone');
  assertEq(nodeIds.size, 2, 'prune: exact count 2');
});

  it("add+prune: A present", () => {
  // Add AND prune — pruned wins over added when the same id is in both
  const base = new Set(['A', 'B']);
  const added = new Set(['C', 'D']);
  const pruned = new Set(['B', 'C']); // C added then pruned → absent
  const { nodeIds } = buildVisibleTraceScope(base, added, pruned, []);
  assert(nodeIds.has('A'), 'add+prune: A present');
  assert(nodeIds.has('D'), 'add+prune: D present (added, not pruned)');
  assert(!nodeIds.has('B'), 'add+prune: B absent (base then pruned)');
  assert(!nodeIds.has('C'), 'add+prune: C absent (added then pruned)');
  assertEq(nodeIds.size, 2, 'add+prune: exact count 2');
});

  it("edge collection: 3 nodes", () => {
  // Edge collection: only edges whose endpoints are BOTH in the visible set
  const base = new Set(['A', 'B', 'C']);
  const edgeList = edges(['A', 'B'], ['B', 'C'], ['A', 'C'], ['B', 'D']);
  const { nodeIds, edgeIds } = buildVisibleTraceScope(base, new Set(), new Set(), edgeList);
  assertEq(nodeIds.size, 3, 'edge collection: 3 nodes');
  // A→B, B→C, A→C all within scope; B→D excluded (D not in scope)
  assert(edgeIds.has('A→B'), 'edge collection: A→B included');
  assert(edgeIds.has('B→C'), 'edge collection: B→C included');
  assert(edgeIds.has('A→C'), 'edge collection: A→C included');
  assert(!edgeIds.has('B→D'), 'edge collection: B→D excluded (D not in scope)');
  assertEq(edgeIds.size, 3, 'edge collection: exact 3 edges');
});

  it("empty node scope → 0 edges", () => {
  // Empty scope → no edges
  const result = collectScopeEdgeIds(edges(['A', 'B']), new Set());
  assertEq(result.size, 0, 'empty node scope → 0 edges');
});

  it("self-loop included when node in scope", () => {
  // Self-loop edge — both endpoints are the same node, which is in scope
  const result = collectScopeEdgeIds(edges(['A', 'A']), new Set(['A']));
  assert(result.has('A→A'), 'self-loop included when node in scope');
});

  it("bfsReachable", () => {
  // Linear chain A→B→C: from A, all reachable (undirected BFS)
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set());
  assert(reach.has('A') && reach.has('B') && reach.has('C'), 'chain: A B C reachable from A');
  assertEq(reach.size, 3, 'chain: exact count 3');
});

  it("removed B: A still reachable from A (start)", () => {
  // B removed → from A: A reachable, B and C not (undirected BFS blocked at B)
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set(['B']));
  assert(reach.has('A'), 'removed B: A still reachable from A (start)');
  assert(!reach.has('B'), 'removed B: B not in result');
  assert(!reach.has('C'), 'removed B: C cut off');
});

  it("candidateId B excluded", () => {
  // candidateId excluded — equivalent to removing it without adding to removedSet
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set(), 'B');
  assert(!reach.has('B'), 'candidateId B excluded');
  assert(!reach.has('C'), 'C cut off by candidateId exclusion');
});

  it("scope A+B: both reachable", () => {
  // Scope restriction: A→B→C but scope only allows A and B
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set(), undefined, new Set(['A', 'B']));
  assert(reach.has('A') && reach.has('B'), 'scope A+B: both reachable');
  assert(!reach.has('C'), 'scope A+B: C outside scope, not reached');
});

  it("missing start → empty set", () => {
  // Start node not in graph → empty set
  const g = makeGraph([{ id: 'A' }], []);
  const reach = bfsReachable(g, 'MISSING', new Set());
  assertEq(reach.size, 0, 'missing start → empty set');
});

  it("empty required set → null", () => {
  // No required nodes → always null
  const g = makeGraph([{ id: 'A' }, { id: 'B' }], [['A', 'B']]);
  const result = firstDisconnectedRequiredNode(g, 'A', new Set(['B']), new Set());
  assert(result === null, 'empty required set → null');
});

  it("removing bridge B disconnects required C", () => {
  // A→B→C: remove B. Required = {C}. C becomes disconnected from A.
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const result = firstDisconnectedRequiredNode(g, 'A', new Set(['B']), new Set(['C']));
  assertEq(result, 'C', 'removing bridge B disconnects required C');
});

  it("removing B when C has direct path from A → no disconnection", () => {
  // A→B, A→C (two paths from A). Removing B leaves C still reachable.
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['A', 'C']]);
  const result = firstDisconnectedRequiredNode(g, 'A', new Set(['B']), new Set(['C']));
  assert(result === null, 'removing B when C has direct path from A → no disconnection');
});

  it("required node already in removedSet is skipped", () => {
  // removedSet includes a required node — skipped (already removed, not flagged)
  const g = makeGraph([{ id: 'A' }, { id: 'B' }], [['A', 'B']]);
  const result = firstDisconnectedRequiredNode(g, 'A', new Set(['B']), new Set(['B']));
  assert(result === null, 'required node already in removedSet is skipped');
});

  it("canPruneTraceNode", () => {
  // Pruning the origin is always rejected with reason 'origin'
  const g = makeGraph([{ id: 'O' }, { id: 'A' }, { id: 'B' }], [['O', 'A'], ['A', 'B']]);
  const visible = new Set(['O', 'A', 'B']);
  const check = canPruneTraceNode(g, 'O', visible, 'O');
  assert(!check.safe, 'origin prune: not safe');
  assertEq(check.reason, 'origin', "origin prune: reason='origin'");
});

  it("not-visible prune: not safe", () => {
  // Pruning a node that is not in the visible set → reason 'not-visible'
  const g = makeGraph([{ id: 'O' }, { id: 'A' }], [['O', 'A']]);
  const visible = new Set(['O', 'A']);
  const check = canPruneTraceNode(g, 'O', visible, 'HIDDEN');
  assert(!check.safe, 'not-visible prune: not safe');
  assertEq(check.reason, 'not-visible', "not-visible prune: reason='not-visible'");
});

  it("null origin: not safe", () => {
  // null origin always returns reason 'origin'
  const g = makeGraph([{ id: 'A' }], []);
  const check = canPruneTraceNode(g, null, new Set(['A']), 'A');
  assert(!check.safe, 'null origin: not safe');
  assertEq(check.reason, 'origin', "null origin: reason='origin'");
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
  assert(!check.safe, 'bridge prune: not safe');
  assertEq(check.reason, 'disconnected', "bridge prune: reason='disconnected'");
  assertEq(check.disconnectedNodeId, 'C', 'bridge prune: disconnectedNodeId=C');
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
  assert(check.safe, 'safe leaf prune: safe=true');
  assert(check.reason === undefined, 'safe leaf prune: no reason');
});

  it("diamond prune A: safe — C reachable via B", () => {
  // Safe prune in diamond: O→A, O→B, A→C, B→C. Pruning A leaves C reachable via B.
  const g = makeGraph(
    [{ id: 'O' }, { id: 'A' }, { id: 'B' }, { id: 'C' }],
    [['O', 'A'], ['O', 'B'], ['A', 'C'], ['B', 'C']]
  );
  const visible = new Set(['O', 'A', 'B', 'C']);
  const check = canPruneTraceNode(g, 'O', visible, 'A');
  assert(check.safe, 'diamond prune A: safe — C reachable via B');
});

  it("origin not in visible: not safe", () => {
  // Origin is not in visible set → reason 'origin' (guard at line 143)
  const g = makeGraph([{ id: 'O' }, { id: 'A' }], [['O', 'A']]);
  // visible does NOT contain O
  const visible = new Set(['A']);
  const check = canPruneTraceNode(g, 'O', visible, 'A');
  assert(!check.safe, 'origin not in visible: not safe');
  assertEq(check.reason, 'origin', "origin not in visible: reason='origin'");
});

  it("no-path: disconnected → null", () => {
  // No-path: disconnected graph → null
  const g = makeGraph([{ id: 'A' }, { id: 'B' }], []); // no edges
  const result = findShortestPathOrdered(g, 'A', 'B');
  assert(result === null, 'no-path: disconnected → null');
});

  it("missing endpoint → null", () => {
  // Missing endpoint → null
  const g = makeGraph([{ id: 'A' }], []);
  const result = findShortestPathOrdered(g, 'A', 'GHOST');
  assert(result === null, 'missing endpoint → null');
});

  it("forward path: result not null", () => {
  // Forward directed path A→B→C: direction='source_to_target', correct order
  const g = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    [['A', 'B'], ['B', 'C']]
  );
  const result = findShortestPathOrdered(g, 'A', 'C');
  assert(result !== null, 'forward path: result not null');
  assertEq(result!.direction, 'source_to_target', "forward path: direction='source_to_target'");
  assertEq(result!.path[0], 'A', 'forward path: starts at A');
  assertEq(result!.path[result!.path.length - 1], 'C', 'forward path: ends at C');
  assertEq(result!.path.length, 3, 'forward path: length=3 (A-B-C)');
});

  it("reverse path: result not null", () => {
  // Reverse path: edges go C→B→A; calling with (A, C) must find it via reverse retry
  // → direction='target_to_source', path is C-B-A
  const g = makeGraph(
    [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    [['C', 'B'], ['B', 'A']]
  );
  const result = findShortestPathOrdered(g, 'A', 'C');
  assert(result !== null, 'reverse path: result not null');
  assertEq(result!.direction, 'target_to_source', "reverse path: direction='target_to_source'");
  assertEq(result!.path[0], 'C', 'reverse path: starts at C (target)');
  assertEq(result!.path[result!.path.length - 1], 'A', 'reverse path: ends at A (source)');
});

  it("single hop: not null", () => {
  // Direct single-hop path A→B
  const g = makeGraph([{ id: 'A' }, { id: 'B' }], [['A', 'B']]);
  const result = findShortestPathOrdered(g, 'A', 'B');
  assert(result !== null, 'single hop: not null');
  assertEq(result!.path.length, 2, 'single hop: path length=2');
  assertEq(result!.direction, 'source_to_target', "single hop: direction='source_to_target'");
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
  assertEq(isManualTraceScopeEdit(previous, next), false, 'identical states: false');
});

  it("previous.mode='none': false (non-editable previous mode short-circuits)", () => {
  const previous = baseState({ mode: 'none' });
  const next = baseState({ manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), false, "previous.mode='none': false");
});

  it("previous.mode='configuring': false (non-editable previous mode)", () => {
  const previous = baseState({ mode: 'configuring' });
  const next = baseState({ manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), false, "previous.mode='configuring': false");
});

  it("previous.mode='pathfinding': false (non-editable previous mode)", () => {
  const previous = baseState({ mode: 'pathfinding' });
  const next = baseState({ mode: 'pathfinding', manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), false, "previous.mode='pathfinding': false");
});

  it("previous.mode='path-applied': false (non-editable previous mode)", () => {
  const previous = baseState({ mode: 'path-applied' });
  const next = baseState({ mode: 'path-applied', manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), false, "previous.mode='path-applied': false");
});

  it("previous.mode='analysis': false (non-editable previous mode)", () => {
  const previous = baseState({ mode: 'analysis' });
  const next = baseState({ mode: 'analysis', manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), false, "previous.mode='analysis': false");
});

  it("next.mode='none': false (non-editable next mode short-circuits)", () => {
  const previous = baseState();
  const next = baseState({ mode: 'none', manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), false, "next.mode='none': false");
});

  it("next.mode='analysis': false (non-editable next mode)", () => {
  const previous = baseState();
  const next = baseState({ mode: 'analysis', manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), false, "next.mode='analysis': false");
});

  it("mode 'applied' -> 'filtered', otherwise identical: false (both editable, no manual delta)", () => {
  // Both modes pass isEditableTraceMode individually; the function never compares mode
  // equality between previous and next, only editability of each side.
  const previous = baseState({ mode: 'applied' });
  const next = baseState({ mode: 'filtered' });
  assertEq(isManualTraceScopeEdit(previous, next), false, "mode transition, no manual delta: false");
});

  it("mode 'filtered' -> 'applied', with manual add delta: true (both editable)", () => {
  const previous = baseState({ mode: 'filtered' });
  const next = baseState({ mode: 'applied', manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), true, "mode transition, with manual delta: true");
});

  it("selectedNodeId differs: false (origin change is not a manual scope edit)", () => {
  const previous = baseState({ selectedNodeId: 'ORIGIN' });
  const next = baseState({ selectedNodeId: 'OTHER', manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), false, 'selectedNodeId differs: false');
});

  it("selectedNodeId null vs non-null: false", () => {
  const previous = baseState({ selectedNodeId: null });
  const next = baseState({ selectedNodeId: 'ORIGIN' });
  assertEq(isManualTraceScopeEdit(previous, next), false, 'selectedNodeId null vs non-null: false');
});

  it("targetNodeId differs: false (pathfinding target change is not a manual scope edit)", () => {
  const previous = baseState({ targetNodeId: null });
  const next = baseState({ targetNodeId: 'TARGET', manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), false, 'targetNodeId differs: false');
});

  it("upstreamLevels differs: false (depth change is not a manual scope edit)", () => {
  const previous = baseState({ upstreamLevels: 2 });
  const next = baseState({ upstreamLevels: 3, manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), false, 'upstreamLevels differs: false');
});

  it("downstreamLevels differs: false (depth change is not a manual scope edit)", () => {
  const previous = baseState({ downstreamLevels: 2 });
  const next = baseState({ downstreamLevels: 3, manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), false, 'downstreamLevels differs: false');
});

  it("autoPromoted differs (false -> true): false (promotion is a fresh scope, not a manual edit)", () => {
  const previous = baseState({ autoPromoted: false });
  const next = baseState({ autoPromoted: true, manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), false, 'autoPromoted false->true: false');
});

  it("autoPromoted differs (undefined -> true): false (strict !== treats missing as distinct from true)", () => {
  const previous = baseState({ autoPromoted: undefined });
  const next = baseState({ autoPromoted: true, manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), false, 'autoPromoted undefined->true: false');
});

  it("autoPromoted same on both sides (undefined): true when manual delta present", () => {
  // undefined === undefined passes the strict comparison; only manualAdded/Pruned decide the result.
  const previous = baseState({ autoPromoted: undefined });
  const next = baseState({ autoPromoted: undefined, manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), true, 'autoPromoted undefined on both sides: true');
});

  it("baseNodeIds differs (fresh BFS scope): false, even with a manual delta present", () => {
  const previous = baseState({ baseNodeIds: new Set(['ORIGIN', 'A', 'B']) });
  const next = baseState({
    baseNodeIds: new Set(['ORIGIN', 'A', 'B', 'D']),
    manualAddedNodeIds: new Set(['C']),
  });
  assertEq(isManualTraceScopeEdit(previous, next), false, 'baseNodeIds differs: false');
});

  it("baseNodeIds same size, different membership: false (sameIdSet checks membership, not just size)", () => {
  const previous = baseState({ baseNodeIds: new Set(['ORIGIN', 'A', 'B']) });
  const next = baseState({
    baseNodeIds: new Set(['ORIGIN', 'A', 'D']),
    manualAddedNodeIds: new Set(['C']),
  });
  assertEq(isManualTraceScopeEdit(previous, next), false, 'baseNodeIds same size, different membership: false');
});

  it("baseEdgeIds differs (fresh BFS scope): false, even with a manual delta present", () => {
  const previous = baseState({ baseEdgeIds: new Set(['ORIGIN→A', 'A→B']) });
  const next = baseState({
    baseEdgeIds: new Set(['ORIGIN→A']),
    manualAddedNodeIds: new Set(['C']),
  });
  assertEq(isManualTraceScopeEdit(previous, next), false, 'baseEdgeIds differs: false');
});

  it("manualAddedNodeIds differs, manualPrunedNodeIds identical: true", () => {
  const previous = baseState({ manualAddedNodeIds: new Set() });
  const next = baseState({ manualAddedNodeIds: new Set(['C']) });
  assertEq(isManualTraceScopeEdit(previous, next), true, 'manualAddedNodeIds differs: true');
});

  it("manualPrunedNodeIds differs, manualAddedNodeIds identical: true", () => {
  const previous = baseState({ manualPrunedNodeIds: new Set() });
  const next = baseState({ manualPrunedNodeIds: new Set(['A']) });
  assertEq(isManualTraceScopeEdit(previous, next), true, 'manualPrunedNodeIds differs: true');
});

  it("manualAddedNodeIds AND manualPrunedNodeIds both differ: true", () => {
  const previous = baseState({ manualAddedNodeIds: new Set(), manualPrunedNodeIds: new Set() });
  const next = baseState({
    manualAddedNodeIds: new Set(['C']),
    manualPrunedNodeIds: new Set(['A']),
  });
  assertEq(isManualTraceScopeEdit(previous, next), true, 'manualAdded and manualPruned both differ: true');
});

  it("manualAddedNodeIds same size, different membership: true (sameIdSet checks membership)", () => {
  const previous = baseState({ manualAddedNodeIds: new Set(['C']) });
  const next = baseState({ manualAddedNodeIds: new Set(['D']) });
  assertEq(isManualTraceScopeEdit(previous, next), true, 'manualAddedNodeIds same size, different membership: true');
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
  assertEq(isManualTraceScopeEdit(previous, next), false, 'no manual delta despite non-empty sets: false');
});

});
