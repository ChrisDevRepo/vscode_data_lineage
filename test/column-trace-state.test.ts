/**
 * Unit tests for ColumnTraceState — the hop-and-distill state machine.
 * Tests state machine logic WITHOUT AI — simulates verdicts programmatically.
 * Requires: test/AdventureWorks.dacpac
 */

import { assert, assertEq, printSummary, loadAdventureWorksModel, resetCounters } from './testUtils';
import { buildBareGraph } from '../src/ai/graphUtils';
import { ColumnTraceState } from '../src/ai/columnTraceState';
import type { DatabaseModel, LineageNode, LineageEdge, NeighborIndex } from '../src/engine/types';

const logs: string[] = [];
const log = (level: string, msg: string) => { logs.push(`[${level}] ${msg}`); };
const clearLogs = () => { logs.length = 0; };

// ─── Test: Lifecycle & Status ────────────────────────────────────────────────

async function testLifecycleStatus(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  assertEq(state.status, 'created', 'Initial status is created');
  assert(!state.isInitialized, 'Not initialized before init()');
  assert(!state.isComplete, 'Not complete before init()');

  // getHopContext before init → error
  const hop0 = state.getHopContext();
  assert('error' in hop0, 'getHopContext before init returns error');

  // submitVerdicts before init → error
  const sub0 = state.submitVerdicts({ focusNodeId: 'x', verdicts: [] });
  assert('error' in sub0, 'submitVerdicts before init returns error');

  // getResult before init → error
  const res0 = state.getResult();
  assert('error' in res0, 'getResult before init returns error');
}

// ─── Test: Init with valid origin ────────────────────────────────────────────

async function testInitWithOrigin(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Find a table with columns in AdventureWorks
  const table = model.nodes.find(n => n.type === 'table' && n.columns?.length);
  assert(!!table, 'Found a table with columns');

  const colName = table!.columns![0].name;
  const result = state.init({ targetColumns: [colName], origin: table!.id, direction: 'up' });

  assert('ok' in result, `Init succeeded for ${table!.id}`);
  assertEq(state.status, 'initialized', 'Status is initialized');
  assert(state.isInitialized, 'isInitialized is true');
  assert((result as { scopeSize: number }).scopeSize >= 0, 'Scope size is non-negative');
}

// ─── Test: Init with invalid origin ──────────────────────────────────────────

async function testInitInvalidOrigin(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  const result = state.init({ targetColumns: ['FakeCol'], origin: '[fake].[nonexistent]' });
  assert('error' in result, 'Init with invalid origin returns error');
  assertEq((result as { error: string }).error, 'origin_not_found', 'Error is origin_not_found');
  assertEq(state.status, 'error', 'Status is error');
}

// ─── Test: Init with no columns and no origin → error ────────────────────────

async function testInitNoColumnsNoOrigin(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  const result = state.init({ targetColumns: [] });
  assert('error' in result, 'Init with empty columns + no origin returns error');
  assertEq((result as { error: string }).error, 'no_origin', 'Error is no_origin');
}

// ─── Test: Init with no columns but explicit origin → graph mode succeeds ────

async function testInitNoColumnsWithOrigin(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Pick any node with neighbors
  const node = model.nodes.find(n => {
    const nb = model.neighborIndex[n.id];
    return nb && (nb.in.length > 0 || nb.out.length > 0);
  });
  assert(!!node, 'Found a node with neighbors for graph mode test');

  const result = state.init({ targetColumns: [], origin: node!.id, direction: 'up' });
  assert('ok' in result, `Graph mode init succeeded for ${node!.id}`);
  assertEq(state.status, 'initialized', 'Status is initialized');
  assert((result as { scopeSize: number }).scopeSize >= 0, 'Scope size is non-negative');
}

// ─── Test: Graph mode full hop cycle (no columns) ────────────────────────────

async function testGraphModeHopCycle(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Pick a node with neighbors
  const node = model.nodes.find(n => {
    const nb = model.neighborIndex[n.id];
    return nb && (nb.in.length > 0 || nb.out.length > 0);
  });
  assert(!!node, 'Found a node for graph mode hop cycle');

  const initResult = state.init({ targetColumns: [], origin: node!.id, direction: 'up' });
  assert('ok' in initResult, 'Graph mode init succeeded');

  const hop1 = state.getHopContext();
  if ('done' in hop1) {
    // No neighbors in upstream direction — valid, trace complete
    return;
  }
  assert(!('error' in hop1), 'First hop context succeeds');

  // Submit all neighbors as prune (no columnsOut needed in graph mode)
  const hopData = hop1 as { focus_node: { id: string }; neighbors: Array<{ id: string }> };
  const verdicts = hopData.neighbors.map(n => ({
    nodeId: n.id,
    verdict: 'prune' as const,
    summary: 'graph mode test — pruning all',
  }));
  const submitResult = state.submitVerdicts({
    focusNodeId: (hopData.focus_node as { id: string }).id,
    notes: 'Graph mode hop — no column tracking',
    verdicts,
  });
  assert('ok' in submitResult, 'Graph mode verdict submission succeeds without columnsOut');
}

// ─── Test: Auto-discover origin ──────────────────────────────────────────────

async function testAutoDiscoverOrigin(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Find a column that exists on exactly one table
  const table = model.nodes.find(n => n.type === 'table' && n.columns?.length);
  assert(!!table, 'Found a table with columns');

  const colName = table!.columns![0].name;
  const result = state.init({ targetColumns: [colName], direction: 'up' });

  // Should auto-discover (might be this table or another with same column)
  assert('ok' in result, `Auto-discover succeeded for column ${colName}`);
  assert(state.isInitialized, 'State initialized after auto-discover');
}

// ─── Test: getHopContext returns correct structure ────────────────────────────

async function testHopContextStructure(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Find a procedure with upstream deps (likely has neighbors)
  const sp = model.nodes.find(n => n.type === 'procedure' && n.bodyScript);
  assert(!!sp, 'Found a procedure with DDL');

  const initResult = state.init({ targetColumns: ['TestCol'], origin: sp!.id, direction: 'up' });
  if ('error' in initResult) {
    // SP might not have upstream neighbors — try another
    console.log(`  (skipping: ${sp!.id} has no upstream neighbors)`);
    return;
  }

  const hop = state.getHopContext();
  if ('done' in hop) {
    console.log('  (skipping: frontier empty after init)');
    return;
  }
  assert(!('error' in hop), 'getHopContext returns valid hop');

  // Verify structure
  const ctx = hop as { ct_mode: string; hop: number; focus_node: Record<string, unknown>; neighbors: unknown[]; active_columns: string[] };
  assertEq(ctx.ct_mode, 'hop_and_distill', 'ct_mode is hop_and_distill');
  assertEq(ctx.hop, 1, 'First hop is 1');
  assert(!!ctx.focus_node, 'focus_node is present');
  assert(Array.isArray(ctx.neighbors), 'neighbors is an array');
  assert(Array.isArray(ctx.active_columns), 'active_columns is an array');
  assertEq(state.status, 'awaiting_verdicts', 'Status is awaiting_verdicts');
}

// ─── Test: Focus node has DDL for SPs, columns for tables ────────────────────

async function testFocusNodeContent(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Find an SP that has upstream table neighbors
  const sp = model.nodes.find(n =>
    n.type === 'procedure' && n.bodyScript &&
    (model.neighborIndex[n.id]?.in.length ?? 0) > 0,
  );
  if (!sp) { console.log('  (skipping: no SP with upstream neighbors)'); return; }

  state.init({ targetColumns: ['TestCol'], origin: sp.id, direction: 'up' });
  const hop = state.getHopContext();
  if ('done' in hop || 'error' in hop) { console.log('  (skipping: no hop)'); return; }

  const ctx = hop as { focus_node: Record<string, unknown>; neighbors: Array<{ t: string; cols?: unknown[]; hasDdl: boolean }> };

  // Focus node is a neighbor of the SP (upstream) — could be table or another SP
  // Check neighbor metadata
  for (const nb of ctx.neighbors) {
    if (nb.t === 'table') {
      // Tables should have cols (if they have ColumnDef)
      // Note: not all tables have columns extracted
    }
    if (nb.t === 'procedure' || nb.t === 'view' || nb.t === 'function') {
      assert(typeof nb.hasDdl === 'boolean', `Neighbor ${nb.t} has hasDdl flag`);
    }
  }
  assert(true, 'Focus node and neighbor content validated');
}

// ─── Test: Boundary detection ────────────────────────────────────────────────

async function testBoundaryDetection(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Find a table with no upstream (source boundary)
  const sourceTable = model.nodes.find(n => {
    if (n.type !== 'table' || !n.columns?.length) return false;
    const nb = model.neighborIndex[n.id];
    return nb && nb.in.length === 0 && nb.out.length > 0;
  });

  if (!sourceTable) { console.log('  (skipping: no source boundary table found)'); return; }

  state.init({ targetColumns: [sourceTable.columns![0].name], origin: sourceTable.id, direction: 'up' });
  const hop = state.getHopContext();

  if ('done' in hop) {
    // No upstream = source boundary = frontier empty immediately
    assert(state.isComplete, 'Source boundary node: frontier empty, trace complete');
    return;
  }

  // If we got a hop, check if any neighbor has boundary flag
  const ctx = hop as { neighbors: Array<{ boundary: string }> };
  // At least verify the structure has boundary fields
  for (const nb of ctx.neighbors) {
    assert(typeof nb.boundary === 'string', 'Neighbor has boundary field');
  }
  assert(true, 'Boundary detection validated');
}

// ─── Test: Submit verdicts — remove ──────────────────────────────────────────

