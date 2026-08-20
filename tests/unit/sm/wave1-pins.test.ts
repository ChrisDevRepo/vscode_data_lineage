/**
 * Wave 1 pinning tests.
 *
 * @remarks
 * W1.1 — badge_label's 50-char cap is Zod-enforced but was never stated in the field's
 * `.describe()`, which burned retries on `invalid_tool_input` in real e2e runs. Pins that both
 * submit-findings schemas now disclose the cap in their model-facing description.
 *
 * W1.2 — the compose round (`phase: 'compose'`) was the only model call in the pipeline with no
 * `system` key on the wire, even though its output (the discovery summary) rides every later hop
 * as established fact. Pins that the compose instruction plan now carries a non-empty, grounded
 * `@lineage` system prompt.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  SubmitFindingsBbInputSchema,
  SubmitFindingsModelSchema,
} from '../../../src/ai/tools/toolSchemas';
import { compileInstructionPlan } from '../../../src/ai/agent/instructionPlan';
import { DISCOVERY_SUMMARY_COMPOSE_SYSTEM_PROMPT } from '../../../src/ai/agent/graph';
import { modelUserMessage } from '../../../src/ai/model/modelPort';

type JsonSchemaWithProps = { properties?: Record<string, { description?: string }> };

describe('Wave 1 pins', () => {
  describe('W1.1 — badge_label cap disclosure', () => {
    it('SubmitFindingsBbInputSchema badge_label describe states the 50-char cap', () => {
      const jsonSchema = z.toJSONSchema(SubmitFindingsBbInputSchema) as JsonSchemaWithProps;
      expect(jsonSchema.properties?.badge_label?.description ?? '').toContain('Maximum 50 characters');
    });

    it('SubmitFindingsModelSchema badge_label describe states the 50-char cap', () => {
      const jsonSchema = z.toJSONSchema(SubmitFindingsModelSchema) as JsonSchemaWithProps;
      expect(jsonSchema.properties?.badge_label?.description ?? '').toContain('Maximum 50 characters');
    });
  });

  describe('W1.2 — compose round system prompt', () => {
    it('the compose instruction plan carries a non-empty @lineage system prompt', () => {
      const plan = compileInstructionPlan({
        kind: 'text',
        phase: 'compose',
        system: DISCOVERY_SUMMARY_COMPOSE_SYSTEM_PROMPT,
        messages: [modelUserMessage('Compose the discovery summary.')],
      });

      expect(plan.input.system).toBeTruthy();
      expect(plan.input.system).toContain('@lineage');
    });
  });
});
