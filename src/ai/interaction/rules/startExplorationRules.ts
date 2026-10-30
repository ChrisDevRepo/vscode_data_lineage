import type { InteractionRuleResult } from '../types';
import { DEFAULT_EXPLORATION_QUESTION } from '../../sm/smTypes';
import { REJECTION_CODES } from '../../support/rejectionCodes';
import { resolveModelColumnNames } from '../../support/modelReferences';
import { at, makeRejection, type ToolRejection } from '../../support/toolErrorEnvelope';
import { allowsMissingColumnMetadata } from '../../sm/columnTracer';

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
  return makeRejection({ code: REJECTION_CODES.invalidInput, errors: at('already_started'), detail: { next_action: 'submit_findings' } });
}

/** Enforces one start_exploration call per LM round. */
export function evaluateParallelStartRule(
  priorStartRoundId: number | null,
  currentRoundId: number,
): InteractionRuleResult {
  if (priorStartRoundId === null || priorStartRoundId !== currentRoundId) return null;
  return makeRejection({ code: REJECTION_CODES.invalidInput, errors: at('one_call'), detail: { next_action: 'submit_findings' } });
}

/** CT requires named targets; BB forbids the field, including an empty list. Callers supply native-valid targets and the effective proposal mode. */
export function evaluateStartTargetColumnsRule(mode: 'bb' | 'ct' | undefined, targetColumns: readonly string[] | undefined): InteractionRuleResult {
  if (mode === 'ct' && !targetColumns?.length) return makeRejection({ code: REJECTION_CODES.invalidInput, errors: at('missing', ['targetColumns']) });
  if (mode === 'bb' && targetColumns !== undefined) return makeRejection({ code: REJECTION_CODES.invalidInput,
    reason: 'analysisMode "bb" is whole-object lineage and does not accept targetColumns.', errors: at('never', ['targetColumns']) });
  return null;
}

/** Resolves targets against the bound origin's columns; missing metadata is trusted only for D-026 object kinds. */
export function inspectTargetColumns(node: Parameters<typeof allowsMissingColumnMetadata>[0], declaredNames: readonly string[], columns: readonly string[] | ReadonlyMap<number, string>, identifierCaseSensitive = false): { resolved: string[]; unmatched: string[]; rejection: ToolRejection | null } {
  const supplied = [...columns.entries()];
  const names = supplied.map(([, value]) => value);
  const { resolved, unmatched } = declaredNames.length || allowsMissingColumnMetadata(node)
    ? resolveModelColumnNames(declaredNames, names, identifierCaseSensitive)
    : { resolved: [], unmatched: names };
  if (unmatched.length === 0) return { resolved, unmatched, rejection: null };
  const offending = unmatched;
  return { resolved, unmatched, rejection: makeRejection({
    code: REJECTION_CODES.invalidInput,
    resend: ['analysisMode'],
    reason: `targetColumns must match declared columns of the origin under its identifier comparison policy${declaredNames.length > 0 ? '' : '; the origin declares no columns of its own'}.`,
    errors: at('unknown_target_column', supplied.flatMap(([index, column]) => offending.includes(column) ? [`targetColumns.${index}`] : []), declaredNames),
    detail: { node: node.id },
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
  return { ...lists, originId, rejection: errors.length ? makeRejection({ code: REJECTION_CODES.invalidInput, errors }) : null };
}
