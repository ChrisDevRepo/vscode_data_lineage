import type { ClassificationValue } from '../../session/classification';
import type { CapturedSection, CaptureAngle } from '../../session/memoryManager';
import type { Verdict } from '../../sm/smTypes';
import type { InteractionRuleResult } from '../types';
import { REJECTION_CODES } from '../../support/rejectionCodes';

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
 * @remarks
 * A `prune` verdict carries no analysis into the lineage answer — its sections are discarded
 * either way (accepted content is refused separately by `prune_sections_conflict`) — so a prune
 * is exempt from the angle requirement below, the same way the unlocked branch already exempts
 * it from the non-empty requirement.
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
 * Expands a `classification_lock_violation` message with the submission's own present/missing
 * angles and the literal edit — an addition, never a replacement.
 *
 * @remarks
 * `validateSectionsAgainstClassification` names the classification and the full required set, but
 * a partial submission under `classification="both"` (one angle present, one missing) leaves the
 * model to diff its own payload against that requirement to find the fix. Observed failure
 * (`test-results/e2e/m0-zai-1-zai/run-T8`, hop 3, `[ai].[sploadsalesstaging]`): a business-only
 * submission was rejected with the bare requirement restated, and the model's very next retry
 * resubmitted the identical business-only content — evidence the hint did not name the repair.
 * The present/missing split below is data `validateSectionsAgainstClassification`'s caller already
 * holds (the submitted `sections[]`), so this names it rather than requiring the model to infer it.
 *
 * @param violation - The non-null string `validateSectionsAgainstClassification` returned.
 * @param sections - The findings' submitted sections (the same array that produced `violation`).
 * @param classification - The locked classification for the session.
 * @returns `violation` unchanged when there is nothing further to name (no classification, or every
 *   required angle already present — the latter should not occur if `violation` came from a real
 *   miss); otherwise `violation` plus one sentence naming what is present, what is missing, and the
 *   add-not-replace edit.
 */
export function describeClassificationLockViolation(
  violation: string,
  sections: CapturedSection[] | undefined,
  classification: ClassificationValue | undefined,
): string {
  if (!classification) return violation;
  const rule = SECTION_RULES[classification];
  const present = [...new Set((sections ?? []).map(s => s.angle))];
  const missing = rule.required.filter(req => !present.includes(req));
  if (missing.length === 0) return violation;
  const missingList = missing.map(a => `angle="${a}"`).join(' and ');
  const presentList = present.length > 0 ? present.map(a => `angle="${a}"`).join(', ') : 'none';
  const addNoun = missing.length > 1 ? 'sections' : 'a section';
  return `${violation} This submission included ${presentList}; add ${addNoun} with ${missingList} to the sections array — keep the existing section(s) exactly as sent, do not remove or replace them.`;
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
