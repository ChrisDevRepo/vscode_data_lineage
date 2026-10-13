/**
 * Mission-type classification — selects which capture angles fire.
 *
 * @remarks
 * A mechanical contract (Zod enum): `business` keeps the business capture,
 * `technical` keeps the technical capture, and `both` keeps both angles. Synthesis merges their findings.
 * Declared by the AI as a REQUIRED `start_exploration` parameter; Zod hard-rejects missing or
 * invalid values, so there is no engine-side fallback. Unspecified intent is `business`;
 * `technical` and `both` require the user to request their respective views.
 * The value is part of the approved contract, so the gate
 * states it. The selection rule's one model-facing home is the field's `.describe()`.
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
 * Capture angle(s) a locked classification keeps in `submit_findings.sections`.
 *
 * @remarks
 * Single source for both readers that must never drift apart: the per-dispatch
 * `submit_findings` schema (`tools/toolSchemas.ts` `submitFindingsSchemaForMode`) narrows
 * the advertised section keys to this set before the model is dispatched, and the
 * classification-lock validator (`interaction/rules/submitFindingsRules.ts`) reads the
 * same set to check the required angle(s) are present.
 */
export const CLASSIFICATION_KEPT_ANGLES: Record<ClassificationValue, readonly ('business' | 'technical')[]> = {
  business: ['business'],
  technical: ['technical'],
  both: ['business', 'technical'],
};
