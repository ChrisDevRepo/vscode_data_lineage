import type { ClassificationValue } from '../../session/classification';
import type { CapturedSection, CaptureAngle } from '../../session/memoryManager';
import type { InteractionRuleResult } from '../types';

/** Section-shape truth table by locked classification. */
const SECTION_RULES: Record<ClassificationValue, {
  required: CaptureAngle[];
  forbidden: CaptureAngle[];
  count: number;
  missingMsg: string;
  forbiddenMsg: string | null;
  countMsg: string;
}> = {
  business: {
    required: ['business'],
    forbidden: ['technical'],
    count: 1,
    missingMsg: 'classification=business requires exactly one section with angle="business".',
    forbiddenMsg: 'classification=business rejects technical sections - submit only the business angle.',
    countMsg: 'classification=business expects one section; got more.',
  },
  technical: {
    required: ['technical'],
    forbidden: ['business'],
    count: 1,
    missingMsg: 'classification=technical requires exactly one section with angle="technical".',
    forbiddenMsg: 'classification=technical rejects business sections - submit only the technical angle.',
    countMsg: 'classification=technical expects one section; got more.',
  },
  both: {
    required: ['business', 'technical'],
    forbidden: [],
    count: 2,
    missingMsg: 'classification=both requires two sections - one with angle="business" and one with angle="technical".',
    forbiddenMsg: null,
    countMsg: 'classification=both expects exactly two sections (one per angle).',
  },
};

/**
 * Validates findings `sections[]` against the locked classification contract.
 */
export function validateSectionsAgainstClassification(
  sections: CapturedSection[] | undefined,
  verdict: 'analyze' | 'pass' | 'prune',
  classification: ClassificationValue | undefined,
): string | null {
  if (verdict === 'prune') return null;
  const list = sections ?? [];
  if (!classification) {
    return list.length === 0 ? 'sections[] must contain at least one section when verdict is analyze or pass.' : null;
  }
  const rule = SECTION_RULES[classification];
  const angles = new Set(list.map(s => s.angle));
  for (const req of rule.required) {
    if (!angles.has(req)) return rule.missingMsg;
  }
  for (const forb of rule.forbidden) {
    if (angles.has(forb)) return rule.forbiddenMsg!;
  }
  if (list.length !== rule.count) return rule.countMsg;
  return null;
}

/**
 * `submit_findings` is disallowed once the engine sealed the archive.
 */
export function evaluateExplorationCompleteRule(engineStatus: string): InteractionRuleResult {
  if (engineStatus !== 'complete') return null;
  return {
    error: 'exploration_complete',
    hint: 'Hop loop is closed - every scope node has been analyzed and the archive is sealed. Call lineage_present_result to assemble the final report from the archive. Do not retry submit_findings.',
    next_action: 'present_result',
  };
}

/**
 * Enforces focus-id alignment with the engine's current focus.
 */
export function evaluateFocusMismatchRule(
  expectedFocusNodeId: string | null,
  submittedFocusNodeId: string,
): InteractionRuleResult {
  if (!expectedFocusNodeId || submittedFocusNodeId.toLowerCase() === expectedFocusNodeId.toLowerCase()) return null;
  return {
    error: 'focus_node_id_mismatch',
    expected: expectedFocusNodeId,
    got: submittedFocusNodeId,
    hint: `submit_findings.focus_node_id must match the current focus node. Expected: ${expectedFocusNodeId}. Resubmit with the correct focus_node_id.`,
  };
}
