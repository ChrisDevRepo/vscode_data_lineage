import type { ClassificationValue } from '../../session/classification';
import type { CapturedSection, CaptureAngle } from '../../session/memoryManager';
import type { InteractionRuleResult } from '../types';

/** Active-hop submit_findings rejection categories with phase-valid recovery hints. */
export type SubmitFindingsActiveRecoveryKind = 'focus' | 'route' | 'prune';

/**
 * Required section angles by locked classification. Off-classification angles are
 * not stored: `filterSectionsForClassification` drops them deterministically at
 * commit so a business-only answer cannot leak technical sections (and vice versa).
 */
const SECTION_RULES: Record<ClassificationValue, {
  required: CaptureAngle[];
  missingMsg: string;
}> = {
  business: {
    required: ['business'],
    missingMsg: 'classification=business requires at least one section with angle="business".',
  },
  technical: {
    required: ['technical'],
    missingMsg: 'classification=technical requires at least one section with angle="technical".',
  },
  both: {
    required: ['business', 'technical'],
    missingMsg: 'classification=both requires sections with angle="business" and angle="technical".',
  },
};

/**
 * Validates findings `sections[]` includes the angles required by the locked classification.
 *
 * @param sections - The captured sections to validate.
 * @param classification - The locked classification for the session.
 * @returns An error message string if invalid, otherwise null.
 */
export function validateSectionsAgainstClassification(
  sections: CapturedSection[] | undefined,
  classification: ClassificationValue | undefined,
): string | null {
  const list = sections ?? [];
  if (!classification) {
    return list.length === 0 ? 'sections[] must contain at least one section when verdict is analyze or pass.' : null;
  }
  const rule = SECTION_RULES[classification];
  const angles = new Set(list.map(s => s.angle));
  for (const req of rule.required) {
    if (!angles.has(req)) return rule.missingMsg;
  }
  return null;
}

/**
 * Drops sections whose angle the locked classification did not request.
 *
 * @remarks
 * Runs at commit, after `validateSectionsAgainstClassification` accepted the
 * submission — a deterministic drop instead of a rejection, because a surplus
 * section is not a field-scoped defect the held-draft repair flow could patch
 * without re-requesting the full payload. Multiple sections of a requested
 * angle are preserved; `both` (and an unlocked classification) drop nothing.
 *
 * @param sections - The captured sections accepted for this submission.
 * @param classification - The locked classification for the session.
 * @returns The kept sections plus the angles of any dropped sections.
 */
export function filterSectionsForClassification(
  sections: CapturedSection[],
  classification: ClassificationValue | undefined,
): { kept: CapturedSection[]; droppedAngles: CaptureAngle[] } {
  if (!classification) return { kept: sections, droppedAngles: [] };
  const allowed = new Set(SECTION_RULES[classification].required);
  const kept: CapturedSection[] = [];
  const droppedAngles: CaptureAngle[] = [];
  for (const section of sections) {
    if (allowed.has(section.angle)) kept.push(section);
    else droppedAngles.push(section.angle);
  }
  return { kept, droppedAngles };
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
      error: 'invalid_input',
      message: `focus_node_id \`${got}\` not found in the loaded model.`,
      hint: activeSubmitFindingsRecoveryHint('focus', expected),
    };
  }
  return null;
}

/**
 * Returns phase-valid recovery guidance for active-hop `submit_findings` rejections.
 *
 * @remarks
 * Active SM exposes only `lineage_submit_findings` and `lineage_get_neighbor_columns`.
 * These hints therefore never point at discovery tools; unresolved names must be
 * corrected from the current-hop focus/neighbor IDs already in the worker context.
 *
 * @param kind - The active rejection category that needs a self-heal hint.
 * @param expectedFocusNodeId - Expected focus id for focus mismatch errors.
 * @returns A model-facing recovery hint that mentions only active-phase tools.
 */
export function activeSubmitFindingsRecoveryHint(
  kind: SubmitFindingsActiveRecoveryKind,
  expectedFocusNodeId?: string,
): string {
  switch (kind) {
    case 'focus':
      return expectedFocusNodeId
        ? `Retry lineage_submit_findings with the exact current-hop focus_node.id: \`${expectedFocusNodeId}\`.`
        : 'Retry lineage_submit_findings with the exact focus_node_id from the current hop focus_node.id.';
    case 'route':
      return 'Retry lineage_submit_findings with a route_requests[].nodeId from the current-hop neighbors[] list, or omit the route.';
    case 'prune':
      return 'Retry lineage_submit_findings with a prune_neighbors id from the current-hop neighbors[] list, or omit it. Use lineage_get_neighbor_columns only for column names in opaque DDL.';
  }
}
