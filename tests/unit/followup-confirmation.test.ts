/**
 * Unit tests for preserving clarified follow-up graph edits across short
 * confirmations such as "yes do it".
 */

import { assert, printSummary } from './helpers/testUtils';
import {
  buildConfirmedGraphPresentationEditInstruction,
  extractNodeIdsFromMarkdown,
  isShortAffirmation,
} from '../../src/ai/prompting/followUpConfirmation';

async function runTests() {
  console.log('\n══════ followup-confirmation tests ══════');

  console.log('\n── short affirmation detection ──');
  assert(isShortAffirmation('yes do it'), 'yes do it is an affirmation');
  assert(isShortAffirmation('go ahead.'), 'go ahead is an affirmation');
  assert(!isShortAffirmation('yes, but only upstream'), 'partial affirm with extra scope is not treated as bare confirmation');

  console.log('\n── node id extraction ──');
  const ids = extractNodeIdsFromMarkdown('Add `source` to `[ai].[saporders]` and `[ai].[oracleorders]`.');
  assert(ids.length === 2, 'extracts two node ids');
  assert(ids.includes('[ai].[saporders]'), 'extracts saporders');
  assert(ids.includes('[ai].[oracleorders]'), 'extracts oracleorders');

  console.log('\n── confirmed graph edit instruction ──');
  const instruction = buildConfirmedGraphPresentationEditInstruction(
    'yes do it',
    'Add the **`source`** label to these order-source tables:\n\n- `[ai].[saporders]`\n- `[ai].[oracleorders]`',
    'completed',
  );
  assert(!!instruction, 'builds instruction for confirmed source label edit');
  assert(instruction!.includes('lineage_present_result'), 'routes to present_result');
  assert(instruction!.includes('add_node_ids'), 'mentions add_node_ids for invisible nodes');
  assert(instruction!.includes('highlight_groups'), 'mentions highlight_groups');
  assert(instruction!.includes('color:"source"'), 'preserves source role');
  assert(instruction!.includes('[ai].[saporders]'), 'preserves resolved node id');

  const activeInstruction = buildConfirmedGraphPresentationEditInstruction(
    'yes',
    'Add the **`source`** label to `[ai].[saporders]`.',
    'exploring',
  );
  assert(activeInstruction?.includes('finish the current focus'), 'active phase carries edit after current focus');

  const noInstruction = buildConfirmedGraphPresentationEditInstruction(
    'yes do it',
    'The lineage report is complete.',
    'completed',
  );
  assert(noInstruction === null, 'does not fire without prior presentation edit');

  printSummary('followup-confirmation');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
