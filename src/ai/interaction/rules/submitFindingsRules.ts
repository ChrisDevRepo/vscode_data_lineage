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
 * @param archivedAngles - Angles already archived for this focus node from an earlier visit
 * (`AiMemoryManager.getArchivedAngles`). A CT reopen revisits a node whose earlier sections
 * `storeDetail` already appended into the archive (never replaced), so an angle present there
 * satisfies the lock even when this submission does not re-carry it.
 * @returns An error message string if invalid, otherwise null.
 */
export function validateSectionsAgainstClassification(
  sections: CapturedSection[] | undefined,
  classification: ClassificationValue | undefined,
  verdict: Verdict | undefined,
  archivedAngles?: ReadonlySet<'business' | 'technical'>,
): string | null {
  const list = sections ?? [];
  if (!classification) {
    return list.length === 0 ? 'sections[] must contain at least one section when verdict is analyze or pass.' : null;
  }
  if (verdict === 'prune') return null;
  const rule = SECTION_RULES[classification];
  const angles = new Set(list.map(s => s.angle));
  const missing = rule.required.filter(req => !angles.has(req) && !archivedAngles?.has(req));
  if (missing.length === 0) return null;
  // The rule alone does not say which angle is absent, so a model holding one angle can resend
  // the other in its place and be refused again for the angle it just dropped.
  const kept = rule.required.filter(req => angles.has(req));
  const missingText = missing.map(a => `missing angle="${a}"`).join(', ');
  const keepText = kept.length > 0
    ? ` Add the missing section and keep the ${kept.map(a => `angle="${a}"`).join(', ')} section already sent, both in one sections[] list.`
    : '';
  return `${rule.missingMsg} This submission is ${missingText}.${keepText}`;
}

/**
 * Best-effort `sections[].angle` extraction from a raw, not-yet-Zod-validated submission payload.
 *
 * @remarks
 * Reused by the `submit_findings` handler's Zod-failure branch so a submission that fails
 * strict-schema validation for an unrelated reason (an unrecognized key, a wrong field type) and
 * is also missing a locked angle gets one combined hint instead of two sequential rejections —
 * the model would otherwise fix the schema issue, resend, and only then learn about the angle
 * gap. Deliberately tolerant: an item missing `text` or carrying an extra key still counts toward
 * angle coverage, since only `angle` is read here and the strict shape check is Zod's job, not
 * this one's.
 *
 * @param rawSections - The unparsed `sections` value from the raw or normalized tool input.
 * @returns Angle-bearing entries suitable for {@link validateSectionsAgainstClassification};
 * anything not shaped like `{ angle: 'business' | 'technical', ... }` is dropped.
 */
export function extractRawSectionAngles(rawSections: unknown): CapturedSection[] {
  if (!Array.isArray(rawSections)) return [];
  const out: CapturedSection[] = [];
  for (const item of rawSections) {
    if (typeof item !== 'object' || item === null) continue;
    const angle = (item as { angle?: unknown }).angle;
    if (angle !== 'business' && angle !== 'technical') continue;
    const text = (item as { text?: unknown }).text;
    out.push({ angle, text: typeof text === 'string' ? text : '' });
  }
  return out;
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
