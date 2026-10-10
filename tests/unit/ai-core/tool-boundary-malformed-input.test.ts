/** Invalid model payloads reject with every defect visible to the sender. */
import { describe, expect, it } from 'vitest';
import { buildStartExplorationReject } from '../../../src/ai/interaction/rules/startExplorationRules';
import { rejectionFromZodError } from '../../../src/ai/support/toolErrorEnvelope';
import {
  MergedSectionsSchema,
  StartExplorationInputSchema,
  presentResultSchemaForPhase,
} from '../../../src/ai/tools/toolSchemas';

const base = {
  name: 'Synthetic report', summary: 'Synthetic summary.',
  highlight_groups: [{ label: 'Origin', color: 'target', node_ids: ['origin'] }],
};

const stages = [
  ['catalog', presentResultSchemaForPhase()],
  ['external', presentResultSchemaForPhase('external')],
  ['synthesis', presentResultSchemaForPhase('synthesis')],
  ['completed', presentResultSchemaForPhase('completed')],
  ['retained', presentResultSchemaForPhase('completed', null, true)],
  ['preview', presentResultSchemaForPhase('visual_preview', null, false, 1)],
  ['repair', presentResultSchemaForPhase('synthesis', ['sections'])],
  ['preview repair', presentResultSchemaForPhase('visual_preview', ['sections'], false, 1)],
  ['merged', MergedSectionsSchema],
] as const;

describe('malformed present_result section entries', () => {
  it.each(stages)('rejects null and undefined entries without throwing in %s', (_stage, schema) => {
    for (const entry of [null, undefined]) {
      const input = { ...base, sections: [entry] };
      const parsed = schema.safeParse(input);
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error('Malformed section unexpectedly passed the boundary.');
      const rejection = rejectionFromZodError(parsed.error, { code: 'invalid_input', input, schema });
      expect(rejection.issuePaths).toContain('sections.0');
      expect(rejection.reason).toContain('sections[0]');
    }
  });

  it('reports malformed entries and duplicate valid labels together', () => {
    const schema = presentResultSchemaForPhase('synthesis');
    const parsed = schema.safeParse({ ...base, sections: [
      null,
      { label: 'Origin', node_ids: ['origin'], text: 'Synthetic detail.' },
      { label: ' origin ', node_ids: ['origin'], text: 'Synthetic detail.' },
    ] });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Malformed sections unexpectedly passed the boundary.');
    expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['sections', 0], code: 'invalid_type' }),
      expect.objectContaining({ path: ['sections', 2, 'label'], message: expect.stringContaining('Duplicate section label') }),
    ]));
  });
});

describe('start_exploration schema diagnostics', () => {
  it('discloses every invalid field in the same rejection', () => {
    const input = { origin: 8, classification: 9, analysisMode: 10, question: 11, excludeSchemas: 12 };
    const parsed = StartExplorationInputSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Malformed start unexpectedly passed the boundary.');
    const rejection = buildStartExplorationReject(parsed.error, input);
    expect(rejection.issuePaths).toEqual(expect.arrayContaining(Object.keys(input)));
    expect(rejection.detail).toMatchObject({ issues: expect.arrayContaining(Object.keys(input).map(path => expect.objectContaining({ path }))) });
    for (const path of Object.keys(input)) expect(rejection.reason).toContain(path);
  });
});
