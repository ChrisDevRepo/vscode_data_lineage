import { z } from 'zod';
import { hoistSectionNotes } from '../../../src/ai/support/inputNormalization';
import {
  PresentResultSynthesisModelSchema,
  presentResultRepairPatchSchemaForFields,
  presentResultSchemaForPhase,
} from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { describe, expect, it } from 'vitest';

/**
 * Measured 2026-09-16 (SYNTHESIS-ABANDONED-3-SEMANTIC-FAILURES): the model repeatedly nests a
 * below-node caption list under the section it groups them with (`sections.N.notes`) instead of
 * `present_result`'s one legal home for that shape, the payload's top-level `notes[]`. Two
 * independent m17 azure-foundry captures (run-T7, run-T8) each burned their whole synthesis
 * semantic-failure budget on repeats of the identical placement mistake and ended with no answer at
 * all. The schema itself is unchanged (a section still strictly rejects an unrecognized `notes`
 * key) — {@link hoistSectionNotes} relocates the identically-shaped entries before that schema
 * parses, at the one call site (`presentResultSchemaForPhase`) that supplies every port's
 * pre-dispatch schema.
 */
describe('present_result section-notes hoist (SYNTHESIS-ABANDONED-3-SEMANTIC-FAILURES)', () => {
  const minimalSynthesisPayload = (sections: unknown) => ({
    name: 'n',
    summary: 's',
    highlight_groups: [{ label: 'Source', color: 'source' as const, node_ids: ['a'] }],
    sections,
  });

  const sectionsWithNestedNotes = [
    { label: 'Quantity path', node_ids: ['a'], text: 'text a' },
    {
      label: 'Price path',
      node_ids: ['b'],
      text: 'text b',
      notes: [{ node_id: 'b', text: 'a below-node caption' }],
    },
  ];

  it('RED: the underlying strict schema still rejects a section-nested notes key unchanged', () => {
    const parsed = PresentResultSynthesisModelSchema.safeParse(minimalSynthesisPayload(sectionsWithNestedNotes));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(JSON.stringify(parsed.error.issues)).toContain('sections');
  });

  it('GREEN: the phase-selected synthesis schema hoists the nested notes and accepts the call', () => {
    const schema = presentResultSchemaForPhase('synthesis');
    const parsed = schema.safeParse(minimalSynthesisPayload(sectionsWithNestedNotes));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const data = parsed.data as { sections: Array<{ notes?: unknown }>; notes?: Array<{ node_id: string; text: string }> };
    expect(data.sections.every((section) => !('notes' in section))).toBe(true);
    expect(data.notes).toEqual([{ node_id: 'b', text: 'a below-node caption' }]);
  });

  it('GREEN: hoisted entries merge after any notes already declared at the top level', () => {
    const schema = presentResultSchemaForPhase('synthesis');
    const parsed = schema.safeParse({
      ...minimalSynthesisPayload(sectionsWithNestedNotes),
      notes: [{ node_id: 'a', text: 'already top-level' }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const data = parsed.data as { notes?: Array<{ node_id: string }> };
    expect(data.notes?.map((note) => note.node_id)).toEqual(['a', 'b']);
  });

  it('GREEN: visual-preview and default phase selections hoist identically', () => {
    const preview = presentResultSchemaForPhase('visual_preview').safeParse({
      highlight_groups: [{ label: 'Source', color: 'source' as const, node_ids: ['a'] }],
      sections: sectionsWithNestedNotes,
    });
    expect(preview.success).toBe(true);

    const defaultPhase = presentResultSchemaForPhase(undefined).safeParse(minimalSynthesisPayload(sectionsWithNestedNotes));
    expect(defaultPhase.success).toBe(true);
  });

  it('a malformed hoisted entry still rejects, at the top-level notes path', () => {
    const schema = presentResultSchemaForPhase('synthesis');
    const parsed = schema.safeParse(minimalSynthesisPayload([
      { label: 'A', node_ids: ['a'], text: 'ta' },
      { label: 'B', node_ids: ['b'], text: 'tb', notes: [{ node_id: 'b' }] }, // missing required `text`
    ]));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(JSON.stringify(parsed.error.issues)).toContain('notes');
  });

  it('a payload with no section-nested notes is passed through unchanged (no-op)', () => {
    const clean = minimalSynthesisPayload([{ label: 'A', node_ids: ['a'], text: 'ta' }]);
    expect(hoistSectionNotes(clean)).toBe(clean);
  });

  it('repair patch: sections+notes both authorized together hoists the nested entry', () => {
    const schema = presentResultRepairPatchSchemaForFields(['sections', 'notes']);
    const parsed = schema.safeParse({ is_update: true, sections: sectionsWithNestedNotes });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const data = parsed.data as { notes?: unknown };
    expect(data.notes).toEqual([{ node_id: 'b', text: 'a below-node caption' }]);
  });

  it('repair patch: sections authorized without notes still rejects a section-nested notes key (no unauthorized-field leak)', () => {
    const schema = presentResultRepairPatchSchemaForFields(['sections']);
    const parsed = schema.safeParse({ is_update: true, sections: sectionsWithNestedNotes });
    expect(parsed.success).toBe(false);
  });

  it('model-facing JSON schema stays byte-identical through the wrap (io: "input" transparency)', () => {
    const wrapped = toModelJsonSchema(z.preprocess(hoistSectionNotes, PresentResultSynthesisModelSchema));
    const plain = toModelJsonSchema(PresentResultSynthesisModelSchema);
    expect(JSON.stringify(wrapped)).toBe(JSON.stringify(plain));
  });
});
