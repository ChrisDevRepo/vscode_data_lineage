import type { InteractionRuleResult } from '../types';
import { makeRejection } from '../../support/toolErrorEnvelope';

/** `present_result` requires either a bounded preview scope or a completed exploration graph. */
export function evaluatePresentResultPreconditionsRule(hasPresentationSource: boolean): InteractionRuleResult {
  if (hasPresentationSource) return null;
  return makeRejection({
    code: 'missing_result_graph',
    reason: 'No presentation source is available.',
    hint: 'Load one bounded scope for a visual preview or complete the active exploration first.',
  });
}
