import {
  CLASSIFICATION_KEPT_ANGLES,
  type ClassificationValue,
} from '../session/classification';
import type { ToolError } from './toolErrorEnvelope';

/** Shared shape facts for tool admission and the separate persisted-finding contract. */
export function findingShapeIssues(
  value: Record<string, unknown>,
  fresh: boolean,
  classification?: ClassificationValue,
): ToolError[] {
  const errors: ToolError[] = [];
  const kept = classification
    ? CLASSIFICATION_KEPT_ANGLES[classification]
    : undefined;
  const sections = value.sections;
  if (kept?.length === 1 && sections && typeof sections === 'object') {
    for (const key of Object.keys(sections).filter((key) => key !== kept[0]))
      errors.push({
        path: `sections.${key}`,
        code:
          key === 'business' || key === 'technical' ? 'never' : 'unknown_key',
      });
  }
  const bodies =
    sections && typeof sections === 'object' && !Array.isArray(sections)
      ? sections
      : undefined;
  const filled = new Set(
    Object.entries(bodies ?? {})
      .filter(([, body]) => typeof body === 'string')
      .map(([angle]) => angle),
  );
  if (fresh && bodies && filled.size === 0)
    errors.push({ path: 'sections', code: 'missing' });
  if (
    fresh &&
    kept?.length === CLASSIFICATION_KEPT_ANGLES.both.length &&
    bodies &&
    filled.size > 0
  ) {
    for (const angle of CLASSIFICATION_KEPT_ANGLES.both)
      if (!filled.has(angle))
        errors.push({ path: `sections.${angle}`, code: 'missing' });
  }
  if (fresh && typeof value.summary === 'string' && value.summary.trim() === '')
    errors.push({ path: 'summary', code: 'missing' });
  return errors;
}
