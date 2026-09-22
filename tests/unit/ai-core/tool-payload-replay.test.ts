import { describe, expect, it } from 'vitest';
import { SUBMIT_FINDINGS_BADGE_LABEL_MAX, SubmitFindingsBbInputSchema } from '../../../src/ai/tools/toolSchemas';
import { loadToolPayloadFixture, replayToolPayload } from './helpers/toolPayloadReplay';

/**
 * T10b (B2) — replay harness for archived tool-call payloads.
 *
 * @remarks
 * `submit-findings-badge-label-overflow.json` is shaped from an archived UAT payload (the archived
 * UAT trace, n15 spLoadSalesStaging) whose only defect is a `badge_label` of 55 characters against a
 * 50-character cap. `replayToolPayload` runs the identical schema + Zod-error reader
 * `VscodeModelPort.generateToolTurn` applies at dispatch, without a provider, session, or graph.
 *
 * That cap is a CONTENT cap, and content caps are advertised in the JSON schema the model reads but
 * enforced by `NavigationEngine.submitFindings` — which rejects the field alone, states the measured
 * length, and holds the draft so the retry need not re-author the analysis. The archived payload
 * therefore clears this boundary and is judged by the engine; the engine-side rejection is pinned in
 * `tests/unit/sm/submit-findings-handler.test.ts`. A STRUCTURAL defect in the same archived payload
 * still reproduces here as the rejection class it always was.
 */
describe('tool payload replay (T10b/B2)', () => {
  it('carries the archived over-long badge_label through the boundary to the engine that owns it', () => {
    const payload = loadToolPayloadFixture('submit-findings-badge-label-overflow') as Record<string, unknown>;
    expect(String(payload.badge_label), 'the archived label is still over the cap').toHaveLength(SUBMIT_FINDINGS_BADGE_LABEL_MAX + 5);

    const verdict = replayToolPayload(SubmitFindingsBbInputSchema, payload);

    expect(verdict.accepted, 'a content cap is not a boundary rejection').toBe(true);
    if (!verdict.accepted) throw new Error('unreachable');
    expect(verdict.input.focus_node_id).toBe('[ai].[sploadsalesstaging]');
    expect(verdict.input.badge_label, 'the over-long label reaches the engine unmodified').toBe(payload.badge_label);

    // Replaying the same archived fixture twice must yield byte-identical verdicts — no hidden
    // state, no schema-instance reuse artifact.
    expect(replayToolPayload(SubmitFindingsBbInputSchema, loadToolPayloadFixture('submit-findings-badge-label-overflow'))).toEqual(verdict);
  });

  it('reproduces a structural rejection class deterministically', () => {
    const archived = loadToolPayloadFixture('submit-findings-badge-label-overflow') as Record<string, unknown>;
    const { focus_node_id: _missing, ...structurallyInvalid } = archived;

    const verdict = replayToolPayload(SubmitFindingsBbInputSchema, structurallyInvalid);

    expect(verdict.accepted, 'a missing required field is the schema\'s own rule').toBe(false);
    if (verdict.accepted) throw new Error('unreachable');
    expect(verdict.rejectionCode).toBe('invalid_tool_input');
    expect(verdict.issuePaths).toEqual(['focus_node_id']);
    expect(verdict.reason).toContain('focus_node_id');

    expect(replayToolPayload(SubmitFindingsBbInputSchema, structurallyInvalid)).toEqual(verdict);
  });

  it('accepts the same payload once badge_label is within the 50-character bound', () => {
    const archived = loadToolPayloadFixture('submit-findings-badge-label-overflow') as Record<string, unknown>;
    const repaired = { ...archived, badge_label: 'spLoadSalesStaging reload' };
    const verdict = replayToolPayload(SubmitFindingsBbInputSchema, repaired);

    expect(verdict.accepted).toBe(true);
    if (!verdict.accepted) throw new Error('unreachable');
    expect(verdict.input.focus_node_id).toBe('[ai].[sploadsalesstaging]');
    expect(verdict.input.badge_label).toBe('spLoadSalesStaging reload');
  });
});
