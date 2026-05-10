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
  ROUTE_REQUESTS_VERBATIM_CONTRACT,
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

    const active = buildPhasePrompt('active', { isInline: false });
    assert(active.includes('Active Exploration Protocol'), 'active includes protocol heading');
    assert(active.includes('TOOL CONSTRAINTS'), 'active includes tool constraints');
    assert(active.includes('ROUTE_REQUESTS'), 'active includes route_requests contract');

    const synthesis = buildPhasePrompt('synthesis');
    assert(synthesis.includes('Synthesis Protocol'), 'synthesis includes protocol heading');
    assert(synthesis.includes('## sections[] — REQUIRED'), 'synthesis enforces sections[]');

    const completed = buildPhasePrompt('completed');
    assert(completed.includes('Follow-Up Protocol'), 'completed includes follow-up heading');
    assert(completed.includes('Refinement paths:'), 'completed includes refinement paths');
  }

  console.log('\n── buildSmProtocol invariants ──');
  {
    const sm = buildSmProtocol({ classification: 'business' });
    assert(sm.includes('Verdict Protocol'), 'SM includes verdict contract');
    assert(sm.includes('Section Submission'), 'SM includes section submission contract');
    assert(sm.includes('Metadata Protocol'), 'SM includes metadata contract');
    assert(sm.includes('## Routing'), 'SM includes routing contract');

    const smCt = buildSmProtocol({ classification: 'both', targetColumns: ['TotalRevenue'] });
    assert(smCt.includes('Column Trace: active'), 'SM CT includes CT stable anchor');
    assert(smCt.includes('column_flow'), 'SM CT includes column_flow contract');
  }

  console.log('\n── active assembly redundancy guard ──');
  {
    const base = buildGeneralSystemPrompt('active', 'SQL Server', ['dbo'], 1, 10, 10);
    const phase = buildPhasePrompt('active', { isInline: false });
    const sm = buildSmProtocol({ classification: 'business' });
    const assembled = [base, phase, sm].join('\n\n');
    const count = countOccurrences(assembled, ROUTE_REQUESTS_VERBATIM_CONTRACT);
    assertEq(count, 1, 'canonical route_requests contract appears exactly once in active assembly');
  }

  printSummary('prompt-composition');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});

