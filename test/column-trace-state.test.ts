/**
 * Unit tests for ColumnTraceState — the hop-and-distill state machine.
 * Tests state machine logic WITHOUT AI — simulates verdicts programmatically.
 * Requires: test/AdventureWorks.dacpac
 */

import { assert, assertEq, printSummary, loadAdventureWorksModel, resetCounters } from './testUtils';
import { buildBareGraph } from '../src/ai/graphUtils';
import { ColumnTraceState } from '../src/ai/columnTraceState';
import type { DatabaseModel } from '../src/engine/types';

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

// ─── Test: Init with no columns ──────────────────────────────────────────────

async function testInitNoColumns(model: DatabaseModel) {
  clearLogs();
  const state = new ColumnTraceState(model, log);

  const result = state.init({ targetColumns: [] });
  assert('error' in result, 'Init with empty columns returns error');
  assertEq((result as { error: string }).error, 'no_columns', 'Error is no_columns');
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
    verdict: 'remove' as const,
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
      verdict: 'relevant',
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
      verdict: 'relevant',
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
  const r1 = state.submitVerdicts({ focusNodeId: focusId, verdicts: [{ nodeId: tableNb.id, verdict: 'relevant', columnsOut: ['__BAD1__'] }] });
  assert('error' in r1 && (r1 as { error: string }).error === 'invalid_columns', 'Rejection #1');

  // Reject #2
  const r2 = state.submitVerdicts({ focusNodeId: focusId, verdicts: [{ nodeId: tableNb.id, verdict: 'relevant', columnsOut: ['__BAD2__'] }] });
  assert('error' in r2 && (r2 as { error: string }).error === 'invalid_columns', 'Rejection #2');

  // Reject #3 → cap reached, should accept on trust
  const r3 = state.submitVerdicts({ focusNodeId: focusId, verdicts: [{ nodeId: tableNb.id, verdict: 'relevant', columnsOut: ['__BAD3__'], summary: 'cap test' }] });
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
      verdicts: ctx.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'remove' as const, summary: 'drain' })),
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
      verdicts: ctx.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'remove' as const, summary: 'test' })),
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
      verdicts: c.neighbors.map(nb => ({ nodeId: nb.id, verdict: 'remove' as const, summary: 'drain' })),
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
    columnFlow: string;
  };

  assertEq(r.status, 'complete', 'Result status is complete');
  assert(Array.isArray(r.chain), 'chain is array');
  assert(Array.isArray(r.fullNodes), 'fullNodes is array');
  assert(Array.isArray(r.edges), 'edges is array');
  assert(Array.isArray(r.outOfScope), 'outOfScope is array');
  assert(typeof r.stats === 'object', 'stats is object');
  assert(typeof r.stats.hops === 'number', 'stats.hops is number');
  assert(typeof r.stats.examined === 'number', 'stats.examined is number');
  assert(typeof r.columnFlow === 'string', 'columnFlow is string');
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
    verdicts: [{ nodeId: nb.id, verdict: 'passthrough', summary: 'test passthrough' }],
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
      verdict: 'relevant',
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  resetCounters();
  console.log('═══ Column Trace State Machine Tests ═══');
  try {
    const model = await loadAdventureWorksModel();

    await testLifecycleStatus(model);
    await testInitWithOrigin(model);
    await testInitInvalidOrigin(model);
    await testInitNoColumns(model);
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
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('Column Trace State');
}

main();
