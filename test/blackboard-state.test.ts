/**
 * Unit tests for BlackboardState — Type 1 free-form exploration state machine.
 * Tests state machine logic WITHOUT AI — simulates findings programmatically.
 * Uses synthetic model for deterministic tests.
 */

import Graph from 'graphology';
import { assert, assertEq, printSummary, resetCounters } from './testUtils';
import { BlackboardState } from '../src/ai/blackboardState';
import type { DatabaseModel, LineageNode, LineageEdge, NeighborIndex } from '../src/engine/types';

function buildGraphFromModel(model: DatabaseModel): Graph {
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

/**
 * 6-node model (same topology as column-trace-state tests):
 *
 *   ext.RemoteDB ─→ dbo.spLoadStaging ─exec→ dbo.spTransform
 *                        ↑                        ↓
 *                   staging.RawData ───────→ dbo.vwClean ──→ dbo.FactSales
 *                        ↑_________________________/
 */
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

// ─── Test: Lifecycle & Status ────────────────────────────────────────────────

async function testLifecycleStatus() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);

  assertEq(state.status, 'created', 'Initial status is created');

  // getHopContext before init → error
  const hop0 = state.getHopContext();
  assert('error' in hop0, 'getHopContext before init returns error');

  // submitFindings before init → error
  const sub0 = state.submitFindings({ focusNodeId: 'x', findings: 'x', summary: 'x' });
  assert('error' in sub0, 'submitFindings before init returns error');

  // getResult before init → error
  const res0 = state.getResult();
  assert('error' in res0, 'getResult before init returns error');
}

// ─── Test: Init ──────────────────────────────────────────────────────────────

async function testInitValid() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);

  const result = state.init({
    question: 'Document all business rules',
    origin: '[dbo].[sptransform]',
  });

  assert('ok' in result, 'Init succeeds');
  const r = result as { ok: true; scopeSize: number; map: { nodes: unknown[]; edges: unknown[] } };
  assert(r.scopeSize === 6, `Scope includes all 6 nodes (got ${r.scopeSize})`);
  assert(r.map.nodes.length === 6, `Map has 6 nodes (got ${r.map.nodes.length})`);
  assert(r.map.edges.length > 0, 'Map has edges');
  assertEq(state.status, 'initialized', 'Status is initialized after init');
}

async function testInitInvalidOrigin() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);

  const result = state.init({ question: 'test', origin: '[nonexistent].[table]' });
  assert('error' in result, 'Init with invalid origin returns error');
  assertEq(state.status, 'error', 'Status is error after invalid init');
}

// ─── Test: Hop Context ───────────────────────────────────────────────────────

async function testHopContextStructure() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  const hop = state.getHopContext();
  assert(!('done' in hop) && !('error' in hop), 'First hop returns context');

  const ctx = hop as {
    bb_mode: string; hop: number; focus_node: Record<string, unknown>;
    neighbors: unknown[]; current_task: string; working_memory: Record<string, unknown>;
    agenda_remaining: number;
  };

  assertEq(ctx.bb_mode, 'exploring', 'bb_mode is exploring');
  assertEq(ctx.hop, 1, 'First hop is 1');
  assert(!!ctx.focus_node.id, 'Focus node has id');
  assert(ctx.neighbors.length > 0, 'Focus node has neighbors');
  assert(ctx.current_task.length > 0, 'Has current_task');
  assert(ctx.agenda_remaining >= 0, 'Has agenda_remaining');

  // Working memory structure
  const wm = ctx.working_memory as {
    user_question: string; all_summaries: unknown[]; pending_questions: unknown[];
    checklist: { noted: number; total: number; open: number; coveragePct: number };
  };
  assertEq(wm.user_question, 'Test', 'Working memory includes user_question goal anchor');
  assertEq(wm.all_summaries.length, 0, 'No summaries initially');
  assertEq(wm.pending_questions.length, 0, 'No questions initially');
  assert(wm.checklist.total > 0, 'Checklist has total');
  assertEq(wm.checklist.noted, 0, 'No notes yet');

  assertEq(state.status, 'awaiting_findings', 'Status is awaiting_findings after getHopContext');
}

