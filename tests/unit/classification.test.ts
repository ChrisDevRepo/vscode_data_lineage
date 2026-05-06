/**
 * Unit tests for the classification gate.
 *
 * Covers:
 *   ClassificationSchema — Zod enum rejects invalid values
 *   AiSession.setClassification — stores value, reset clears it
 */

import { assert, printSummary } from './helpers/testUtils';
import {
  ClassificationSchema,
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