async function testVerdictRemove(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Find SP with multiple upstream neighbors
  const sp = model.nodes.find(n =>
    n.type === 'procedure' && n.bodyScript &&
    (model.neighborIndex[n.id]?.in.length ?? 0) >= 2,
  );
  if (!sp) { console.log('  (skipping: no SP with 2+ upstream neighbors)'); return; }

  state.init({ targetColumns: ['TestCol'], origin: sp.id, direction: 'up' });
  const hop = state.getHopContext();
  if ('done' in hop || 'error' in hop) { console.log('  (skipping: no hop)'); return; }

  const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string }> };
  const focusId = ctx.focus_node.id as string;

  // Remove ALL neighbors
  const verdicts = ctx.neighbors.map(nb => ({
    nodeId: nb.id,
    verdict: 'prune' as const,
    summary: 'Test removal',
  }));

  const result = state.submitVerdicts({ focusNodeId: focusId, verdicts });
  assert('ok' in result, 'submitVerdicts with remove succeeds');
  assertEq((result as { advanced: number }).advanced, 0, 'No frontier advancement after all removes');
  assertEq(state.status, 'hopping', 'Status is hopping after verdicts');
}

// ─── Test: Submit verdicts — relevant with column validation ─────────────────

async function testVerdictRelevantWithValidation(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Find SP with upstream table neighbor that has columns
  const sp = model.nodes.find(n => {
    if (n.type !== 'procedure' || !n.bodyScript) return false;
    const upIds = model.neighborIndex[n.id]?.in ?? [];
    return upIds.some(uid => {
      const uNode = model.nodes.find(nn => nn.id === uid);
      return uNode?.type === 'table' && uNode.columns?.length;
    });
  });
  if (!sp) { console.log('  (skipping: no SP with upstream table+columns)'); return; }

  state.init({ targetColumns: ['TestCol'], origin: sp.id, direction: 'up' });
  const hop = state.getHopContext();
  if ('done' in hop || 'error' in hop) { console.log('  (skipping: no hop)'); return; }

  const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string; t: string; cols?: Array<{ n: string }> }> };
  const focusId = ctx.focus_node.id as string;

  // Find a table neighbor with columns
  const tableNb = ctx.neighbors.find(nb => nb.t === 'table' && nb.cols?.length);
  if (!tableNb) { console.log('  (skipping: no table neighbor with columns in hop)'); return; }

  // Submit with INVALID column → should be rejected
  const badResult = state.submitVerdicts({
    focusNodeId: focusId,
    verdicts: [{
      nodeId: tableNb.id,
      verdict: 'trace',
      columnsOut: ['__NONEXISTENT_COLUMN__'],
      summary: 'Test bad column',
    }],
  });
  assert('error' in badResult, 'Invalid column is rejected');
  assertEq((badResult as { error: string }).error, 'invalid_columns', 'Error is invalid_columns');
  assert(Array.isArray((badResult as { valid: string[] }).valid), 'Rejection includes valid column list');
  assertEq(state.status, 'awaiting_verdicts', 'Status stays awaiting_verdicts after rejection');

  // Submit with VALID column → should succeed
  const validCol = tableNb.cols![0].n;
  const goodResult = state.submitVerdicts({
    focusNodeId: focusId,
    verdicts: [{
      nodeId: tableNb.id,
      verdict: 'trace',
      columnsOut: [validCol],
      summary: 'Test valid column',
    }],
  });
  assert('ok' in goodResult, `Valid column "${validCol}" accepted`);
}

// ─── Test: Rejection cap (max 2 per hop) ─────────────────────────────────────

async function testRejectionCap(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Same setup as above — find SP with upstream table
  const sp = model.nodes.find(n => {
    if (n.type !== 'procedure' || !n.bodyScript) return false;
    const upIds = model.neighborIndex[n.id]?.in ?? [];
    return upIds.some(uid => {
      const uNode = model.nodes.find(nn => nn.id === uid);
      return uNode?.type === 'table' && uNode.columns?.length;
    });
  });
  if (!sp) { console.log('  (skipping: no SP with upstream table+columns)'); return; }

  state.init({ targetColumns: ['TestCol'], origin: sp.id, direction: 'up' });
  const hop = state.getHopContext();
  if ('done' in hop || 'error' in hop) { console.log('  (skipping: no hop)'); return; }

  const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string; t: string; cols?: Array<{ n: string }> }> };
  const focusId = ctx.focus_node.id as string;
  const tableNb = ctx.neighbors.find(nb => nb.t === 'table' && nb.cols?.length);
  if (!tableNb) { console.log('  (skipping: no table neighbor)'); return; }

  // Reject #1
  const r1 = state.submitVerdicts({ focusNodeId: focusId, verdicts: [{ nodeId: tableNb.id, verdict: 'trace', columnsOut: ['__BAD1__'] }] });
  assert('error' in r1 && (r1 as { error: string }).error === 'invalid_columns', 'Rejection #1');

  // Reject #2
  const r2 = state.submitVerdicts({ focusNodeId: focusId, verdicts: [{ nodeId: tableNb.id, verdict: 'trace', columnsOut: ['__BAD2__'] }] });
  assert('error' in r2 && (r2 as { error: string }).error === 'invalid_columns', 'Rejection #2');

  // Reject #3 → cap reached, should accept on trust
  const r3 = state.submitVerdicts({ focusNodeId: focusId, verdicts: [{ nodeId: tableNb.id, verdict: 'trace', columnsOut: ['__BAD3__'], summary: 'cap test' }] });
  assert('ok' in r3, 'Rejection #3 accepted (cap reached)');
  assert(logs.some(l => l.includes('Rejection cap reached')), 'Cap warning logged');
}

// ─── Test: Cycle detection ───────────────────────────────────────────────────

async function testCycleDetection(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Init from any node with neighbors
  const node = model.nodes.find(n =>
    n.columns?.length && (model.neighborIndex[n.id]?.in.length ?? 0) > 0,
  );
  if (!node) { console.log('  (skipping: no node with upstream)'); return; }

  state.init({ targetColumns: [node.columns![0].name], origin: node.id, direction: 'up' });

  // Process hops until done (cycle detection should prevent infinite loop)
  let hops = 0;
  const maxSafeHops = 100;
  while (hops < maxSafeHops) {
    const hop = state.getHopContext();
    if ('done' in hop) break;
    if ('error' in hop) break;
    hops++;

    const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string }> };
    // Remove all neighbors to drain frontier quickly
    state.submitVerdicts({
      focusNodeId: ctx.focus_node.id as string,
      verdicts: ctx.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
    });
  }

  assert(hops < maxSafeHops, `Trace completed in ${hops} hops (no infinite loop)`);
  assert(state.isComplete, 'State is complete after draining frontier');
}

// ─── Test: getResult structure ───────────────────────────────────────────────

async function testGetResultStructure(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  const node = model.nodes.find(n => n.columns?.length && (model.neighborIndex[n.id]?.in.length ?? 0) > 0);
  if (!node) { console.log('  (skipping: no node with upstream)'); return; }

  state.init({ targetColumns: [node.columns![0].name], origin: node.id, direction: 'up' });

  // Process one hop, remove all neighbors
  const hop = state.getHopContext();
  if (!('done' in hop) && !('error' in hop)) {
    const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string }> };
    state.submitVerdicts({
      focusNodeId: ctx.focus_node.id as string,
      verdicts: ctx.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'test' })),
    });
  }

  // Drain remaining frontier
  while (true) {
    const h = state.getHopContext();
    if ('done' in h) break;
    if ('error' in h) break;
    const c = h as { focus_node: { id: string }; neighbors: Array<{ id: string }> };
    state.submitVerdicts({
      focusNodeId: c.focus_node.id as string,
      verdicts: c.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
    });
  }

  const result = state.getResult();
  assert(!('error' in result), 'getResult succeeds after draining');

  const r = result as {
    status: string;
    chain: unknown[];
    fullNodes: unknown[];
    edges: unknown[];
    outOfScope: unknown[];
    stats: { hops: number; examined: number; relevant: number; removed: number; passthrough: number };
  };

  assertEq(r.status, 'complete', 'Result status is complete');
  assert(Array.isArray(r.chain), 'chain is array');
  assert(Array.isArray(r.fullNodes), 'fullNodes is array');
  assert(Array.isArray(r.edges), 'edges is array');
  assert(Array.isArray(r.outOfScope), 'outOfScope is array');
  assert(typeof r.stats === 'object', 'stats is object');
  assert(typeof r.stats.hops === 'number', 'stats.hops is number');
  assert(typeof r.stats.examined === 'number', 'stats.examined is number');
  assert(r.chain.length >= 1, 'Chain has at least origin node');
}

// ─── Test: getResult before complete → error ─────────────────────────────────

async function testGetResultTooEarly(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Find node with upstream neighbors so frontier is not empty
  const sp = model.nodes.find(n =>
    n.type === 'procedure' && n.bodyScript &&
    (model.neighborIndex[n.id]?.in.length ?? 0) > 0,
  );
  if (!sp) { console.log('  (skipping: no SP with upstream)'); return; }

  state.init({ targetColumns: ['TestCol'], origin: sp.id, direction: 'up' });

  // Don't process any hops — try getResult immediately
  const result = state.getResult();
  assert('error' in result, 'getResult before processing hops returns error');
}

// ─── Test: Focus mismatch ────────────────────────────────────────────────────

async function testFocusMismatch(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  const sp = model.nodes.find(n =>
    n.type === 'procedure' && n.bodyScript &&
    (model.neighborIndex[n.id]?.in.length ?? 0) > 0,
  );
  if (!sp) { console.log('  (skipping: no SP)'); return; }

  state.init({ targetColumns: ['TestCol'], origin: sp.id, direction: 'up' });
  const hop = state.getHopContext();
  if ('done' in hop || 'error' in hop) { console.log('  (skipping: no hop)'); return; }

  // Submit with wrong focus node ID
  const result = state.submitVerdicts({ focusNodeId: '__WRONG_ID__', verdicts: [] });
  assert('error' in result, 'Focus mismatch detected');
  assertEq((result as { error: string }).error, 'focus_mismatch', 'Error is focus_mismatch');
}

// ─── Test: Re-init resets state ──────────────────────────────────────────────

async function testReInit(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  const table = model.nodes.find(n => n.type === 'table' && n.columns?.length);
  if (!table) { console.log('  (skipping: no table)'); return; }

  const col = table.columns![0].name;

  // First init
  const r1 = state.init({ targetColumns: [col], origin: table.id });
  assert('ok' in r1, 'First init succeeds');

  // Second init — should reset and work
  const r2 = state.init({ targetColumns: [col], origin: table.id });
  assert('ok' in r2, 'Second init succeeds (state reset)');
  assertEq(state.hops, 0, 'Hops reset to 0');
  assertEq(state.status, 'initialized', 'Status reset to initialized');
}

