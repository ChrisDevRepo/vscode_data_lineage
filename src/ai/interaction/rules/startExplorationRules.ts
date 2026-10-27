import type { InteractionRuleResult } from '../types';
import type { ZodError, ZodIssue } from 'zod';
import { DEFAULT_EXPLORATION_QUESTION } from '../../sm/smTypes';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { resolveModelColumnNames } from '../../support/modelReferences';
import { makeRejection, rejectionFromZodError, type ToolRejection } from '../../support/toolErrorEnvelope';
import {
  ASYMMETRIC_DEPTH_BOTH_ZERO,
} from '../../../engine/shared/explorationDepthContract';
import { CT_TARGET_COLUMNS_RECOVERY, StartExplorationInputSchema } from '../../tools/toolSchemas';

type StartRejectIssue = { code: string; path: string; message: string; action?: string };

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

const BB_ACTION = 'Omit targetColumns and resubmit the BB specification.';

function mapStartIssue(issue: ZodIssue, input?: Record<string, unknown>): StartRejectIssue {
  const path = issue.path.join('.') || '(root)';
  const tag = issue.code === 'custom' ? issue.params?.startIssue : undefined;
  const message = issue.message;
  if (tag === 'bb_target_columns_forbidden') return { code: REJECTION_CODES.ctFieldForbiddenInBb, path, message, action: BB_ACTION };
  if (tag === 'ct_target_columns_required') return { code: REJECTION_CODES.missingField, path, message, action: CT_TARGET_COLUMNS_RECOVERY };
  if (tag === ASYMMETRIC_DEPTH_BOTH_ZERO) return { code: ASYMMETRIC_DEPTH_BOTH_ZERO, path, message, action: 'At least one side must be ≥ 1 or "all"; both 0 would create an empty scope.' };
  if (issue.code === 'unrecognized_keys') return { code: 'unknown_field', path: issue.keys.join(',') || path, message, action: 'Remove the unknown field and resubmit.' };
  if (issue.code === 'invalid_type') return { code: issue.expected === 'undefined' ? REJECTION_CODES.missingField : 'invalid_type', path, message };
  if (issue.code === 'invalid_value' && ['analysisMode', 'classification'].includes(path)) {
    if (input && !Object.prototype.hasOwnProperty.call(input, path)) return { code: REJECTION_CODES.missingField, path, message };
    return { code: 'invalid_enum', path, message };
  }
  return { code: tag === 'analysis_mode_required' || tag === 'classification_required' || tag === 'start_shape_required' || tag === 'depth_required' ? REJECTION_CODES.missingField : 'invalid_value', path, message };
}

/** Builds a stable rejection envelope from every start-exploration Zod issue. */
export function buildStartExplorationReject(error: ZodError, input?: Record<string, unknown>): NonNullable<InteractionRuleResult> {
  const unique = new Map<string, StartRejectIssue>();
  for (const issue of error.issues) {
    const mapped = mapStartIssue(issue, input);
    unique.set(`${mapped.code}:${mapped.path}`, mapped);
  }
  const issues = [...unique.values()];
  const schemaFaults = rejectionFromZodError(error, { code: REJECTION_CODES.invalidInput, input, schema: StartExplorationInputSchema });
  const actions = [...new Set(issues.flatMap(issue => issue.action ? [issue.action] : []))];
  return makeRejection({
    code: issues[0]?.code ?? 'invalid_value',
    reason: schemaFaults.reason,
    hint: actions.join(' ') || undefined,
    detail: [{ issues: issues.map(({ action: _action, ...issue }) => issue) }],
    issuePaths: issues.map(issue => issue.path),
    errors: schemaFaults.errors,
  });
}

/** Rejects named columns inherited into a BB refine without mutating engine state. */
export function evaluateBbTargetColumnsRule(targetColumns: readonly string[] | undefined): InteractionRuleResult {
  if (!targetColumns?.length) return null;
  return makeRejection({ code: REJECTION_CODES.ctFieldForbiddenInBb, hint: BB_ACTION });
}

/** Duplicate-start guard for live engines in the same session when no refine loop is active. */
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

/** Enforces one start_exploration call per LM round. */
export function evaluateParallelStartRule(
  priorStartRoundId: number | null,
  currentRoundId: number,
): InteractionRuleResult {
  if (priorStartRoundId === null || priorStartRoundId !== currentRoundId) return null;
  return makeRejection({
    code: 'parallel_call_forbidden',
    reason: 'lineage_start_exploration was already called in this reply.',
    hint: 'Send lineage_submit_findings for the current object; each accepted finding serves the next queued object.',
    detail: { next_action: 'submit_findings' },
  });
}

/** Read-only CT target admission over the uniquely bound origin's current declared columns. */
export function inspectTargetColumns(nodeId: string, declaredNames: readonly string[], columns: readonly string[], identifierCaseSensitive = false): { resolved: string[]; unmatched: string[]; rejection: ToolRejection | null } {
  const { resolved, unmatched } = resolveModelColumnNames(declaredNames, columns, identifierCaseSensitive);
  if (columns.length === 0 || (resolved.length > 0 && unmatched.length === 0)) return { resolved, unmatched, rejection: null };
  const offending = unmatched.length > 0 ? unmatched : columns;
  return { resolved, unmatched, rejection: makeRejection({
    code: 'unknown_columns',
    resend: ['analysisMode'],
    reason: 'targetColumns must match declared columns of the origin under its identifier comparison policy.',
    issuePaths: columns.flatMap((column, index) => offending.includes(column) ? [`targetColumns.${index}`] : []),
    detail: columns.flatMap((column, index) => offending.includes(column)
      ? [{ path: `targetColumns.${index}`, allowed_values: declaredNames, when: { node: nodeId } }] : []),
    hint: declaredNames.length > 0
      ? `targetColumns [${offending.join(', ')}] are not columns on ${nodeId}. Provide valid columns, ask the user to clarify, or switch analysisMode to "bb".`
      : `targetColumns [${offending.join(', ')}] are not columns on ${nodeId}, which exposes no column metadata of its own. Provide valid columns, ask the user to clarify, or switch analysisMode to "bb".`,
  }) };
}
