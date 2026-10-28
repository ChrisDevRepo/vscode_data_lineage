/** Invalid model payloads reject with every defect visible to the sender. */
import { describe, expect, it } from 'vitest';
import { validateToolCandidate } from '../../../src/ai/support/toolValidation';
import {
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
  ['retained', presentResultSchemaForPhase('completed', true)],
  ['preview', presentResultSchemaForPhase('visual_preview', false, 1)],
] as const;

describe('malformed present_result section entries', () => {
  it.each(stages)('rejects null and undefined entries without throwing in %s', (_stage, schema) => {
    for (const entry of [null, undefined]) {
      const input = { ...base, sections: [entry] };
      const parsed = validateToolCandidate(schema, input);
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error('Malformed section unexpectedly passed the boundary.');
      const rejection = parsed.rejection;
      expect(rejection.issuePaths).toContain('sections.0');
      expect(rejection.errors).toContainEqual(expect.objectContaining({ path: 'sections.0', code: entry === null ? 'type' : 'missing' }));
    }
  });

  it('reports malformed entries and duplicate valid labels together', () => {
    const schema = presentResultSchemaForPhase('synthesis');
    const parsed = validateToolCandidate(schema, { ...base, sections: [
      null,
      { label: 'Origin', node_ids: ['origin'], text: 'Synthetic detail.' },
      { label: ' origin ', node_ids: ['origin'], text: 'Synthetic detail.' },
    ] });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Malformed sections unexpectedly passed the boundary.');
    expect(parsed.rejection.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'sections.0', code: 'type' }),
      expect.objectContaining({ path: 'sections.2.label', code: 'duplicate' }),
    ]));
  });
});

describe('start_exploration schema diagnostics', () => {
  it('discloses every invalid field in the same rejection', () => {
    const input = { origin: 8, classification: 9, analysisMode: 10, question: 11, excludeSchemas: 12 };
    const parsed = validateToolCandidate(StartExplorationInputSchema, input);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Malformed start unexpectedly passed the boundary.');
    const rejection = parsed.rejection;
    expect(rejection.issuePaths).toEqual(expect.arrayContaining(Object.keys(input)));
    expect(rejection.code).toBe('invalid_input');
    expect(rejection.errors?.map(error => error.path)).toEqual(expect.arrayContaining(Object.keys(input)));
  });
});
