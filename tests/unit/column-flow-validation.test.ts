/**
 * Unit tests for `column_flow` validation and CT-mode guards in NavigationEngine.
 *
 * Covers: column_flow_required, prune exemption, out_col/from_node/from_col
 * structural rejection, edge accumulation, filter_only exclusion,
 * activeModeOf CT discriminator, and supplementAgenda CT propagation.
 */

import { NavigationEngine } from '../../src/ai/smBase';
import { activeModeOf } from '../../src/ai/toolPolicy';
import type { DatabaseModel, LineageNode } from '../../src/engine/types';
import { assert, resetCounters, printSummary, makeGraph } from './helpers/testUtils';

console.log('Column Flow Validation');
console.log('='.repeat(40));
resetCounters();

// ─── Shared graph: origin_view (view) ← base_table (table) ──────────────────
// origin_view.amount derives from base_table.raw_amount.
const originNode: LineageNode = {
  id: 'origin',
  schema: 'dbo',
  name: 'origin_view',
  type: 'view',
  columns: [
    { name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' },
    { name: 'region', type: 'nvarchar(50)', nullable: 'NULL', extra: '' },
  ],
};

const baseTable: LineageNode = {
  id: 'base_table',
  schema: 'dbo',
  name: 'base_table',
  type: 'table',
  columns: [
    { name: 'raw_amount', type: 'int', nullable: 'NOT NULL', extra: '' },
  ],
};

const nodes: LineageNode[] = [originNode, baseTable];
const edgePairs: Array<[string, string]> = [['base_table', 'origin']];
const model: DatabaseModel = {
  nodes,
  edges: edgePairs.map(([s, t]) => ({ source: s, target: t, type: 'SELECT' })),
  schemas: ['dbo'],
  dbPlatform: 'SQL Server',
};
const graph = makeGraph(nodes, edgePairs);

/** Convenience: init a CT engine and advance to awaiting_findings at origin. */
function ctEngine(targetColumns = ['amount']) {
  const engine = new NavigationEngine(model, graph, () => {}, {});
  engine.init({ origin: 'origin', question: 'test', direction: 'upstream', targetColumns });
  engine.getHopContext();
  return engine;
}

// ── Test 1: column_flow_required fires for verdict=analyze without column_flow ──
{
  const engine = ctEngine();
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
  });
  assert('error' in result && result.error === 'column_flow_required', 'column_flow_required on analyze');
}

// ── Test 2: column_flow_required fires for verdict=pass without column_flow ──
{
  const engine = ctEngine();
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'pass',
  });
  assert('error' in result && result.error === 'column_flow_required', 'column_flow_required on pass');
}

// ── Test 3: prune is allowed without column_flow in CT mode ──
{
  const engine = ctEngine();
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [],
    summary: 'pruned',
    verdict: 'prune',
  });
  // prune on the origin node is rejected (origin cannot be pruned — it would orphan itself)
  // so we check for any error that is NOT column_flow_required
  assert(!('error' in result && result.error === 'column_flow_required'), 'prune does not trigger column_flow_required');
}

// ── Test 4: out_col not in active_columns → route_validation_failed ──
{
  const engine = ctEngine(['amount']); // active = ['amount']
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{ out_col: 'wrong_col', contributors: [] }],
  });
  assert('error' in result && result.error === 'route_validation_failed', 'out_col not in active_columns → route_validation_failed');
  if ('error' in result && 'detail' in result) {
    const detail = JSON.stringify(result.detail);
    assert(detail.includes('column_flow_invalid'), 'detail contains column_flow_invalid');
    assert(detail.includes('wrong_col'), 'detail names the offending out_col');
  }
}

// ── Test 5: out_col in active_columns but not on focus node → route_validation_failed ──
{
  // init with a column NOT in origin_view.columns
  const engine = ctEngine(['missing_col']);
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{ out_col: 'missing_col', contributors: [] }],
  });
  assert('error' in result && result.error === 'route_validation_failed', 'out_col not on node → route_validation_failed');
  if ('error' in result && 'detail' in result) {
    const detail = JSON.stringify(result.detail);
    assert(detail.includes('column_flow_validation_failed'), 'detail contains column_flow_validation_failed');
  }
}

// ── Test 6: contributor from_node not in graph → route_validation_failed ──
{
  const engine = ctEngine(['amount']);
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{
      out_col: 'amount',
      contributors: [{ from_node: 'nonexistent_table', from_col: 'any_col', role: 'formula' as const }],
    }],
  });
  assert('error' in result && result.error === 'route_validation_failed', 'from_node not in graph → route_validation_failed');
  if ('error' in result) {
    const ids = 'unresolved_route_target_ids' in result ? result.unresolved_route_target_ids : undefined;
    assert(Array.isArray(ids) && ids.includes('nonexistent_table'), 'unresolved_route_target_ids includes nonexistent_table');
  }
}