async function testFocusNodeDdl() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  // Drain until we find a procedure with DDL
  let foundDdl = false;
  for (let i = 0; i < 6; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    const ctx = hop as { focus_node: Record<string, unknown>; neighbors: unknown[] };

    if (ctx.focus_node.bb_ddl) {
      foundDdl = true;
      assert(typeof ctx.focus_node.bb_ddl === 'string', 'DDL is string');
      assert((ctx.focus_node.bb_ddl as string).length > 0, 'DDL is non-empty');
      break;
    }

    // Submit minimal findings to advance
    state.submitFindings({
      focusNodeId: ctx.focus_node.id as string,
      findings: 'test',
      summary: 'test',
    });
  }
  assert(foundDdl, 'Found a focus node with DDL');
}

async function testFocusNodeColumns() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[staging].[rawdata]' });

  // rawdata is origin (visited), so first hop is a neighbor
  // Drain until we find a table with columns
  let foundCols = false;
  for (let i = 0; i < 6; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    const ctx = hop as { focus_node: Record<string, unknown> };

    if (ctx.focus_node.cols) {
      foundCols = true;
      const cols = ctx.focus_node.cols as string[];
      assert(cols.length > 0, 'Has columns');
      // Check compact format: "Amount decimal(18,2), nullable"
      assert(cols.some(c => c.includes('decimal') || c.includes('int') || c.includes('varchar')),
        'Columns have type info');
      break;
    }

    state.submitFindings({
      focusNodeId: ctx.focus_node.id as string,
      findings: 'test', summary: 'test',
    });
  }
  assert(foundCols, 'Found a focus node with compact columns');
}

// ─── Test: Submit Findings ───────────────────────────────────────────────────

async function testSubmitFindings() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  const hop = state.getHopContext();
  assert(!('done' in hop) && !('error' in hop), 'Got hop');
  const ctx = hop as { focus_node: { id: string } };

  const result = state.submitFindings({
    focusNodeId: ctx.focus_node.id,
    findings: 'Loads data from external source into staging',
    summary: 'External→staging load',
    tags: ['transform'],
  });

  assert('ok' in result, 'submitFindings succeeds');
  assertEq(state.noteCount, 1, 'One note stored');
  assertEq(state.status, 'exploring', 'Status is exploring after submit');
}

async function testSubmitFocusMismatch() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });
  state.getHopContext();

  const result = state.submitFindings({
    focusNodeId: '[nonexistent].[x]',
    findings: 'test', summary: 'test',
  });
  assert('error' in result, 'Focus mismatch returns error');
}

async function testFindingsHardLimit() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log, { findingsHardLimit: 50 });
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  const hop = state.getHopContext();
  const ctx = hop as { focus_node: { id: string } };

  const result = state.submitFindings({
    focusNodeId: ctx.focus_node.id,
    findings: 'x'.repeat(51),
    summary: 'test',
  });
  assert('error' in result, 'Findings exceeding hard limit → error');
  assert((result as { error: string }).error === 'findings_too_long', 'Error is findings_too_long');
}

async function testSummaryHardLimit() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log, { summaryHardLimit: 20 });
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  const hop = state.getHopContext();
  const ctx = hop as { focus_node: { id: string } };

  const result = state.submitFindings({
    focusNodeId: ctx.focus_node.id,
    findings: 'test',
    summary: 'x'.repeat(21),
  });
  assert('error' in result, 'Summary exceeding hard limit → error');
  assert((result as { error: string }).error === 'summary_too_long', 'Error is summary_too_long');
}

// ─── Test: Working Memory ────────────────────────────────────────────────────