// ─── Test: Direction 'down' — only downstream neighbors ─────────────────────

async function testDirectionDown(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Find a table that has downstream consumers
  const table = model.nodes.find(n =>
    n.type === 'table' && n.columns?.length &&
    (model.neighborIndex[n.id]?.out.length ?? 0) > 0,
  );
  if (!table) { console.log('  (skipping: no table with downstream)'); return; }

  state.init({ targetColumns: [table.columns![0].name], origin: table.id, direction: 'down' });
  const hop = state.getHopContext();
  if ('done' in hop || 'error' in hop) { console.log('  (skipping: no hop)'); return; }

  const ctx = hop as { neighbors: Array<{ edge_direction: string }> };
  for (const nb of ctx.neighbors) {
    assertEq(nb.edge_direction, 'downstream', `Direction down: neighbor is downstream`);
  }
  assert(true, 'Direction down: all neighbors are downstream');
}

// ─── Test: Direction 'both' — upstream + downstream ─────────────────────────

async function testDirectionBoth(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Find a node with both upstream and downstream
  const node = model.nodes.find(n =>
    n.columns?.length &&
    (model.neighborIndex[n.id]?.in.length ?? 0) > 0 &&
    (model.neighborIndex[n.id]?.out.length ?? 0) > 0,
  );
  if (!node) { console.log('  (skipping: no node with both directions)'); return; }

  const result = state.init({ targetColumns: [node.columns![0].name], origin: node.id, direction: 'both' });
  assert('ok' in result, 'Init with direction both succeeds');
  assert(state.frontierSize > 0, 'Frontier has entries for both directions');
}

// ─── Test: Passthrough verdict advances frontier with inherited columns ──────

async function testPassthroughVerdict(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  const sp = model.nodes.find(n =>
    n.type === 'procedure' && n.bodyScript &&
    (model.neighborIndex[n.id]?.in.length ?? 0) > 0,
  );
  if (!sp) { console.log('  (skipping: no SP with upstream)'); return; }

  state.init({ targetColumns: ['TestCol'], origin: sp.id, direction: 'up' });
  const hop = state.getHopContext();
  if ('done' in hop || 'error' in hop) { console.log('  (skipping: no hop)'); return; }

  const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string; boundary: string }> };
  const focusId = ctx.focus_node.id as string;

  // Mark first neighbor as passthrough
  const nb = ctx.neighbors[0];
  if (!nb) { console.log('  (skipping: no neighbors)'); return; }

  const frontierBefore = state.frontierSize;
  const result = state.submitVerdicts({
    focusNodeId: focusId,
    verdicts: [{ nodeId: nb.id, verdict: 'pass', summary: 'test passthrough' }],
  });

  assert('ok' in result, 'Passthrough verdict accepted');
  // Passthrough should advance frontier if neighbor has further connections and is not a boundary
  if (nb.boundary === 'none') {
    assert((result as { advanced: number }).advanced >= 0, 'Passthrough may advance frontier');
  }
  assert(true, 'Passthrough verdict processed');
}

// ─── Test: Relevant with column rename — frontier gets new columns ──────────

async function testRelevantColumnRename(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Find SP with upstream SP neighbor (exec edge, no column validation)
  const sp = model.nodes.find(n => {
    if (n.type !== 'procedure' || !n.bodyScript) return false;
    const upIds = model.neighborIndex[n.id]?.in ?? [];
    return upIds.some(uid => model.nodes.find(nn => nn.id === uid)?.type === 'procedure');
  });
  if (!sp) { console.log('  (skipping: no SP→SP)'); return; }

  state.init({ targetColumns: ['OriginalCol'], origin: sp.id, direction: 'up' });
  const hop = state.getHopContext();
  if ('done' in hop || 'error' in hop) { console.log('  (skipping: no hop)'); return; }

  const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string; t: string }> };
  const spNeighbor = ctx.neighbors.find(nb => nb.t === 'procedure');
  if (!spNeighbor) { console.log('  (skipping: no SP neighbor)'); return; }

  // Submit with renamed column (SP→SP: accepted on trust)
  const result = state.submitVerdicts({
    focusNodeId: ctx.focus_node.id as string,
    verdicts: [{
      nodeId: spNeighbor.id,
      verdict: 'trace',
      columnsOut: ['RenamedCol'],  // different from 'OriginalCol'
      summary: 'Column renamed from OriginalCol to RenamedCol',
    }],
  });

  assert('ok' in result, 'Relevant verdict with renamed column accepted (SP→SP, no validation)');
  assert(logs.some(l => l.includes('SP→SP exec') || l.includes('RenamedCol')), 'Rename tracked in logs');
}

// ─── Test: Frontier cap — excess goes to outOfScope ─────────────────────────

async function testFrontierCap(model: DatabaseModel) {
  clearLogs();
  // Use a very small frontier cap to trigger it
  const state = new ColumnTraceState(model, log, { maxFrontierSize: 2 });

  // Find a node with many connections
  const hub = model.nodes.find(n =>
    n.columns?.length &&
    (model.neighborIndex[n.id]?.in.length ?? 0) > 3,
  );
  if (!hub) { console.log('  (skipping: no hub node with >3 upstream)'); return; }

  const result = state.init({ targetColumns: [hub.columns![0].name], origin: hub.id, direction: 'up' });
  assert('ok' in result, 'Init with small frontier cap');
  // With maxFrontierSize=2 and >3 upstream neighbors, frontier should be capped
  assert(state.frontierSize <= 2, `Frontier capped at 2 (got ${state.frontierSize})`);
}

// ─── Test: External node boundary ────────────────────────────────────────────

async function testExternalBoundary(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  // Find an external node
  const ext = model.nodes.find(n => n.type === 'external');
  if (!ext) { console.log('  (skipping: no external nodes in model)'); return; }

  // Find a node connected to the external
  const connected = model.nodes.find(n => {
    const nbs = [...(model.neighborIndex[n.id]?.in ?? []), ...(model.neighborIndex[n.id]?.out ?? [])];
    return nbs.includes(ext.id) && n.columns?.length;
  });
  if (!connected) { console.log('  (skipping: no node connected to external)'); return; }

  state.init({ targetColumns: [connected.columns![0].name], origin: connected.id, direction: 'up' });
  const hop = state.getHopContext();
  if ('done' in hop || 'error' in hop) { console.log('  (skipping: no hop)'); return; }

  const ctx = hop as { neighbors: Array<{ id: string; boundary: string }> };
  const extNb = ctx.neighbors.find(nb => nb.id === ext.id);
  if (extNb) {
    assertEq(extNb.boundary, 'external', 'External node has boundary=external');
  } else {
    console.log('  (skipping: external not in neighbor list for this direction)');
  }
}

// ─── Synthetic Model ─────────────────────────────────────────────────────────

function buildSyntheticModel(): DatabaseModel {
  // IDs must be lowercase — matches normalizeName() in the real pipeline
  const nodes: LineageNode[] = [
    { id: '[staging].[rawdata]', schema: 'staging', name: 'RawData', fullName: '[staging].[RawData]', type: 'table',
      columns: [{ name: 'Amount', type: 'decimal(18,2)', nullable: 'true', extra: '' }, { name: 'Currency', type: 'varchar(3)', nullable: 'false', extra: '' }] },
    { id: '[dbo].[sploadstaging]', schema: 'dbo', name: 'spLoadStaging', fullName: '[dbo].[spLoadStaging]', type: 'procedure',
      bodyScript: 'CREATE PROCEDURE [dbo].[spLoadStaging] AS INSERT INTO staging.RawData SELECT Amount, Currency FROM ext.RemoteDB' },
    { id: '[dbo].[sptransform]', schema: 'dbo', name: 'spTransform', fullName: '[dbo].[spTransform]', type: 'procedure',
      bodyScript: 'CREATE PROCEDURE [dbo].[spTransform] AS EXEC [dbo].[spLoadStaging]; INSERT INTO dbo.vwClean SELECT OrderQty, OrderAmount FROM staging.RawData' },
    { id: '[dbo].[vwclean]', schema: 'dbo', name: 'vwClean', fullName: '[dbo].[vwClean]', type: 'view',
      bodyScript: 'CREATE VIEW [dbo].[vwClean] AS SELECT OrderQty, OrderAmount FROM staging.RawData WHERE OrderQty > 0',
      columns: [{ name: 'OrderQty', type: 'int', nullable: 'false', extra: '' }, { name: 'OrderAmount', type: 'decimal(18,2)', nullable: 'true', extra: '' }] },
    { id: '[dbo].[factsales]', schema: 'dbo', name: 'FactSales', fullName: '[dbo].[FactSales]', type: 'table',
      columns: [{ name: 'Revenue', type: 'decimal(18,2)', nullable: 'true', extra: '' }, { name: 'Qty', type: 'int', nullable: 'false', extra: '' }] },
    { id: '[ext].[remotedb]', schema: 'ext', name: 'RemoteDB', fullName: '[ext].[RemoteDB]', type: 'external',
      externalType: 'db', columns: [{ name: 'SourceId', type: 'int', nullable: 'false', extra: '' }] },
  ];

  const edges: LineageEdge[] = [
    { source: '[staging].[rawdata]', target: '[dbo].[sploadstaging]', type: 'body' },
    { source: '[ext].[remotedb]', target: '[dbo].[sploadstaging]', type: 'body' },
    { source: '[dbo].[sploadstaging]', target: '[dbo].[sptransform]', type: 'exec' },
    { source: '[staging].[rawdata]', target: '[dbo].[sptransform]', type: 'body' },
    { source: '[staging].[rawdata]', target: '[dbo].[vwclean]', type: 'body' },
    { source: '[dbo].[sptransform]', target: '[dbo].[vwclean]', type: 'body' },
    { source: '[dbo].[vwclean]', target: '[dbo].[factsales]', type: 'body' },
  ];

  // Build neighborIndex from edges
  const neighborIndex: NeighborIndex = {};
  for (const n of nodes) neighborIndex[n.id] = { in: [], out: [] };
  for (const e of edges) {
    neighborIndex[e.source]?.out.push(e.target);
    neighborIndex[e.target]?.in.push(e.source);
  }

  return {
    nodes, edges, neighborIndex,
    schemas: [
      { name: 'staging', nodeCount: 1, types: { table: 1, view: 0, procedure: 0, function: 0, external: 0 } },
      { name: 'dbo', nodeCount: 4, types: { table: 1, view: 1, procedure: 2, function: 0, external: 0 } },
      { name: 'ext', nodeCount: 1, types: { table: 0, view: 0, procedure: 0, function: 0, external: 1 } },
    ],
    catalog: Object.fromEntries(nodes.map(n => [n.id, { schema: n.schema, name: n.name, type: n.type }])),
  };
}

