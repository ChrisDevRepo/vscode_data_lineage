/**
 * Unit tests for NavigationEngine — the unified state machine.
 * Validates:
 * - Unification of BB/CT modes.
 * - Per-hop `all_summaries` delivery (every prior finding surfaced automatically).
 * - Column-trace route validation (metadata-guarded sub-questions).
 * - Lifecycle, coverage, and termination.
 */

import Graph from 'graphology';
import { assert, assertEq, printSummary, resetCounters } from './helpers/testUtils';
import { NavigationEngine } from '../../src/ai/smBase';
import type { DatabaseModel, LineageNode, LineageEdge, NeighborIndex } from '../../src/engine/types';

function buildBareGraph(model: DatabaseModel): Graph {
  const g = new Graph({ type: 'directed', multi: false });
  for (const n of model.nodes) g.addNode(n.id, { type: n.type, schema: n.schema });
  for (const e of model.edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target) && !g.hasEdge(e.source, e.target)) {
      g.addEdge(e.source, e.target, { type: e.type });
    }
  }
  return g;
}

const logs: string[] = [];
const log = (level: string, msg: string) => { logs.push(`[${level}] ${msg}`); };

// ─── Synthetic Model ────────────────────────────────────────────────────────

function buildSyntheticModel(): DatabaseModel {
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

// ─── Lifecycle & Status Tests ───────────────────────────────────────────────

async function testLifecycle() {
  console.log('\n── Lifecycle & Status ──');
  const model = buildSyntheticModel();
  const engine = new NavigationEngine(model, buildBareGraph(model), log, 'blackboard', { qualityGuards: false });

  assertEq(engine.status, 'created', 'Initial status');
  
  engine.init({ question: 'Test', origin: '[dbo].[sptransform]' });
  assertEq(engine.status, 'initialized', 'Status after init');

  const hop = engine.getHopContext();
  assertEq(engine.status, 'awaiting_findings', 'Status in hop');

  const result = engine.submitFindings({
    focus_node_id: hop.focus_node.id,
    detail_analysis: 'Detail.',
    summary: 'Sum.',
    verdict: 'relevant'
  });
  assert('ok' in result, 'Submission success');
  assertEq(engine.status, 'exploring', 'Status after submission');
}

// ─── Memory Delivery Tests ──────────────────────────────────────────────────

async function testAllSummariesDelivery() {
  console.log('\n── All-Summaries Delivery ──');
  const model = buildSyntheticModel();
  const engine = new NavigationEngine(model, buildBareGraph(model), log, 'blackboard', { qualityGuards: false });
  engine.init({ question: 'Test question', origin: '[dbo].[sptransform]' });

  // Hop 1 (origin)
  const hop1 = engine.getHopContext() as any;
  assertEq(hop1.working_memory.user_question, 'Test question', 'Hop 1 echoes user question');
  assertEq(hop1.working_memory.all_summaries.length, 0, 'Hop 1 starts with empty all_summaries');
  engine.submitFindings({
    focus_node_id: hop1.focus_node.id,
    detail_analysis: 'Deep evidence for origin.',
    summary: 'Insight Alpha',
    verdict: 'relevant',
  });

  // Hop 2 — should see hop 1's summary
  const hop2 = engine.getHopContext() as any;
  assertEq(hop2.working_memory.all_summaries.length, 1, 'Hop 2 sees 1 prior summary');
  assertEq(hop2.working_memory.all_summaries[0].summary, 'Insight Alpha', 'Hop 2 receives hop 1 summary verbatim');
  engine.submitFindings({
    focus_node_id: hop2.focus_node.id,
    detail_analysis: 'Deep evidence.',
    summary: 'Insight Beta',
    verdict: 'relevant',
  });

  // Hop 3 — should see hops 1 + 2
  const hop3 = engine.getHopContext() as any;
  assertEq(hop3.working_memory.all_summaries.length, 2, 'Hop 3 sees 2 prior summaries (cumulative)');
  assertEq(hop3.working_memory.all_summaries[1].summary, 'Insight Beta', 'Hop 3 sees hop 2 summary in order');
}

// ─── Column-Trace Route Validation ──────────────────────────────────────────

async function testColumnTraceRouteValidation() {
  console.log('\n── Column-Trace Route Validation ──');
  const model = buildSyntheticModel();
  const engine = new NavigationEngine(model, buildBareGraph(model), log, 'column_trace', { qualityGuards: false });
  engine.init({ question: 'Trace', origin: '[dbo].[vwclean]', targetColumns: ['OrderAmount'] });

  const hop = engine.getHopContext() as any;

  // Hallucinated column on the target neighbor
  const badResult = engine.submitFindings({
    focus_node_id: hop.focus_node.id,
    detail_analysis: 'Detail.',
    summary: 'Sum.',
    verdict: 'relevant',
    route_requests: [{
      nodeId: '[staging].[rawdata]',
      question: 'Check bad col',
      columns: ['NON_EXISTENT_COL'],
    }],
  });
  assert('error' in badResult && badResult.error === 'route_validation_failed', 'Hallucinated column rejected');
  assertEq(engine.status, 'awaiting_findings', 'Engine stays awaiting findings after rejection');

  // Valid column succeeds
  const goodResult = engine.submitFindings({
    focus_node_id: hop.focus_node.id,
    detail_analysis: 'Detail.',
    summary: 'Sum.',
    verdict: 'relevant',
    route_requests: [{
      nodeId: '[staging].[rawdata]',
      question: 'Check valid col',
      columns: ['Amount'],
    }],
  });
  assert('ok' in goodResult, 'Valid column routing accepted');
}

// ─── Blackboard Drops Columns ──────────────────────────────────────────────

async function testBlackboardDropsColumns() {
  console.log('\n── Blackboard Drops route_requests.columns ──');
  const model = buildSyntheticModel();
  const engine = new NavigationEngine(model, buildBareGraph(model), log, 'blackboard', { qualityGuards: false });
  engine.init({ question: 'Test', origin: '[dbo].[vwclean]' });
  const hop = engine.getHopContext() as any;

  // In blackboard mode `columns` is silently stripped — even a fake column passes.
  const result = engine.submitFindings({
    focus_node_id: hop.focus_node.id,
    detail_analysis: 'Detail.',
    summary: 'Sum.',
    verdict: 'relevant',
    route_requests: [{
      nodeId: '[staging].[rawdata]',
      question: 'Check',
      columns: ['NON_EXISTENT_COL'],
    }],
  });
  assert('ok' in result, 'Blackboard mode ignores columns — no validation error');
}

// ─── Map & Topology Tests ───────────────────────────────────────────────────

async function testTopologicalMap() {
  console.log('\n── Topological Map ──');
  const model = buildSyntheticModel();
  const engine = new NavigationEngine(model, buildBareGraph(model), log, 'blackboard', { qualityGuards: false });
  // Use vwClean — has neighbors
  engine.init({ question: 'Test', origin: '[dbo].[vwclean]' });

  const hop1 = engine.getHopContext() as any;
  assert(hop1.working_memory.topological_map.visited_nodes.includes('[dbo].[vwclean]'), 'Origin in visited');
  assertEq(hop1.working_memory.topological_map.current_focus, hop1.focus_node.id, 'Current focus in map');
  assert(hop1.working_memory.topological_map.agenda.length > 0, 'Agenda populated in map');
}

// ─── Unification Mode Tests ──────────────────────────────────────────────────

async function testModes() {
  console.log('\n── Unification Modes ──');
  const model = buildSyntheticModel();
  
  // Blackboard mode
  const bb = new NavigationEngine(model, buildBareGraph(model), log, 'blackboard', { qualityGuards: false });
  bb.init({ question: 'BB Test', origin: '[dbo].[factsales]' });
  assertEq((bb as any).mode, 'blackboard', 'Engine in blackboard mode');

  // Column Trace mode
  const ct = new NavigationEngine(model, buildBareGraph(model), log, 'column_trace', { qualityGuards: false });
  ct.init({ question: 'CT Test', origin: '[dbo].[factsales]', targetColumns: ['Revenue'] });
  assertEq((ct as any).mode, 'column_trace', 'Engine in column_trace mode');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  resetCounters();
  console.log('════════════════════════════════════════════════════════');
  console.log('  Navigation Engine Unified Tests');
  console.log('════════════════════════════════════════════════════════');

  try {
    await testLifecycle();
    await testAllSummariesDelivery();
    await testColumnTraceRouteValidation();
    await testBlackboardDropsColumns();
    await testTopologicalMap();
    await testModes();
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('Navigation Engine');
}

main();
