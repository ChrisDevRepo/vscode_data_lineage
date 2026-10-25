import type { ClassificationValue } from '../../session/classification';
import { CLASSIFICATION_KEPT_ANGLES } from '../../session/classification';
import type { CapturedSection } from '../../session/memoryManager';

/** Required section angles by locked classification, read from the same {@link CLASSIFICATION_KEPT_ANGLES} the per-dispatch `submit_findings` schema (`tools/toolSchemas.ts`) narrows the `sections` keys to. An off-lock angle can no longer be authored at all — it fails that schema before this validator ever runs — so this rule only ever catches a locked angle that is missing, not a surplus one. */
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

/** Validates findings carry the `sections.business`/`sections.technical` keys required by the locked classification. */
export function validateSectionsAgainstClassification(
  sections: CapturedSection[] | undefined,
  classification: ClassificationValue | undefined,
  archivedAngles?: ReadonlySet<'business' | 'technical'>,
): string | null {
  const list = sections ?? [];
  if (!classification) {
    return list.length === 0 ? 'sections must contain at least one of sections.business or sections.technical.' : null;
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

/** Converts a `sections` object keyed by angle into angle-bearing entries. */
export function extractRawSectionAngles(rawSections: unknown): CapturedSection[] {
  if (typeof rawSections !== 'object' || rawSections === null || Array.isArray(rawSections)) return [];
  const record = rawSections as Record<string, unknown>;
  const out: CapturedSection[] = [];
  for (const angle of ['business', 'technical'] as const) {
    if (!(angle in record)) continue;
    const text = record[angle];
    if (typeof text === 'string') out.push({ angle, text });
  }
  return out;
}

