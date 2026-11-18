/**
 * Mission-type classification, selecting which synthesis subsections fire. A mechanical contract
 * (Zod enum): `business` omits the "#### Technical" subsection, `technical` treats the section body
 * as the technical write-up, `both` appends the subsection. Declared by the AI as a REQUIRED
 * `start_exploration` parameter; Zod hard-rejects missing or invalid values, so there is no
 * engine-side fallback. `business` and `technical` are chosen only when the user asks for that
 * view; a question in neither terms, or both, is `both`. The value is part of the approved
 * contract, so the gate states it. The selection rule's one model-facing home is the field's
 * `.describe()`.
 */

import { z } from 'zod';

/** Zod enum for the mission-type classification value. */
export const ClassificationSchema = z.enum(['business', 'technical', 'both']);

/** Resolved mission-type classification value. */
export type ClassificationValue = z.infer<typeof ClassificationSchema>;

/** Short label per classification, for confirm-SM-start messages, banners and status lines. */
export const CLASSIFICATION_LABEL: Record<ClassificationValue, string> = {
  business: 'business-driven',
  technical: 'technical-driven',
  both: 'business + technical driven',
};

/**
 * `submit_findings.sections[].angle` value(s) a locked classification keeps. The single source for
 * both readers that must never drift: the per-dispatch `submit_findings` schema
 * (`submitFindingsSchemaForMode`) narrows the advertised `angle` enum to this set, and the
 * classification-lock validator (`submitFindingsRules.ts`) checks the required angle(s) are present
 * from the same set.
 */
export const CLASSIFICATION_KEPT_ANGLES: Record<ClassificationValue, readonly ('business' | 'technical')[]> = {
  business: ['business'],
  technical: ['technical'],
  both: ['business', 'technical'],
};
