import { describe, expect, it } from 'vitest';
import { SUBMIT_FINDINGS_BADGE_LABEL_MAX, SubmitFindingsBbInputSchema } from '../../../src/ai/tools/toolSchemas';
import { loadToolPayloadFixture, replayToolPayload } from './helpers/toolPayloadReplay';

/**
 * Replay harness for archived tool-call payloads: `replayToolPayload` runs the identical schema +
 * Zod-error reader `VscodeModelPort.generateToolTurn` applies at dispatch, without a provider,
 * session, or graph. `submit-findings-badge-label-overflow.json`'s only defect is a `badge_label`
 * of 55 characters against a 50-character cap — a CONTENT cap, advertised in the JSON schema but
 * enforced by `NavigationEngine.submitFindings`, so the payload clears this boundary and is judged
 * by the engine (engine-side rejection pinned in `tests/unit/sm/submit-findings-handler.test.ts`).
 */
describe('tool payload replay', () => {
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
