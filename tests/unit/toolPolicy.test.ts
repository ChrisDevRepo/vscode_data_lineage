/**
 * Unit tests for the tool × phase policy.
 *
 * Covers:
 *   getAllowedLmToolNames — correct tool set returned for every LmStage variant
 *   activeModeOf          — flag → ActiveMode derivation
 *   filterLmTools         — predicate filter wraps getAllowedLmToolNames correctly
 */

import { assert, assertEq, printSummary } from './helpers/testUtils';
import {
  getAllowedLmToolNames,
  activeModeOf,
  filterLmTools,
  type LmStage,
} from '../../src/ai/toolPolicy';

async function runTests() {
  console.log('\n══════ toolPolicy tests ══════');

  // ── getAllowedLmToolNames ─────────────────────────────────────────────────

  console.log('\n── discover stage ──');
  {
    const tools = getAllowedLmToolNames({ kind: 'discover' });
    assert(tools.has('lineage_get_context'),           'get_context present');
    assert(tools.has('lineage_search_objects'),        'search_objects present');
    assert(tools.has('lineage_search_ddl'),            'search_ddl present');
    assert(tools.has('lineage_get_object_detail'),     'get_object_detail present');
    assert(tools.has('lineage_detect_graph_patterns'), 'detect_graph_patterns present');
    assert(tools.has('lineage_start_exploration'),     'start_exploration present');
    assert(!tools.has('lineage_submit_findings'),      'submit_findings absent');
    assert(!tools.has('lineage_present_result'),       'present_result absent');
    assert(!tools.has('lineage_get_neighbor_columns'), 'get_neighbor_columns absent');
    assertEq(tools.size, 6, 'discover: exactly 6 tools');
  }

  console.log('\n── active / inline_bb ──');
  {
    const tools = getAllowedLmToolNames({ kind: 'active', mode: 'inline_bb' });
    assert(tools.has('lineage_submit_findings'),       'submit_findings present');
    assert(!tools.has('lineage_get_neighbor_columns'), 'get_neighbor_columns absent (no DDL fetch in inline)');
    assertEq(tools.size, 1, 'inline_bb: exactly 1 tool');
  }

  console.log('\n── active / sm_bb ──');
  {
    const tools = getAllowedLmToolNames({ kind: 'active', mode: 'sm_bb' });
    assert(tools.has('lineage_submit_findings'),       'submit_findings present');
    assert(tools.has('lineage_get_neighbor_columns'),  'get_neighbor_columns present');
    assertEq(tools.size, 2, 'sm_bb: exactly 2 tools');
  }

  console.log('\n── active / sm_ct ──');
  {
    const tools = getAllowedLmToolNames({ kind: 'active', mode: 'sm_ct' });
    assert(tools.has('lineage_submit_findings'),       'submit_findings present');
    assert(tools.has('lineage_get_neighbor_columns'),  'get_neighbor_columns present');
    assertEq(tools.size, 2, 'sm_ct: exactly 2 tools');
  }

  console.log('\n── synthesis stage ──');
  {
    const tools = getAllowedLmToolNames({ kind: 'synthesis' });
    assert(tools.has('lineage_present_result'), 'present_result present');
    assert(!tools.has('lineage_submit_findings'), 'submit_findings absent');
    assertEq(tools.size, 1, 'synthesis: exactly 1 tool');
  }

  console.log('\n── completed stage ──');
  {
    const tools = getAllowedLmToolNames({ kind: 'completed' });
    assert(tools.has('lineage_present_result'),        'present_result present');
    assert(tools.has('lineage_get_object_detail'),     'get_object_detail present');
    assert(tools.has('lineage_search_ddl'),            'search_ddl present');
    assert(tools.has('lineage_search_objects'),        'search_objects present');
    assert(tools.has('lineage_start_exploration'),     'start_exploration present (supplement)');
    assert(!tools.has('lineage_submit_findings'),      'submit_findings absent');
    assertEq(tools.size, 5, 'completed: exactly 5 tools');
  }

  // ── activeModeOf ─────────────────────────────────────────────────────────

  console.log('\n── activeModeOf ──');
  assertEq(activeModeOf(true, false),  'inline_bb', 'inlineMode=true → inline_bb');
  assertEq(activeModeOf(false, false), 'sm_bb',     'inlineMode=false, no CT → sm_bb');
  assertEq(activeModeOf(false, true),  'sm_ct',     'inlineMode=false, CT → sm_ct');
  // inlineMode wins even when CT flag is set — CT forces SM at a higher gate, so this
  // combination should not occur in practice, but the function still returns inline_bb.
  assertEq(activeModeOf(true, true), 'inline_bb', 'inlineMode wins over CT flag');

  // ── filterLmTools ────────────────────────────────────────────────────────

  console.log('\n── filterLmTools ──');
  {
    const allTools = [
      { name: 'lineage_submit_findings' },
      { name: 'lineage_get_neighbor_columns' },
      { name: 'lineage_present_result' },
      { name: 'lineage_search_objects' },
      { name: 'lineage_start_exploration' },
      { name: 'lineage_get_context' },
    ];
    const active = filterLmTools(allTools, { kind: 'active', mode: 'sm_bb' });
    assertEq(active.length, 2, 'sm_bb: filters to 2 tools from 6 registered');
    assert(active.some(t => t.name === 'lineage_submit_findings'),      'submit_findings in result');
    assert(active.some(t => t.name === 'lineage_get_neighbor_columns'), 'get_neighbor_columns in result');

    const synthesis = filterLmTools(allTools, { kind: 'synthesis' });
    assertEq(synthesis.length, 1, 'synthesis: filters to 1 tool');
    assertEq(synthesis[0].name, 'lineage_present_result', 'synthesis tool is present_result');
  }

  printSummary('toolPolicy');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
