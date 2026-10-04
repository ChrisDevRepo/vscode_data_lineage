/** Wire findings, typed engine findings and held drafts share strict mode-specific fields. */
import { describe, expect, it } from 'vitest';
import { heldHopFindingSchemaForMode, submitFindingsSchemaForMode, validateHopSubmissionShape } from '../../../src/ai/tools/toolSchemas';

const kept = { focus_node_id: '[hop].[focus]', verdict: 'analyze', summary: 'Observed SQL.', sections: [{ angle: 'technical', text: 'Observed SQL.' }] };
describe('shared typed hop admission', () => {
  
  it.each([
    { unexpected: true }, { sections: { technical: 'Wrong wire shape.' } }, { sections: [{ angle: 'business', text: 'Wrong classification.' }] },
    { sections: [{ angle: 'technical', text: 'A', unexpected: true }] }, { verdict: 'unknown' }, { column_flow: [] },
    { questions: [{ nodeId: 'next', question: 'Check.', caller_context: { node: 'focus', col: 'Value' } }] },
  ])('rejects typed BB fields outside the active contract: %j', patch => {
    expect(validateHopSubmissionShape({ ...kept, ...patch }, 'bb', 'technical', true).ok).toBe(false);
  });
  it('requires explicit CT flow instead of inventing an empty terminal', () => {
    expect(validateHopSubmissionShape(kept, 'ct', 'technical', true).ok).toBe(false);
    expect(validateHopSubmissionShape({ ...kept, column_flow: [] }, 'ct', 'technical', true).ok).toBe(true);
  });
  it('retains incomplete safe repair content without relaxing full CT admission', () => {
    const held = { ...kept, summary: '', sections: [] };
    expect(heldHopFindingSchemaForMode('ct').safeParse(held).success).toBe(true);
    expect(validateHopSubmissionShape(held, 'ct', 'technical', false).ok).toBe(false);
    expect(heldHopFindingSchemaForMode('bb').safeParse({ ...held, column_flow: [] }).success).toBe(false);
    expect(heldHopFindingSchemaForMode('bb').safeParse({ ...held, questions: [{ nodeId: 'next', question: 'Check.', caller_context: { node: 'focus', col: 'Value' } }] }).success).toBe(false);
  });
  it('uses the same strict nested flow contract for wire and typed admission', () => {
    const flow = [{ out_col: 'Value', upstream_columns: [], unexpected: true }];
    expect(submitFindingsSchemaForMode('ct', 'technical', true).safeParse({ ...kept, sections: { technical: 'Observed SQL.' }, column_flow: flow }).success).toBe(false);
    expect(validateHopSubmissionShape({ ...kept, column_flow: flow }, 'ct', 'technical', true).ok).toBe(false);
  });
});
