import type { ClassificationValue } from '../../session/classification';
import { CLASSIFICATION_KEPT_ANGLES } from '../../session/classification';
import type { CapturedSection } from '../../session/memoryManager';
import type { Verdict } from '../../sm/smTypes';
import type { InteractionRuleResult } from '../types';
import { REJECTION_CODES } from '../../support/rejectionCodes';

/**
 * Required section angles by locked classification, read from the same
 * {@link CLASSIFICATION_KEPT_ANGLES} the per-dispatch `submit_findings` schema
 * (`tools/toolSchemas.ts`) narrows `sections[].angle` to. An off-lock angle can no
 * longer be authored at all — it fails that schema before this validator ever runs —
 * so this rule only ever catches a locked angle that is missing, not a surplus one.
 */
const SECTION_RULES: Record<ClassificationValue, {
  required: readonly ('business' | 'technical')[];
  missingMsg: string;
}> = {
  business: {
    required: CLASSIFICATION_KEPT_ANGLES.business,
    missingMsg: 'classification=business requires at least one section with angle="business".',
  },
  technical: {
    required: CLASSIFICATION_KEPT_ANGLES.technical,
    missingMsg: 'classification=technical requires at least one section with angle="technical".',
  },
  both: {
    required: CLASSIFICATION_KEPT_ANGLES.both,
    missingMsg: 'classification=both requires sections with angle="business" and angle="technical".',
  },
};

/**
 * Validates findings `sections[]` includes the angles required by the locked classification.
 *
 * @remarks
 * A `prune` verdict carries no analysis into the lineage answer — its sections are discarded
 * either way — so a prune is exempt from the angle requirement below, the same way the unlocked
 * branch already exempts it from the non-empty requirement.
 *
 * @param sections - The captured sections to validate.
 * @param classification - The locked classification for the session.
 * @param verdict - The submission's verdict; a `prune` verdict requires no angle.
 * @returns An error message string if invalid, otherwise null.
 */
export function validateSectionsAgainstClassification(
  sections: CapturedSection[] | undefined,
  classification: ClassificationValue | undefined,
  verdict: Verdict | undefined,
): string | null {
  const list = sections ?? [];
  if (!classification) {
    return list.length === 0 ? 'sections[] must contain at least one section when verdict is analyze or pass.' : null;
  }
  if (verdict === 'prune') return null;
  const rule = SECTION_RULES[classification];
  const angles = new Set(list.map(s => s.angle));
  for (const req of rule.required) {
    if (!angles.has(req)) return rule.missingMsg;
  }
  return null;
}

/**
 * Maps authoritative NavigationEngine status/focus failures to the established model-facing
 * `submit_findings` envelopes. This helper is pure and does not re-evaluate engine state.
 *
 * @param failure - The guard failure returned by `NavigationEngine.submitFindings()`.
 * @returns The stable external envelope, or null for a non-guard engine result.
 */
export function mapSubmitFindingsEngineGuard(
  failure: { error: string; [key: string]: unknown },
): InteractionRuleResult {
  if (failure.error === 'invalid_status') {
    const status = String(failure.current_status ?? 'unknown');
    if (status === 'complete') {
      return {
        error: 'exploration_complete',
        hint: 'Hop loop is closed - every scope node has been analyzed and the archive is sealed. Call lineage_present_result to assemble the final report from the archive. Do not retry submit_findings.',
        next_action: 'present_result',
      };
    }
    return {
      error: 'invalid_status',
      current_status: status,
      hint: typeof failure.hint === 'string'
        ? failure.hint
        : `Engine is in status '${status}'. Expected 'awaiting_findings'.`,
    };
  }
  if (failure.error === 'focus_mismatch') {
    const expected = typeof failure.expected === 'string' ? failure.expected : '';
    const got = typeof failure.got === 'string' ? failure.got : '';
    return {
      error: 'focus_node_id_mismatch',
      expected,
      got,
      hint: `submit_findings.focus_node_id must match the current focus node. Expected: ${expected}. Resubmit with the correct focus_node_id.`,
    };
  }
  if (failure.error === 'invalid_focus_node') {
    const got = typeof failure.got === 'string' ? failure.got : '';
    const expected = typeof failure.expected === 'string' ? failure.expected : undefined;
    return {
      error: REJECTION_CODES.invalidInput,
      message: `focus_node_id \`${got}\` not found in the loaded model.`,
      hint: activeSubmitFindingsRecoveryHint(expected),
    };
  }
  return null;
}

/**
 * Returns phase-valid recovery guidance for an active-hop `submit_findings` focus rejection.
 *
 * @remarks
 * Active SM exposes only `lineage_submit_findings` and `lineage_get_neighbor_columns`.
 * The hint therefore never points at discovery tools; an unresolved focus must be
 * corrected from the current-hop focus ID already in the worker context.
 *
 * @param expectedFocusNodeId - Expected focus id for focus mismatch errors.
 * @returns A model-facing recovery hint that mentions only active-phase tools.
 */
export function activeSubmitFindingsRecoveryHint(expectedFocusNodeId?: string): string {
  return expectedFocusNodeId
    ? `Retry lineage_submit_findings with the exact current-hop focus_node.id: \`${expectedFocusNodeId}\`.`
    : 'Retry lineage_submit_findings with the exact focus_node_id from the current hop focus_node.id.';
}