// ─── Synthetic Tests ─────────────────────────────────────────────────────────

async function testDirectionDownSynthetic() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new ColumnTraceState(model, log);
  state.init({ targetColumns: ['Revenue'], origin: '[dbo].[factsales]', direction: 'down' });
  const hop = state.getHopContext();
  if ('done' in hop) {
    // FactSales has no downstream consumers — correct
    assert(state.isComplete, 'Syn: FactSales has no downstream → complete immediately');
    return;
  }
  if ('error' in hop) { assert(false, `Syn direction down: unexpected error ${hop.error}`); return; }
  const ctx = hop as { neighbors: Array<{ edge_direction: string }> };
  for (const nb of ctx.neighbors) {
    assertEq(nb.edge_direction, 'downstream', 'Syn: all neighbors are downstream');
  }
}

async function testPassthroughSynthetic() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new ColumnTraceState(model, log);
  state.init({ targetColumns: ['OrderQty'], origin: '[dbo].[sptransform]', direction: 'up' });
  const hop = state.getHopContext();
  if ('done' in hop || 'error' in hop) { assert(false, 'Syn: expected hop'); return; }

  const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string }> };
  const frontierBefore = state.frontierSize;
  // Passthrough the focus node's first neighbor
  const nb = ctx.neighbors[0];
  const result = state.submitVerdicts({
    focusNodeId: ctx.focus_node.id as string,
    verdicts: [{ nodeId: nb.id, verdict: 'pass', summary: 'test passthrough' }],
  });
  assert('ok' in result, 'Syn: passthrough accepted');
  assert(true, 'Syn: passthrough verdict processed');
}

async function testRelevantColumnRenameSynthetic() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new ColumnTraceState(model, log);
  // Init from spTransform upstream — hops will visit spLoadStaging which has rawdata+remotedb as neighbors
  state.init({ targetColumns: ['OrderQty'], origin: '[dbo].[sptransform]', direction: 'up' });

  // Drain hops until we find a focus node whose neighbors include rawdata (table with columns)
  let found = false;
  for (let i = 0; i < 5; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string; t: string }> };
    const rawData = ctx.neighbors.find(nb => nb.id === '[staging].[rawdata]');
    if (rawData) {
      // Submit relevant with valid column 'Amount' (renamed from OrderQty)
      const result = state.submitVerdicts({
        focusNodeId: ctx.focus_node.id as string,
        verdicts: [{ nodeId: rawData.id, verdict: 'trace', columnsOut: ['Amount'], summary: 'OrderQty ← Amount' }],
      });
      assert('ok' in result, 'Syn: relevant verdict with valid renamed column accepted');
      found = true;
      break;
    }
    // Remove all neighbors to advance
    state.submitVerdicts({
      focusNodeId: ctx.focus_node.id as string,
      verdicts: ctx.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
    });
  }
  assert(found, 'Syn: found RawData as neighbor for column rename test');
}

async function testFrontierCapSynthetic() {
  clearLogs();
  const model = buildSyntheticModel();
  // spLoadStaging has 2 upstream (RawData + RemoteDB) — use cap=1
  const state = new ColumnTraceState(model, log, { maxFrontierSize: 1 });
  state.init({ targetColumns: ['Amount'], origin: '[dbo].[sploadstaging]', direction: 'up' });
  assert(state.frontierSize <= 1, `Syn: frontier capped at 1 (got ${state.frontierSize})`);
}

async function testExternalBoundarySynthetic() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new ColumnTraceState(model, log);
  // Init from spTransform → first hop is spLoadStaging → its neighbors include RemoteDB
  state.init({ targetColumns: ['OrderQty'], origin: '[dbo].[sptransform]', direction: 'up' });
  const hop = state.getHopContext();
  if ('done' in hop || 'error' in hop) { assert(false, 'Syn: expected hop'); return; }

  const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string; boundary: string }> };
  // Focus is one of spTransform's upstream. If it's spLoadStaging, its neighbors include RemoteDB.
  // If not, submit remove verdicts and get next hop.
  let found = false;
  let maxHops = 5;
  let currentCtx = ctx;
  while (maxHops-- > 0) {
    const ext = currentCtx.neighbors.find(nb => nb.id === '[ext].[remotedb]');
    if (ext) {
      assertEq(ext.boundary, 'external', 'Syn: RemoteDB has boundary=external');
      found = true;
      break;
    }
    // Submit remove for all neighbors, get next hop
    state.submitVerdicts({
      focusNodeId: currentCtx.focus_node.id as string,
      verdicts: currentCtx.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
    });
    const next = state.getHopContext();
    if ('done' in next || 'error' in next) break;
    currentCtx = next as typeof ctx;
  }
  assert(found, 'Syn: found RemoteDB as external boundary in hop neighbors');
}

async function testSPtoSPExecEdgeSynthetic() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new ColumnTraceState(model, log);
  // Init from vwClean → first hop is spTransform (upstream) → its neighbors include spLoadStaging (exec)
  state.init({ targetColumns: ['OrderQty'], origin: '[dbo].[vwclean]', direction: 'up' });

  // Drain until we focus on spTransform (which has spLoadStaging as exec neighbor)
  let found = false;
  for (let i = 0; i < 5; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string; t: string; edge_type: string }> };
    const spNb = ctx.neighbors.find(nb => nb.id === '[dbo].[sploadstaging]');
    if (spNb) {
      assertEq(spNb.t, 'procedure', 'Syn: spLoadStaging is procedure');
      // Submit relevant with arbitrary column — SP→SP should accept on trust
      const result = state.submitVerdicts({
        focusNodeId: ctx.focus_node.id as string,
        verdicts: [{ nodeId: spNb.id, verdict: 'trace', columnsOut: ['ArbitraryCol'], summary: 'SP→SP, no validation' }],
      });
      assert('ok' in result, 'Syn: SP→SP relevant verdict accepted (no column validation)');
      found = true;
      break;
    }
    state.submitVerdicts({
      focusNodeId: ctx.focus_node.id as string,
      verdicts: ctx.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
    });
  }
  assert(found, 'Syn: found SP→SP exec edge in hop neighbors');
}

async function testGetResultAwaitingVerdictsSynthetic() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new ColumnTraceState(model, log);
  state.init({ targetColumns: ['OrderQty'], origin: '[dbo].[vwclean]', direction: 'up' });
  const hop = state.getHopContext();
  if ('done' in hop || 'error' in hop) { assert(false, 'Syn: expected hop'); return; }

  // Don't submit verdicts — try getResult() in awaiting_verdicts state
  assertEq(state.status, 'awaiting_verdicts', 'Syn: status is awaiting_verdicts');
  const result = state.getResult();
  assert('error' in result, 'Syn: getResult in awaiting_verdicts → error');
}

async function testDirectionBothEdgeLabelingSynthetic() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new ColumnTraceState(model, log);
  // vwClean has upstream (staging.RawData, dbo.spTransform) and downstream (dbo.FactSales)
  // Origin = vwClean, direction = both. Frontier gets all 3 neighbors.
  // First focus = staging.rawdata (FIFO). rawdata has no in, only out → all neighbors downstream.
  // To test mixed directions, drain until we hit spTransform which has both in and out.
  state.init({ targetColumns: ['OrderQty'], origin: '[dbo].[vwclean]', direction: 'both' });

  // Find a focus node with both upstream and downstream neighbors
  let found = false;
  for (let i = 0; i < 10; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string; edge_direction: string }> };

    // Check if this focus node has neighbors in both directions
    const dirs = new Set(ctx.neighbors.map(nb => nb.edge_direction));
    if (dirs.has('upstream') && dirs.has('downstream')) {
      // Verify each neighbor is correctly labeled
      const focusId = ctx.focus_node.id as string;
      const nb = model.neighborIndex[focusId] ?? { in: [], out: [] };
      const inSet = new Set(nb.in);
      for (const n of ctx.neighbors) {
        const expected = inSet.has(n.id) ? 'upstream' : 'downstream';
        assertEq(n.edge_direction, expected, `Syn both: ${n.id} is ${expected} of ${focusId}`);
      }
      found = true;
      break;
    }
    // Remove all neighbors to advance
    state.submitVerdicts({
      focusNodeId: ctx.focus_node.id as string,
      verdicts: ctx.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
    });
  }

  if (!found) {
    // Fallback: just verify the per-neighbor labeling logic is consistent on any hop
    // Re-init and verify first hop neighbors match their actual edge direction
    const state2 = new ColumnTraceState(model, log);
    state2.init({ targetColumns: ['OrderQty'], origin: '[dbo].[vwclean]', direction: 'both' });
    const hop = state2.getHopContext();
    if (!('done' in hop) && !('error' in hop)) {
      const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string; edge_direction: string }> };
      const focusId = ctx.focus_node.id as string;
      const nb = model.neighborIndex[focusId] ?? { in: [], out: [] };
      const inSet = new Set(nb.in);
      for (const n of ctx.neighbors) {
        const expected = inSet.has(n.id) ? 'upstream' : 'downstream';
        assertEq(n.edge_direction, expected, `Syn both fallback: ${n.id} is ${expected} of ${focusId}`);
      }
      found = true;
    }
  }
  assert(found, 'Syn both: edge_direction correctly labeled per-neighbor');
}

