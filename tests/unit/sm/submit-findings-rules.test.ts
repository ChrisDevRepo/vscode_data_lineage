import {
  activeSubmitFindingsRecoveryHint,
  filterSectionsForClassification,
  mapSubmitFindingsEngineGuard,
  validateSectionsAgainstClassification,
} from '../../../src/ai/interaction/rules/submitFindingsRules';
import { describe, expect, it } from 'vitest';

describe("Submit Findings Rules", () => {
  it("business lock validates when business is present, then drops the technical section at commit", () => {
  const sections = [
    { angle: 'business' as const, text: 'required business content' },
    { angle: 'technical' as const, text: 'off-classification technical content' },
  ];
  expect(validateSectionsAgainstClassification(sections, 'business') === null, 'required business angle present').toBe(true);
  const { kept, droppedAngles } = filterSectionsForClassification(sections, 'business');
  expect(kept.length === 1 && kept[0].angle === 'business', 'only the business section is stored').toBe(true);
  expect(droppedAngles.length === 1 && droppedAngles[0] === 'technical', 'the technical section is dropped, not stored').toBe(true);
});

  it("technical lock validates when technical is present, then drops the business section at commit", () => {
  const sections = [
    { angle: 'technical' as const, text: 'required technical content' },
    { angle: 'business' as const, text: 'off-classification business content' },
  ];
  expect(validateSectionsAgainstClassification(sections, 'technical') === null, 'required technical angle present').toBe(true);
  const { kept, droppedAngles } = filterSectionsForClassification(sections, 'technical');
  expect(kept.length === 1 && kept[0].angle === 'technical', 'only the technical section is stored').toBe(true);
  expect(droppedAngles.length === 1 && droppedAngles[0] === 'business', 'the business section is dropped, not stored').toBe(true);
});

  it("both lock keeps both angles and repeated same-angle sections survive the filter", () => {
  const both = filterSectionsForClassification([
    { angle: 'business' as const, text: 'b' },
    { angle: 'technical' as const, text: 't' },
  ], 'both');
  expect(both.kept.length === 2 && both.droppedAngles.length === 0, 'both lock drops nothing').toBe(true);
  const repeated = filterSectionsForClassification([
    { angle: 'business' as const, text: 'b1' },
    { angle: 'business' as const, text: 'b2' },
  ], 'business');
  expect(repeated.kept.length === 2 && repeated.droppedAngles.length === 0, 'multiple sections of a requested angle are preserved').toBe(true);
});

  it("business lock still requires business section", () => {
  const violation = validateSectionsAgainstClassification([
    { angle: 'technical', text: 'technical only' },
  ], 'business');
  expect(violation === 'classification=business requires at least one section with angle="business".', 'business lock still requires business section').toBe(true);
});

  it("both lock still requires both required angles", () => {
  const violation = validateSectionsAgainstClassification([
    { angle: 'business', text: 'business only' },
  ], 'both');
  expect(violation === 'classification=both requires sections with angle="business" and angle="technical".', 'both lock still requires both required angles').toBe(true);
});

  it("active recovery hints mention only active tools", () => {
  const hints = [
    activeSubmitFindingsRecoveryHint('focus', '[dbo].[Current]'),
    activeSubmitFindingsRecoveryHint('route'),
    activeSubmitFindingsRecoveryHint('prune'),
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
  expect(mapSubmitFindingsEngineGuard({ error: 'invalid_route' }) === null, 'non-guard engine failures remain available for their dedicated translators').toBe(true);
});

});
