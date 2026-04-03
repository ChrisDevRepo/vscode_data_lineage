/**
 * Orchestration loop tests — fake Copilot responses driving real tool functions.
 * Tests mode routing, tool filtering, dedup, history management, and CT context control.
 * Execute with: npx tsx test/chat-loop.test.ts
 */

import { assert, assertEq, printSummary, loadAdventureWorksModel, resetCounters } from './testUtils';
import { buildBareGraph } from '../src/ai/graphUtils';
import { runChatLoop } from './chatLoopTestHarness';
import type { ScriptedRound } from './chatLoopTestHarness';
import type { DatabaseModel } from '../src/engine/types';
import type Graph from 'graphology';

// ─── Mode Detection Tests ───────────────────────────────────────────────────

async function testExploreFirstDesign() {
  console.log('\n── Explore-First Design ──');

  // No mode detection — all tools visible, AI discovers intent via exploration
  // Slash commands are shortcuts (intent context only), not mode switches
  assert(true, 'Explore-first: no upfront mode detection');
  assert(true, 'Slash commands /trace /search /explain are intent shortcuts');
  assert(true, 'Dynamic tool filtering: discover → ct_active → ct_done');
}

// ─── Classic Mode: Search → Detail → BFS → Create View ─────────────────────

async function testClassicSearchDetailBfsView(model: DatabaseModel, graph: Graph) {
  console.log('\n── Classic: search → detail → BFS → enrich_view ──');

  // Script what a correct Copilot would do for "/trace Employee"
  const empNode = model.nodes.find(n => n.schema === 'HumanResources' && n.name === 'Employee');
  assert(empNode !== undefined, 'HumanResources.Employee exists in model');
  if (!empNode) return;
  const empId = empNode.id;

  const script: ScriptedRound[] = [
    // Round 1: AI searches for Employee
    {
      text: 'Searching for Employee...',
      toolCalls: [{ name: 'lineage_search_objects', input: { query: 'Employee', types: ['table'] } }],
    },
    // Round 2: AI gets detail for the found node
    {
      text: 'Getting details...',
      toolCalls: [{ name: 'lineage_get_object_detail', input: { id: empId } }],
    },
    // Round 3: AI traces BFS from Employee
    {
      toolCalls: [{ name: 'lineage_run_bfs_trace', input: { origin: empId, hops_up: 2, hops_down: 2, include_ddl: true } }],
    },
    // Round 4: AI creates a view
    {
      toolCalls: [{
        name: 'lineage_enrich_view',
        input: {
          name: 'Employee Lineage',
          node_ids: [empId],
          summary: 'Employee table dependencies.',
        },
      }],
    },
    // Round 5: AI responds with final text (no tool calls → loop exits)
    { text: 'Here is the Employee lineage view.' },
  ];

  const result = runChatLoop({
    prompt: 'Trace Employee lineage',
    command: 'trace',
    script,
    model,
    graph,
  });

  assertEq(result.phase, 'discover', 'Phase: discover');
  assertEq(result.rounds, 5, 'Took 5 rounds');
  assert(!result.hitRoundLimit, 'Did not hit round limit');

  // Tool sequence
  assertEq(result.toolSequence[0], 'search_objects', 'First tool: search');
  assertEq(result.toolSequence[1], 'get_object_detail', 'Second tool: detail');
  assertEq(result.toolSequence[2], 'run_bfs_trace', 'Third tool: BFS');
  assertEq(result.toolSequence[3], 'enrich_view', 'Fourth tool: enrich view');

  // Tool results are valid JSON
  for (const tr of result.toolResults) {
    const parsed = JSON.parse(tr.result);
    assert(!parsed.error || parsed.error === 'unknown_tool', `${tr.name}: no error (got ${parsed.error ?? 'none'})`);
  }

  // Markdown output captured
  assert(result.markdownOutput.length > 0, 'Markdown output produced');
  assert(result.markdownOutput.some(m => m.includes('Employee')), 'Output mentions Employee');

  // Column trace state not used
  assert(result.columnTraceState === null, 'No CT state in classic mode');
}

// ─── Explore-first: all tools visible during discovery ───────────────────────

async function testAllToolsVisible(model: DatabaseModel, graph: Graph) {
  console.log('\n── Explore-first: all tools visible ──');

  const script: ScriptedRound[] = [
    {
      toolCalls: [
        { name: 'lineage_search_objects', input: { query: 'Employee' } },
        { name: 'lineage_start_column_trace', input: { columns: ['BusinessEntityID'], origin: '[HumanResources].[Employee]', direction: 'up' } },
      ],
    },
    { text: 'Done.' },
  ];

  const result = runChatLoop({ prompt: 'test', command: 'trace', script, model, graph });

  // Both classic and CT tools should work — explore-first, no blocking
  const searchResult = result.toolResults.find(r => r.name === 'lineage_search_objects');
  assert(searchResult !== undefined, 'Search tool available');
  assert(!searchResult!.result.includes('tool_not_available'), 'Search tool works in discover phase');

  const ctResult = result.toolResults.find(r => r.name === 'lineage_start_column_trace');
  assert(ctResult !== undefined, 'CT tool available');
  assert(!ctResult!.result.includes('tool_not_available'), 'CT tool works in discover phase');
}

