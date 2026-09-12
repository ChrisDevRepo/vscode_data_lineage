/**
 * Wave 2 pinning tests.
 *
 * @remarks
 * W2.2a — `validatePresentResult`'s unknown-node-id repair hint named `lineage_search_objects`
 * unconditionally, but `toolPolicy.ts` exposes that tool only in the `completed` stage —
 * `visual_preview` and `synthesis` see `lineage_present_result` alone. Naming an off-policy tool
 * there guarantees a caller-impossible retry. Pins that the hint is stage-aware: no tool name
 * leaks into the preview/synthesis wording, and the `completed` wording is unchanged.
 *
 * W2.2b — `NavigationEngine.init`'s `origin_not_found` hint named `get_context`, but
 * `start_exploration` (which drives `init`) is callable only from stages whose tool policy never
 * includes `get_context` (`sm_entry`: search_objects + start_exploration only). Pins the hint no
 * longer names that unavailable tool.
 *
 * W2.3 — `HopVerdictSchema` was a single shared description reused by both the BB and CT
 * `submit_findings` schemas, worded with the BB-only "business/technical logic" framing. In CT
 * mode the model then read two incompatible definitions of `analyze` (system prompt CT protocol
 * vs. schema description). Pins that CT's schema description no longer carries the BB phrase and
 * BB's no longer carries the CT-only "terminal source" phrase.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NavigationEngine } from '../../../src/ai/sm/smBase';
import { orderAndAssemble, validatePresentResult } from '../../../src/ai/tools/presentResult';
import { SubmitFindingsBbInputSchema, SubmitFindingsCtInputSchema } from '../../../src/ai/tools/toolSchemas';
import { makeGraph } from '../helpers/testUtils';
import { makeModel, makeNode } from '../sm/helpers/fixtures';

type JsonSchemaWithProps = { properties?: Record<string, { description?: string }> };

describe('Wave 2 pins', () => {
  describe('W2.2a — present_result unknown-node-id hint is stage-aware', () => {
    const buildUnknownIdFailure = (stage: Parameters<typeof validatePresentResult>[6]) => {
      const sections = [{ label: 'Source', node_ids: ['unknown_node'], text: 'One.' }];
      const assembled = orderAndAssemble(sections);
      return validatePresentResult(
        {
          name: 'ok',
          summary: 'ok',
          sections,
          highlight_groups: [{ label: 'Flow', color: 'source' as const, node_ids: [] }],
        },
        ['a'],
        assembled.badges,
        assembled.description,
        false,
        [],
        stage,
      );
    };

    it('visual_preview rejection names no tool the stage does not have', () => {
      const result = buildUnknownIdFailure('visual_preview');
      if (result.success) throw new Error('unknown node id must reject');
      expect(result.hint).not.toContain('lineage_search_objects');
      expect(result.errors.join(' ')).not.toContain('lineage_search_objects');
    });

    it('synthesis rejection names no tool the stage does not have', () => {
      const result = buildUnknownIdFailure('synthesis');
      if (result.success) throw new Error('unknown node id must reject');
      expect(result.hint).not.toContain('lineage_search_objects');
      expect(result.errors.join(' ')).not.toContain('lineage_search_objects');
    });

    it('completed rejection still points at lineage_search_objects', () => {
      const result = buildUnknownIdFailure('completed');
      if (result.success) throw new Error('unknown node id must reject');
      expect(result.hint).toContain('lineage_search_objects');
    });
  });

  describe('W2.2b — origin_not_found hint names no unavailable tool', () => {
    it('never mentions get_context, the sole caller stage never has it', () => {
      const nodes = [makeNode({ id: 'origin', schema: 'dbo', name: 'origin', type: 'procedure' })];
      const model = makeModel(nodes, [], ['dbo']);
      const graph = makeGraph(nodes, []);
      const engine = new NavigationEngine(model, graph, () => {}, {});

      const result = engine.init({ origin: 'no_such_origin', question: 'q', direction: 'downstream' });
      expect('error' in result && result.error).toBe('origin_not_found');
      expect('hint' in result ? result.hint : '').not.toContain('get_context');
    });
  });

  describe('W2.3 — CT/BB verdict schema descriptions do not cross-contaminate', () => {
    it('CT schema description carries no BB-only "business/technical logic" phrase', () => {
      const jsonSchema = z.toJSONSchema(SubmitFindingsCtInputSchema) as JsonSchemaWithProps;
      expect(jsonSchema.properties?.verdict?.description ?? '').not.toContain('business/technical logic');
    });

    it('BB schema description carries no CT-only "terminal source" phrase', () => {
      const jsonSchema = z.toJSONSchema(SubmitFindingsBbInputSchema) as JsonSchemaWithProps;
      expect(jsonSchema.properties?.verdict?.description ?? '').not.toContain('terminal source');
    });
  });
});