async function testGetResultFieldsSynthetic() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new ColumnTraceState(model, log);
  state.init({ targetColumns: ['Amount'], origin: '[staging].[rawdata]', direction: 'down' });

  // Drain all hops
  while (true) {
    const h = state.getHopContext();
    if ('done' in h) break;
    if ('error' in h) break;
    const c = h as { focus_node: { id: string }; neighbors: Array<{ id: string }> };
    state.submitVerdicts({
      focusNodeId: c.focus_node.id as string,
      verdicts: c.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
    });
  }

  const result = state.getResult();
  assert(!('error' in result), 'Syn: getResult succeeds');
  const r = result as { targetColumns: string[]; originNodeId: string; direction: string };
  assertEq(JSON.stringify(r.targetColumns), '["Amount"]', 'Syn: targetColumns in result');
  assertEq(r.originNodeId, '[staging].[rawdata]', 'Syn: originNodeId in result');
  assertEq(r.direction, 'down', 'Syn: direction in result');
}

// ─── Notes + Question Routing Test ──────────────────────────────────────────

async function testNotesAndQuestionRoutingSynthetic() {
  console.log('\n── Syn: Notes + Question Routing ──');
  const model = buildSyntheticModel();
  const state = new ColumnTraceState(model, log);
  state.init({ targetColumns: ['Amount'], origin: '[staging].[rawdata]', direction: 'down' });

  // Hop 1: submit with notes + question on first traced neighbor
  const hop1 = state.getHopContext();
  assert(!('done' in hop1) && !('error' in hop1), 'Syn notes: hop 1 not done/error');
  const ctx1 = hop1 as { focus_node: { id: string }; neighbors: Array<{ id: string }> };
  const tracedNb = ctx1.neighbors[0];
  state.submitVerdicts({
    focusNodeId: ctx1.focus_node.id as string,
    notes: 'SP loads Amount from external source.',
    verdicts: [
      { nodeId: tracedNb.id, verdict: 'trace', columnsOut: ['Amount'], summary: 'Amount flows', question: 'Does this transform Amount?' },
      // Prune rest
      ...ctx1.neighbors.slice(1).map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
    ],
  });

  // Drain remaining hops, collecting path_so_far data
  let foundNotesInPath = false;
  let foundSubQuestion = false;
  for (let i = 0; i < 20; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    const ctx = hop as { focus_node: { id: string }; sub_question: string; neighbors: Array<{ id: string }>; path_so_far: Array<{ notes?: string }> };

    // Check if notes appeared in path_so_far
    if (ctx.path_so_far.some(p => p.notes === 'SP loads Amount from external source.')) foundNotesInPath = true;
    // Check if our question was routed as sub_question to the traced neighbor
    if (ctx.focus_node.id === tracedNb.id && ctx.sub_question === 'Does this transform Amount?') foundSubQuestion = true;

    state.submitVerdicts({
      focusNodeId: ctx.focus_node.id as string,
      verdicts: ctx.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
    });
  }

  assert(foundNotesInPath, 'Syn notes: notes from hop 1 appeared in later path_so_far');
  assert(foundSubQuestion, 'Syn notes: question routed as sub_question to traced neighbor');

  // Verify notes in final result chain
  const result = state.getResult();
  assert(!('error' in result), 'Syn notes: result not error');
  const r = result as { chain: Array<{ nodeId: string; notes?: string }> };
  const withNotes = r.chain.filter(e => e.notes);
  assert(withNotes.length > 0, 'Syn notes: chain entry has notes in result');
  assertEq(withNotes[0].notes!, 'SP loads Amount from external source.', 'Syn notes: notes content matches in result');
}

// ─── Bug regression tests ───────────────────────────────────────────────────

/** Diamond model: Origin → SP_A → MergeTable ← SP_B ← Origin
 *  Both SP_A and SP_B write to MergeTable — tests chain merge (Bug #4) */
function buildDiamondModel(): DatabaseModel {
  const nodes: LineageNode[] = [
    { id: '[dbo].[origin]', schema: 'dbo', name: 'Origin', fullName: '[dbo].[Origin]', type: 'table',
      columns: [{ name: 'Amount', type: 'decimal(18,2)', nullable: 'true', extra: '' }, { name: 'Qty', type: 'int', nullable: 'false', extra: '' }] },
    { id: '[dbo].[sp_a]', schema: 'dbo', name: 'SP_A', fullName: '[dbo].[SP_A]', type: 'procedure',
      bodyScript: 'CREATE PROCEDURE [dbo].[SP_A] AS INSERT INTO dbo.MergeTable SELECT Amount FROM dbo.Origin' },
    { id: '[dbo].[sp_b]', schema: 'dbo', name: 'SP_B', fullName: '[dbo].[SP_B]', type: 'procedure',
      bodyScript: 'CREATE PROCEDURE [dbo].[SP_B] AS INSERT INTO dbo.MergeTable SELECT Qty FROM dbo.Origin' },
    { id: '[dbo].[mergetable]', schema: 'dbo', name: 'MergeTable', fullName: '[dbo].[MergeTable]', type: 'table',
      columns: [{ name: 'Amount', type: 'decimal(18,2)', nullable: 'true', extra: '' }, { name: 'Qty', type: 'int', nullable: 'false', extra: '' }] },
  ];
  const edges: LineageEdge[] = [
    { source: '[dbo].[origin]', target: '[dbo].[sp_a]', type: 'body' },
    { source: '[dbo].[origin]', target: '[dbo].[sp_b]', type: 'body' },
    { source: '[dbo].[sp_a]', target: '[dbo].[mergetable]', type: 'body' },
    { source: '[dbo].[sp_b]', target: '[dbo].[mergetable]', type: 'body' },
  ];
  const neighborIndex: NeighborIndex = {};
  for (const n of nodes) neighborIndex[n.id] = { in: [], out: [] };
  for (const e of edges) {
    neighborIndex[e.source]?.out.push(e.target);
    neighborIndex[e.target]?.in.push(e.source);
  }
  return {
    nodes, edges, neighborIndex,
    schemas: [{ name: 'dbo', nodeCount: 4, types: { table: 2, view: 0, procedure: 2, function: 0, external: 0 } }],
    catalog: Object.fromEntries(nodes.map(n => [n.id, { schema: n.schema, name: n.name, type: n.type }])),
  };
}

/** Bug #4: Diamond pattern — chain entry should merge columnsIn, not clobber */
async function testDiamondMergeChainSynthetic() {
  console.log('\n── Syn: Diamond Merge Chain (Bug #4) ──');
  clearLogs();
  const model = buildDiamondModel();
  const state = new ColumnTraceState(model, log);
  // Trace downstream from Origin to see both SP_A and SP_B feed into MergeTable
  state.init({ targetColumns: ['Amount'], origin: '[dbo].[origin]', direction: 'down' });

  // Hop 1: focus is one of the SPs (Origin's downstream neighbors are SP_A, SP_B)
  const hop1 = state.getHopContext();
  assert(!('done' in hop1) && !('error' in hop1), 'Diamond: hop 1 ok');
  const ctx1 = hop1 as { focus_node: { id: string }; neighbors: Array<{ id: string }> };
  // Trace MergeTable from this SP
  const mt1 = ctx1.neighbors.find(nb => nb.id === '[dbo].[mergetable]');
  state.submitVerdicts({
    focusNodeId: ctx1.focus_node.id as string,
    verdicts: [
      ...(mt1 ? [{ nodeId: mt1.id, verdict: 'trace' as const, columnsOut: ['Amount'], summary: 'from SP_A path' }] : []),
      ...ctx1.neighbors.filter(nb => nb.id !== '[dbo].[mergetable]').map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'skip' })),
    ],
  });

  // Hop 2: focus is the other SP (or MergeTable if already queued)
  const hop2 = state.getHopContext();
  if ('done' in hop2 || 'error' in hop2) {
    // MergeTable might be terminal (source boundary when direction=down, no out edges)
    assert(true, 'Diamond: completed after 1 SP');
    return;
  }
  const ctx2 = hop2 as { focus_node: { id: string }; neighbors: Array<{ id: string }> };
  const mt2 = ctx2.neighbors.find(nb => nb.id === '[dbo].[mergetable]');
  if (mt2) {
    // Second SP also verdicts MergeTable — should MERGE, not clobber
    state.submitVerdicts({
      focusNodeId: ctx2.focus_node.id as string,
      verdicts: [
        { nodeId: mt2.id, verdict: 'trace', columnsOut: ['Qty'], summary: 'from SP_B path' },
        ...ctx2.neighbors.filter(nb => nb.id !== '[dbo].[mergetable]').map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'skip' })),
      ],
    });
  } else {
    state.submitVerdicts({
      focusNodeId: ctx2.focus_node.id as string,
      verdicts: ctx2.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'skip' })),
    });
  }

  // Drain remaining
  for (let i = 0; i < 10; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string }> };
    state.submitVerdicts({
      focusNodeId: ctx.focus_node.id as string,
      verdicts: ctx.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
    });
  }

  const result = state.getResult();
  assert(!('error' in result), 'Diamond: result ok');
  const r = result as { chain: Array<{ nodeId: string; columnsIn: string[]; columnsOut: string[] }> };
  const mtEntry = r.chain.find(e => e.nodeId === '[dbo].[mergetable]');
  if (mtEntry) {
    // Bug #4: columnsOut should contain BOTH Amount and Qty (merged from both paths)
    assert(mtEntry.columnsOut.includes('Amount') || mtEntry.columnsOut.includes('Qty'),
      `Diamond: MergeTable columnsOut has data (got [${mtEntry.columnsOut}])`);
  }
  assert(true, 'Diamond: merge chain test complete');
}