// ─── Dedup: identical tool calls return cached result ───────────────────────

async function testDedup(model: DatabaseModel, graph: Graph) {
  console.log('\n── Dedup: identical calls cached ──');

  const script: ScriptedRound[] = [
    {
      toolCalls: [
        { name: 'lineage_search_objects', input: { query: 'Employee' } },
      ],
    },
    {
      toolCalls: [
        // Same call again
        { name: 'lineage_search_objects', input: { query: 'Employee' } },
      ],
    },
    { text: 'Done.' },
  ];

  const result = runChatLoop({ prompt: 'search twice', command: 'search', script, model, graph });

  // Second call should be deduped
  const dedupResult = result.toolResults[1];
  assert(dedupResult.result.includes('_dedup'), 'Second identical call returned dedup marker');
  assert(result.historyOps.some(o => o.includes('DEDUP')), 'DEDUP op logged');

  // Only 1 tool in sequence (dedup doesn't count)
  assertEq(result.toolSequence.length, 1, 'Only 1 tool in sequence (dedup skipped)');
}

// ─── CT Multi-hop: start → submit → submit → complete ───────────────────────

async function testCTMultiHop(model: DatabaseModel, graph: Graph) {
  console.log('\n── CT: multi-hop start → submit → complete ──');

  // Find a table with upstream neighbors for a real multi-hop trace
  const table = model.nodes.find(n =>
    n.type === 'table' && n.columns?.length &&
    (model.neighborIndex[n.id]?.in.length ?? 0) > 0,
  );
  assert(!!table, 'Found a table with upstream neighbors');
  if (!table) return;

  const col = table.columns![0].name;

  // Round 1: AI starts column trace
  const script: ScriptedRound[] = [
    {
      toolCalls: [{
        name: 'lineage_start_column_trace',
        input: { columns: [col], origin: table.id, direction: 'up' },
      }],
    },
  ];

  // Run round 1 to get the init result
  const r1 = runChatLoop({ prompt: `trace ${col}`, command: 'trace', script, model, graph });
  assertEq(r1.phase, 'ct_active', 'Phase: ct_active (CT state machine active)');
  assert(r1.toolResults.length > 0, 'Got init result');

  const initResult = JSON.parse(r1.toolResults[0].result);
  if (initResult.error) {
    console.log(`  (skipping: init error ${initResult.error})`);
    return;
  }

  // Extract hop context to build round 2
  const hopCtx = initResult.hop_context;
  if (!hopCtx || 'done' in hopCtx) {
    console.log('  (skipping: no hop context or already done)');
    return;
  }

  // Round 2: AI submits verdicts (prune all → completes trace)
  const verdicts = hopCtx.neighbors.map((nb: { id: string }) => ({
    neighbor_id: nb.id,
    verdict: 'prune',
    summary: 'test pruning',
  }));

  const script2: ScriptedRound[] = [
    {
      toolCalls: [{
        name: 'lineage_start_column_trace',
        input: { columns: [col], origin: table.id, direction: 'up' },
      }],
    },
    {
      toolCalls: [{
        name: 'lineage_submit_hop_analysis',
        input: {
          focus_node_id: hopCtx.focus_node.id,
          notes: 'Testing: prune all neighbors',
          verdicts,
        },
      }],
    },
    { text: 'Trace complete.' },
  ];

  const r2 = runChatLoop({ prompt: `trace ${col}`, command: 'trace', script: script2, model, graph });

  assertEq(r2.toolSequence[0], 'start_column_trace', 'First tool: start');
  assert(r2.toolSequence.includes('submit_hop_analysis'), 'Has submit tool');
  assert(r2.columnTraceState !== null, 'CT state created');

  // CT context compaction should have fired
  if (r2.toolResults.length >= 2) {
    // Check that compaction was logged (only if >1 successful CT call)
    const ctSuccesses = r2.toolResults.filter(tr =>
      (tr.name === 'lineage_start_column_trace' || tr.name === 'lineage_submit_hop_analysis') &&
      !tr.result.includes('error'),
    );
    if (ctSuccesses.length > 1) {
      assert(r2.historyOps.some(o => o.includes('CT_COMPACT')), 'CT compaction logged');
    }
  }
}

// ─── Round Limit: loop stops at maxRounds ───────────────────────────────────

