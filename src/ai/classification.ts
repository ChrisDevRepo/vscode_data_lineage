/**
 * Mission-type classification — selects which synthesis subsections fire.
 *
 * @remarks
 * The classification gate is a mechanical contract (Zod enum); the value
 * chooses whether the "#### Technical" subsection is appended below the
 * business body. `business` omits it; `technical` treats the section body
 * as the technical write-up; `both` appends the subsection.
 *
 * Classification is inferred heuristically from the user's question and
 * mission brief — see {@link inferClassificationFromText}. No separate
 * tool-call is required from the AI.
 */

import { z } from 'zod';

/** Zod enum for the mission-type classification value. */
export const ClassificationSchema = z.enum(['business', 'technical', 'both']);

/** Resolved mission-type classification value. */
export type ClassificationValue = z.infer<typeof ClassificationSchema>;

/**
 * Short human-readable label per classification value. Used inside
 * confirm-SM-start messages, banners, and status lines.
 */
export const CLASSIFICATION_LABEL: Record<ClassificationValue, string> = {
  business: 'business-driven',
  technical: 'technical-driven',
  both: 'business + technical driven',
};

/**
 * Inline chat banner shown at synthesis start for each classification value.
 *
 * @remarks
 * Rendered via `stream.markdown()` in the chat participant the moment
 * classification resolves (inline mode only). Format: markdown blockquote.
 */
export const CLASSIFICATION_BANNER: Record<ClassificationValue, string> = {
  business: `> Starting analyze phase — ${CLASSIFICATION_LABEL.business}.`,
  technical: `> Starting analyze phase — ${CLASSIFICATION_LABEL.technical}.`,
  both: `> Starting analyze phase — ${CLASSIFICATION_LABEL.both}.`,
};

/**
 * Heuristically infers a classification value from free-text input.
 *
 * @remarks
 * Pure keyword scan. The intent is to avoid asking the AI for a separate
 * tool-call — the mission brief and question are already on hand and carry
 * the mission-type signal. Defaults to `business` when no keyword fires.
 * Intentionally conservative — `both` fires only when BOTH a technical and
 * a business signal are present.
 *
 * Signals (case-insensitive):
 *   technical — `performance`, `join`, `antipattern`, `anti-pattern`,
 *               `distribution`, `index`, `partition`, `execution`, `slow`,
 *               `how does`, `how is`, `how are`
 *   business  — `what`, `business`, `logic`, `meaning`, `impact`, `explain`,
 *               `describe`, `documentation`
 *
 * @param text - Concatenated text to scan (e.g. `mission_brief + ' ' + question`).
 * @returns The inferred `ClassificationValue`.
 */
export function inferClassificationFromText(text: string): ClassificationValue {
  const t = (text ?? '').toLowerCase();
  if (!t.trim()) return 'business';

  const technicalSignals = [
    'performance', 'join', 'antipattern', 'anti-pattern',
    'distribution', 'index', 'partition', 'execution', 'slow',
    'how does', 'how is', 'how are',
  ];
  const businessSignals = [
    'what', 'business', 'logic', 'meaning', 'impact',
    'explain', 'describe', 'documentation',
  ];

  const hitsTechnical = technicalSignals.some(kw => t.includes(kw));
  const hitsBusiness = businessSignals.some(kw => t.includes(kw));

  if (hitsTechnical && hitsBusiness) return 'both';
  if (hitsTechnical) return 'technical';
  return 'business';
}
