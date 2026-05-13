/**
 * Unit tests for phase-first prompt composition and SM protocol assembly.
 *
 * Covers:
 *   buildPhasePrompt — phase invariants remain present after reorg
 *   buildSmProtocol  — active-mode SM guidance preserved
 *   redundancy guard — canonical route_requests contract appears once in active assembly
 */

import { assert, assertEq, printSummary } from './helpers/testUtils';
import {
  buildGeneralSystemPrompt,
  buildPhasePrompt,
} from '../../src/ai/prompting/prompts';
import { buildSmProtocol } from '../../src/ai/prompting/smPrompts';

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let start = 0;
  while (true) {
    const idx = haystack.indexOf(needle, start);
    if (idx < 0) break;
    count++;
    start = idx + needle.length;
  }
  return count;
}

async function runTests() {
  console.log('\n══════ prompt-composition tests ══════');

  console.log('\n── buildPhasePrompt invariants ──');
  {
    const discover = buildPhasePrompt('discover');
    assert(discover.includes('Class D — Direct'), 'discover includes Class D guidance');
    assert(discover.includes('Class S — State machine'), 'discover includes Class S guidance');
    assert(discover.includes('Discovery is the default state'), 'discover defaults to discovery-first routing');
    assert(discover.includes('explicitly asks for visual graph render'), 'discover escalates on explicit graph render intent');
    assert(discover.includes('requests column tracing (`targetColumns`)'), 'discover escalates on column-trace intent');
    assert(discover.includes('over_discovery_budget'), 'discover escalates on scope-bundle budget overflow');
    assert(discover.includes('deeper hop-by-hop analysis'), 'discover escalates on explicit deeper-analysis intent');
    assert(!discover.includes('prefer Class S'), 'discover no longer biases ambiguous routing to Class S');

    const active = buildPhasePrompt('active', { isInline: false });
    assert(active.includes('Active Exploration Protocol'), 'active includes protocol heading');
    assert(active.includes('TOOL CONSTRAINTS'), 'active includes tool constraints');
    assert(active.includes('DECISION SOURCE'), 'active points to canonical decision contract');

    const synthesis = buildPhasePrompt('synthesis');
    assert(synthesis.includes('Synthesis Protocol'), 'synthesis includes protocol heading');
    assert(synthesis.includes('## sections[] — REQUIRED'), 'synthesis enforces sections[]');

    const completed = buildPhasePrompt('completed');
    assert(completed.includes('Follow-Up Protocol'), 'completed includes follow-up heading');
    assert(completed.includes('Route A - Adjust the existing graph'), 'completed includes existing-graph route');
    assert(completed.includes('Route B - Start a new trace'), 'completed includes fresh-trace route');
    assert(completed.includes('DEFAULT: Route A'), 'completed defaults follow-up routing to Route A');
    assert(completed.includes('If uncertain, stay in Route A'), 'completed includes Route A tiebreaker');
    assert(completed.includes('Section labels remain the authoritative final grouping/linking surface'), 'completed states section-label precedence');
    assert(completed.includes('badges regenerate from section labels'), 'completed maps badge regeneration to sections');
    assert(completed.includes('notes[]'), 'completed maps note updates');
  }

  console.log('\n── buildSmProtocol invariants ──');
  {
    const sm = buildSmProtocol({ classification: 'business' });
    assert(sm.includes('Verdict Protocol'), 'SM includes verdict contract');
    assert(sm.includes('Section Submission'), 'SM includes section submission contract');
    assert(sm.includes('Metadata Protocol'), 'SM includes metadata contract');
    assert(sm.includes('Neighbor Decision Contract (Current Hop Only)'), 'SM includes canonical hop decision contract');
    assert(sm.includes('prune_neighbors'), 'SM BB keeps prune_neighbors guidance');

    const smCt = buildSmProtocol({ classification: 'both', targetColumns: ['TotalRevenue'] });
    assert(smCt.includes('Column Trace: active'), 'SM CT includes CT stable anchor');
    assert(smCt.includes('column_flow'), 'SM CT includes column_flow contract');
    assert(!smCt.includes('prune commands are disabled'), 'SM CT has no negation prune instruction');
    assert(!smCt.includes('prune non-relevant neighbors via `prune_neighbors`'), 'SM CT removes prune_neighbors guidance');
    assert(!smCt.includes('→ Does not interact:        verdict=prune. Omit column_flow.'), 'SM CT removes map-or-prune guidance');
  }

  console.log('\n── active assembly redundancy guard ──');
  {
    const base = buildGeneralSystemPrompt('active', 'SQL Server', ['dbo'], 1, 10, 10);
    const phase = buildPhasePrompt('active', { isInline: false });
    const sm = buildSmProtocol({ classification: 'business' });
    const assembled = [base, phase, sm].join('\n\n');
    const needle = 'Neighbor Decision Contract (Current Hop Only)';
    const count = countOccurrences(assembled, needle);
    assertEq(count, 1, 'canonical hop decision contract appears exactly once in active assembly');
  }

  printSummary('prompt-composition');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
