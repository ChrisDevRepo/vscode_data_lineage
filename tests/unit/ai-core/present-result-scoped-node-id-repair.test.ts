/**
 * Scoped repair authorization for the three unknown-node-id rejection sites in
 * `validatePresentResult` (sections/notes/highlight_groups). Register row 46: a rejection naming
 * one field must not force the model to re-synthesize the entire payload — content in unauthorized
 * fields must survive the merge verbatim, and the merged draft must still clear full re-validation.
 */

import { describe, expect, it } from 'vitest';
import {
  isRepairablePresentResultFailure,
  mergePresentResultRepairPatch,
  orderAndAssemble,
  validatePresentResult,
} from '../../../src/ai/tools/presentResult';
import { presentResultRepairPatchSchemaForFields } from '../../../src/ai/tools/toolSchemas';

describe('Present Result — scoped unknown-node-id repair', () => {
  it('unknown node_ids in a section holds the draft repairable for sections only', () => {
    const sections = [
      { label: 'Source', node_ids: ['a', '[ai].[bogus]'], text: 'One.' },
      { label: 'Output', node_ids: ['a'], text: 'Two.' },
    ];
    const assembled = orderAndAssemble(sections);
    const result = validatePresentResult({
      name: 'ok',
      summary: 'ok',
      sections,
      highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
    }, ['a'], assembled.badges, assembled.description);

    expect(!result.success && result.errors.some(e => e.includes('unknown IDs')), 'reports the unknown-ID rejection').toBe(true);
    expect(!result.success && isRepairablePresentResultFailure(result), 'unknown section node_ids is now repairable').toBe(true);
    expect(!result.success && result.repairFields.join(','), 'repair authorization names sections only').toBe('sections');
  });

  it('the repair hint names only the offending field', () => {
    const sections = [{ label: 'Source', node_ids: ['a', '[ai].[bogus]'], text: 'One.' }];
    const assembled = orderAndAssemble(sections);
    const result = validatePresentResult({
      name: 'ok',
      summary: 'ok',
      sections,
      highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
    }, ['a'], assembled.badges, assembled.description);

    expect(!result.success && result.hint.startsWith('Fix sections only.'), 'hint names only sections').toBe(true);
    expect(!result.success && !result.hint.includes('notes') && !result.hint.includes('highlight_groups'),
      'hint does not drag in notes or highlight_groups').toBe(true);
  });

  it('unknown node_id in a note holds the draft repairable for notes only', () => {
    const sections = [{ label: 'Source', node_ids: ['a'], text: 'One.' }];
    const assembled = orderAndAssemble(sections);
    const result = validatePresentResult({
      name: 'ok',
      summary: 'ok',
      sections,
      highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
      notes: [{ node_id: '[ai].[bogus]', text: 'Bad note.' }],
    }, ['a'], assembled.badges, assembled.description);

    expect(!result.success && result.errors.some(e => e.includes('unknown ID')), 'reports the unknown note-ID rejection').toBe(true);
    expect(!result.success && isRepairablePresentResultFailure(result), 'unknown note node_id is now repairable').toBe(true);
    expect(!result.success && result.repairFields.join(','), 'repair authorization names notes only').toBe('notes');
    expect(!result.success && result.hint.startsWith('Fix notes only.'), 'hint names only notes').toBe(true);
  });

  it('unknown node_id in a highlight group holds the draft repairable for highlight_groups only', () => {
    const sections = [{ label: 'Source', node_ids: ['a'], text: 'One.' }];
    const assembled = orderAndAssemble(sections);
    const result = validatePresentResult({
      name: 'ok',
      summary: 'ok',
      sections,
      highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a', '[ai].[bogus]'] }],
    }, ['a'], assembled.badges, assembled.description);

    expect(!result.success && result.errors.some(e => e.includes('unknown IDs')), 'reports the unknown highlight-ID rejection').toBe(true);
    expect(!result.success && isRepairablePresentResultFailure(result), 'unknown highlight_groups node_ids is now repairable').toBe(true);
    expect(!result.success && result.repairFields.join(','), 'repair authorization names highlight_groups only').toBe('highlight_groups');
    expect(!result.success && result.hint.startsWith('Fix highlight_groups only.'), 'hint names only highlight_groups').toBe(true);
  });

  it('content in unauthorized fields survives the merge verbatim, and the merged draft still clears full re-validation', () => {
    const fullDraft = {
      name: 'ok',
      summary: 'ok',
      sections: [{ label: 'Source', node_ids: ['a', '[ai].[bogus]'], text: 'Sections text held intact.' }],
      highlight_groups: [{ label: 'Flow', color: 'source' as const, node_ids: ['a'] }],
      notes: [{ node_id: 'a', text: 'Accepted note text that must survive untouched.' }],
    };
    const assembled = orderAndAssemble(fullDraft.sections);
    const rejection = validatePresentResult(fullDraft, ['a'], assembled.badges, assembled.description);
    expect(!rejection.success && rejection.repairFields.join(','), 'rejection authorizes sections only').toBe('sections');

    // Model resends only the corrected sections collection, exactly the strict per-field patch
    // schema for the authorized field set — never notes or highlight_groups.
    const patchSchema = presentResultRepairPatchSchemaForFields(['sections']);
    const patch = patchSchema.parse({
      is_update: true,
      sections: [{ label: 'Source', node_ids: ['a'], text: 'Sections text held intact.' }],
    });
    const merged = mergePresentResultRepairPatch(fullDraft, patch, ['sections']);

    // Unauthorized fields survive verbatim.
    expect(merged.notes, 'notes survive the merge verbatim').toEqual(fullDraft.notes);
    expect(merged.highlight_groups, 'highlight_groups survive the merge verbatim').toEqual(fullDraft.highlight_groups);

    // The merged draft is re-validated in full, not accepted on the strength of the scoped patch
    // alone — an unrelated defect in an unauthorized field would still surface here.
    const mergedAssembled = orderAndAssemble(merged.sections ?? []);
    const finalResult = validatePresentResult(merged, ['a'], mergedAssembled.badges, mergedAssembled.description);
    expect(finalResult.success, 'merged draft with the corrected section passes full re-validation').toBe(true);
  });

  it('scoping a repair to one field cannot smuggle an untouched defect in another field through the merge', () => {
    // Held draft carries a `highlight_groups` defect (unknown ID) that this repair round did not
    // authorize (allowedFields hand-set to ['sections'] only, independent of what the real
    // validator would grant, to isolate the merge/re-validate safety net itself). The merge must
    // still be followed by full re-validation, so the untouched defect still surfaces.
    const fullDraft = {
      name: 'ok',
      summary: 'ok',
      sections: [{ label: 'Source', node_ids: ['a'], text: 'One.' }],
      highlight_groups: [{ label: 'Flow', color: 'source' as const, node_ids: ['[ai].[bogus-highlight-id]'] }],
    };
    const patchSchema = presentResultRepairPatchSchemaForFields(['sections']);
    const patch = patchSchema.parse({
      is_update: true,
      sections: [{ label: 'Source Renamed', node_ids: ['a'], text: 'One, corrected.' }],
    });
    const merged = mergePresentResultRepairPatch(fullDraft, patch, ['sections']);

    // The authorized field did change; the unauthorized one is carried over untouched.
    expect(merged.sections, 'the authorized field is replaced by the patch').toEqual(patch.sections);
    expect(merged.highlight_groups, 'the unauthorized field is carried over untouched').toEqual(fullDraft.highlight_groups);

    const mergedAssembled = orderAndAssemble(merged.sections ?? []);
    const finalResult = validatePresentResult(merged, ['a'], mergedAssembled.badges, mergedAssembled.description);

    expect(!finalResult.success, 'merged draft is still rejected on the untouched highlight_groups defect').toBe(true);
    expect(!finalResult.success && finalResult.errors.some(e => e.includes('unknown IDs')),
      'rejection still reports the unauthorized-field defect — authorizing sections did not waive full re-validation').toBe(true);
  });

  it('the strict repair patch schema rejects a patch naming a field outside the authorized set', () => {
    const patchSchema = presentResultRepairPatchSchemaForFields(['sections']);
    const badPatch = patchSchema.safeParse({
      is_update: true,
      sections: [{ label: 'Source', node_ids: ['a'], text: 'One.' }],
      notes: [{ node_id: 'a', text: 'Not authorized this round.' }],
    });
    expect(!badPatch.success, 'patch schema rejects an unauthorized field').toBe(true);
  });

  it('mergePresentResultRepairPatch throws on a key outside allowedFields (malformed-input path)', () => {
    const fullDraft = {
      name: 'ok',
      summary: 'ok',
      sections: [{ label: 'Source', node_ids: ['a'], text: 'One.' }],
      highlight_groups: [{ label: 'Flow', color: 'source' as const, node_ids: ['a'] }],
    };
    expect(() => mergePresentResultRepairPatch(
      fullDraft,
      { notes: [{ node_id: 'a', text: 'x' }] } as Parameters<typeof mergePresentResultRepairPatch>[1],
      ['sections'],
    )).toThrow('Unauthorized present_result repair field: notes');
  });

  it('unknown node_ids in a note combined with a non-repairable defect makes the whole failure non-repairable', () => {
    const sections = [{ label: 'Source', node_ids: ['a'], text: 'One.' }];
    const assembled = orderAndAssemble(sections);
    const result = validatePresentResult({
      name: '', // non-repairable: name is required
      summary: 'bad',
      sections,
      highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
      notes: [{ node_id: '[ai].[bogus]', text: 'Bad note.' }],
    }, ['a'], assembled.badges, assembled.description);

    expect(!result.success && result.errors.includes('name is required'), 'reports the non-repairable name defect').toBe(true);
    expect(!result.success && result.errors.some(e => e.includes('unknown ID')), 'reports the unknown note-ID defect').toBe(true);
    expect(!result.success && !isRepairablePresentResultFailure(result),
      'one non-repairable error in the batch makes the whole failure non-repairable').toBe(true);
  });
});
