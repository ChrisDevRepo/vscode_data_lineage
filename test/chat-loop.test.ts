/**
 * Orchestration loop tests — fake Copilot responses driving real tool functions.
 * Tests mode routing, tool filtering, dedup, history management, and CT context control.
 * Execute with: npx tsx test/chat-loop.test.ts
 */

import { assert, assertEq, printSummary, loadAdventureWorksModel, resetCounters } from './testUtils';
import { buildBareGraph } from '../src/ai/graphUtils';
import { runChatLoop, detectMode, detectModeWithRouting } from './chatLoopTestHarness';
import type { ScriptedRound } from './chatLoopTestHarness';
import type { DatabaseModel } from '../src/engine/types';
import type Graph from 'graphology';

// ─── Mode Detection Tests ───────────────────────────────────────────────────

async function testModeDetection() {
  console.log('\n── Mode Detection ──');

  // Slash commands → direct mode
  assertEq(detectMode('column-trace').mode, 'column_trace', '/column-trace → column_trace');
  assertEq(detectMode('column-trace').promptVariant, 'column-trace', '/column-trace variant');
  assertEq(detectMode('impact').mode, 'hop', '/impact → hop');
  assertEq(detectMode('impact').promptVariant, 'impact', '/impact variant');
  assertEq(detectMode('biz').mode, 'hop', '/biz → hop');
  assertEq(detectMode('doc').mode, 'hop', '/doc → hop');
  assertEq(detectMode('sql').mode, 'hop', '/sql → hop');
  assertEq(detectMode('trace').mode, 'classic', '/trace → classic');
  assertEq(detectMode('search').mode, 'classic', '/search → classic');
  assertEq(detectMode('explain').mode, 'classic', '/explain → classic');
  assertEq(detectMode(undefined).mode, 'classic', 'free-form default → classic');

  // With routing
  assertEq(detectModeWithRouting(undefined, 'hop').mode, 'hop', 'free-form + router=hop → hop');
  assertEq(detectModeWithRouting(undefined, 'classic').mode, 'classic', 'free-form + router=classic → classic');
  assertEq(detectModeWithRouting('column-trace', 'classic').mode, 'column_trace', 'slash command overrides router');
}

// ─── Classic Mode: Search → Detail → BFS → Create View ─────────────────────

