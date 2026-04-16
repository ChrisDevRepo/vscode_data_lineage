/**
 * Unit tests for NavigationEngine — the unified "Map & Router" state machine.
 * Validates:
 * - Unification of BB/CT modes.
 * - Incremental Blackboard (Short Memory) updates.
 * - Selection-Inference Routing (Metadata-Guarded sub-questions).
 * - Lifecycle, Coverage, and Termination.
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
const clearLogs = () => { logs.length = 0; };

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
  const engine = new NavigationEngine(model, buildBareGraph(model), log, 'blackboard', {});

  assertEq(engine.status, 'created', 'Initial status');
  
  const init = engine.init({ question: 'Test', origin: '[dbo].[sptransform]' });
  assert('ok' in init, 'Init ok');
  assertEq(engine.status, 'initialized', 'Status after init');

  const hop = engine.getHopContext();
  assertEq(engine.status, 'awaiting_findings', 'Status in hop');

  engine.submitFindings({
    focusNodeId: (hop as any).focus_node.id,
    narrative_update: 'Start.',
    detail_analysis: 'Detail.',
    summary: 'Sum.',
    verdict: 'relevant'
  });
  assertEq(engine.status, 'exploring', 'Status after submission');
}

// ─── Memory & Blackboard Tests ───────────────────────────────────────────────

async function testIncrementalBlackboard() {
  console.log('\n── Incremental Blackboard ──');
  const model = buildSyntheticModel();
  const engine = new NavigationEngine(model, buildBareGraph(model), log, 'blackboard', {});
  engine.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  // Hop 1
  const hop1 = engine.getHopContext() as any;
  engine.submitFindings({
    focusNodeId: hop1.focus_node.id,
    narrative_update: 'Insight Alpha.',
    detail_analysis: 'Deep evidence.',
    summary: 'Sum 1',
    verdict: 'relevant'
  });

  // Hop 2
  const hop2 = engine.getHopContext() as any;
  assertEq(hop2.working_memory.blackboard, 'Insight Alpha.', 'Hop 2 receives previous Blackboard');
  
  engine.submitFindings({
    focusNodeId: hop2.focus_node.id,
    narrative_update: 'Insight Alpha + Beta.',
    detail_analysis: 'Deep evidence.',
    summary: 'Sum 2',
    verdict: 'relevant'
  });

  // Hop 3
  const hop3 = engine.getHopContext() as any;
  assertEq(hop3.working_memory.blackboard, 'Insight Alpha + Beta.', 'Hop 3 receives updated Blackboard');
}

// ─── Selection-Inference Routing Tests ───────────────────────────────────────

async function testSelectionInferenceValidation() {
  console.log('\n── Selection-Inference Validation ──');
  const model = buildSyntheticModel();
  const engine = new NavigationEngine(model, buildBareGraph(model), log, 'blackboard', {});
  engine.init({ question: 'Test', origin: '[dbo].[vwclean]' });

  const hop = engine.getHopContext() as any;
  
  // Submit with hallucinated column in neighbor
  const badResult = engine.submitFindings({
    focusNodeId: hop.focus_node.id,
    narrative_update: 'Update.',
    detail_analysis: 'Detail.',
    summary: 'Sum.',
    verdict: 'relevant',
    route_requests: [{
      nodeId: '[staging].[rawdata]',
      question: 'Check bad col',
      columns: ['NON_EXISTENT_COL']
    }]
  });

  assert('error' in badResult && badResult.error === 'route_validation_failed', 'Hallucinated column rejected');
  assertEq(engine.status, 'awaiting_findings', 'Engine stays awaiting findings after rejection');

  // Submit with valid column
  const goodResult = engine.submitFindings({
    focusNodeId: hop.focus_node.id,
    narrative_update: 'Update.',
    detail_analysis: 'Detail.',
    summary: 'Sum.',
    verdict: 'relevant',
    route_requests: [{
      nodeId: '[staging].[rawdata]',
      question: 'Check valid col',
      columns: ['Amount']
    }]
  });
  assert('ok' in goodResult, 'Valid column routing accepted');
}

// ─── Map & Topology Tests ───────────────────────────────────────────────────

async function testTopologicalMap() {
  console.log('\n── Topological Map ──');
  const model = buildSyntheticModel();
  const engine = new NavigationEngine(model, buildBareGraph(model), log, 'blackboard', {});
  // Use vwClean — has upstream neighbors (staging.RawData, spTransform)
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
  const bb = new NavigationEngine(model, buildBareGraph(model), log, 'blackboard', {});
  bb.init({ question: 'BB Test', origin: '[dbo].[factsales]' });
  assertEq((bb as any).mode, 'blackboard', 'Engine in blackboard mode');

  // Column Trace mode
  const ct = new NavigationEngine(model, buildBareGraph(model), log, 'column_trace', {});
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
    await testIncrementalBlackboard();
    await testSelectionInferenceValidation();
    await testTopologicalMap();
    await testModes();
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('Navigation Engine');
}

main();
