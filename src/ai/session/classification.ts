/** Mission-type classification — selects which capture angles fire. */

/** Resolved mission-type classification value. */
export type ClassificationValue = 'business' | 'technical' | 'both';

/**
 * Short human-readable label per classification value. Used inside confirm-SM-start messages,
 * banners, and status lines.
 */
export const CLASSIFICATION_LABEL: Record<ClassificationValue, string> = {
  business: 'business-driven',
  technical: 'technical-driven',
  both: 'business + technical driven',
};

/** Capture angle(s) a locked classification keeps in `submit_findings.sections`. */
export const CLASSIFICATION_KEPT_ANGLES: Record<
  ClassificationValue,
  readonly ('business' | 'technical')[]
> = {
  business: ['business'],
  technical: ['technical'],
  both: ['business', 'technical'],
};
