import {
  activeSubmitFindingsRecoveryHint,
  mapSubmitFindingsEngineGuard,
  validateSectionsAgainstClassification,
} from '../../../src/ai/interaction/rules/submitFindingsRules';
import { describe, expect, it } from 'vitest';

// `filterSectionsForClassification` (the silent commit-time drop) is removed: an off-lock angle
// can no longer be authored at all, since `submitFindingsSchemaForMode` (`toolSchemas.ts`) narrows
// the per-dispatch `sections[].angle` enum to the locked classification's kept angle(s) before the
// model is dispatched. Schema-narrowing coverage (business lock rejects a technical section with a
// kept-angle hint; both lock accepts both; business lock accepts business-only) now lives in
// `submit-findings-schema.test.ts`, next to the other `submitFindingsSchemaForMode` behavior. What
// remains here is `validateSectionsAgainstClassification`'s own job: the locked angle(s) must
// actually be present — a surplus angle is no longer its concern.
describe("Submit Findings Rules", () => {
  it("business lock validates when only the business angle is present", () => {
  const sections = [
    { angle: 'business' as const, text: 'required business content' },
  ];
  expect(validateSectionsAgainstClassification(sections, 'business', 'analyze') === null, 'required business angle present').toBe(true);
});

  it("technical lock validates when only the technical angle is present", () => {
  const sections = [
    { angle: 'technical' as const, text: 'required technical content' },
  ];
  expect(validateSectionsAgainstClassification(sections, 'technical', 'analyze') === null, 'required technical angle present').toBe(true);
});

  it("both lock validates when both angles are present, including repeated same-angle sections", () => {
  const both = validateSectionsAgainstClassification([
    { angle: 'business' as const, text: 'b' },
    { angle: 'technical' as const, text: 't' },
  ], 'both', 'analyze');
  expect(both === null, 'both lock is satisfied when both angles are present').toBe(true);
  const repeated = validateSectionsAgainstClassification([
    { angle: 'business' as const, text: 'b1' },
    { angle: 'business' as const, text: 'b2' },
  ], 'business', 'analyze');
  expect(repeated === null, 'multiple sections of the one requested angle still satisfy the lock').toBe(true);
});

  it("business lock still requires business section", () => {
  const violation = validateSectionsAgainstClassification([
    { angle: 'technical', text: 'technical only' },
  ], 'business', 'analyze');
  expect(violation === 'classification=business requires at least one section with angle="business".', 'business lock still requires business section').toBe(true);
});

  it("both lock still requires both required angles", () => {
  const violation = validateSectionsAgainstClassification([
    { angle: 'business', text: 'business only' },
  ], 'both', 'analyze');
  expect(violation === 'classification=both requires sections with angle="business" and angle="technical".', 'both lock still requires both required angles').toBe(true);
});

  it("a prune verdict is exempt from the angle requirement under a both lock", () => {
  // A pruned node contributes no analysis to the lineage answer, so it has no angles to
  // require — `sections: []` must reach the engine's own `prune_sections_conflict` check
  // instead of being rejected here first.
  const violation = validateSectionsAgainstClassification([], 'both', 'prune');
  expect(violation === null, 'a prune verdict with sections:[] is not a classification_lock_violation').toBe(true);
});

  it("a prune verdict with a single business-only prose section is exempt under a both lock", () => {
  // The exemption is not conditioned on sections being empty — a prune carrying only one
  // angle (no captured artifact, so the engine's own prune_sections_conflict does not fire
  // either) must reach commit without a spurious classification_lock_violation demanding the
  // technical angle a pruned node was never going to produce.
  const violation = validateSectionsAgainstClassification([
    { angle: 'business', text: 'Off the trace — display-only rationale.' },
  ], 'both', 'prune');
  expect(violation === null, 'a prune verdict with one business-only section is not a classification_lock_violation').toBe(true);
});

  it("active recovery hints mention only active tools", () => {
  const hints = [
    activeSubmitFindingsRecoveryHint('[dbo].[Current]'),
    activeSubmitFindingsRecoveryHint(),
  ];
  expect(hints.every(h => h.includes('lineage_submit_findings') || h.includes('lineage_get_neighbor_columns')), 'active recovery hints mention only active tools').toBe(true);
  expect(!hints.some(h => h.includes('lineage_search_objects') || h.includes('search_objects')), 'active recovery hints do not mention discovery search tools').toBe(true);
});

  it("complete engine status maps without re-evaluating state", () => {
  const complete = mapSubmitFindingsEngineGuard({ error: 'invalid_status', current_status: 'complete' });
  expect(complete?.error === 'exploration_complete' && complete.next_action === 'present_result', 'complete engine status maps without re-evaluating state').toBe(true);
  const mismatch = mapSubmitFindingsEngineGuard({ error: 'focus_mismatch', expected: 'origin', got: 'other' });
  expect(mismatch?.error === 'focus_node_id_mismatch' && mismatch.expected === 'origin' && mismatch.got === 'other', 'engine focus mismatch maps to the stable external envelope').toBe(true);
  const unknown = mapSubmitFindingsEngineGuard({ error: 'invalid_focus_node', got: 'missing' });
  expect(unknown?.error === 'invalid_input' && unknown.message === 'focus_node_id `missing` not found in the loaded model.', 'engine invalid focus maps to the stable invalid_input envelope').toBe(true);
  expect(unknown?.hint === 'Retry lineage_submit_findings with the exact focus_node_id from the current hop focus_node.id.', 'invalid_focus_node without an expected id falls back to the generic recovery hint').toBe(true);
  const unknownWithExpected = mapSubmitFindingsEngineGuard({ error: 'invalid_focus_node', got: 'missing', expected: '[ai].[vwpricelist]' });
  expect(unknownWithExpected?.hint === 'Retry lineage_submit_findings with the exact current-hop focus_node.id: `[ai].[vwpricelist]`.', 'invalid_focus_node with an expected id names it in the recovery hint so the model does not resubmit the same wrong id').toBe(true);
  expect(mapSubmitFindingsEngineGuard({ error: 'budget_exhausted' }) === null, 'engine failures with no guard envelope fall through to the raw result').toBe(true);
});

});
