import type { InteractionRuleResult } from '../types';

/**
 * `present_result` requires a completed state-machine archive.
 */
export function evaluatePresentResultPreconditionsRule(hasResultGraph: boolean): InteractionRuleResult {
  if (hasResultGraph) return null;
  return {
    success: false,
    errors: ['No state-machine result available - present_result requires a completed blackboard or column_trace exploration.'],
    error: 'missing_result_graph',
    hint: 'Complete the active exploration first so resultGraph is available.',
  };
}
