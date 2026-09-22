/**
 * Mission-type classification — selects which synthesis subsections fire.
 *
 * @remarks
 * A mechanical contract (Zod enum): `business` omits the "#### Technical" subsection,
 * `technical` treats the section body as the technical write-up, `both` appends the subsection.
 * Declared by the AI as a REQUIRED `start_exploration` parameter; Zod hard-rejects missing or
 * invalid values, so there is no engine-side fallback. `technical` requires the user to have named
 * a technical lens (performance, indexes, execution plan, query shape, load pattern) as the whole
 * request; `both` is for a request spanning both angles.
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
 * `submit_findings.sections[].angle` value(s) a locked classification keeps.
 *
 * @remarks
 * Single source for both readers that must never drift apart: the per-dispatch
 * `submit_findings` schema (`tools/toolSchemas.ts` `submitFindingsSchemaForMode`) narrows
 * the advertised `angle` enum to this set before the model is dispatched, and the
 * classification-lock validator (`interaction/rules/submitFindingsRules.ts`) reads the
 * same set to check the required angle(s) are present.
 */
export const CLASSIFICATION_KEPT_ANGLES: Record<ClassificationValue, readonly ('business' | 'technical')[]> = {
  business: ['business'],
  technical: ['technical'],
  both: ['business', 'technical'],
};
