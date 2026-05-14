import type { InteractionRuleResult } from '../types';

/**
 * Duplicate-start guard for live engines in the same session when no refine
 * loop is active.
 */
export function evaluateAlreadyStartedRule(
  hasLiveEngine: boolean,
  sameSession: boolean,
  isRefining: boolean,
  recovery: 'active_agenda' | 'presentation_update_after_agenda' = 'active_agenda',
): InteractionRuleResult {
  if (!(hasLiveEngine && sameSession && !isRefining)) return null;
  if (recovery === 'presentation_update_after_agenda') {
    return {
      error: 'already_started',
      hint: 'Exploration is already in progress. Preserve the user\'s presentation edit request; finish the current agenda with submit_findings, then apply the requested graph update with lineage_present_result using is_update:true, add_node_ids if needed, and highlight_groups for source/transform/target labels.',
      next_action: 'submit_findings',
    };
  }
  return {
    error: 'already_started',
    hint: 'start_exploration is one-shot per turn. Use submit_findings to continue the current agenda. After complete_rejected, the unvisited neighbors are already queued at priority 3 - the next submit_findings will present one of them.',
    next_action: 'submit_findings',
  };
}

/**
 * Enforces one start_exploration call per LM round.
 */
export function evaluateParallelStartRule(
  priorStartRoundId: number | null,
  currentRoundId: number,
): InteractionRuleResult {
  if (priorStartRoundId === null || priorStartRoundId !== currentRoundId) return null;
  return {
    error: 'parallel_call_forbidden',
    hint: 'start_exploration is strictly serial and one-shot per round. Use submit_findings for the queued neighbors - after complete_rejected they are queued at priority 3 and will be served on the next submit_findings.',
    next_action: 'submit_findings',
  };
}

/**
 * Supplement path requires a completed engine archive.
 */
export function evaluateSupplementPrereqRule(engineStatus: string | null): InteractionRuleResult {
  if (engineStatus === 'complete') return null;
  return {
    error: 'supplement_requires_complete_engine',
    hint: `supplement requires a completed prior exploration. Current engine status: ${engineStatus ?? 'none'}. Start a fresh exploration instead (omit the 'supplement' field, provide 'origin').`,
  };
}

/**
 * Scope-to-round-budget guard result payload.
 */
export function evaluateScopeBudgetRule(
  scopeSize: number,
  safeMaxHops: number,
  maxRounds: number,
  safeDepthHint: number | null | undefined,
): InteractionRuleResult {
  if (scopeSize <= safeMaxHops) return null;
  return {
    error: 'scope_exceeds_budget',
    scope_size: scopeSize,
    max_rounds: maxRounds,
    safe_max_hops: safeMaxHops,
    safe_depth_hint: safeDepthHint,
    hint: `Scope has ${scopeSize} nodes; sliding-memory budget allows ~${safeMaxHops} hops (of ${maxRounds} with 30% reserve). Restart with depth=${safeDepthHint || 1}, narrow the direction, or raise 'dataLineageViz.ai.maxRounds'.`,
    next_action: 'retry_with_smaller_depth',
  };
}