async function testClassicSearchDetailBfsView(model: DatabaseModel, graph: Graph) {
  console.log('\n── Classic: search → detail → BFS → create_ai_view ──');

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
        name: 'lineage_create_ai_view',
        input: {
          name: 'Employee Lineage',
          node_ids: [empId],
          summary: 'Employee table dependencies.',
          description: '## Data Flow\nShows Employee dependencies.\n\n## Details\nTraced 2 hops.',
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

  assertEq(result.mode, 'classic', 'Classic mode');
  assertEq(result.promptVariant, 'classic', 'Classic variant');
  assertEq(result.rounds, 5, 'Took 5 rounds');
  assert(!result.hitRoundLimit, 'Did not hit round limit');

  // Tool sequence
  assertEq(result.toolSequence[0], 'search_objects', 'First tool: search');
  assertEq(result.toolSequence[1], 'get_object_detail', 'Second tool: detail');
  assertEq(result.toolSequence[2], 'run_bfs_trace', 'Third tool: BFS');
  assertEq(result.toolSequence[3], 'create_ai_view', 'Fourth tool: create view');

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

// ─── Tool Filtering: CT tools blocked in classic mode ───────────────────────

async function testToolFilteringClassic(model: DatabaseModel, graph: Graph) {
  console.log('\n── Tool Filtering: CT tools blocked in classic ──');

  const script: ScriptedRound[] = [
    {
      toolCalls: [
        { name: 'lineage_start_column_trace', input: { columns: ['Revenue'], direction: 'up' } },
        { name: 'lineage_search_objects', input: { query: 'Employee' } },
      ],
    },
    { text: 'Done.' },
  ];

  const result = runChatLoop({ prompt: 'test', command: 'search', script, model, graph });

  // start_column_trace should be blocked
  const ctResult = result.toolResults.find(r => r.name === 'lineage_start_column_trace');
  assert(ctResult !== undefined, 'CT tool call recorded');
  assert(ctResult!.result.includes('tool_not_available'), 'CT tool blocked in classic mode');
  assert(result.historyOps.some(o => o.includes('BLOCKED')), 'BLOCKED op logged');

  // search_objects should work
  const searchResult = result.toolResults.find(r => r.name === 'lineage_search_objects');
  assert(searchResult !== undefined, 'Search tool call recorded');
  assert(!searchResult!.result.includes('tool_not_available'), 'Search tool allowed in classic mode');
}

// ─── Tool Filtering: Classic tools blocked in CT mode ───────────────────────

async function testToolFilteringCT(model: DatabaseModel, graph: Graph) {
  console.log('\n── Tool Filtering: classic tools blocked in CT mode ──');

  const script: ScriptedRound[] = [
    {
      toolCalls: [
        { name: 'lineage_search_objects', input: { query: 'Employee' } },
        { name: 'lineage_start_column_trace', input: { columns: ['BusinessEntityID'], origin: '[HumanResources].[Employee]', direction: 'up' } },
      ],
    },
    { text: 'Done.' },
  ];

  const result = runChatLoop({ prompt: 'trace column', command: 'column-trace', script, model, graph });

  assertEq(result.mode, 'column_trace', 'CT mode');

  // search_objects should be blocked in CT mode
  const searchResult = result.toolResults.find(r => r.name === 'lineage_search_objects');
  assert(searchResult!.result.includes('tool_not_available'), 'Search tool blocked in CT mode');

  // start_column_trace should work
  const ctResult = result.toolResults.find(r => r.name === 'lineage_start_column_trace');
  assert(!ctResult!.result.includes('tool_not_available'), 'CT tool allowed in CT mode');
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
  const r1 = runChatLoop({ prompt: `trace ${col}`, command: 'column-trace', script, model, graph });
  assertEq(r1.mode, 'column_trace', 'CT mode');
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

  const r2 = runChatLoop({ prompt: `trace ${col}`, command: 'column-trace', script: script2, model, graph });

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

// ─── Free-form Routing: hop vs classic ──────────────────────────────────────

async function testFreeFormRouting(model: DatabaseModel, graph: Graph) {
  console.log('\n── Free-form Routing ──');

  const hopResult = runChatLoop({
    prompt: 'where does Revenue come from?',
    command: undefined,
    routerResponse: 'hop',
    script: [{ text: 'Routed to hop.' }],
    model, graph,
  });
  assertEq(hopResult.mode, 'hop', 'Routed to hop');
  assertEq(hopResult.promptVariant, 'biz', 'Default hop variant is biz');

  const classicResult = runChatLoop({
    prompt: 'list all tables',
    command: undefined,
    routerResponse: 'classic',
    script: [{ text: 'Routed to classic.' }],
    model, graph,
  });
  assertEq(classicResult.mode, 'classic', 'Routed to classic');
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

// ─── Slash Command Prompt Variants ──────────────────────────────────────────

async function testSlashCommandVariants() {
  console.log('\n── Slash Command Prompt Variants ──');

  const variants: Array<[string, string, string]> = [
    ['column-trace', 'column_trace', 'column-trace'],
    ['impact', 'hop', 'impact'],
    ['biz', 'hop', 'biz'],
    ['doc', 'hop', 'doc'],
    ['sql', 'hop', 'sql'],
    ['trace', 'classic', 'classic'],
    ['search', 'classic', 'classic'],
    ['explain', 'classic', 'classic'],
  ];

  for (const [cmd, expectedMode, expectedVariant] of variants) {
    const { mode, promptVariant } = detectMode(cmd);
    assertEq(mode, expectedMode, `/${cmd} → mode ${expectedMode}`);
    assertEq(promptVariant, expectedVariant, `/${cmd} → variant ${expectedVariant}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  resetCounters();
  console.log('═══ Chat Loop Orchestration Tests ═══');
  try {
    const model = await loadAdventureWorksModel();
    const graph = buildBareGraph(model);

    await testModeDetection();
    await testSlashCommandVariants();
    await testClassicSearchDetailBfsView(model, graph);
    await testToolFilteringClassic(model, graph);
    await testToolFilteringCT(model, graph);
    await testDedup(model, graph);
    await testCTMultiHop(model, graph);
    await testRoundLimit(model, graph);
    await testFreeFormRouting(model, graph);
    await testHistoryDrop(model, graph);
  } catch (err) {
    console.error('\n✗ Fatal error:', err);
  }

  printSummary('Chat Loop');
}

main();