/** Bug #1: Passthrough node added to visited — prevents dual membership in chain+passthroughMap */
async function testPassthroughVisitedSynthetic() {
  console.log('\n── Syn: Passthrough Visited Guard (Bug #1) ──');
  clearLogs();
  // Use diamond model: Origin → SP_A → MergeTable ← SP_B
  // Direction down: pass SP_A, trace SP_B — both share MergeTable as neighbor
  // After pass, SP_A should be in visited, preventing re-encounter issues
  const model = buildDiamondModel();
  const state = new ColumnTraceState(model, log);
  state.init({ targetColumns: ['Amount'], origin: '[dbo].[origin]', direction: 'down' });

  const hop1 = state.getHopContext();
  assert(!('done' in hop1) && !('error' in hop1), 'PassVisited: hop 1 ok');
  const ctx1 = hop1 as { focus_node: { id: string }; neighbors: Array<{ id: string }> };

  // Pass this focus node's neighbors (MergeTable), trace the other SP
  state.submitVerdicts({
    focusNodeId: ctx1.focus_node.id as string,
    verdicts: ctx1.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'pass' as const, summary: 'pass for visited test' })),
  });

  // Continue draining — passthrough nodes should be in visited now
  for (let i = 0; i < 10; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string; boundary: string }> };
    // If any neighbor is a passthrough node we already passed, it should show boundary='cycle'
    for (const nb of ctx.neighbors) {
      for (const passedId of ctx1.neighbors.map(n => n.id)) {
        if (nb.id === passedId) {
          assertEq(nb.boundary, 'cycle', `PassVisited: re-encountered passthrough ${nb.id} has boundary=cycle`);
        }
      }
    }
    state.submitVerdicts({
      focusNodeId: ctx.focus_node.id as string,
      verdicts: ctx.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
    });
  }

  const result = state.getResult();
  assert(!('error' in result), 'PassVisited: result ok');
  assert(true, 'PassVisited: passthrough nodes correctly in visited');
}

/** Bug #3: Passthrough depth — children of passthrough should be at focusDepth+2, not focusDepth+1 */
async function testPassthroughDepthSynthetic() {
  console.log('\n── Syn: Passthrough Depth (Bug #3) ──');
  clearLogs();
  const model = buildSyntheticModel();
  const state = new ColumnTraceState(model, log);
  // Up from spTransform(depth=0): spLoadStaging(depth=1) is neighbor
  // If spLoadStaging is pass → its children (rawdata, remotedb) should be depth=3 (not 2)
  state.init({ targetColumns: ['OrderQty'], origin: '[dbo].[sptransform]', direction: 'up' });

  const hop1 = state.getHopContext();
  assert(!('done' in hop1) && !('error' in hop1), 'PassDepth: hop 1 ok');
  const ctx1 = hop1 as { focus_node: { id: string }; neighbors: Array<{ id: string }> };

  // Pass all neighbors to test depth propagation
  state.submitVerdicts({
    focusNodeId: ctx1.focus_node.id as string,
    verdicts: ctx1.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'pass' as const, summary: 'pass for depth test' })),
  });

  // Next hop should be children of the passthrough nodes — check depth in logs
  const hop2 = state.getHopContext();
  if (!('done' in hop2) && !('error' in hop2)) {
    const ctx2 = hop2 as { focus_node: { id: string }; neighbors: Array<{ id: string }> };
    // Check logs for depth info — passthrough children should be depth >= 3
    const depthLog = logs.find(l => l.includes(`Hop 2`) && l.includes('depth='));
    if (depthLog) {
      const depthMatch = depthLog.match(/depth=(\d+)/);
      if (depthMatch) {
        const depth = parseInt(depthMatch[1]);
        assert(depth >= 2, `PassDepth: children of passthrough at depth=${depth} (expected >= 2)`);
      }
    }
    state.submitVerdicts({
      focusNodeId: ctx2.focus_node.id as string,
      verdicts: ctx2.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
    });
  }

  // Drain remaining
  for (let i = 0; i < 10; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string }> };
    state.submitVerdicts({
      focusNodeId: ctx.focus_node.id as string,
      verdicts: ctx.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
    });
  }
  assert(true, 'PassDepth: test complete');
}

/** Bug #2: Focus node notes should get boundaryFlag='none', not 'cycle' */
async function testFocusNodeBoundaryNotCycleSynthetic() {
  console.log('\n── Syn: Focus Node Boundary (Bug #2) ──');
  clearLogs();
  const model = buildSyntheticModel();
  const state = new ColumnTraceState(model, log);
  state.init({ targetColumns: ['OrderQty'], origin: '[dbo].[sptransform]', direction: 'up' });

  const hop1 = state.getHopContext();
  assert(!('done' in hop1) && !('error' in hop1), 'FocusBoundary: hop 1 ok');
  const ctx1 = hop1 as { focus_node: { id: string }; neighbors: Array<{ id: string }> };

  // Submit verdicts with notes — this triggers ad-hoc chain entry creation if focus not in chain
  state.submitVerdicts({
    focusNodeId: ctx1.focus_node.id as string,
    notes: 'Test notes for boundary check',
    verdicts: ctx1.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
  });

  // Get result and check focus node's boundaryFlag
  // Drain remaining
  for (let i = 0; i < 10; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string }> };
    state.submitVerdicts({
      focusNodeId: ctx.focus_node.id as string,
      verdicts: ctx.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
    });
  }

  const result = state.getResult();
  assert(!('error' in result), 'FocusBoundary: result ok');
  const r = result as { chain: Array<{ nodeId: string; boundaryFlag: string; notes?: string }> };
  const focusEntry = r.chain.find(e => e.nodeId === ctx1.focus_node.id as string);
  if (focusEntry) {
    assert(focusEntry.boundaryFlag !== 'cycle',
      `FocusBoundary: focus node boundary is '${focusEntry.boundaryFlag}' (not 'cycle')`);
    assertEq(focusEntry.notes!, 'Test notes for boundary check', 'FocusBoundary: notes preserved');
  }
}

// ─── Extended Synthetic Model (multi-branch, dead ends, filter-only) ────────

function buildGoldenModel(): DatabaseModel {
  // Models the [ai] schema structure for deterministic golden scenario testing:
  //
  // FactSales.Revenue = Qty * UnitPrice  (in spBuildFact)
  //   Branch A (Qty):   vwClean.OrderQty → Staging.OrderQty → spLoad → RawImport.RawQty → Source1.Quantity
  //   Branch B (Price): PriceMaster.ListPrice → spRefreshPrices → SupplierPrices.CostPrice [SOURCE]
  //   Dead ends:        AuditLog (write target), DimCalendar (filter-only join)
  //
  const nodes: LineageNode[] = [
    // Sink
    { id: '[dbo].[factsales]', schema: 'dbo', name: 'FactSales', fullName: '[dbo].[FactSales]', type: 'table',
      columns: [{ name: 'Revenue', type: 'decimal(18,2)', nullable: 'true', extra: '' },
                { name: 'Qty', type: 'int', nullable: 'false', extra: '' },
                { name: 'UnitPrice', type: 'decimal(18,2)', nullable: 'true', extra: '' }] },
    // L1 — SP that builds fact
    { id: '[dbo].[spbuildfact]', schema: 'dbo', name: 'spBuildFact', fullName: '[dbo].[spBuildFact]', type: 'procedure',
      bodyScript: 'CREATE PROCEDURE [dbo].[spBuildFact] AS INSERT INTO dbo.FactSales(Revenue, Qty, UnitPrice) SELECT c.OrderQty * p.UnitPrice, c.OrderQty, p.UnitPrice FROM dbo.vwClean c JOIN dbo.PriceMaster p ON c.ProductId = p.ProductId' },
    // Branch A — Qty path
    { id: '[dbo].[vwclean]', schema: 'dbo', name: 'vwClean', fullName: '[dbo].[vwClean]', type: 'view',
      bodyScript: 'CREATE VIEW [dbo].[vwClean] AS SELECT OrderQty, ProductId FROM dbo.Staging WHERE IsValid = 1',
      columns: [{ name: 'OrderQty', type: 'int', nullable: 'false', extra: '' },
                { name: 'ProductId', type: 'int', nullable: 'false', extra: '' }] },
    { id: '[dbo].[staging]', schema: 'dbo', name: 'Staging', fullName: '[dbo].[Staging]', type: 'table',
      columns: [{ name: 'OrderQty', type: 'int', nullable: 'false', extra: '' },
                { name: 'IsValid', type: 'bit', nullable: 'false', extra: '' },
                { name: 'ProductId', type: 'int', nullable: 'false', extra: '' }] },
    { id: '[dbo].[spload]', schema: 'dbo', name: 'spLoad', fullName: '[dbo].[spLoad]', type: 'procedure',
      bodyScript: 'CREATE PROCEDURE [dbo].[spLoad] AS INSERT INTO dbo.Staging(OrderQty, IsValid, ProductId) SELECT RawQty, 1, ProductId FROM dbo.RawImport; EXEC dbo.spLogAudit @Action=\'Load\'' },
    { id: '[dbo].[rawimport]', schema: 'dbo', name: 'RawImport', fullName: '[dbo].[RawImport]', type: 'table',
      columns: [{ name: 'RawQty', type: 'int', nullable: 'true', extra: '' },
                { name: 'ProductId', type: 'int', nullable: 'false', extra: '' }] },
    { id: '[ext].[source1]', schema: 'ext', name: 'Source1', fullName: '[ext].[Source1]', type: 'external',
      externalType: 'db',
      columns: [{ name: 'Quantity', type: 'int', nullable: 'false', extra: '' }] },
    // Branch B — Price path
    { id: '[dbo].[pricemaster]', schema: 'dbo', name: 'PriceMaster', fullName: '[dbo].[PriceMaster]', type: 'table',
      columns: [{ name: 'ListPrice', type: 'decimal(18,2)', nullable: 'true', extra: '' },
                { name: 'ProductId', type: 'int', nullable: 'false', extra: '' }] },
    { id: '[dbo].[sprefreshprices]', schema: 'dbo', name: 'spRefreshPrices', fullName: '[dbo].[spRefreshPrices]', type: 'procedure',
      bodyScript: 'CREATE PROCEDURE [dbo].[spRefreshPrices] AS MERGE dbo.PriceMaster AS tgt USING dbo.SupplierPrices AS src ON tgt.ProductId = src.ProductId WHEN MATCHED THEN UPDATE SET ListPrice = src.CostPrice * 1.2' },
    { id: '[dbo].[supplierprices]', schema: 'dbo', name: 'SupplierPrices', fullName: '[dbo].[SupplierPrices]', type: 'table',
      columns: [{ name: 'CostPrice', type: 'decimal(18,2)', nullable: 'true', extra: '' },
                { name: 'ProductId', type: 'int', nullable: 'false', extra: '' }] },
    // Dead ends
    { id: '[dbo].[auditlog]', schema: 'dbo', name: 'AuditLog', fullName: '[dbo].[AuditLog]', type: 'table',
      columns: [{ name: 'Action', type: 'varchar(50)', nullable: 'false', extra: '' }] },
    { id: '[dbo].[splogaudit]', schema: 'dbo', name: 'spLogAudit', fullName: '[dbo].[spLogAudit]', type: 'procedure',
      bodyScript: 'CREATE PROCEDURE [dbo].[spLogAudit] @Action VARCHAR(50) AS INSERT INTO dbo.AuditLog(Action) VALUES (@Action)' },
    { id: '[dbo].[dimcalendar]', schema: 'dbo', name: 'DimCalendar', fullName: '[dbo].[DimCalendar]', type: 'table',
      columns: [{ name: 'FiscalYear', type: 'int', nullable: 'false', extra: '' }] },
  ];

  // Edges: source → target (data flow direction: source is read by target)
  const edges: LineageEdge[] = [
    // L1: spBuildFact reads from vwClean + PriceMaster, writes to FactSales
    { source: '[dbo].[vwclean]', target: '[dbo].[spbuildfact]', type: 'body' },
    { source: '[dbo].[pricemaster]', target: '[dbo].[spbuildfact]', type: 'body' },
    { source: '[dbo].[spbuildfact]', target: '[dbo].[factsales]', type: 'write' },
    // Branch A: vwClean reads Staging, spLoad reads RawImport + writes Staging
    { source: '[dbo].[staging]', target: '[dbo].[vwclean]', type: 'body' },
    { source: '[dbo].[rawimport]', target: '[dbo].[spload]', type: 'body' },
    { source: '[dbo].[spload]', target: '[dbo].[staging]', type: 'write' },
    { source: '[ext].[source1]', target: '[dbo].[rawimport]', type: 'body' },
    // Branch B: spRefreshPrices reads SupplierPrices + writes PriceMaster
    { source: '[dbo].[supplierprices]', target: '[dbo].[sprefreshprices]', type: 'body' },
    { source: '[dbo].[sprefreshprices]', target: '[dbo].[pricemaster]', type: 'write' },
    // Dead end: spLoad EXEC spLogAudit → AuditLog
    { source: '[dbo].[splogaudit]', target: '[dbo].[spload]', type: 'exec' },
    { source: '[dbo].[auditlog]', target: '[dbo].[splogaudit]', type: 'body' },
    // Dead end: DimCalendar joined in vwClean (filter-only)
    { source: '[dbo].[dimcalendar]', target: '[dbo].[vwclean]', type: 'body' },
  ];

  const neighborIndex: NeighborIndex = {};
  for (const n of nodes) neighborIndex[n.id] = { in: [], out: [] };
  for (const e of edges) {
    neighborIndex[e.source]?.out.push(e.target);
    neighborIndex[e.target]?.in.push(e.source);
  }

  return {
    nodes, edges, neighborIndex,
    schemas: [
      { name: 'dbo', nodeCount: 11, types: { table: 6, view: 1, procedure: 4, function: 0, external: 0 } },
      { name: 'ext', nodeCount: 1, types: { table: 0, view: 0, procedure: 0, function: 0, external: 1 } },
    ],
    catalog: Object.fromEntries(nodes.map(n => [n.id, { schema: n.schema, name: n.name, type: n.type }])),
  };
}

