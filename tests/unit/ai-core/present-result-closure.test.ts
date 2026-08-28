/**
 * Closed-graph validation guard for present_result add/prune updates.
 */

import { describe, it } from 'vitest';
import {
  findDisconnectedViewNodes,
  isRepairablePresentResultFailure,
  mergePresentResultRepairPatch,
  orderAndAssemble,
  validatePresentResult,
} from '../../../src/ai/tools/presentResult';
import { PresentResultModelSchema, PresentResultRepairPatchSchema } from '../../../src/ai/tools/toolSchemas';
import { assert } from '../helpers/testUtils';

describe('Present Result Closure', () => {
  it('runs all present-result closure assertions', () => {
    console.log('Present Result Closure');
    console.log('='.repeat(40));

    {
      const withoutSections = PresentResultModelSchema.safeParse({
        name: 'Preview',
        summary: 'Bounded preview.',
        highlight_groups: [{ label: 'Target', color: 'target', node_ids: ['origin'] }],
      });
      assert(!withoutSections.success, 'model boundary requires sections for every new presentation');
    }

    {
      const nodeIds = ['origin', 'a', 'b', 'x'];
      const edges: Array<[string, string, string]> = [
        ['origin', 'a', 'read'],
        ['a', 'b', 'read'],
      ];

      const disconnected = findDisconnectedViewNodes(nodeIds, edges, 'origin');
      assert(disconnected.length === 1 && disconnected[0] === 'x', 'reports disconnected nodes from origin');
    }

    {
      const nodeIds = ['origin', 'a', 'b'];
      const edges: Array<[string, string, string]> = [
        ['origin', 'a', 'read'],
        ['a', 'b', 'read'],
      ];

      const disconnected = findDisconnectedViewNodes(nodeIds, edges, 'origin');
      assert(disconnected.length === 0, 'returns empty when view is closed');
    }

    {
      const assembled = orderAndAssemble([
        { label: 'Source Tables', node_ids: ['a', 'b'], text: 'Sources feed the calculation.' },
        { label: 'Output', text: 'The output table stores the result.' },
      ]);
      const result = validatePresentResult({
        name: 'ok',
        summary: 'ok',
        sections: [
          { label: 'Source Tables', node_ids: ['a', 'b'], text: 'Sources feed the calculation.' },
          { label: 'Output', text: 'The output table stores the result.' },
        ],
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
        notes: [
          { node_id: 'a', text: 'Source input for the calculation.' },
          { node_id: 'b', text: 'Second source input for the calculation.' },
        ],
      }, ['a', 'b', 'c'], assembled.badges, assembled.description);
      assert(result.success, 'allows unpreviewed graph nodes without notes or highlight colors');
    }

    {
      const assembled = orderAndAssemble([{ label: '', text: 'Missing label.' }]);
      const result = validatePresentResult({
        name: 'bad',
        summary: 'bad',
        sections: [{ label: '', text: 'Missing label.' }],
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
      }, ['a'], assembled.badges, assembled.description);
      assert(!result.success && result.errors.some(e => e.includes('Section label is required')), 'rejects empty section labels');
    }

    {
      const sections = [
        { label: 'Source Tables', text: 'One.' },
        { label: '1 Source Tables', text: 'Two.' },
      ];
      const assembled = orderAndAssemble(sections);
      const result = validatePresentResult({
        name: 'bad',
        summary: 'bad',
        sections,
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
      }, ['a'], assembled.badges, assembled.description);
      assert(!result.success && result.errors.some(e => e.includes('Duplicate section label')), 'rejects duplicate normalized labels');
    }

    {
      // Label brevity ("2-3 words") is prompt guidance, not a boundary rejection — a multi-word
      // label is structurally valid and must be accepted (Zod-only-rejection rule).
      const sections = [{ label: 'Very Long Section Label', text: 'Now accepted.' }];
      const assembled = orderAndAssemble(sections);
      const result = validatePresentResult({
        name: 'ok',
        summary: 'ok',
        sections,
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
        notes: [{ node_id: 'a', text: 'Highlighted node explanation.' }],
      }, ['a'], assembled.badges, assembled.description);
      assert(result.success, 'accepts multi-word section labels (no boundary word-count rejection)');
    }

    {
      const sections = [{ label: 'Output', node_ids: ['a'], text: '' }];
      const assembled = orderAndAssemble(sections);
      const result = validatePresentResult({
        name: 'bad',
        summary: 'bad',
        sections,
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
      }, ['a'], assembled.badges, assembled.description);
      assert(!result.success && result.errors.some(e => e.includes('missing text')), 'rejects empty section text');
    }

    // Formatting never rejects (UAT turn-9 class): the verbatim payloads that killed turn 9 must be
    // ACCEPTED — the webview renderer degrades invalid math to its original source text, and formatting
    // quality is measured by the offline harness, never by a runtime guard.
    {
      const sections = [{
        label: 'Deduplication',
        node_ids: ['a'],
        text: '$$\\text{DupRank} = \\text{ROW_NUMBER() OVER (PARTITION BY ColA)}$$',
      }];
      const assembled = orderAndAssemble(sections);
      const result = validatePresentResult({
        name: 'katex-underscore',
        summary: 'katex underscore',
        sections,
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
        notes: [{ node_id: 'a', text: 'Deduplication input node.' }],
      }, ['a'], assembled.badges, assembled.description);
      assert(
        result.success,
        'accepts block math the KaTeX renderer cannot parse (turn-9 payload 1 — formatting never rejects)',
      );
    }

    {
      const sections = [{
        label: 'Validation',
        node_ids: ['a'],
        text: "$$\\text{'%Unknown region%'}$$",
      }];
      const assembled = orderAndAssemble(sections);
      const result = validatePresentResult({
        name: 'katex-percent',
        summary: 'katex percent',
        sections,
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
        notes: [{ node_id: 'a', text: 'Validation input node.' }],
      }, ['a'], assembled.badges, assembled.description);
      assert(
        result.success,
        'accepts strict KaTeX failures such as unescaped percent signs (turn-9 payload 2)',
      );
    }

    {
      const sections = [{
        label: 'Discount Inputs',
        node_ids: ['a'],
        text: 'Uses `dbo.DiscountRules without closing the inline code span.',
      }];
      const assembled = orderAndAssemble(sections);
      const result = validatePresentResult({
        name: 'inline-code',
        summary: 'inline code',
        sections,
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
        notes: [{ node_id: 'a', text: 'Discount rules input node.' }],
      }, ['a'], assembled.badges, assembled.description);
      assert(
        result.success,
        'accepts an unmatched inline-code delimiter (formatting never rejects)',
      );
    }

    {
      const sections = [
        { label: 'Source', node_ids: ['a'], text: 'One.' },
        { label: 'Output', node_ids: ['a'], text: 'Two.' },
      ];
      const assembled = orderAndAssemble(sections);
      const result = validatePresentResult({
        name: 'bad',
        summary: 'bad',
        sections,
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
      }, ['a'], assembled.badges, assembled.description);
      assert(!result.success && result.errors.some(e => e.includes('already appears in section')), 'rejects same node linked to multiple final sections');
    }

    {
      const sections = [{ label: 'Source', node_ids: ['a'], text: 'One.' }];
      const assembled = orderAndAssemble(sections);
      const result = validatePresentResult({
        name: 'bad',
        summary: 'bad',
        sections,
        notes: [{ node_id: 'a', text: 'Source node explanation.' }],
        // highlight_groups intentionally omitted — this call tests runtime rejection of that.
      } as Parameters<typeof validatePresentResult>[0], ['a'], assembled.badges, assembled.description);
      assert(!result.success && result.errors.some(e => e.includes('highlight_groups[] is required')), 'rejects new renders without highlight_groups');
    }

    {
      // Regression guard: the legend waiver is gated on the engine-derived `isAmendment` param, NOT
      // the model's raw `is_update` flag. A raw is_update:true with no highlight_groups must STILL reject
      // when the engine did not classify the call an amendment (isAmendment defaults false).
      const sections = [{ label: 'Source', node_ids: ['a'], text: 'One.' }];
      const assembled = orderAndAssemble(sections);
      const result = validatePresentResult({
        name: 'bad',
        summary: 'bad',
        is_update: true,
        sections,
        notes: [{ node_id: 'a', text: 'Source node explanation.' }],
        // highlight_groups intentionally omitted — this call tests runtime rejection of that.
      } as Parameters<typeof validatePresentResult>[0], ['a'], assembled.badges, assembled.description);
      assert(!result.success && result.errors.some(e => e.includes('highlight_groups[] is required')), 'raw is_update:true does not waive highlight_groups (waiver is engine-derived)');
    }

    {
      // The amendment path (isAmendment=true — repair-merge or completed-phase update) waives the
      // legend requirement so a patch need not re-supply highlight_groups.
      const sections = [{ label: 'Source', node_ids: ['a'], text: 'One.' }];
      const assembled = orderAndAssemble(sections);
      const result = validatePresentResult({
        name: 'ok',
        summary: 'ok',
        sections,
        notes: [{ node_id: 'a', text: 'Source node explanation.' }],
        // highlight_groups intentionally omitted — isAmendment=true waives the requirement.
      } as Parameters<typeof validatePresentResult>[0], ['a'], assembled.badges, assembled.description, /* isAmendment */ true);
      assert(result.success, 'isAmendment=true waives the highlight_groups legend requirement');
    }

    {
      const sections = [{ label: 'Source', node_ids: ['a'], text: 'One.' }];
      const assembled = orderAndAssemble(sections);
      const result = validatePresentResult({
        name: 'ok',
        summary: 'ok',
        sections,
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
      }, ['a'], assembled.badges, assembled.description);
      assert(result.success, 'section-linked preview node needs no note (full note coverage is not required)');
    }

    {
      const sections = [{ label: 'Source', text: 'One.' }];
      const assembled = orderAndAssemble(sections);
      const result = validatePresentResult({
        name: 'bad',
        summary: 'bad',
        sections,
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
        notes: [],
      }, ['a'], assembled.badges, assembled.description);
      assert(!result.success && result.errors.some(e => e.includes('highlight_groups node_ids must be explained')), 'rejects highlighted nodes without section or note explanation');
      assert(!result.success && isRepairablePresentResultFailure(result), 'highlight explanation gap is repairable');
      // LEVER A regression: the reason names both resolution paths (add-to-section/note AND drop),
      // and the hint no longer forecloses the drop path or drags in the irrelevant unknown-ID hint.
      if (!result.success) {
        const reason = result.errors.find(e => e.includes('highlight_groups node_ids must be explained'))!;
        assert(reason.includes("add it to a section's node_ids[] or add a note naming it"), 'reason names the add-to-section/note resolution path');
        assert(reason.includes('drop it from highlight_groups[] if it is uncolored plumbing'), 'reason names the drop-from-highlight_groups resolution path');
        assert(result.hint.includes('sections') && result.hint.includes('notes') && result.hint.includes('highlight_groups'), 'hint names all three authorized repair fields');
        assert(!result.hint.includes('Keep all other fields (notes, summary, highlight_groups) exactly as submitted'), 'hint no longer forecloses the highlight_groups removal path');
        assert(!result.hint.includes('Use node IDs from the current result graph'), 'hint no longer appends the irrelevant unknown-ID resolution hint');
      }
    }

    // Mixed-failure aggregation: a repairable error (unexplained highlight) alongside a non-repairable
    // one (missing name) in the SAME call must NOT be repairable as a whole — every accumulated error
    // must be individually repairable.
    {
      const sections = [{ label: 'Source', text: 'One.' }];
      const assembled = orderAndAssemble(sections);
      const result = validatePresentResult({
        name: '',
        summary: 'bad',
        sections,
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
        notes: [],
      }, ['a'], assembled.badges, assembled.description);
      assert(!result.success && result.errors.includes('name is required'), 'mixed case still reports the non-repairable error');
      assert(!result.success && result.errors.some(e => e.includes('highlight_groups node_ids must be explained')), 'mixed case still reports the repairable error');
      assert(!result.success && !isRepairablePresentResultFailure(result), 'one non-repairable error in the batch makes the whole failure non-repairable');
    }

    {
      const fullDraft = {
        name: 'ok',
        summary: 'ok',
        sections: [{ label: 'Source', text: 'One.' }],
        highlight_groups: [{ label: 'Flow', color: 'source' as const, node_ids: ['a'] }],
      };
      const patch = PresentResultRepairPatchSchema.parse({
        is_update: true,
        notes: [{ node_id: 'a', text: 'Highlighted source node explanation.' }],
      });
      const repaired = mergePresentResultRepairPatch(fullDraft, patch, ['notes']);
      const assembled = orderAndAssemble(repaired.sections ?? []);
      const result = validatePresentResult(repaired, ['a'], assembled.badges, assembled.description);
      assert(result.success, 'repair patch can explain a highlighted node without reauthoring full draft');
    }

    {
      const badPatch = PresentResultRepairPatchSchema.safeParse({
        is_update: true,
        add_node_ids: ['x'],
      });
      assert(!badPatch.success, 'repair patch rejects graph-edit fields');
    }

    {
      const sections = [
        { label: 'Source', node_ids: ['a'], text: 'One.' },
        { label: 'Output', node_ids: ['a'], text: 'Two.' },
      ];
      const assembled = orderAndAssemble(sections);
      const result = validatePresentResult({
        name: 'bad',
        summary: 'bad',
        sections,
        highlight_groups: [{ label: 'Flow', color: 'source', node_ids: ['a'] }],
      }, ['a'], assembled.badges, assembled.description);
      assert(!result.success && isRepairablePresentResultFailure(result), 'duplicate section ownership authorizes a held-draft repair');
      assert(!result.success && result.repairFields.join(',') === 'sections', 'duplicate section ownership authorizes sections only');
    }

    // isRepairablePresentResultFailure reads the STRUCTURAL `repairable` field set at each `addError`
    // call site — never the error text. Hand-built failure shapes (not run through validatePresentResult)
    // prove the decoupling: wording that looks repairable/non-repairable must not sway the verdict.
    {
      const result = { success: false as const, errors: ['totally unrelated wording, nothing about highlight_groups'], hint: 'x', repairable: true, repairFields: ['notes'] as Array<'notes'> };
      assert(isRepairablePresentResultFailure(result), 'reads the structural flag, not the error text — decoupled from wording (would fail under the old string-match implementation)');
    }
    {
      const result = { success: false as const, errors: ['highlight_groups node_ids must be explained by sections'], hint: 'x', repairable: false, repairFields: [] };
      assert(!isRepairablePresentResultFailure(result), 'a false structural flag wins even when the error text looks like the old repairable-allowlist pattern');
    }

  });
});
