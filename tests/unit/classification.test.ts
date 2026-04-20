/**
 * Unit tests for the classification gate (mission-type inference).
 *
 * Covers:
 *   ClassificationSchema — Zod enum rejects invalid values
 *   inferClassificationFromText — heuristic defaults + both-signal handling
 *   AiSession.setClassification — stores value, reset clears it
 */

import { assert, printSummary } from './helpers/testUtils';
import {
  ClassificationSchema,
  inferClassificationFromText,
  CLASSIFICATION_BANNER,
} from '../../src/ai/classification';
import { AiSession } from '../../src/ai/session';

async function runTests() {
  console.log('\n══════ classification tests ══════');

  // Zod enum
  console.log('\n── ClassificationSchema ──');
  assert(ClassificationSchema.safeParse('business').success, 'business accepted');
  assert(ClassificationSchema.safeParse('technical').success, 'technical accepted');
  assert(ClassificationSchema.safeParse('both').success, 'both accepted');
  assert(!ClassificationSchema.safeParse('other').success, 'invalid value rejected');
  assert(!ClassificationSchema.safeParse('').success, 'empty string rejected');
  assert(!ClassificationSchema.safeParse(undefined as any).success, 'undefined rejected');

  // inferClassificationFromText — pure heuristic
  console.log('\n── inferClassificationFromText (heuristic) ──');
  assert(inferClassificationFromText('') === 'business', 'empty → business default');
  assert(inferClassificationFromText('   ') === 'business', 'whitespace → business default');
  assert(
    inferClassificationFromText('What is the business meaning of TotalRevenue?') === 'business',
    'business keyword → business',
  );
  assert(
    inferClassificationFromText('Explain the impact on downstream consumers') === 'business',
    'explain + impact → business',
  );
  assert(
    inferClassificationFromText('What join strategy does spLoadFact use and is performance good?') === 'both',
    'join + performance + what → both (technical + business signals)',
  );
  assert(
    inferClassificationFromText('Check for antipatterns in the join predicates') === 'technical',
    'antipattern + join (no business signal) → technical',
  );
  assert(
    inferClassificationFromText('How does this procedure run — show me the execution plan') === 'technical',
    'how does + execution → technical',
  );
  assert(
    inferClassificationFromText('Describe the pipeline performance') === 'both',
    'describe (business) + performance (technical) → both',
  );

  // Banner text
  console.log('\n── CLASSIFICATION_BANNER ──');
  assert(CLASSIFICATION_BANNER.business.includes('business-driven'), 'business banner text');
  assert(CLASSIFICATION_BANNER.technical.includes('technical-driven'), 'technical banner text');
  assert(CLASSIFICATION_BANNER.both.includes('business + technical'), 'both banner text');

  // AiSession integration
  console.log('\n── AiSession.setClassification ──');
  {
    const sess = new AiSession();
    assert(sess.classification === undefined, 'default undefined');

    sess.setClassification('technical');
    assert(sess.classification === 'technical', 'set to technical');

    sess.setClassification('both');
    assert(sess.classification === 'both', 'set to both');

    // resetExploration clears it
    sess.resetExploration();
    assert(sess.classification === undefined, 'cleared on resetExploration');

    // Zod rejects invalid
    let threw = false;
    try {
      sess.setClassification('invalid' as any);
    } catch {
      threw = true;
    }
    assert(threw, 'invalid value throws');
  }

  printSummary('classification');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