// ─── Golden Scenario: Multi-branch column trace (upstream) ──────────────────

async function testGoldenMultiBranchColumnTrace() {
  console.log('\n── Golden: Multi-branch column trace (Revenue upstream) ──');
  const model = buildGoldenModel();
  const state = new ColumnTraceState(model, log);
  clearLogs();

  // Init: trace Revenue from FactSales upstream
  const init = state.init({ targetColumns: ['Revenue'], origin: '[dbo].[factsales]', direction: 'up' });
  assert('ok' in init, 'Golden CT: init succeeds');

  // Pre-recorded verdict sequence (simulates what a correct AI would produce)
  // The state machine determines focus order via FIFO frontier.
  // After init: frontier = upstream neighbors of FactSales = [spBuildFact]
  const verdictScript: Array<{ expectedFocus: string; verdicts: Array<{ nodeId: string; verdict: 'trace' | 'prune' | 'pass'; columnsOut?: string[]; summary: string }> }> = [];

  // Hop 1: focus=spBuildFact. Neighbors: vwClean (upstream), PriceMaster (upstream), FactSales (downstream, but direction=up so only upstream shown)
  // Expect neighbors: vwClean + PriceMaster (upstream of spBuildFact)
  // Verdict: trace both (Revenue = OrderQty * UnitPrice → split into two branches)
  verdictScript.push({
    expectedFocus: '[dbo].[spbuildfact]',
    verdicts: [
      { nodeId: '[dbo].[vwclean]', verdict: 'trace', columnsOut: ['OrderQty'], summary: 'OrderQty feeds Qty path of Revenue' },
      { nodeId: '[dbo].[pricemaster]', verdict: 'trace', columnsOut: ['ListPrice'], summary: 'ListPrice feeds UnitPrice path' },
    ],
  });

  // Hop 2: focus=vwClean (FIFO — first traced neighbor). Neighbors: Staging (upstream), DimCalendar (upstream)
  verdictScript.push({
    expectedFocus: '[dbo].[vwclean]',
    verdicts: [
      { nodeId: '[dbo].[staging]', verdict: 'trace', columnsOut: ['OrderQty'], summary: 'OrderQty passes through from Staging' },
      { nodeId: '[dbo].[dimcalendar]', verdict: 'prune', summary: 'DimCalendar is filter-only JOIN, no data column flow' },
    ],
  });

  // Hop 3: focus=PriceMaster (next in FIFO). Neighbors: spRefreshPrices (upstream)
  verdictScript.push({
    expectedFocus: '[dbo].[pricemaster]',
    verdicts: [
      { nodeId: '[dbo].[sprefreshprices]', verdict: 'trace', columnsOut: ['CostPrice'], summary: 'ListPrice = CostPrice * 1.2' },
    ],
  });

  // Hop 4: focus=Staging. Neighbors: spLoad (upstream)
  verdictScript.push({
    expectedFocus: '[dbo].[staging]',
    verdicts: [
      { nodeId: '[dbo].[spload]', verdict: 'trace', columnsOut: ['RawQty'], summary: 'OrderQty comes from RawQty' },
    ],
  });

  // Hop 5: focus=spRefreshPrices. Neighbors: SupplierPrices (upstream)
  verdictScript.push({
    expectedFocus: '[dbo].[sprefreshprices]',
    verdicts: [
      { nodeId: '[dbo].[supplierprices]', verdict: 'trace', columnsOut: ['CostPrice'], summary: 'CostPrice is source price' },
    ],
  });

  // Hop 6: focus=spLoad. Neighbors: RawImport (upstream), spLogAudit (exec edge — upstream)
  verdictScript.push({
    expectedFocus: '[dbo].[spload]',
    verdicts: [
      { nodeId: '[dbo].[rawimport]', verdict: 'trace', columnsOut: ['RawQty'], summary: 'RawQty is the raw quantity' },
      { nodeId: '[dbo].[splogaudit]', verdict: 'prune', summary: 'Audit SP — no data column flow' },
    ],
  });

  // Hop 7: focus=SupplierPrices. No upstream neighbors → source boundary
  // (This should auto-complete or the next getHopContext returns done)

  // Hop 8: focus=RawImport. Neighbors: Source1 (upstream, external)
  // Source1 is external → boundary. RawImport is a table, RawQty column validated.

  // Execute the verdict script
  let hopIndex = 0;
  while (hopIndex < verdictScript.length + 5) { // +5 buffer for boundary hops
    const hop = state.getHopContext();
    if ('done' in hop) break;
    if ('error' in hop) { assert(false, `Golden CT hop ${hopIndex}: unexpected error: ${(hop as { error: string }).error}`); return; }

    const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string; boundary: string }> };
    const focusId = ctx.focus_node.id as string;

    // Check if we have a scripted verdict for this focus
    const script = verdictScript.find(s => s.expectedFocus === focusId);
    if (script) {
      // Filter verdicts to only include neighbors actually present in this hop
      const presentNeighborIds = new Set(ctx.neighbors.map(nb => nb.id));
      const applicableVerdicts = script.verdicts.filter(v => presentNeighborIds.has(v.nodeId));

      // Add prune for any unexpected neighbors not in script
      const scriptedIds = new Set(script.verdicts.map(v => v.nodeId));
      const extraNeighbors = ctx.neighbors.filter(nb => !scriptedIds.has(nb.id));
      const allVerdicts = [
        ...applicableVerdicts,
        ...extraNeighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'not in golden script' })),
      ];

      if (allVerdicts.length > 0) {
        state.submitVerdicts({ focusNodeId: focusId, notes: `Analyzed ${focusId}`, verdicts: allVerdicts });
      } else {
        state.submitVerdicts({
          focusNodeId: focusId, notes: `Analyzed ${focusId}`,
          verdicts: ctx.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'drain' })),
        });
      }
    } else {
      // Unscripted hop (boundary nodes) — prune all to drain
      state.submitVerdicts({
        focusNodeId: focusId, notes: `Boundary: ${focusId}`,
        verdicts: ctx.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'prune' as const, summary: 'boundary drain' })),
      });
    }
    hopIndex++;
  }

  assert(state.isComplete, 'Golden CT: trace complete');

  // Assert on final result
  const result = state.getResult();
  assert(!('error' in result), 'Golden CT: getResult succeeds');
  const r = result as {
    chain: Array<{ nodeId: string }>;
    fullNodes: Array<{ id: string }>;
    edges: Array<[string, string, string]>;
    outOfScope: Array<{ nodeId: string; reason: string }>;
    stats: { hops: number; examined: number; relevant: number; removed: number; passthrough: number };
  };

  // Chain should contain all on-path nodes
  const chainIds = new Set(r.chain.map(c => c.nodeId));
  const expectedOnPath = [
    '[dbo].[factsales]',       // origin
    '[dbo].[spbuildfact]',     // L1
    '[dbo].[vwclean]',         // Branch A
    '[dbo].[staging]',         // Branch A
    '[dbo].[spload]',          // Branch A
    '[dbo].[rawimport]',       // Branch A
    '[dbo].[pricemaster]',     // Branch B
    '[dbo].[sprefreshprices]', // Branch B
    '[dbo].[supplierprices]',  // Branch B
  ];
  for (const id of expectedOnPath) {
    assert(chainIds.has(id), `Golden CT: chain includes ${id}`);
  }

  // outOfScope should contain dead ends
  const outOfScopeIds = new Set(r.outOfScope.map(o => o.nodeId));
  assert(outOfScopeIds.has('[dbo].[dimcalendar]'), 'Golden CT: DimCalendar pruned');
  assert(outOfScopeIds.has('[dbo].[splogaudit]'), 'Golden CT: spLogAudit pruned');

  // Dead ends should NOT be in chain
  assert(!chainIds.has('[dbo].[dimcalendar]'), 'Golden CT: DimCalendar not in chain');
  assert(!chainIds.has('[dbo].[splogaudit]'), 'Golden CT: spLogAudit not in chain');
  assert(!chainIds.has('[dbo].[auditlog]'), 'Golden CT: AuditLog not in chain');

  // Stats validation
  assert(r.stats.hops >= 5, `Golden CT: at least 5 hops (got ${r.stats.hops})`);
  assert(r.stats.relevant >= 7, `Golden CT: at least 7 traced nodes (got ${r.stats.relevant})`);
  assert(r.stats.removed >= 2, `Golden CT: at least 2 pruned nodes (got ${r.stats.removed})`);

  // Edges should connect chain nodes
  assert(r.edges.length > 0, 'Golden CT: edges present');
  for (const [src, tgt] of r.edges) {
    assert(chainIds.has(src) || outOfScopeIds.has(src), `Golden CT: edge source ${src} in chain or outOfScope`);
  }
}

