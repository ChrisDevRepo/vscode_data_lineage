import type { InteractionRuleResult } from '../types';
import type { ZodError } from 'zod';
import { DEFAULT_EXPLORATION_QUESTION } from '../../sm/smTypes';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { resolveModelColumnNames } from '../../support/modelReferences';
import { at, makeRejection, rejectionFromZodError, type ToolRejection } from '../../support/toolErrorEnvelope';
import { BB_TARGET_COLUMNS_FAULT, StartExplorationInputSchema } from '../../tools/toolSchemas';

/** Resolves the canonical user question for an exploration. */
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

/** The one start-exploration schema rejection: every fault by path and issue code, messages from the schema and the issue-code table. */
export function buildStartExplorationReject(error: ZodError, input?: Record<string, unknown>): NonNullable<InteractionRuleResult> {
  return rejectionFromZodError(error, { code: REJECTION_CODES.invalidInput, input, schema: StartExplorationInputSchema });
}

/** Rejects named columns inherited into a BB refine without mutating engine state. */
export function evaluateBbTargetColumnsRule(targetColumns: readonly string[] | undefined): InteractionRuleResult {
  if (!targetColumns?.length) return null;
  return makeRejection({ code: REJECTION_CODES.ctFieldForbiddenInBb, reason: BB_TARGET_COLUMNS_FAULT, errors: at('never', ['targetColumns']) });
}

/** Duplicate-start guard for live engines in the same session when no refine loop is active. */
export function evaluateAlreadyStartedRule(
  hasLiveEngine: boolean,
  sameSession: boolean,
  isRefining: boolean,
): InteractionRuleResult {
  if (!(hasLiveEngine && sameSession && !isRefining)) return null;
  return makeRejection({ code: REJECTION_CODES.alreadyStarted, errors: at('already_started'), detail: { next_action: 'submit_findings' } });
}

/** Enforces one start_exploration call per LM round. */
export function evaluateParallelStartRule(
  priorStartRoundId: number | null,
  currentRoundId: number,
): InteractionRuleResult {
  if (priorStartRoundId === null || priorStartRoundId !== currentRoundId) return null;
  return makeRejection({ code: REJECTION_CODES.parallelCallForbidden, errors: at('one_call'), detail: { next_action: 'submit_findings' } });
}

/** Read-only CT target admission over the uniquely bound origin's current declared columns. */
export function inspectTargetColumns(nodeId: string, declaredNames: readonly string[], columns: readonly string[], identifierCaseSensitive = false): { resolved: string[]; unmatched: string[]; rejection: ToolRejection | null } {
  const { resolved, unmatched } = resolveModelColumnNames(declaredNames, columns, identifierCaseSensitive);
  if (columns.length === 0 || (resolved.length > 0 && unmatched.length === 0)) return { resolved, unmatched, rejection: null };
  const offending = unmatched.length > 0 ? unmatched : columns;
  return { resolved, unmatched, rejection: makeRejection({
    code: REJECTION_CODES.unknownColumns,
    resend: ['analysisMode'],
    reason: `targetColumns must match declared columns of the origin under its identifier comparison policy${declaredNames.length > 0 ? '' : '; the origin declares no columns of its own'}.`,
    errors: at('unknown_column', columns.flatMap((column, index) => offending.includes(column) ? [`targetColumns.${index}`] : []), declaredNames),
    detail: { node: nodeId },
  }) };
}
