import type { InteractionRuleResult } from '../types';
import { makeRejection } from '../../support/toolErrorEnvelope';
import { REJECTION_CODES } from '../../support/rejectionCodes';

/**
 * `present_result` requires a bounded preview scope or a completed exploration graph;
 * `hasPresentationSource` says whether one exists. Returns a rule error when neither does, else
 * null.
 */
export function evaluatePresentResultPreconditionsRule(hasPresentationSource: boolean): InteractionRuleResult {
  if (hasPresentationSource) return null;
  return makeRejection({
    code: REJECTION_CODES.missingResultGraph,
    reason: 'No presentation source is available.',
    hint: 'Load one bounded scope for a visual preview or complete the active exploration first.',
  });
}
