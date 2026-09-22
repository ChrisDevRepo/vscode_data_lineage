import { z } from 'zod';
import { hoistSectionNotes, repairArrayBoundaryArtifacts } from '../../../src/ai/support/inputNormalization';
import {
  PresentResultSynthesisModelSchema,
  presentResultRepairPatchSchemaForFields,
  presentResultSchemaForPhase,
} from '../../../src/ai/tools/toolSchemas';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { describe, expect, it } from 'vitest';

/**
 * Measured 2026-09-16 on `m18-close-azure-foundry` run-T8S
 * (`run-T8S/lm-trace/trace-2026-09-16T17-57-31-092Z.ndjson`, provider-raw lines 56 and 64): Azure's
 * own non-streaming `lineage_present_result` tool-call body corrupted an array-element boundary —
 * the structural `},{` that should close one `sections` element and open the next arrived instead as
 * a quoted property key, with whatever followed swept into that key's string value. Call 7's swept
 * value carried two complete further sections (fully recoverable); call 8's swept value was a bare
 * fragment with nothing inside it (a pure, logged drop). Two of the run's three synthesis
 * semantic-failure strikes were spent on this before `repairArrayBoundaryArtifacts`
 * (`src/ai/support/inputNormalization.ts`) started rejoining/dropping it ahead of the
 * `.strict()` parse. Fixtures below mirror the SHAPE of both measured payloads (a
 * structural-punctuation-only key whose value is either a rejoinable tail or an unrecoverable
 * fragment) without repeating the measured question's content, so the predicate under test —
 * "a key built solely from JSON structural characters is an array-element-boundary artifact,
 * general over any array of objects" — is exercised generically, using two different artifact-key
 * spellings (`},{`) and (`,`) to prove the fix is not keyed to one literal token.
 */
