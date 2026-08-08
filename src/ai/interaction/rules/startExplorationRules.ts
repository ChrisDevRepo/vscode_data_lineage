import type { InteractionRuleResult } from '../types';
import type { ZodError, ZodIssue } from 'zod';
import { DEFAULT_EXPLORATION_QUESTION } from '../../sm/smTypes';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import {
  ASYMMETRIC_DEPTH_BOTH_ZERO,
  ASYMMETRIC_DEPTH_REQUIRES_BIDIRECTIONAL,
} from '../../../engine/shared/explorationDepthContract';

type StartRejectIssue = { code: string; path: string; message: string; action: string };

/**
 * Resolves the canonical user question for an exploration.
 *
 * @remarks
 * User-authored text always wins over the model's paraphrase: the retained
 * verbatim discovery prompt covers approve-gate and follow-up flows, the current
 * turn's verbatim prompt covers direct free-text entry, and only then does the
 * model-supplied `question` (or the refined proposal's retained question) apply.
 * Without this precedence the stored question is frequently the model's
 * restatement — or the literal default `'Explore lineage'` — which then anchors
 * every hop and synthesis to the wrong text.
 *
 * @param sources - The candidate question sources in provenance order.
 * @returns The canonical question, or null when no source is available.
 */
export function resolveCanonicalQuestion(sources: {
  lastDiscoveryQuestion: string | null;
  currentTurnPrompt: string | null;
  modelQuestion: string | undefined;
  pendingInitQuestion: string | undefined;
}): string | null {
  // The placeholder sentinel is "absent" by contract (see DEFAULT_EXPLORATION_QUESTION in
  // smTypes.ts) — it must never become the canonical question that anchors hops and synthesis.
  const pick = (v: string | null | undefined): string | null =>
    typeof v === 'string' && v.trim().length > 0 && v.trim() !== DEFAULT_EXPLORATION_QUESTION
      ? v
      : null;
  return pick(sources.lastDiscoveryQuestion)
    ?? pick(sources.currentTurnPrompt)
    ?? pick(sources.modelQuestion)
    ?? pick(sources.pendingInitQuestion);
}

const BB_ACTION = 'Omit targetColumns and resubmit the BB specification. If the provider emits an empty array, the encoding boundary normalizes it automatically.';
const CT_ACTION = 'Provide at least one named targetColumns value and resubmit CT.';

function mapStartIssue(issue: ZodIssue, input?: Record<string, unknown>): StartRejectIssue {
  const path = issue.path.join('.') || '(root)';
  const tag = issue.code === 'custom' ? issue.params?.startIssue : undefined;
  if (tag === 'bb_target_columns_forbidden') return { code: 'ct_field_forbidden_in_bb', path, message: issue.message, action: BB_ACTION };
  if (tag === 'ct_target_columns_required') return { code: 'missing_field', path, message: issue.message, action: CT_ACTION };
  if (tag === ASYMMETRIC_DEPTH_BOTH_ZERO) return { code: ASYMMETRIC_DEPTH_BOTH_ZERO, path, message: issue.message, action: 'At least one side must be ≥ 1 or "all"; both 0 would create an empty scope.' };
  if (tag === ASYMMETRIC_DEPTH_REQUIRES_BIDIRECTIONAL) return { code: ASYMMETRIC_DEPTH_REQUIRES_BIDIRECTIONAL, path, message: issue.message, action: 'Asymmetric upstream/downstream depth requires direction "bidirectional". For one direction only, use direction "upstream"/"downstream" with a symmetric depth (a hard border); or keep "bidirectional" and set the other side to 0 to permanently exclude it.' };
  if (issue.code === 'unrecognized_keys') return { code: 'unknown_field', path: issue.keys.join(',') || path, message: issue.message, action: 'Remove the unknown field and resubmit.' };
  if (issue.code === 'invalid_type') return { code: issue.expected === 'undefined' ? 'missing_field' : 'invalid_type', path, message: issue.message, action: `Correct ${path} and resubmit.` };
  if (issue.code === 'invalid_value' && ['analysisMode', 'classification', 'direction'].includes(path)) {
    if (input && !Object.prototype.hasOwnProperty.call(input, path)) return { code: 'missing_field', path, message: issue.message, action: `Provide ${path} and resubmit.` };
    return { code: 'invalid_enum', path, message: issue.message, action: `Use an allowed ${path} value and resubmit.` };
  }
  return { code: tag === 'analysis_mode_required' || tag === 'classification_required' || tag === 'start_shape_required' ? 'missing_field' : 'invalid_value', path, message: issue.message, action: `Correct ${path} and resubmit.` };
}

