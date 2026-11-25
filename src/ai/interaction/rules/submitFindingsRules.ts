import type { ClassificationValue } from '../../session/classification';
import { CLASSIFICATION_KEPT_ANGLES, sectionField } from '../../session/classification';
import type { CapturedSection } from '../../session/memoryManager';

/**
 * Validates findings carry the section field(s) the locked classification requires, read from the
 * same {@link CLASSIFICATION_KEPT_ANGLES} the per-dispatch `submit_findings` schema serves. An
 * off-lock field fails that schema before this validator runs, so this rule only catches a locked
 * angle that is missing, not a surplus one.
 *
 * @param archivedAngles - Angles already archived for this focus node from an earlier visit
 *   (`AiMemoryManager.getArchivedAngles`). A `supplementAgenda` follow-up revisits a node whose
 *   earlier sections `storeDetail` appended (never replaced), so an angle present there satisfies
 *   the lock though this submission does not re-carry it.
 * @returns The reason and the missing fields, or `null` when the lock is met.
 */
export function validateSectionsAgainstClassification(
  sections: CapturedSection[] | undefined,
  classification: ClassificationValue | undefined,
  archivedAngles?: ReadonlySet<'business' | 'technical'>,
): { readonly reason: string; readonly fields: string[] } | null {
  const angles = new Set((sections ?? []).map(s => s.angle));
  if (!classification) {
    const fields = CLASSIFICATION_KEPT_ANGLES.both.map(sectionField);
    return angles.size === 0 ? { reason: `At least one of ${fields.join(' or ')} is required when verdict is analyze or passthrough.`, fields } : null;
  }
  const required = CLASSIFICATION_KEPT_ANGLES[classification];
  const fields = required.filter(angle => !angles.has(angle) && !archivedAngles?.has(angle)).map(sectionField);
  if (fields.length === 0) return null;
  return { reason: `classification=${classification} requires ${required.map(sectionField).join(' and ')}. This submission is missing ${fields.join(' and ')}.`, fields };
}

/**
 * Reads the section fields of a `submit_findings` payload into angle-bearing entries, for a
 * validated payload (`toHopFinding` in `toolSchemas.ts`) and a rejected one being held. Tolerant on
 * purpose: a blank or non-string body is absent, so it never counts toward coverage and never
 * overwrites a held body.
 *
 * @param input - The raw tool input.
 */
export function extractRawSectionAngles(input: Readonly<Record<string, unknown>>): CapturedSection[] {
  return CLASSIFICATION_KEPT_ANGLES.both.flatMap(angle => {
    const text = input[sectionField(angle)];
    return typeof text === 'string' && text.trim() !== '' ? [{ angle, text }] : [];
  });
}