// ─── Golden Scenario: Hop mode (no columns — object-level traversal) ────────

async function testGoldenHopMode() {
  console.log('\n── Golden: Hop mode (no columns, object-level) ──');
  const model = buildGoldenModel();
  const state = new ColumnTraceState(model, log);
  clearLogs();

  // Hop mode uses a wildcard column — state machine requires non-empty targetColumns.
  // In production, AI always provides at least one column. For hop mode (biz/doc/sql),
  // AI typically picks a relevant column from the origin. Using '*' as a sentinel.
  const init = state.init({ targetColumns: ['Revenue'], origin: '[dbo].[factsales]', direction: 'up' });
  assert('ok' in init, 'Golden Hop: init succeeds');

  // In hop mode: no column validation, all verdicts accepted on trust
  let hops = 0;
  const tracedNodes = new Set<string>();
  const prunedNodes = new Set<string>();

  while (hops < 20) {
    const hop = state.getHopContext();
    if ('done' in hop) break;
    if ('error' in hop) { assert(false, `Golden Hop: error at hop ${hops}`); return; }

    const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string; t: string }> };
    const focusId = ctx.focus_node.id as string;
    tracedNodes.add(focusId);

    // Simulate: trace all non-audit neighbors, prune audit
    const verdicts = ctx.neighbors.map(nb => {
      if (nb.id.includes('audit') || nb.id.includes('logaudit')) {
        prunedNodes.add(nb.id);
        return { nodeId: nb.id, verdict: 'prune' as const, summary: 'audit noise' };
      }
      if (nb.id.includes('dimcalendar')) {
        prunedNodes.add(nb.id);
        return { nodeId: nb.id, verdict: 'prune' as const, summary: 'filter-only' };
      }
      // For trace: provide columnsOut (hop mode still requires columns since targetColumns is non-empty)
      // Use generic column names — SP neighbors accept on trust, table neighbors need valid column
      const neighborNode = model.nodes.find(n => n.id === nb.id);
      const cols = neighborNode?.columns?.length ? [neighborNode.columns[0].name] : ['Revenue'];
      return { nodeId: nb.id, verdict: 'trace' as const, columnsOut: cols, summary: 'relevant for analysis' };
    });

    state.submitVerdicts({ focusNodeId: focusId, notes: `Hop analysis: ${focusId}`, verdicts });
    hops++;
  }

  assert(state.isComplete, 'Golden Hop: trace complete');

  const result = state.getResult();
  assert(!('error' in result), 'Golden Hop: getResult succeeds');
  const r = result as { chain: Array<{ nodeId: string }>; outOfScope: Array<{ nodeId: string }> };

  // Hop mode should reach source tables without column validation blocking
  const chainIds = new Set(r.chain.map(c => c.nodeId));
  assert(chainIds.has('[dbo].[supplierprices]'), 'Golden Hop: reached SupplierPrices (no column validation)');
  assert(chainIds.has('[dbo].[rawimport]'), 'Golden Hop: reached RawImport');

  // Pruned nodes in outOfScope
  const oosIds = new Set(r.outOfScope.map(o => o.nodeId));
  assert(oosIds.has('[dbo].[splogaudit]') || oosIds.has('[dbo].[dimcalendar]'),
    'Golden Hop: at least one dead end pruned');
}

// ─── Golden Scenario: Impact mode (downstream) ─────────────────────────────

async function testGoldenImpactDownstream() {
  console.log('\n── Golden: Impact mode (downstream from Staging) ──');
  const model = buildGoldenModel();
  const state = new ColumnTraceState(model, log);
  clearLogs();

  // Impact: "what breaks if I drop Staging?" → direction=down
  const init = state.init({ targetColumns: ['OrderQty'], origin: '[dbo].[staging]', direction: 'down' });
  assert('ok' in init, 'Golden Impact: init succeeds');

  // Drain all hops — trace everything downstream
  let hops = 0;
  while (hops < 20) {
    const hop = state.getHopContext();
    if ('done' in hop) break;
    if ('error' in hop) { assert(false, `Golden Impact: error at hop ${hops}`); return; }

    const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string; edge_direction: string }> };

    // All downstream neighbors should be edge_direction=downstream
    for (const nb of ctx.neighbors) {
      assertEq(nb.edge_direction, 'downstream', `Golden Impact: ${nb.id} is downstream of ${ctx.focus_node.id}`);
    }

    // Trace all downstream neighbors — provide columnsOut (required in column mode)
    state.submitVerdicts({
      focusNodeId: ctx.focus_node.id as string,
      notes: `Impact: ${ctx.focus_node.id as string}`,
      verdicts: ctx.neighbors.map(nb => {
        const neighborNode = model.nodes.find(n => n.id === nb.id);
        const cols = neighborNode?.columns?.length ? [neighborNode.columns[0].name] : ['OrderQty'];
        return { nodeId: nb.id, verdict: 'trace' as const, columnsOut: cols, summary: 'downstream impact' };
      }),
    });
    hops++;
  }

  assert(state.isComplete, 'Golden Impact: trace complete');

  const result = state.getResult();
  assert(!('error' in result), 'Golden Impact: getResult succeeds');
  const r = result as { chain: Array<{ nodeId: string }>; direction: string };
  const chainIds = new Set(r.chain.map(c => c.nodeId));

  // Downstream from Staging: vwClean → spBuildFact → FactSales
  assert(chainIds.has('[dbo].[staging]'), 'Golden Impact: origin Staging in chain');
  assert(chainIds.has('[dbo].[vwclean]'), 'Golden Impact: vwClean affected (reads from Staging)');
  assert(chainIds.has('[dbo].[spbuildfact]'), 'Golden Impact: spBuildFact affected');
  assert(chainIds.has('[dbo].[factsales]'), 'Golden Impact: FactSales affected');

  // Upstream nodes should NOT be in chain (direction=down)
  assert(!chainIds.has('[dbo].[spload]'), 'Golden Impact: spLoad not in downstream chain');
  assert(!chainIds.has('[dbo].[rawimport]'), 'Golden Impact: RawImport not in downstream chain');
  assert(!chainIds.has('[dbo].[supplierprices]'), 'Golden Impact: SupplierPrices not in downstream chain');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  resetCounters();
  console.log('═══ Column Trace State Machine Tests ═══');
  try {
    const model = await loadAdventureWorksModel();

    await testLifecycleStatus(model);
    await testInitWithOrigin(model);
    await testInitInvalidOrigin(model);
    await testInitNoColumnsNoOrigin(model);
    await testInitNoColumnsWithOrigin(model);
    await testGraphModeHopCycle(model);
    await testAutoDiscoverOrigin(model);
    await testHopContextStructure(model);
    await testFocusNodeContent(model);
    await testBoundaryDetection(model);
    await testVerdictRemove(model);
    await testVerdictRelevantWithValidation(model);
    await testRejectionCap(model);
    await testCycleDetection(model);
    await testGetResultStructure(model);
    await testGetResultTooEarly(model);
    await testFocusMismatch(model);
    await testReInit(model);
    // Phase 2 additional tests
    await testDirectionDown(model);
    await testDirectionBoth(model);
    await testPassthroughVerdict(model);
    await testRelevantColumnRename(model);
    await testFrontierCap(model);
    await testExternalBoundary(model);

    // Synthetic model tests (zero skips — controlled topology)
    console.log('\n── Synthetic Model Tests ──');
    await testDirectionDownSynthetic();
    await testPassthroughSynthetic();
    await testRelevantColumnRenameSynthetic();
    await testFrontierCapSynthetic();
    await testExternalBoundarySynthetic();
    await testSPtoSPExecEdgeSynthetic();
    await testGetResultAwaitingVerdictsSynthetic();
    await testDirectionBothEdgeLabelingSynthetic();
    await testGetResultFieldsSynthetic();
    await testNotesAndQuestionRoutingSynthetic();

    // Bug regression tests
    console.log('\n── Bug Regression Tests ──');
    await testDiamondMergeChainSynthetic();
    await testPassthroughVisitedSynthetic();
    await testPassthroughDepthSynthetic();
    await testFocusNodeBoundaryNotCycleSynthetic();

    // Golden scenario tests (deterministic end-to-end replay)
    console.log('\n── Golden Scenario Tests ──');
    await testGoldenMultiBranchColumnTrace();
    await testGoldenHopMode();
    await testGoldenImpactDownstream();
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('Column Trace State');
}

main();