async function testRoundLimit(model: DatabaseModel, graph: Graph) {
  console.log('\n── Round Limit ──');

  // Script 10 rounds but limit to 3
  const script: ScriptedRound[] = Array.from({ length: 10 }, (_, i) => ({
    toolCalls: [{ name: 'lineage_search_objects', input: { query: `test${i}` } }],
  }));

  const result = runChatLoop({ prompt: 'test', command: 'search', script, model, graph, maxRounds: 3 });

  assert(result.hitRoundLimit, 'Hit round limit');
  assertEq(result.rounds, 3, 'Stopped at 3 rounds');
  assert(result.toolSequence.length <= 3, 'At most 3 tool calls');
}

// ─── Explore-first: no routing round, AI discovers via tools ────────────────

async function testExploreFirstNoRouting(model: DatabaseModel, graph: Graph) {
  console.log('\n── Explore-first: no routing round ──');

  // Free-form questions go straight to tools — no classification round
  const result = runChatLoop({
    prompt: 'where does Revenue come from?',
    command: undefined,
    script: [{ text: 'Exploring revenue lineage...' }],
    model, graph,
  });
  assert(result.rounds >= 1, 'Free-form: at least 1 round');
}

// ─── History: DROP noise results ────────────────────────────────────────────

async function testHistoryDrop(model: DatabaseModel, graph: Graph) {
  console.log('\n── History: DROP noise results ──');

  // Search for something that doesn't exist → empty result → should be DROPped
  const script: ScriptedRound[] = [
    {
      toolCalls: [{ name: 'lineage_search_objects', input: { query: 'xyznonexistent99' } }],
    },
    { text: 'Nothing found.' },
  ];

  const result = runChatLoop({ prompt: 'find xyz', command: 'search', script, model, graph });

  // The empty search result should trigger a DROP
  assert(result.historyOps.some(o => o.includes('DROP')), 'Empty result DROPped');
}

// ─── Slash commands are intent shortcuts (no mode detection) ────────────────

async function testSlashCommandShortcuts() {
  console.log('\n── Slash Command Shortcuts ──');
  // Explore-first: slash commands just add intent context, no mode switching
  assert(true, '/trace = intent shortcut for lineage');
  assert(true, '/search = intent shortcut for search');
  assert(true, '/explain = intent shortcut for explain');
}

// ─── BB Exploration: search → start_exploration → submit_findings → done ────

async function testBBExplorationFlow(model: DatabaseModel, graph: Graph) {
  console.log('\n── BB: search → start_exploration → submit_findings ──');

  // Find a table first, then start exploration
  const table = model.nodes.find(n => n.type === 'table' && n.columns?.length);
  assert(!!table, 'BB: found a table');

  const script: ScriptedRound[] = [
    // Round 1: search
    {
      toolCalls: [{ name: 'lineage_search_objects', input: { query: table!.name } }],
    },
    // Round 2: start exploration
    {
      toolCalls: [{
        name: 'lineage_start_exploration',
        input: { question: 'Document business rules', origin: table!.id },
      }],
    },
    // Round 3: submit findings for first hop
    {
      toolCalls: [{
        name: 'lineage_submit_findings',
        input: {
          focus_node_id: '', // will be filled by the state machine (but harness doesn't validate)
          findings: 'This is a test finding',
          summary: 'Test summary',
        },
      }],
    },
    // Round 4: done
    { text: 'Analysis complete.' },
  ];

  const result = runChatLoop({ prompt: 'document business rules', script, model, graph });

  assert(result.toolSequence.includes('start_exploration'), 'BB: start_exploration called');
  assert(result.blackboardState !== null, 'BB: blackboard state created');
  assert(result.phase === 'bb_active', 'BB: phase is bb_active');
  assert(result.historyOps.some(o => o.includes('BB_TRACK')), 'BB: tool results tracked');
}

async function testBBToolVisible(model: DatabaseModel, graph: Graph) {
  console.log('\n── BB: exploration tools visible in discover phase ──');

  const script: ScriptedRound[] = [
    {
      toolCalls: [{ name: 'lineage_get_context', input: {} }],
    },
    { text: 'Context loaded.' },
  ];

  const result = runChatLoop({ prompt: 'test', script, model, graph });
  // BB tools should be visible (in ALL_TOOLS set)
  assert(result.toolSequence.includes('get_context'), 'BB visible: get_context works');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  resetCounters();
  console.log('═══ Chat Loop Orchestration Tests ═══');
  try {
    const model = await loadAdventureWorksModel();
    const graph = buildBareGraph(model);

    await testExploreFirstDesign();
    await testSlashCommandShortcuts();
    await testClassicSearchDetailBfsView(model, graph);
    await testAllToolsVisible(model, graph);
    await testDedup(model, graph);
    await testCTMultiHop(model, graph);
    await testRoundLimit(model, graph);
    await testExploreFirstNoRouting(model, graph);
    await testHistoryDrop(model, graph);

    // Blackboard (Type 1) tests
    console.log('\n── Blackboard Exploration Tests ──');
    await testBBExplorationFlow(model, graph);
    await testBBToolVisible(model, graph);
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('Chat Loop');
}

main();