async function testWorkingMemoryGrows() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  // Hop 1: submit findings
  const hop1 = state.getHopContext();
  assert(!('done' in hop1) && !('error' in hop1), 'Hop 1 ok');
  const ctx1 = hop1 as { focus_node: { id: string } };
  state.submitFindings({
    focusNodeId: ctx1.focus_node.id,
    findings: 'First finding',
    summary: 'Summary 1',
  });

  // Hop 2: check working memory includes previous summary
  const hop2 = state.getHopContext();
  assert(!('done' in hop2) && !('error' in hop2), 'Hop 2 ok');
  const ctx2 = hop2 as { working_memory: { all_summaries: Array<{ nodeId: string; summary: string }> } };

  assertEq(ctx2.working_memory.all_summaries.length, 1, 'Working memory has 1 summary');
  assertEq(ctx2.working_memory.all_summaries[0].summary, 'Summary 1', 'Summary content matches');
}

// ─── Test: Question Queue (Self-Ask) ─────────────────────────────────────────

async function testQuestionBoostsPriority() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  const hop1 = state.getHopContext();
  assert(!('done' in hop1) && !('error' in hop1), 'Hop 1 ok');
  const ctx1 = hop1 as { focus_node: { id: string }; neighbors: Array<{ id: string }> };

  // Submit findings with a question targeting FactSales (probably deep in BFS)
  state.submitFindings({
    focusNodeId: ctx1.focus_node.id,
    findings: 'Found reference to FactSales',
    summary: 'References FactSales',
    questions: [{ nodeId: '[dbo].[factsales]', question: 'What revenue logic exists here?' }],
  });

  // Next hop should be FactSales (question-boosted to priority 2)
  const hop2 = state.getHopContext();
  assert(!('done' in hop2) && !('error' in hop2), 'Hop 2 ok');
  const ctx2 = hop2 as { focus_node: { id: string }; current_task: string };
  assertEq(ctx2.focus_node.id, '[dbo].[factsales]', 'Question-boosted node is next');
  assertEq(ctx2.current_task, 'What revenue logic exists here?', 'Self-Ask question delivered as current_task');
}

async function testQuestionShowsInPendingQuestions() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  const hop1 = state.getHopContext();
  const ctx1 = hop1 as { focus_node: { id: string } };

  // Submit with 2 questions
  state.submitFindings({
    focusNodeId: ctx1.focus_node.id,
    findings: 'test', summary: 'test',
    questions: [
      { nodeId: '[dbo].[factsales]', question: 'Check revenue' },
      { nodeId: '[staging].[rawdata]', question: 'Check raw data quality' },
    ],
  });

  // Next hop: pending_questions should include the question NOT for the current focus
  const hop2 = state.getHopContext();
  const ctx2 = hop2 as {
    focus_node: { id: string };
    working_memory: { pending_questions: Array<{ nodeId: string; question: string }> };
  };

  // One question gets answered (it's the focus), one stays pending
  const pending = ctx2.working_memory.pending_questions;
  // The current focus should have its question removed from pending (it's the current_task)
  assert(pending.length >= 1, 'At least 1 pending question');
}

async function testQuestionAnsweredOnSubmit() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  const hop1 = state.getHopContext();
  const ctx1 = hop1 as { focus_node: { id: string } };

  // Ask question for FactSales
  state.submitFindings({
    focusNodeId: ctx1.focus_node.id,
    findings: 'test', summary: 'test',
    questions: [{ nodeId: '[dbo].[factsales]', question: 'Check revenue' }],
  });

  // FactSales should be next (boosted)
  const hop2 = state.getHopContext();
  const ctx2 = hop2 as { focus_node: { id: string } };
  assertEq(ctx2.focus_node.id, '[dbo].[factsales]', 'FactSales is next');

  // Submit findings for FactSales → question should be marked answered
  state.submitFindings({
    focusNodeId: ctx2.focus_node.id,
    findings: 'Revenue = amount * rate', summary: 'Revenue calculation',
  });

  // Next hop: pending_questions should be empty (the question for FactSales was answered)
  const hop3 = state.getHopContext();
  if ('done' in hop3) return; // might be done if agenda empty
  const ctx3 = hop3 as { working_memory: { pending_questions: unknown[] } };
  assertEq(ctx3.working_memory.pending_questions.length, 0, 'Question for FactSales answered — no pending');
}

