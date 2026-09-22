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
import { EMPTY_AI_TEMPLATES, type AiOutputTemplates } from '../../../src/ai/session/types';
import { buildActiveHopInstruction } from '../../../src/ai/agent/stagePrompts';
import type { NavigationEngine } from '../../../src/ai/sm/smBase';

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
    expect(() => sess.requireLockedClassification(), 'missing locked classification fails closed').toThrow();
    expect(() => sess.setClassification('invalid' as any), 'invalid value throws').toThrow();
  });
});

const gatingTemplates: AiOutputTemplates = {
  ...EMPTY_AI_TEMPLATES,
  business_capture: 'Capture the business meaning and any decision-impacting data-quality caveat.',
  technical_capture: 'Capture the physical shape, join risk, and load pattern.',
};

function gatingSession(classification: 'business' | 'technical' | 'both'): AiSession {
  return {
    outputTemplates: gatingTemplates,
    classification,
    memory: {
      slotCount: 3,
      getShortTermMemory: () => [],
      getRecentRejections: () => [],
    },
  } as unknown as AiSession;
}

function gatingEngine(): NavigationEngine {
  return {
    columnAspect: undefined,
    getCurrentTasks: () => [],
    pendingLineageQuestions: [],
    requiredNeighborIds: () => [],
    peekHopContext: () => null,
  } as unknown as NavigationEngine;
}

describe('classification gating provenance', () => {
  it('names the capture key the locked classification excluded', () => {
    const technical = buildActiveHopInstruction(gatingSession('technical'), gatingEngine(), '[ai].[vworders]');
    expect(technical.classificationGatedKeys).toContain('business_capture');
    expect(technical.templateKeys).toContain('technical_capture');
    expect(technical.templateKeys).not.toContain('business_capture');

    const business = buildActiveHopInstruction(gatingSession('business'), gatingEngine(), '[ai].[vworders]');
    expect(business.classificationGatedKeys).toContain('technical_capture');
    expect(business.templateKeys).toContain('business_capture');
  });

  it('reports nothing gated when the classification requests both angles', () => {
    const both = buildActiveHopInstruction(gatingSession('both'), gatingEngine(), '[ai].[vworders]');
    expect(both.classificationGatedKeys).toEqual([]);
    expect(both.templateKeys).toEqual(expect.arrayContaining(['business_capture', 'technical_capture']));
  });
});
