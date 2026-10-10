/**
 * The synthesis system prompt states each report rule once. These checks pin the rules a recorded
 * run showed the report losing; they verify the instruction is served, not that a model follows it.
 */
import { describe, expect, it } from 'vitest';
import { buildSynthesisInstruction } from '../../../src/ai/agent/stagePrompts';
import { deriveStagePromptContext } from '../../../src/ai/prompting/hostPrompts';
import { AiSession } from '../../../src/ai/session/session';

function synthesisSystem(): string {
  const session = new AiSession();
  session.setClassification('business');
  return buildSynthesisInstruction(session, deriveStagePromptContext(null, null)).system;
}

describe('synthesis prompt contract', () => {
  it('retains question-led grouping and contextual formulas from the default branch', () => {
    const system = synthesisSystem();
    expect(system).toContain('grouped by what best answers the question');
    expect(system).toContain('Keep the final formula contextual too.');
    expect(system).not.toContain('one section per role in the answer');
  });

  it('carries row-dropping steps and the role of each captured input into the section text', () => {
    const system = synthesisSystem();
    expect(system).toContain('row-dropping steps (filters, inner joins, dedup)');
    expect(system).toContain('the role each captured input plays (value, filter-only or display-only)');
    expect(system.match(/row-dropping steps/g)).toHaveLength(1);
  });

  it('shows a reused SQL block as an opening line with its id followed by a closing line', () => {
    expect(synthesisSystem()).toContain('write two lines with nothing between them: the opening line with its id, then a bare closing ``` line');
  });
});
