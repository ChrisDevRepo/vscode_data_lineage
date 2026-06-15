/**
 * Unit tests for interactive-trace safety backend.
 *
 * Covers the two pure modules that enforce graph-integrity rules for
 * user-initiated add/prune edits on a rendered trace:
 *  - src/engine/traceScope.ts  — buildVisibleTraceScope, canPruneTraceNode, collectScopeEdgeIds
 *  - src/engine/graphGuards.ts — bfsReachable, firstDisconnectedRequiredNode, findShortestPathOrdered
 *
 * Self-running script (not vitest describe/it). Registered in the support runner via
 * auto-discovery (discoverUnitTestFiles non-recursive readdirSync of tests/unit/).
 */

import { assert, assertEq, makeGraph, printSummary, resetCounters } from './helpers/testUtils';
import {
  buildVisibleTraceScope,
  canPruneTraceNode,
  collectScopeEdgeIds,
} from '../../src/engine/traceScope';
import {
  bfsReachable,
  firstDisconnectedRequiredNode,
  findShortestPathOrdered,
} from '../../src/engine/graphGuards';
import type { LineageEdge } from '../../src/engine/types';

console.log('Trace Scope Safety Tests');
console.log('='.repeat(40));
resetCounters();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a LineageEdge array from a simple [source, target] tuple list. */
function edges(...pairs: Array<[string, string]>): LineageEdge[] {
  return pairs.map(([source, target]) => ({ source, target, type: 'body' as const }));
}

// ── buildVisibleTraceScope — set math ────────────────────────────────────────

console.log('\n── buildVisibleTraceScope ──');

{
  // Base only — no add, no prune
  const base = new Set(['A', 'B', 'C']);
  const { nodeIds } = buildVisibleTraceScope(base, new Set(), new Set(), []);
  assert(nodeIds.has('A') && nodeIds.has('B') && nodeIds.has('C'), 'base only: all base nodes present');
  assertEq(nodeIds.size, 3, 'base only: exact count 3');
}

{
  // Add a node not in base
  const base = new Set(['A', 'B']);
  const added = new Set(['C']);
  const { nodeIds } = buildVisibleTraceScope(base, added, new Set(), []);
  assert(nodeIds.has('A') && nodeIds.has('B') && nodeIds.has('C'), 'add: A B C all present');
  assertEq(nodeIds.size, 3, 'add: exact count 3');
}

{
  // Prune a node from base
  const base = new Set(['A', 'B', 'C']);
  const pruned = new Set(['B']);
  const { nodeIds } = buildVisibleTraceScope(base, new Set(), pruned, []);
  assert(nodeIds.has('A') && nodeIds.has('C'), 'prune: A and C remain');
  assert(!nodeIds.has('B'), 'prune: B is gone');
  assertEq(nodeIds.size, 2, 'prune: exact count 2');
}

{
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
}

{
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
}

// ── collectScopeEdgeIds ───────────────────────────────────────────────────────

console.log('\n── collectScopeEdgeIds ──');

{
  // Empty scope → no edges
  const result = collectScopeEdgeIds(edges(['A', 'B']), new Set());
  assertEq(result.size, 0, 'empty node scope → 0 edges');
}

{
  // Self-loop edge — both endpoints are the same node, which is in scope
  const result = collectScopeEdgeIds(edges(['A', 'A']), new Set(['A']));
  assert(result.has('A→A'), 'self-loop included when node in scope');
}

// ── bfsReachable ─────────────────────────────────────────────────────────────

console.log('\n── bfsReachable ──');

{
  // Linear chain A→B→C: from A, all reachable (undirected BFS)
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set());
  assert(reach.has('A') && reach.has('B') && reach.has('C'), 'chain: A B C reachable from A');
  assertEq(reach.size, 3, 'chain: exact count 3');
}

{
  // B removed → from A: A reachable, B and C not (undirected BFS blocked at B)
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set(['B']));
  assert(reach.has('A'), 'removed B: A still reachable from A (start)');
  assert(!reach.has('B'), 'removed B: B not in result');
  assert(!reach.has('C'), 'removed B: C cut off');
}

{
  // candidateId excluded — equivalent to removing it without adding to removedSet
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set(), 'B');
  assert(!reach.has('B'), 'candidateId B excluded');
  assert(!reach.has('C'), 'C cut off by candidateId exclusion');
}

{
  // Scope restriction: A→B→C but scope only allows A and B
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const reach = bfsReachable(g, 'A', new Set(), undefined, new Set(['A', 'B']));
  assert(reach.has('A') && reach.has('B'), 'scope A+B: both reachable');
  assert(!reach.has('C'), 'scope A+B: C outside scope, not reached');
}

{
  // Start node not in graph → empty set
  const g = makeGraph([{ id: 'A' }], []);
  const reach = bfsReachable(g, 'MISSING', new Set());
  assertEq(reach.size, 0, 'missing start → empty set');
}

// ── firstDisconnectedRequiredNode ─────────────────────────────────────────────

console.log('\n── firstDisconnectedRequiredNode ──');

