import type { ClassificationValue } from '../../session/classification';
import { CLASSIFICATION_KEPT_ANGLES } from '../../session/classification';
import type { CapturedSection } from '../../session/memoryManager';

/**
 * Required section angles by locked classification, read from the same
 * {@link CLASSIFICATION_KEPT_ANGLES} the per-dispatch `submit_findings` schema
 * (`tools/toolSchemas.ts`) narrows the `sections` keys to. An off-lock angle can no
 * longer be authored at all — it fails that schema before this validator ever runs —
 * so this rule only ever catches a locked angle that is missing, not a surplus one.
 */
const SECTION_RULES: Record<ClassificationValue, {
  required: readonly ('business' | 'technical')[];
  missingMsg: string;
}> = {
  business: {
    required: CLASSIFICATION_KEPT_ANGLES.business,
    missingMsg: 'classification=business requires sections.business.',
  },
  technical: {
    required: CLASSIFICATION_KEPT_ANGLES.technical,
    missingMsg: 'classification=technical requires sections.technical.',
  },
  both: {
    required: CLASSIFICATION_KEPT_ANGLES.both,
    missingMsg: 'classification=both requires both sections.business and sections.technical.',
  },
};

/**
 * Validates findings carry the `sections.business`/`sections.technical` keys required by the
 * locked classification.
 *
 * @remarks
 * @param archivedAngles - Angles already archived for this focus node from an earlier visit
 * (`AiMemoryManager.getArchivedAngles`). A follow-up (`supplementAgenda`) revisits a node whose earlier sections
 * `storeDetail` already appended into the archive (never replaced), so an angle present there
 * satisfies the lock even when this submission does not re-carry it.
 */
export function validateSectionsAgainstClassification(
  sections: CapturedSection[] | undefined,
  classification: ClassificationValue | undefined,
  archivedAngles?: ReadonlySet<'business' | 'technical'>,
): string | null {
  const list = sections ?? [];
  if (!classification) {
    return list.length === 0 ? 'sections must contain at least one of sections.business or sections.technical when verdict is analyze or passthrough.' : null;
  }
  const rule = SECTION_RULES[classification];
  const angles = new Set(list.map(s => s.angle));
  const missing = rule.required.filter(req => !angles.has(req) && !archivedAngles?.has(req));
  if (missing.length === 0) return null;
  const kept = rule.required.filter(req => angles.has(req));
  const missingText = missing.map(a => `missing sections.${a}`).join(', ');
  const keepText = kept.length > 0
    ? ` Add the missing key and keep ${kept.map(a => `sections.${a}`).join(', ')} already sent, both in the same sections object.`
    : '';
  return `${rule.missingMsg} This submission is ${missingText}.${keepText}`;
}

/**
 * Converts a `sections` object keyed by angle into angle-bearing entries.
 *
 * @remarks
 * The converter for a validated payload (`toHopFinding` in `toolSchemas.ts`). Tolerant on purpose:
 * only the `business`/`technical` keys are read, and a blank or non-string body is absent, so it
 * never counts toward coverage and never overwrites a held body.
 *
 * @param rawSections - The unparsed `sections` value from the raw or normalized tool input.
 * @returns Angle-bearing entries suitable for {@link validateSectionsAgainstClassification};
 * anything not shaped like `{ business?: string, technical?: string }` is dropped.
 */
export function extractRawSectionAngles(rawSections: unknown): CapturedSection[] {
  if (typeof rawSections !== 'object' || rawSections === null || Array.isArray(rawSections)) return [];
  const record = rawSections as Record<string, unknown>;
  const out: CapturedSection[] = [];
  for (const angle of ['business', 'technical'] as const) {
    if (!(angle in record)) continue;
    const text = record[angle];
    if (typeof text === 'string' && text.trim() !== '') out.push({ angle, text });
  }
  return out;
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
