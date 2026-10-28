import type { ClassificationValue } from '../../session/classification';
import { CLASSIFICATION_KEPT_ANGLES } from '../../session/classification';
import type { CapturedSection } from '../../session/memoryManager';

/** Required section paths still owed after the current finding and archived capture angles. */
export function missingSectionParts(
  sections: CapturedSection[] | undefined,
  classification: ClassificationValue | undefined,
  archivedAngles?: ReadonlySet<'business' | 'technical'>,
): string[] {
  const angles = new Set((sections ?? []).map(section => section.angle));
  if (!classification) return angles.size ? [] : ['sections'];
  return CLASSIFICATION_KEPT_ANGLES[classification]
    .filter(angle => !angles.has(angle) && !archivedAngles?.has(angle)).map(angle => `sections.${angle}`);
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

