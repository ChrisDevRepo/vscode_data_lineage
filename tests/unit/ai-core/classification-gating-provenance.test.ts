import { describe, expect, it } from 'vitest';
import { EMPTY_AI_TEMPLATES, type AiOutputTemplates } from '../../../src/ai/session/types';
import { buildActiveHopInstruction } from '../../../src/ai/agent/stagePrompts';
import type { AiSession } from '../../../src/ai/session/session';
import type { NavigationEngine } from '../../../src/ai/sm/smBase';

const templates: AiOutputTemplates = {
  ...EMPTY_AI_TEMPLATES,
  business_capture: 'Capture the business meaning and any decision-impacting data-quality caveat.',
  technical_capture: 'Capture the physical shape, join risk, and load pattern.',
};

function session(classification: 'business' | 'technical' | 'both'): AiSession {
  return {
    outputTemplates: templates,
    classification,
    memory: {
      slotCount: 3,
      getShortTermMemory: () => [],
      getRecentRejections: () => [],
    },
  } as unknown as AiSession;
}

function engine(): NavigationEngine {
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
    const technical = buildActiveHopInstruction(session('technical'), engine(), '[ai].[vworders]');
    expect(technical.classificationGatedKeys).toContain('business_capture');
    expect(technical.templateKeys).toContain('technical_capture');
    expect(technical.templateKeys).not.toContain('business_capture');

    const business = buildActiveHopInstruction(session('business'), engine(), '[ai].[vworders]');
    expect(business.classificationGatedKeys).toContain('technical_capture');
    expect(business.templateKeys).toContain('business_capture');
  });

  it('reports nothing gated when the classification requests both angles', () => {
    const both = buildActiveHopInstruction(session('both'), engine(), '[ai].[vworders]');
    expect(both.classificationGatedKeys).toEqual([]);
    expect(both.templateKeys).toEqual(expect.arrayContaining(['business_capture', 'technical_capture']));
  });
});
