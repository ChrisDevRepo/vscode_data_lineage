/**
 * Unit tests for StartExplorationInputSchema.
 *
 * The schema guards NavigationEngine.init() from the undefined-origin crash
 * (TypeError: Cannot read properties of undefined (reading 'toLowerCase')).
 */

import { assert, printSummary } from './helpers/testUtils';
import { StartExplorationInputSchema } from '../../src/ai/tools';

async function runTests() {
  console.log('\n══════ start-exploration-schema tests ══════');

  console.log('\n── required fields ──');
  assert(!StartExplorationInputSchema.safeParse({}).success, 'empty input rejected (missing origin + classification)');
  assert(!StartExplorationInputSchema.safeParse({ origin: '' }).success, 'empty-string origin rejected');
  assert(!StartExplorationInputSchema.safeParse({ origin: 123 as any }).success, 'non-string origin rejected');
  assert(!StartExplorationInputSchema.safeParse(undefined as any).success, 'undefined input rejected');
  assert(!StartExplorationInputSchema.safeParse(null as any).success, 'null input rejected');
  assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]' }).success,
    'origin without classification rejected (classification is required)',
  );
  assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', classification: 'invalid' as any }).success,
    'invalid classification value rejected',
  );

  console.log('\n── minimal valid input ──');
  const ok = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', classification: 'business' });
  assert(ok.success, 'origin + classification accepted');
  if (ok.success) {
    assert(ok.data.origin === '[s].[t]', 'origin preserved');
    assert(ok.data.classification === 'business', 'classification preserved');
    assert(ok.data.direction === undefined, 'direction optional');
    assert(ok.data.depth === undefined, 'depth optional');
  }

  console.log('\n── full valid input ──');
  const full = StartExplorationInputSchema.safeParse({
    origin: '[s].[t]',
    question: 'Explain',
    direction: 'upstream',
    depth: 2,
    depth_enforcement: 'strict',
    excludeTypes: ['function', 'view'],
    mission_brief: 'brief',
    targetColumns: ['col1'],
    classification: 'both',
  });
  assert(full.success, 'full input accepted');

  console.log('\n── enum rejections ──');
  assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', classification: 'business', direction: 'sideways' as any }).success,
    'invalid direction rejected',
  );
  assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', classification: 'business', depth_enforcement: 'mandatory' as any }).success,
    'invalid depth_enforcement rejected',
  );

  console.log('\n── depth type coercion / rejections ──');
  // String numerics are coerced to numbers (LLMs frequently emit "10" instead of 10).
  const coercedDepth = StartExplorationInputSchema.safeParse({ origin: '[s].[t]', classification: 'business', depth: '2' as any });
  assert(coercedDepth.success && coercedDepth.data.depth === 2, 'string "2" coerced to number 2');
  assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', classification: 'business', depth: 0 }).success,
    'zero depth rejected (must be positive)',
  );
  assert(
    !StartExplorationInputSchema.safeParse({ origin: '[s].[t]', classification: 'business', depth: -1 }).success,
    'negative depth rejected',
  );

  console.log('\n── regression: the incident payload ──');
  // The second start_exploration call that crashed the extension:
  // {"maxDepth":"1","mission_brief":"..."} — origin missing entirely.
  const incident = StartExplorationInputSchema.safeParse({
    maxDepth: '1',
    mission_brief: 'User wants to analyze...',
    classification: 'business',
  } as any);
  assert(!incident.success, 'incident payload (no origin) rejected cleanly — no crash');
  if (!incident.success) {
    // Schema accepts either `origin` (fresh exploration) or `supplement.nodeIds`
    // (post-synthesis follow-up). A payload missing both is rejected at the root
    // via a refine; the message names both options so the AI can self-correct.
    const msg = incident.error.issues.map(i => i.message).join(' | ');
    assert(
      /origin/i.test(msg) && /supplement/i.test(msg),
      `rejection message names both 'origin' and 'supplement' (got: ${msg})`,
    );
  }

  printSummary('start-exploration-schema');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
