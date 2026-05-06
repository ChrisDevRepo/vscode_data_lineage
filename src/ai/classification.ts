/**
 * Mission-type classification — selects which synthesis subsections fire.
 *
 * @remarks
 * The classification gate is a mechanical contract (Zod enum); the value
 * chooses whether the "#### Technical" subsection is appended below the
 * business body. `business` omits it; `technical` treats the section body
 * as the technical write-up; `both` appends the subsection.
 *
 * The AI declares the classification in the `start_exploration` tool call
 * via the REQUIRED `classification` enum parameter. Zod hard-rejects missing
 * or invalid values — there is no engine-side fallback. The AI is instructed
 * (via the tool param description) to weight toward `business` over
 * `technical` when the user's intent is ambiguous; `both` is reserved for
 * explicit "both angles" asks.
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