// ─── Test: Skip IDs ──────────────────────────────────────────────────────────

async function testPruneIds() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  const hop1 = state.getHopContext();
  const ctx1 = hop1 as { focus_node: { id: string }; agenda_remaining: number };
  const agendaBefore = ctx1.agenda_remaining;

  // Prune ext.RemoteDB (only reachable through spLoadStaging → ext.RemoteDB)
  const result = state.submitFindings({
    focusNodeId: ctx1.focus_node.id,
    findings: 'test', summary: 'test', verdict: 'relevant',
    pruneIds: ['[ext].[remotedb]'],
  });
  assert('ok' in result, 'pruneIds accepted');
  assert((result as { pruned?: number }).pruned! > 0, 'pruneIds triggered cascade');

  // Pruned node should not appear in subsequent hops
  for (let i = 0; i < 10; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    const ctx = hop as { focus_node: { id: string } };
    assert(ctx.focus_node.id !== '[ext].[remotedb]', 'Pruned node not presented');
    state.submitFindings({
      focusNodeId: ctx.focus_node.id,
      findings: 'test', summary: 'test', verdict: 'noted',
    });
  }
}

// ─── Test: Coverage & Termination ────────────────────────────────────────────

async function testCoverageTracking() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  // Drain all hops, recording findings
  let lastChecklist: { noted: number; total: number; coveragePct: number } | null = null;
  for (let i = 0; i < 10; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    const ctx = hop as { focus_node: { id: string }; working_memory: { checklist: typeof lastChecklist } };

    state.submitFindings({
      focusNodeId: ctx.focus_node.id,
      findings: `Finding for ${ctx.focus_node.id}`,
      summary: `Summary for ${ctx.focus_node.id}`,
    });

    // Get checklist from next hop or result
    const next = state.getHopContext();
    if ('done' in next) {
      // Can still check result
      break;
    }
    if (!('error' in next)) {
      const nextCtx = next as { working_memory: { checklist: typeof lastChecklist } };
      lastChecklist = nextCtx.working_memory.checklist;
      // Need to submit for this hop too — push back
      state.submitFindings({
        focusNodeId: (next as { focus_node: { id: string } }).focus_node.id,
        findings: 'test', summary: 'test',
      });
    }
  }

  assert(lastChecklist !== null, 'Got checklist from working memory');
  assert(lastChecklist!.noted > 0, 'Some nodes noted');
  assert(lastChecklist!.coveragePct > 0, 'Coverage > 0%');
}

async function testAgendaExhaustion() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  // Drain ALL hops
  let hops = 0;
  for (let i = 0; i < 20; i++) {
    const hop = state.getHopContext();
    if ('done' in hop) break;
    if ('error' in hop) break;
    hops++;
    const ctx = hop as { focus_node: { id: string } };
    state.submitFindings({
      focusNodeId: ctx.focus_node.id,
      findings: `Finding ${hops}`, summary: `Summary ${hops}`,
    });
  }

  assert(hops > 0, 'Processed at least one hop');
  assertEq(state.status, 'complete', 'Status is complete after agenda exhausted');
}

// ─── Test: getResult ─────────────────────────────────────────────────────────

