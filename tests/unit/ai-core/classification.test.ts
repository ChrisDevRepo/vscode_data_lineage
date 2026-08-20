/**
 * Unit tests for the classification gate.
 *
 * Covers:
 *   ClassificationSchema — Zod enum rejects invalid values
 *   AiSession classification contract — stores, requires, and resets the locked value
 */

import { describe, expect, it } from 'vitest';
import { ClassificationSchema } from '../../../src/ai/session/classification';
import { AiSession } from '../../../src/ai/session/session';

describe('classification', () => {
  it('ClassificationSchema accepts the three locked values and rejects everything else', () => {
    expect(ClassificationSchema.safeParse('business').success, 'business accepted').toBe(true);
    expect(ClassificationSchema.safeParse('technical').success, 'technical accepted').toBe(true);
    expect(ClassificationSchema.safeParse('both').success, 'both accepted').toBe(true);
    expect(ClassificationSchema.safeParse('other').success, 'invalid value rejected').toBe(false);
    expect(ClassificationSchema.safeParse('').success, 'empty string rejected').toBe(false);
    expect(ClassificationSchema.safeParse(undefined as any).success, 'undefined rejected').toBe(false);
  });

  it('AiSession.setClassification stores, locks, resets, and fails closed', () => {
    const sess = new AiSession();
    expect(sess.classification, 'default undefined').toBe(undefined);

    sess.setClassification('technical');
    expect(sess.classification, 'set to technical').toBe('technical');
    expect(sess.requireLockedClassification(), 'locked classification is returned').toBe('technical');

    sess.setClassification('both');
    expect(sess.classification, 'set to both').toBe('both');

    // resetExploration clears it
    sess.resetExploration();
    expect(sess.classification, 'cleared on resetExploration').toBe(undefined);
    let missingThrew = false;
    try {
      sess.requireLockedClassification();
    } catch {
      missingThrew = true;
    }
    expect(missingThrew, 'missing locked classification fails closed').toBe(true);

    // Zod rejects invalid
    let threw = false;
    try {
      sess.setClassification('invalid' as any);
    } catch {
      threw = true;
    }
    expect(threw, 'invalid value throws').toBe(true);
  });
});
