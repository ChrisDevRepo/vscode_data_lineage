import {
  activeSubmitFindingsRecoveryHint,
  filterSectionsForClassification,
  mapSubmitFindingsEngineGuard,
  validateSectionsAgainstClassification,
} from '../../../src/ai/interaction/rules/submitFindingsRules';
import { assert } from '../helpers/testUtils';
import { describe, it } from 'vitest';

describe("Submit Findings Rules", () => {
  it("business lock validates when business is present, then drops the technical section at commit", () => {
  const sections = [
    { angle: 'business' as const, text: 'required business content' },
    { angle: 'technical' as const, text: 'off-classification technical content' },
  ];
  assert(validateSectionsAgainstClassification(sections, 'business') === null, 'required business angle present');
  const { kept, droppedAngles } = filterSectionsForClassification(sections, 'business');
  assert(kept.length === 1 && kept[0].angle === 'business', 'only the business section is stored');
  assert(droppedAngles.length === 1 && droppedAngles[0] === 'technical', 'the technical section is dropped, not stored');
});

  it("technical lock validates when technical is present, then drops the business section at commit", () => {
  const sections = [
    { angle: 'technical' as const, text: 'required technical content' },
    { angle: 'business' as const, text: 'off-classification business content' },
  ];
  assert(validateSectionsAgainstClassification(sections, 'technical') === null, 'required technical angle present');
  const { kept, droppedAngles } = filterSectionsForClassification(sections, 'technical');
  assert(kept.length === 1 && kept[0].angle === 'technical', 'only the technical section is stored');
  assert(droppedAngles.length === 1 && droppedAngles[0] === 'business', 'the business section is dropped, not stored');
});

  it("both lock keeps both angles and repeated same-angle sections survive the filter", () => {
  const both = filterSectionsForClassification([
    { angle: 'business' as const, text: 'b' },
    { angle: 'technical' as const, text: 't' },
  ], 'both');
  assert(both.kept.length === 2 && both.droppedAngles.length === 0, 'both lock drops nothing');
  const repeated = filterSectionsForClassification([
    { angle: 'business' as const, text: 'b1' },
    { angle: 'business' as const, text: 'b2' },
  ], 'business');
  assert(repeated.kept.length === 2 && repeated.droppedAngles.length === 0, 'multiple sections of a requested angle are preserved');
});

  it("business lock still requires business section", () => {
  const violation = validateSectionsAgainstClassification([
    { angle: 'technical', text: 'technical only' },
  ], 'business');
  assert(violation === 'classification=business requires at least one section with angle="business".', 'business lock still requires business section');
});

  it("both lock still requires both required angles", () => {
  const violation = validateSectionsAgainstClassification([
    { angle: 'business', text: 'business only' },
  ], 'both');
  assert(violation === 'classification=both requires sections with angle="business" and angle="technical".', 'both lock still requires both required angles');
});

  it("active recovery hints mention only active tools", () => {
  const hints = [
    activeSubmitFindingsRecoveryHint('focus', '[dbo].[Current]'),
    activeSubmitFindingsRecoveryHint('route'),
    activeSubmitFindingsRecoveryHint('prune'),
  ];
  assert(hints.every(h => h.includes('lineage_submit_findings') || h.includes('lineage_get_neighbor_columns')), 'active recovery hints mention only active tools');
  assert(!hints.some(h => h.includes('lineage_search_objects') || h.includes('search_objects')), 'active recovery hints do not mention discovery search tools');
});

  it("complete engine status maps without re-evaluating state", () => {
  const complete = mapSubmitFindingsEngineGuard({ error: 'invalid_status', current_status: 'complete' });
  assert(complete?.error === 'exploration_complete' && complete.next_action === 'present_result', 'complete engine status maps without re-evaluating state');
  const mismatch = mapSubmitFindingsEngineGuard({ error: 'focus_mismatch', expected: 'origin', got: 'other' });
  assert(mismatch?.error === 'focus_node_id_mismatch' && mismatch.expected === 'origin' && mismatch.got === 'other', 'engine focus mismatch maps to the stable external envelope');
  const unknown = mapSubmitFindingsEngineGuard({ error: 'invalid_focus_node', got: 'missing' });
  assert(unknown?.error === 'invalid_input' && unknown.message === 'focus_node_id `missing` not found in the loaded model.', 'engine invalid focus maps to the stable invalid_input envelope');
  assert(
    unknown?.hint === 'Retry lineage_submit_findings with the exact focus_node_id from the current hop focus_node.id.',
    'invalid_focus_node without an expected id falls back to the generic recovery hint',
  );
  const unknownWithExpected = mapSubmitFindingsEngineGuard({ error: 'invalid_focus_node', got: 'missing', expected: '[ai].[vwpricelist]' });
  assert(
    unknownWithExpected?.hint === 'Retry lineage_submit_findings with the exact current-hop focus_node.id: `[ai].[vwpricelist]`.',
    'invalid_focus_node with an expected id names it in the recovery hint so the model does not resubmit the same wrong id',
  );
  assert(mapSubmitFindingsEngineGuard({ error: 'invalid_route' }) === null, 'non-guard engine failures remain available for their dedicated translators');
});

});