async function testGetResultStructure() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Document business rules', origin: '[dbo].[sptransform]' });

  // Drain all hops with findings
  for (let i = 0; i < 20; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    const ctx = hop as { focus_node: { id: string } };
    state.submitFindings({
      focusNodeId: ctx.focus_node.id,
      findings: `Analysis of ${ctx.focus_node.id}`,
      summary: `Summary: ${ctx.focus_node.id}`,
      tags: ['business-rule'],
    });
  }

  const result = state.getResult();
  assert(!('error' in result), 'getResult succeeds');

  const r = result as {
    status: string; question: string; notes: unknown[];
    fullNodes: unknown[]; edges: unknown[];
    stats: { hops: number; noted: number; scopeSize: number; coveragePct: number;
             questionsAsked: number; questionsAnswered: number };
  };

  assertEq(r.status, 'complete', 'Result status is complete');
  assertEq(r.question, 'Document business rules', 'Question preserved');
  assert(r.notes.length > 0, 'Has notes');
  assert(r.fullNodes.length > 0, 'Has fullNodes');
  assert(r.edges.length > 0, 'Has edges between noted nodes');
  assert(r.stats.hops > 0, 'Stats: hops > 0');
  assert(r.stats.noted > 0, 'Stats: noted > 0');
  assertEq(r.stats.scopeSize, 6, 'Stats: scope is 6');
  assert(r.stats.coveragePct > 0, 'Stats: coverage > 0');
}

async function testGetResultTooEarly() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });
  state.getHopContext();

  // In awaiting_findings state — getResult should error
  const result = state.getResult();
  assert('error' in result, 'getResult in awaiting_findings → error');
}

// ─── Test: Auto-expand scope via question ────────────────────────────────────

async function testAutoExpandScope() {
  clearLogs();
  // Build a disconnected model — 2 separate components
  const nodes: LineageNode[] = [
    { id: '[a].[t1]', schema: 'a', name: 'T1', fullName: '[a].[T1]', type: 'table',
      columns: [{ name: 'Id', type: 'int', nullable: 'false', extra: '' }] },
    { id: '[a].[t2]', schema: 'a', name: 'T2', fullName: '[a].[T2]', type: 'table',
      columns: [{ name: 'Val', type: 'int', nullable: 'false', extra: '' }] },
    { id: '[b].[t3]', schema: 'b', name: 'T3', fullName: '[b].[T3]', type: 'table',
      columns: [{ name: 'X', type: 'int', nullable: 'false', extra: '' }] },
  ];
  const edges: LineageEdge[] = [
    { source: '[a].[t1]', target: '[a].[t2]', type: 'body' },
  ];
  const neighborIndex: NeighborIndex = {};
  for (const n of nodes) neighborIndex[n.id] = { in: [], out: [] };
  for (const e of edges) {
    neighborIndex[e.source]?.out.push(e.target);
    neighborIndex[e.target]?.in.push(e.source);
  }
  const model: DatabaseModel = {
    nodes, edges, neighborIndex,
    schemas: [
      { name: 'a', nodeCount: 2, types: { table: 2, view: 0, procedure: 0, function: 0, external: 0 } },
      { name: 'b', nodeCount: 1, types: { table: 1, view: 0, procedure: 0, function: 0, external: 0 } },
    ],
    catalog: Object.fromEntries(nodes.map(n => [n.id, { schema: n.schema, name: n.name, type: n.type }])),
  };

  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  const initResult = state.init({ question: 'Test', origin: '[a].[t1]' });
  assert('ok' in initResult, 'Init ok');
  // Scope = 2 (T1 + T2, T3 is disconnected)
  assertEq((initResult as { scopeSize: number }).scopeSize, 2, 'Scope is 2 (T3 not reachable)');

  const hop = state.getHopContext();
  const ctx = hop as { focus_node: { id: string } };

  // Submit question for T3 (out of scope) → should auto-expand
  state.submitFindings({
    focusNodeId: ctx.focus_node.id,
    findings: 'test', summary: 'test',
    questions: [{ nodeId: '[b].[t3]', question: 'Check T3' }],
  });

  // T3 should now be on the agenda (auto-expanded)
  const hop2 = state.getHopContext();
  assert(!('done' in hop2), 'Agenda not exhausted — T3 should be queued');
  const ctx2 = hop2 as { focus_node: { id: string } };
  assertEq(ctx2.focus_node.id, '[b].[t3]', 'Auto-expanded T3 is next (question-boosted)');
}

// ─── Test: Agenda cap ────────────────────────────────────────────────────────