describe('present_result array-boundary repair (T8S-SYNTHESIS-ABANDONED)', () => {
  const minimalSynthesisPayload = (sections: unknown) => ({
    name: 'n',
    summary: 's',
    highlight_groups: [{ label: 'Source', color: 'source' as const, node_ids: ['x'] }],
    sections,
  });

  // Shape of call 7 (line 56): one section whose swept boundary value decodes back into two
  // further complete sections.
  const recoverableSections = [
    {
      label: 'A',
      node_ids: ['n1'],
      text: 'ta',
      '},{': 'label":"B","node_ids":["n2"],"text":"tb"},{"label":"C","node_ids":["n3"],"text":"tc"}],',
    },
  ];

  // Shape of call 8 (line 64): a correctly-parsed multi-section array where one section additionally
  // carries a vestigial boundary key whose value has nothing recoverable inside it. A different
  // artifact-key spelling (a bare `,`) than the case above, to prove the predicate is general.
  const vestigialSections = [
    { label: 'A', node_ids: ['n1'], text: 'ta', ',': ',' },
    { label: 'B', node_ids: ['n2'], text: 'tb' },
  ];

  it('RED: the underlying strict schema rejects the recoverable boundary artifact unchanged', () => {
    const parsed = PresentResultSynthesisModelSchema.safeParse(minimalSynthesisPayload(recoverableSections));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(JSON.stringify(parsed.error.issues)).toContain('sections');
  });

  it('RED: the underlying strict schema rejects the vestigial boundary artifact unchanged', () => {
    const parsed = PresentResultSynthesisModelSchema.safeParse(minimalSynthesisPayload(vestigialSections));
    expect(parsed.success).toBe(false);
  });

  it('(a) GREEN: a recoverable artifact value rejoins the array — the two further sections are recovered, nothing lost', () => {
    const schema = presentResultSchemaForPhase('synthesis');
    const parsed = schema.safeParse(minimalSynthesisPayload(recoverableSections));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const data = parsed.data as { sections: Array<{ label: string; text: string }> };
    expect(data.sections.map((s) => s.label)).toEqual(['A', 'B', 'C']);
    expect(data.sections.map((s) => s.text)).toEqual(['ta', 'tb', 'tc']);
    expect(data.sections.every((s) => !('},{' in s))).toBe(true);
  });

  it('(b) GREEN: a vestigial artifact with nothing recoverable is dropped, the element and its real fields survive, array length unchanged', () => {
    const schema = presentResultSchemaForPhase('synthesis');
    const parsed = schema.safeParse(minimalSynthesisPayload(vestigialSections));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const data = parsed.data as { sections: Array<{ label: string; text: string }> };
    expect(data.sections.map((s) => s.label)).toEqual(['A', 'B']);
    expect(data.sections.every((s) => !(',' in s))).toBe(true);
  });

  it('(b) the drop is logged, never silent: repairArrayBoundaryArtifacts removes exactly the artifact key', () => {
    const repaired = repairArrayBoundaryArtifacts(minimalSynthesisPayload(vestigialSections)) as {
      sections: Array<Record<string, unknown>>;
    };
    expect(Object.keys(repaired.sections[0])).toEqual(['label', 'node_ids', 'text']);
  });

  it('(c) GREEN vs REJECT: a genuinely unknown key that is not a structural artifact still rejects', () => {
    const schema = presentResultSchemaForPhase('synthesis');
    const parsed = schema.safeParse(minimalSynthesisPayload([
      { label: 'A', node_ids: ['n1'], text: 'ta', totally_unknown_field: 'nope' },
    ]));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(JSON.stringify(parsed.error.issues)).toMatch(/totally_unknown_field|Unrecognized/);
  });

  it('(d) hoistSectionNotes keeps its existing behavior unchanged, composed with the new repair', () => {
    const withNestedNotes = [
      { label: 'A', node_ids: ['n1'], text: 'ta' },
      { label: 'B', node_ids: ['n2'], text: 'tb', notes: [{ node_id: 'n2', text: 'a caption' }] },
    ];
    const schema = presentResultSchemaForPhase('synthesis');
    const parsed = schema.safeParse(minimalSynthesisPayload(withNestedNotes));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const data = parsed.data as { sections: Array<{ notes?: unknown }>; notes?: Array<{ node_id: string }> };
    expect(data.sections.every((s) => !('notes' in s))).toBe(true);
    expect(data.notes?.map((n) => n.node_id)).toEqual(['n2']);

    // hoistSectionNotes called directly is still a no-op on a payload with no nested notes — pinned
    // unchanged from the sibling suite.
    const clean = minimalSynthesisPayload([{ label: 'A', node_ids: ['n1'], text: 'ta' }]);
    expect(hoistSectionNotes(clean)).toBe(clean);
  });

  it('(d) a recovered section carrying its own nested notes is hoisted too (repair runs before hoist)', () => {
    const sections = [
      {
        label: 'A',
        node_ids: ['n1'],
        text: 'ta',
        '},{': 'label":"B","node_ids":["n2"],"text":"tb","notes":[{"node_id":"n2","text":"a caption"}]}],',
      },
    ];
    const schema = presentResultSchemaForPhase('synthesis');
    const parsed = schema.safeParse(minimalSynthesisPayload(sections));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const data = parsed.data as { sections: Array<{ label: string }>; notes?: Array<{ node_id: string }> };
    expect(data.sections.map((s) => s.label)).toEqual(['A', 'B']);
    expect(data.notes?.map((n) => n.node_id)).toEqual(['n2']);
  });

  it('a payload with no array-boundary artifact is passed through unchanged (no-op)', () => {
    const clean = minimalSynthesisPayload([{ label: 'A', node_ids: ['n1'], text: 'ta' }]);
    expect(repairArrayBoundaryArtifacts(clean)).toBe(clean);
  });

  it('repair patch: a recoverable artifact on an authorized `sections` field rejoins the array', () => {
    const schema = presentResultRepairPatchSchemaForFields(['sections']);
    const parsed = schema.safeParse({ is_update: true, sections: recoverableSections });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const data = parsed.data as { sections?: Array<{ label: string }> };
    expect(data.sections?.map((s) => s.label)).toEqual(['A', 'B', 'C']);
  });

  it('model-facing JSON schema stays byte-identical through the wrap (io: "input" transparency)', () => {
    const wrapped = toModelJsonSchema(z.preprocess(repairArrayBoundaryArtifacts, PresentResultSynthesisModelSchema));
    const plain = toModelJsonSchema(PresentResultSynthesisModelSchema);
    expect(JSON.stringify(wrapped)).toBe(JSON.stringify(plain));

    const wrappedPhase = toModelJsonSchema(presentResultSchemaForPhase('synthesis'));
    expect(JSON.stringify(wrappedPhase)).toBe(JSON.stringify(plain));
  });
});