// ── Test 7: contributor from_col not on from_node → route_validation_failed ──
{
  const engine = ctEngine(['amount']);
  // base_table only has 'raw_amount' — 'wrong_col' does not exist
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{
      out_col: 'amount',
      contributors: [{ from_node: 'base_table', from_col: 'wrong_col', role: 'formula' as const }],
    }],
  });
  assert('error' in result && result.error === 'route_validation_failed', 'from_col not on from_node → route_validation_failed');
  if ('error' in result && 'detail' in result) {
    const detail = JSON.stringify(result.detail);
    assert(detail.includes('column_flow_validation_failed'), 'detail contains column_flow_validation_failed for from_col');
  }
}

// ── Test 8: valid column_flow accumulates edge; filter_only contributor excluded ──
{
  const engine = ctEngine(['amount']);
  const result = engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{
      out_col: 'amount',
      contributors: [
        { from_node: 'base_table', from_col: 'raw_amount', role: 'formula' as const },
        { from_node: 'base_table', from_col: 'raw_amount', role: 'filter_only' as const },
      ],
    }],
  });
  assert('ok' in result && result.ok === true, 'valid column_flow accepted');
  const edges = engine.columnAspect?.edges ?? [];
  assert(edges.length === 1, 'one edge accumulated (filter_only excluded)');
  assert(edges[0]?.role === 'formula', 'accumulated edge role is formula');
  assert(edges[0]?.from_node === 'base_table', 'accumulated edge from_node is base_table');
  assert(edges[0]?.to_col === 'amount', 'accumulated edge to_col is amount');
}

// ── Test 9: activeModeOf — CT presence selects the SM-CT tool scope ──
// Replaces the deleted shouldSmInline check. The two-state model has no inline
// execution mode; CT activation is now expressed mechanically via the ActiveMode
// discriminator (sm_ct), which gates the per-hop tool set in toolPolicy.
{
  assert(activeModeOf(true) === 'sm_ct', 'activeModeOf(hasColumnAspect=true) === sm_ct');
  assert(activeModeOf(false) === 'sm_bb', 'activeModeOf(hasColumnAspect=false) === sm_bb');
}

// ── Test 10: supplementAgenda with CT — supplemented node inherits target_columns ──
{
  // Graph: origin_view (view) upstream of another view
  const secondView: LineageNode = {
    id: 'second_view',
    schema: 'dbo',
    name: 'second_view',
    type: 'view',
    columns: [{ name: 'amount', type: 'int', nullable: 'NOT NULL', extra: '' }],
  };
  const n2: LineageNode[] = [originNode, baseTable, secondView];
  const e2: Array<[string, string]> = [['base_table', 'origin'], ['base_table', 'second_view']];
  const m2: DatabaseModel = {
    nodes: n2,
    edges: e2.map(([s, t]) => ({ source: s, target: t, type: 'SELECT' })),
    schemas: ['dbo'],
    dbPlatform: 'SQL Server',
  };
  const g2 = makeGraph(n2, e2);

  const engine = new NavigationEngine(m2, g2, () => {}, {});
  engine.init({ origin: 'origin', question: 'trace amount', direction: 'upstream', targetColumns: ['amount'] });

  // Drain the single hop (origin only — second_view is not upstream of origin in a strict BFS)
  engine.getHopContext();
  engine.submitFindings({
    focus_node_id: 'origin',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{
      out_col: 'amount',
      contributors: [{ from_node: 'base_table', from_col: 'raw_amount', role: 'formula' as const }],
    }],
  });
  // SM mode signals completion via getHopContext() draining the empty agenda
  const doneCtx = engine.getHopContext();
  assert(doneCtx.done === true, 'exploration completed (done=true)');

  // Supplement with second_view
  const suppResult = engine.supplementAgenda(['second_view']);
  assert('ok' in suppResult && suppResult.ok === true, 'supplementAgenda ok');

  // Advance to second_view hop and verify active_columns = target_columns
  engine.getHopContext();
  const r2 = engine.submitFindings({
    focus_node_id: 'second_view',
    sections: [{ angle: 'business' as const, text: 'ok' }],
    summary: 'ok',
    verdict: 'analyze',
    column_flow: [{
      out_col: 'amount',
      contributors: [{ from_node: 'base_table', from_col: 'raw_amount', role: 'formula' as const }],
    }],
  });
  // column_flow accepted confirms active_columns was set to ['amount'] from supplement
  assert(!('error' in r2 && r2.error === 'column_flow_required'), 'supplement node has column context (no column_flow_required)');
  const diag = engine.getHopDiagnostics();
  assert(diag.activeColumnCount === 1, 'supplemented node has activeColumnCount=1');
}

printSummary('Column Flow Validation');