async function testAgendaCap() {
  clearLogs();
  const model = buildSyntheticModel();
  // Cap agenda at 2 — only 2 nodes queued
  const state = new BlackboardState(model, buildGraphFromModel(model), log, { maxAgendaSize: 2 });
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  // Count available hops
  let hops = 0;
  for (let i = 0; i < 10; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    hops++;
    const ctx = hop as { focus_node: { id: string } };
    state.submitFindings({ focusNodeId: ctx.focus_node.id, findings: 'test', summary: 'test' });
  }

  assert(hops <= 3, `Agenda cap respected (got ${hops} hops, expected ≤3 with cap=2)`);
}

// ─── Test: Boundary detection ────────────────────────────────────────────────

async function testBoundaryDetection() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  // Look for external boundary (RemoteDB) and source/sink boundaries
  let foundExternal = false;
  let foundSource = false;
  for (let i = 0; i < 10; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string; boundary: string }> };

    for (const nb of ctx.neighbors) {
      if (nb.boundary === 'external') foundExternal = true;
      if (nb.boundary === 'source') foundSource = true;
    }

    state.submitFindings({ focusNodeId: ctx.focus_node.id, findings: 'test', summary: 'test' });
  }

  assert(foundExternal, 'Found external boundary (RemoteDB)');
  // source/sink may or may not appear depending on traversal order
}

// ─── Test: Neighbor metadata ─────────────────────────────────────────────────

async function testNeighborMetadata() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  // Find a hop with neighbors that have cols or fks
  let foundCols = false;
  let foundEdgeInfo = false;
  for (let i = 0; i < 10; i++) {
    const hop = state.getHopContext();
    if ('done' in hop || 'error' in hop) break;
    const ctx = hop as { focus_node: { id: string }; neighbors: Array<{ id: string; cols?: string[]; edge_direction: string; edge_type: string }> };

    for (const nb of ctx.neighbors) {
      if (nb.cols && nb.cols.length > 0) foundCols = true;
      if (nb.edge_direction && nb.edge_type) foundEdgeInfo = true;
    }

    state.submitFindings({ focusNodeId: ctx.focus_node.id, findings: 'test', summary: 'test' });
    if (foundCols && foundEdgeInfo) break;
  }

  assert(foundCols, 'Neighbors include compact column info');
  assert(foundEdgeInfo, 'Neighbors include edge direction and type');
}

// ─── Test: Re-init ───────────────────────────────────────────────────────────

async function testReInit() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);

  // First init + some hops
  state.init({ question: 'First', origin: '[dbo].[sptransform]' });
  const hop = state.getHopContext();
  assert(!('done' in hop) && !('error' in hop), 'First init hop ok');

  // Re-init (should reset all state)
  const result2 = state.init({ question: 'Second', origin: '[staging].[rawdata]' });
  assert('ok' in result2, 'Re-init succeeds');
  assertEq(state.noteCount, 0, 'Notes cleared on re-init');
  assertEq(state.status, 'initialized', 'Status reset to initialized');
}

// ─── Test: High coverage hint ────────────────────────────────────────────────

async function testHighCoverageHint() {
  clearLogs();
  // Small model: 2 nodes
  const nodes: LineageNode[] = [
    { id: '[a].[t1]', schema: 'a', name: 'T1', fullName: '[a].[T1]', type: 'table',
      columns: [{ name: 'Id', type: 'int', nullable: 'false', extra: '' }] },
    { id: '[a].[sp1]', schema: 'a', name: 'SP1', fullName: '[a].[SP1]', type: 'procedure',
      bodyScript: 'CREATE PROCEDURE [a].[SP1] AS SELECT Id FROM a.T1' },
  ];
  const edges: LineageEdge[] = [{ source: '[a].[t1]', target: '[a].[sp1]', type: 'body' }];
  const neighborIndex: NeighborIndex = {};
  for (const n of nodes) neighborIndex[n.id] = { in: [], out: [] };
  for (const e of edges) {
    neighborIndex[e.source]?.out.push(e.target);
    neighborIndex[e.target]?.in.push(e.source);
  }
  const model: DatabaseModel = {
    nodes, edges, neighborIndex,
    schemas: [{ name: 'a', nodeCount: 2, types: { table: 1, view: 0, procedure: 1, function: 0, external: 0 } }],
    catalog: Object.fromEntries(nodes.map(n => [n.id, { schema: n.schema, name: n.name, type: n.type }])),
  };

  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[a].[t1]' });

  // Only 1 node on agenda (SP1), origin already visited
  const hop = state.getHopContext();
  assert(!('done' in hop) && !('error' in hop), 'Got hop');
  const ctx = hop as { focus_node: { id: string } };

  // Submit findings → 1 note of 2 scope = 50%. No hint yet.
  state.submitFindings({ focusNodeId: ctx.focus_node.id, findings: 'test', summary: 'test' });

  // Agenda should be empty now (only 2 nodes total, both visited)
  const hop2 = state.getHopContext();
  // Should be done
  assert('done' in hop2, 'Agenda exhausted with 2-node model');
}

