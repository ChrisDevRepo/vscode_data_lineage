import type { InteractionRuleResult } from '../types';
import { DEFAULT_EXPLORATION_QUESTION } from '../../sm/smTypes';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { ISSUES, makeRejection } from '../../support/toolErrorEnvelope';

/**
 * Resolves the canonical user question for an exploration from user-authored text only, never the
 * model's paraphrase (which anchors every hop and synthesis to the wrong text): the retained
 * verbatim discovery prompt covers approve-gate and follow-up flows, and the current turn's verbatim
 * prompt covers direct free-text entry.
 * `pendingInitQuestion` outranks the turn's prompt because callers supply it only while refining a
 * held proposal, where the prompt is the scope change ("skip DimCalendar") and it is the last
 * surviving copy of the question once the sliding-memory wipe removes the original chat turn.
 *
 * @param sources - The candidate question sources in provenance order.
 * @returns The canonical question, or null when no source is available.
 */
export function resolveCanonicalQuestion(sources: {
  lastDiscoveryQuestion: string | null;
  currentTurnPrompt: string | null;
  pendingInitQuestion: string | undefined;
}): string | null {
  const pick = (v: string | null | undefined): string | null =>
    typeof v === 'string' && v.trim().length > 0 && v.trim() !== DEFAULT_EXPLORATION_QUESTION
      ? v
      : null;
  return pick(sources.lastDiscoveryQuestion)
    ?? pick(sources.pendingInitQuestion)
    ?? pick(sources.currentTurnPrompt);
}

/** Rejects named columns inherited into a BB refine without mutating state; `null` if none. */
export function evaluateBbTargetColumnsRule(targetColumns: readonly string[] | undefined): InteractionRuleResult {
  if (!targetColumns?.length) return null;
  const { label, correction } = ISSUES[REJECTION_CODES.ctFieldForbiddenInBb];
  return makeRejection({ code: REJECTION_CODES.ctFieldForbiddenInBb, reason: `${label}.`, hint: correction, issuePaths: ['targetColumns'] });
}

/**
 * Duplicate-start guard for live engines in the same session when no refine loop is active; an
 * error when already started without refining, else null.
 */
export function evaluateAlreadyStartedRule(
  hasLiveEngine: boolean,
  sameSession: boolean,
  isRefining: boolean,
): InteractionRuleResult {
  if (!(hasLiveEngine && sameSession && !isRefining)) return null;
  return makeRejection({
    code: REJECTION_CODES.alreadyStarted,
    reason: 'An exploration is already running in this turn.',
    hint: 'Send lineage_submit_findings for the current object; each accepted finding serves the next queued object.',
    detail: { next_action: 'submit_findings' },
  });
}

/**
 * Enforces one start_exploration call per LM round (compares the previous start's round id with the
 * current one); an error when called in parallel, else null.
 */
export function evaluateParallelStartRule(
  priorStartRoundId: number | null,
  currentRoundId: number,
): InteractionRuleResult {
  if (priorStartRoundId === null || priorStartRoundId !== currentRoundId) return null;
  return makeRejection({
    code: REJECTION_CODES.parallelCallForbidden,
    reason: 'lineage_start_exploration was already called in this reply.',
  });
}

/** A supplement needs a completed engine archive; an error when incomplete, else null. */
export function evaluateSupplementPrereqRule(engineStatus: string | null): InteractionRuleResult {
  if (engineStatus === 'complete') return null;
  return makeRejection({
    code: REJECTION_CODES.supplementRequiresCompleteEngine,
    reason: `A supplement needs a completed prior exploration; the engine status is ${engineStatus ?? 'none'}.`,
    hint: 'Start a fresh exploration instead: omit /supplement and send /origin.',
  });
}