/**
 * Builds a stable, bounded rejection envelope from start-exploration Zod issues.
 *
 * @param error - Strict schema failure whose issue meaning must be preserved.
 * @param input - Normalized payload used to distinguish absent enum fields from invalid values.
 * @returns A compatible rejection envelope containing at most three unique field issues.
 */
export function buildStartExplorationReject(error: ZodError, input?: Record<string, unknown>): NonNullable<InteractionRuleResult> {
  const unique = new Map<string, StartRejectIssue>();
  for (const issue of error.issues) {
    const mapped = mapStartIssue(issue, input);
    unique.set(`${mapped.code}:${mapped.path}`, mapped);
    if (unique.size === 3) break;
  }
  const issues = [...unique.values()];
  const top = issues[0] ?? { code: 'invalid_value', path: '(root)', message: 'Invalid input.', action: 'Correct the input and resubmit.' };
  return { error: top.code, hint: top.action, next_action: top.action, detail: { issues } };
}

/**
 * Rejects named columns inherited into a BB refine without mutating engine state.
 *
 * @param targetColumns - Columns supplied while the effective refine mode is BB.
 * @returns A mode-conflict rejection, or `null` when no named targets are present.
 */
export function evaluateBbTargetColumnsRule(targetColumns: readonly string[] | undefined): InteractionRuleResult {
  if (!targetColumns?.length) return null;
  return { error: 'ct_field_forbidden_in_bb', hint: BB_ACTION, next_action: BB_ACTION };
}

/**
 * Duplicate-start guard for live engines in the same session when no refine
 * loop is active.
 *
 * @param hasLiveEngine - True if an engine is already running.
 * @param sameSession - True if the session matches.
 * @param isRefining - True if currently refining scope.
 * @returns A rule result error if already started without refining, otherwise null.
 */
export function evaluateAlreadyStartedRule(
  hasLiveEngine: boolean,
  sameSession: boolean,
  isRefining: boolean,
): InteractionRuleResult {
  if (!(hasLiveEngine && sameSession && !isRefining)) return null;
  return {
    error: REJECTION_CODES.alreadyStarted,
    hint: 'start_exploration is one-shot per turn. Use submit_findings to continue the current agenda. After complete_rejected, the unvisited neighbors are already queued at priority 3 - the next submit_findings will present one of them.',
    next_action: 'submit_findings',
  };
}

/**
 * Enforces one start_exploration call per LM round.
 *
 * @param priorStartRoundId - The round id of the previous start call, if any.
 * @param currentRoundId - The current round id.
 * @returns A rule result error if called in parallel, otherwise null.
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
 *
 * @param engineStatus - The current status of the engine.
 * @returns A rule result error if the engine is not complete, otherwise null.
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
 *
 * @param scopeSize - The size of the proposed scope.
 * @param safeMaxHops - The maximum number of hops allowed within budget.
 * @param maxRounds - The maximum rounds allowed for the session.
 * @returns A rule result error if scope exceeds budget, otherwise null.
 */
export function evaluateScopeBudgetRule(
  scopeSize: number,
  safeMaxHops: number,
  maxRounds: number,
): InteractionRuleResult {
  if (scopeSize <= safeMaxHops) return null;
  return {
    error: 'scope_exceeds_budget',
    scope_size: scopeSize,
    max_rounds: maxRounds,
    safe_max_hops: safeMaxHops,
    hint: `Scope has ${scopeSize} nodes; sliding-memory budget allows ~${safeMaxHops} hops (of ${maxRounds} with 30% reserve). Narrow structurally with excludeSchemas/excludeNodeIds (or passNodeIds), or ask the user which subset of the lineage they want. Do not invent a depth.`,
    next_action: 'narrow_scope',
  };
}
