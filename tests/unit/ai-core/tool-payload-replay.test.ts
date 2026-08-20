import { describe, expect, it } from 'vitest';
import { SubmitFindingsBbInputSchema } from '../../../src/ai/tools/toolSchemas';
import { loadToolPayloadFixture, replayToolPayload } from './helpers/toolPayloadReplay';

/**
 * T10b (B2) — red-first replay harness.
 *
 * @remarks
 * `submit-findings-badge-label-overflow.json` is shaped from an archived UAT payload
 * (`test-results/archive/2026-08-17-uat-solved/trace-2026-08-17T13-27-30-205Z.ndjson`, n15
 * spLoadSalesStaging, requestId `8216d38d…`) that fails only on `badge_label` exceeding the
 * schema's 50-character cap — the same rejection class the tracked C2 suite
 * (`vscode-model-port.prose-tool-call.test.ts`) pins for the fenced-prose-promotion path. This
 * file replays it without a provider, session, or graph: `replayToolPayload` runs the identical
 * schema + Zod-error reader `VscodeModelPort.generateToolTurn` applies at dispatch, so the
 * rejection class is a deterministic, zero-model-call assertion rather than something only visible
 * inside a live UAT trace.
 */
describe('tool payload replay (T10b/B2)', () => {
  it('reproduces the archived badge_label-overflow rejection class deterministically', () => {
    const payload = loadToolPayloadFixture('submit-findings-badge-label-overflow');
    const verdict = replayToolPayload(SubmitFindingsBbInputSchema, payload);

    expect(verdict.accepted).toBe(false);
    if (verdict.accepted) throw new Error('unreachable');
    expect(verdict.rejectionCode).toBe('invalid_tool_input');
    expect(verdict.issuePaths).toEqual(['badge_label']);
    expect(verdict.reason).toContain('badge_label');
    expect(verdict.reason).toContain('55 chars');
    expect(verdict.reason).toContain('limit 50');

    // Replaying the same archived fixture twice must yield byte-identical verdicts — no hidden
    // state, no schema-instance reuse artifact.
    const second = replayToolPayload(SubmitFindingsBbInputSchema, loadToolPayloadFixture('submit-findings-badge-label-overflow'));
    expect(second).toEqual(verdict);
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
