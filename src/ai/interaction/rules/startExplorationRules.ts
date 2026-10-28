import type { InteractionRuleResult } from '../types';
import { DEFAULT_EXPLORATION_QUESTION } from '../../sm/smTypes';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { resolveModelColumnNames } from '../../support/modelReferences';
import { at, makeRejection, type ToolRejection } from '../../support/toolErrorEnvelope';

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
export function inspectTargetColumns(nodeId: string, declaredNames: readonly string[], columns: readonly string[] | ReadonlyMap<number, string>, identifierCaseSensitive = false): { resolved: string[]; unmatched: string[]; rejection: ToolRejection | null } {
  const supplied = [...columns.entries()];
  const { resolved, unmatched } = resolveModelColumnNames(declaredNames, supplied.map(([, value]) => value), identifierCaseSensitive);
  if (unmatched.length === 0) return { resolved, unmatched, rejection: null };
  const offending = unmatched;
  return { resolved, unmatched, rejection: makeRejection({
    code: REJECTION_CODES.unknownColumns,
    resend: ['analysisMode'],
    reason: `targetColumns must match declared columns of the origin under its identifier comparison policy${declaredNames.length > 0 ? '' : '; the origin declares no columns of its own'}.`,
    errors: at('unknown_target_column', supplied.flatMap(([index, column]) => offending.includes(column) ? [`targetColumns.${index}`] : []), declaredNames),
    detail: { node: nodeId },
  }) };
}

/** Resolve supplied start identities once; collect every unknown reference without mutating navigation state. */
export function inspectStartReferences(input: { origin?: string; excludeNodeIds?: readonly string[] | ReadonlyMap<number, string>; passNodeIds?: readonly string[] | ReadonlyMap<number, string> }, resolveId: (raw: string) => string | null) {
  const errors = at('not_found', []);
  const lists = Object.fromEntries((['excludeNodeIds', 'passNodeIds'] as const).map(field => [field, [...(input[field]?.entries() ?? [])].flatMap(([index, raw]) => {
    const id = resolveId(raw);
    if (!id) errors.push(...at('not_found', [`${field}.${index}`]));
    return id ? [id] : [];
  })])) as Record<'excludeNodeIds' | 'passNodeIds', string[]>;
  const originId = input.origin === undefined ? undefined : resolveId(input.origin);
  if (originId === null) errors.push(...at('not_found', ['origin']));
  return { ...lists, originId, rejection: errors.length ? makeRejection({ code: errors.every(error => error.path === 'origin') ? REJECTION_CODES.originNotFound : REJECTION_CODES.unknownNodeIds, errors }) : null };
}
