import type { InteractionRuleResult } from '../types';
import type { ZodError, ZodIssue } from 'zod';
import { DEFAULT_EXPLORATION_QUESTION } from '../../sm/smTypes';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { INVALID_TOOL_INPUT_REPAIR_HINT, makeRejection } from '../../support/toolErrorEnvelope';
import {
  ASYMMETRIC_DEPTH_BOTH_ZERO,
} from '../../../engine/shared/explorationDepthContract';
import { CT_TARGET_COLUMNS_RECOVERY } from '../../tools/toolSchemas';

type StartRejectIssue = { code: string; path: string; message: string; action: string };

/** The repair of an issue whose message already states the fact: the one generic resend rule. */
const RESEND = INVALID_TOOL_INPUT_REPAIR_HINT;

/**
 * Resolves the canonical user question for an exploration.
 *
 * @remarks
 * User-authored text always wins over the model's paraphrase: the retained verbatim discovery
 * prompt covers approve-gate and follow-up flows, the current turn's verbatim prompt covers direct
 * free-text entry, and only then does the model-supplied `question` apply — otherwise the stored
 * question is frequently the model's restatement, or the literal placeholder default, which then
 * anchors every hop and synthesis to the wrong text. `pendingInitQuestion` outranks the current
 * turn's prompt because callers supply it only while refining a held proposal, where the turn's
 * prompt is the scope change ("skip DimCalendar") rather than the question, and it is the last
 * surviving copy of what the user asked once the sliding-memory wipe removes the original chat turn.
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
  const pick = (v: string | null | undefined): string | null =>
    typeof v === 'string' && v.trim().length > 0 && v.trim() !== DEFAULT_EXPLORATION_QUESTION
      ? v
      : null;
  return pick(sources.lastDiscoveryQuestion)
    ?? pick(sources.pendingInitQuestion)
    ?? pick(sources.currentTurnPrompt)
    ?? pick(sources.modelQuestion);
}

const BB_ACTION = 'Omit targetColumns and resubmit the BB specification.';

function mapStartIssue(issue: ZodIssue, input?: Record<string, unknown>): StartRejectIssue {
  const path = issue.path.join('.') || '(root)';
  const tag = issue.code === 'custom' ? issue.params?.startIssue : undefined;
  if (tag === 'bb_target_columns_forbidden') return { code: REJECTION_CODES.ctFieldForbiddenInBb, path, message: issue.message, action: BB_ACTION };
  if (tag === 'ct_target_columns_required') return { code: REJECTION_CODES.missingField, path, message: issue.message, action: CT_TARGET_COLUMNS_RECOVERY };
  if (tag === 'start_shape_conflict') return { code: 'invalid_value', path, message: issue.message, action: issue.message };
  if (tag === ASYMMETRIC_DEPTH_BOTH_ZERO) return { code: ASYMMETRIC_DEPTH_BOTH_ZERO, path, message: issue.message, action: 'At least one side must be ≥ 1 or "all"; both 0 would create an empty scope.' };
  if (issue.code === 'unrecognized_keys') return { code: 'unknown_field', path: issue.keys.join(',') || path, message: issue.message, action: 'Remove the unknown field and resubmit.' };
  if (issue.code === 'invalid_type') return { code: issue.expected === 'undefined' ? REJECTION_CODES.missingField : 'invalid_type', path, message: issue.message, action: RESEND };
  if (issue.code === 'invalid_value' && ['analysisMode', 'classification'].includes(path)) {
    if (input && !Object.prototype.hasOwnProperty.call(input, path)) return { code: REJECTION_CODES.missingField, path, message: issue.message, action: RESEND };
    return { code: 'invalid_enum', path, message: issue.message, action: RESEND };
  }
  return { code: tag === 'analysis_mode_required' || tag === 'classification_required' || tag === 'start_shape_required' || tag === 'depth_required' ? REJECTION_CODES.missingField : 'invalid_value', path, message: issue.message, action: RESEND };
}

/**
 * Builds a stable, bounded rejection envelope from start-exploration Zod issues.
 *
 * @param error - Strict schema failure whose issue meaning must be preserved.
 * @param input - Raw payload used to distinguish absent enum fields from invalid values.
 * @returns A compatible rejection envelope containing at most three unique field issues; the
 * `reason` states every issue as `path: message` (the path alone when the message is itself a
 * repair the `hint` serves) and the `hint` serves the distinct repairs of
 * every issue once, the generic resend rule last.
 */
export function buildStartExplorationReject(error: ZodError, input?: Record<string, unknown>): NonNullable<InteractionRuleResult> {
  const unique = new Map<string, StartRejectIssue>();
  for (const issue of error.issues) {
    const mapped = mapStartIssue(issue, input);
    unique.set(`${mapped.code}:${mapped.path}`, mapped);
    if (unique.size === 3) break;
  }
  const issues = [...unique.values()];
  const actions = [...new Set(issues.map(issue => issue.action))].sort((a, b) => Number(a === RESEND) - Number(b === RESEND));
  return makeRejection({
    code: issues[0]?.code ?? 'invalid_value',
    reason: issues.map(issue => (actions.includes(issue.message) ? issue.path : `${issue.path}: ${issue.message}`)).join('\n'),
    hint: actions.join(' ') || RESEND,
    detail: { issues: issues.map(({ action: _action, ...issue }) => issue) },
    issuePaths: issues.map(issue => issue.path),
  });
}

/**
 * Rejects named columns inherited into a BB refine without mutating engine state.
 *
 * @param targetColumns - Columns supplied while the effective refine mode is BB.
 * @returns A mode-conflict rejection, or `null` when no named targets are present.
 */
export function evaluateBbTargetColumnsRule(targetColumns: readonly string[] | undefined): InteractionRuleResult {
  if (!targetColumns?.length) return null;
  return makeRejection({ code: REJECTION_CODES.ctFieldForbiddenInBb, hint: BB_ACTION });
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
  return makeRejection({
    code: REJECTION_CODES.alreadyStarted,
    hint: 'start_exploration is one-shot per turn. Use submit_findings to continue the current agenda. After complete_rejected, the unvisited neighbors are already queued at priority 3 - the next submit_findings will present one of them.',
    detail: { next_action: 'submit_findings' },
  });
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
  return makeRejection({
    code: 'parallel_call_forbidden',
    hint: 'start_exploration is strictly serial and one-shot per round. Use submit_findings for the queued neighbors - after complete_rejected they are queued at priority 3 and will be served on the next submit_findings.',
    detail: { next_action: 'submit_findings' },
  });
}

/**
 * Supplement path requires a completed engine archive.
 *
 * @param engineStatus - The current status of the engine.
 * @returns A rule result error if the engine is not complete, otherwise null.
 */
export function evaluateSupplementPrereqRule(engineStatus: string | null): InteractionRuleResult {
  if (engineStatus === 'complete') return null;
  return makeRejection({
    code: REJECTION_CODES.supplementRequiresCompleteEngine,
    hint: `supplement requires a completed prior exploration. Current engine status: ${engineStatus ?? 'none'}. Start a fresh exploration instead (omit the 'supplement' field, provide 'origin').`,
  });
}