// ─── Test: Question with unknown nodeId is ignored ──────────────────────────

async function testQuestionUnknownNodeIgnored() {
  clearLogs();
  const model = buildSyntheticModel();
  const state = new BlackboardState(model, buildGraphFromModel(model), log);
  state.init({ question: 'Test', origin: '[dbo].[sptransform]' });

  const hop = state.getHopContext();
  assert(!('done' in hop) && !('error' in hop), 'Got hop');
  const ctx = hop as { focus_node: { id: string }; agenda_remaining: number };
  const agendaBefore = ctx.agenda_remaining;

  // Submit findings with question pointing to a hallucinated nodeId
  const result = state.submitFindings({
    focusNodeId: ctx.focus_node.id,
    findings: 'found something',
    summary: 'summary',
    questions: [{ nodeId: '[fake].[hallucinated]', question: 'Does this exist?' }],
  });

  assert('ok' in result, 'Submit accepted despite hallucinated question target');

  // Question logged but agenda should NOT grow from the hallucinated node
  const hop2 = state.getHopContext();
  if (!('done' in hop2) && !('error' in hop2)) {
    const ctx2 = hop2 as { focus_node: { id: string } };
    assert(ctx2.focus_node.id !== '[fake].[hallucinated]', 'Hallucinated node never becomes focus');
  }

  // Verify debug log captured the rejection
  assert(logs.some(l => l.includes('unknown node')), 'Debug log captures unknown-node rejection');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  resetCounters();
  console.log('════════════════════════════════════════════════════════');
  console.log('  Blackboard State Machine Tests');
  console.log('════════════════════════════════════════════════════════');

  try {
    console.log('\n── Lifecycle ──');
    await testLifecycleStatus();

    console.log('\n── Init ──');
    await testInitValid();
    await testInitInvalidOrigin();

    console.log('\n── Hop Context ──');
    await testHopContextStructure();
    await testFocusNodeDdl();
    await testFocusNodeColumns();

    console.log('\n── Submit Findings ──');
    await testSubmitFindings();
    await testSubmitFocusMismatch();
    await testFindingsHardLimit();
    await testSummaryHardLimit();

    console.log('\n── Working Memory ──');
    await testWorkingMemoryGrows();

    console.log('\n── Question Queue (Self-Ask) ──');
    await testQuestionBoostsPriority();
    await testQuestionShowsInPendingQuestions();
    await testQuestionAnsweredOnSubmit();

    console.log('\n── Skip & Agenda ──');
    await testPruneIds();
    await testAgendaCap();

    console.log('\n── Coverage & Termination ──');
    await testCoverageTracking();
    await testAgendaExhaustion();

    console.log('\n── Get Result ──');
    await testGetResultStructure();
    await testGetResultTooEarly();

    console.log('\n── Edge Cases ──');
    await testAutoExpandScope();
    await testQuestionUnknownNodeIgnored();
    await testBoundaryDetection();
    await testNeighborMetadata();
    await testReInit();
    await testHighCoverageHint();

  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('Blackboard State');
}

main();
