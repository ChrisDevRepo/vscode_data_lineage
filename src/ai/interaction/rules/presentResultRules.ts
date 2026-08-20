import type { InteractionRuleResult } from '../types';

/**
 * `present_result` requires either a bounded preview scope or a completed exploration graph.
 *
 * @param hasPresentationSource - True if a bounded scope or result graph exists.
 * @returns A rule result error if no presentation source is available, otherwise null.
 */
export function evaluatePresentResultPreconditionsRule(hasPresentationSource: boolean): InteractionRuleResult {
  if (hasPresentationSource) return null;
  return {
    success: false,
    errors: ['No presentation source is available.'],
    error: 'missing_result_graph',
    hint: 'Load one bounded scope for a visual preview or complete the active exploration first.',
  };
}