{
  // No required nodes → always null
  const g = makeGraph([{ id: 'A' }, { id: 'B' }], [['A', 'B']]);
  const result = firstDisconnectedRequiredNode(g, 'A', new Set(['B']), new Set());
  assert(result === null, 'empty required set → null');
}

{
  // A→B→C: remove B. Required = {C}. C becomes disconnected from A.
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['B', 'C']]);
  const result = firstDisconnectedRequiredNode(g, 'A', new Set(['B']), new Set(['C']));
  assertEq(result, 'C', 'removing bridge B disconnects required C');
}

{
  // A→B, A→C (two paths from A). Removing B leaves C still reachable.
  const g = makeGraph([{ id: 'A' }, { id: 'B' }, { id: 'C' }], [['A', 'B'], ['A', 'C']]);
  const result = firstDisconnectedRequiredNode(g, 'A', new Set(['B']), new Set(['C']));
  assert(result === null, 'removing B when C has direct path from A → no disconnection');
}

{
  // removedSet includes a required node — skipped (already removed, not flagged)
  const g = makeGraph([{ id: 'A' }, { id: 'B' }], [['A', 'B']]);
  const result = firstDisconnectedRequiredNode(g, 'A', new Set(['B']), new Set(['B']));
  assert(result === null, 'required node already in removedSet is skipped');
}

// ── canPruneTraceNode ─────────────────────────────────────────────────────────

console.log('\n── canPruneTraceNode ──');

{
  // Pruning the origin is always rejected with reason 'origin'
  const g = makeGraph([{ id: 'O' }, { id: 'A' }, { id: 'B' }], [['O', 'A'], ['A', 'B']]);
  const visible = new Set(['O', 'A', 'B']);
  const check = canPruneTraceNode(g, 'O', visible, 'O');
  assert(!check.safe, 'origin prune: not safe');
  assertEq(check.reason, 'origin', "origin prune: reason='origin'");
}

{
  // Pruning a node that is not in the visible set → reason 'not-visible'
  const g = makeGraph([{ id: 'O' }, { id: 'A' }], [['O', 'A']]);
  const visible = new Set(['O', 'A']);
  const check = canPruneTraceNode(g, 'O', visible, 'HIDDEN');
  assert(!check.safe, 'not-visible prune: not safe');
  assertEq(check.reason, 'not-visible', "not-visible prune: reason='not-visible'");
}

{
  // null origin always returns reason 'origin'
  const g = makeGraph([{ id: 'A' }], []);
  const check = canPruneTraceNode(g, null, new Set(['A']), 'A');
  assert(!check.safe, 'null origin: not safe');
  assertEq(check.reason, 'origin', "null origin: reason='origin'");
}

{
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
}

{
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
}

{
  // Safe prune in diamond: O→A, O→B, A→C, B→C. Pruning A leaves C reachable via B.
  const g = makeGraph(
    [{ id: 'O' }, { id: 'A' }, { id: 'B' }, { id: 'C' }],
    [['O', 'A'], ['O', 'B'], ['A', 'C'], ['B', 'C']]
  );
  const visible = new Set(['O', 'A', 'B', 'C']);
  const check = canPruneTraceNode(g, 'O', visible, 'A');
  assert(check.safe, 'diamond prune A: safe — C reachable via B');
}

{
  // Origin is not in visible set → reason 'origin' (guard at line 143)
  const g = makeGraph([{ id: 'O' }, { id: 'A' }], [['O', 'A']]);
  // visible does NOT contain O
  const visible = new Set(['A']);
  const check = canPruneTraceNode(g, 'O', visible, 'A');
  assert(!check.safe, 'origin not in visible: not safe');
  assertEq(check.reason, 'origin', "origin not in visible: reason='origin'");
}

// ── findShortestPathOrdered ───────────────────────────────────────────────────
// useInteractiveTrace hook tests cover this via computeShortestPath integration but
// do not directly assert the `direction` discriminant or the null-returns. These
// unit cases cover those gaps.

console.log('\n── findShortestPathOrdered ──');

{
  // No-path: disconnected graph → null
  const g = makeGraph([{ id: 'A' }, { id: 'B' }], []); // no edges
  const result = findShortestPathOrdered(g, 'A', 'B');
  assert(result === null, 'no-path: disconnected → null');
}

{
  // Missing endpoint → null
  const g = makeGraph([{ id: 'A' }], []);
  const result = findShortestPathOrdered(g, 'A', 'GHOST');
  assert(result === null, 'missing endpoint → null');
}

{
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
}

{
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
}

{
  // Direct single-hop path A→B
  const g = makeGraph([{ id: 'A' }, { id: 'B' }], [['A', 'B']]);
  const result = findShortestPathOrdered(g, 'A', 'B');
  assert(result !== null, 'single hop: not null');
  assertEq(result!.path.length, 2, 'single hop: path length=2');
  assertEq(result!.direction, 'source_to_target', "single hop: direction='source_to_target'");
}

// ─────────────────────────────────────────────────────────────────────────────

printSummary('Trace Scope Safety Tests');
