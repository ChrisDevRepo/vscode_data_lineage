/** Shared prune validation and column-reference rejection policy for the Navigation Engine. */

import type { InvalidRouteKind, InvalidRoute } from './smTypes';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { makeRejection, type ToolRejection } from '../support/toolErrorEnvelope';

/** Principle: where a removal would lose a fact, the fixed text also says where the fact goes (sections or a question); chosen by fault code only. Last-chance corrective guidance after the first issue-only response. Conflict alternatives are composed per neighbor by {@link routeErrorDirectives}; a refusal for that same neighbor can rule out pruning. */
export const ROUTE_REJECTION_DIRECTIVE: Record<Exclude<InvalidRouteKind, 'prune_question_conflict'>, string> = {
  absent_contributor: 'Use a loaded eligible neighbor, or drop this reference and keep the fact in sections.',
  bad_out_col: 'Use a declared output column.',
  bad_contributor_col: 'Use a declared column, or drop this supplier and keep the fact in sections.',
  self_loop_column: 'Remove the supplier identical to its output destination.',
  bad_return_target: 'Use one supplied caller output and omit writes_to.',
  bad_write_target: 'Use a table this object writes to, or send writes_to: null and keep the write in sections.',
  bad_caller_context: 'Use an active declared caller output, or omit caller_context.',
  pruned_contributor: 'This supplier was pruned: drop it and keep the fact in sections.',
  prune_absent: 'Remove this unknown id from prune_neighbors.',
  prune_noop_removed: 'Remove this already pruned id from prune_neighbors.',
  prune_noop_visited: 'Remove this protected id from prune_neighbors. Resend prune_neighbors with only the entries that stay, or [] when none stay.',
  prune_noop_analyzed: 'Remove this analyzed id from prune_neighbors.',
  prune_noop_queued: 'Remove this queued id from prune_neighbors.',
  column_out_of_scope: 'Outside the approved scope: drop this reference and keep the fact in sections or as a question.',
  prune_noop_out_of_scope: 'Remove this outside id from prune_neighbors.',
  prune_unsupported: 'Remove this protected id from prune_neighbors. Resend prune_neighbors with only the entries that stay, or [] when none stay.',
  question_not_neighbor: 'Use an eligible neighbor, or drop this question and keep the fact in sections.',
  question_closed: 'Remove this visited or pruned neighbor from questions.',
  // The missing outcome names alternatives without invalidating a supplied field.
  neighbor_outcome_missing: '',
};

/** Machine error code per validation kind; unlisted kinds fall back to routeValidationFailed. */
export const ROUTE_REJECTION_CODE: Partial<Record<InvalidRouteKind, string>> = {
  bad_out_col: REJECTION_CODES.outColNotOnNode,
  bad_contributor_col: REJECTION_CODES.contributorColNotOnSource,
  self_loop_column: REJECTION_CODES.columnSelfLoop,
  pruned_contributor: REJECTION_CODES.prunedContributor,
};

/** Builds the atomic content/action rejection envelope. */
export function buildRouteValidationRejection(errors: InvalidRoute[]): ToolRejection {
  const distinctKinds = [...new Set(errors.map(e => e.kind))];
  const code = distinctKinds.length === 1 ? (ROUTE_REJECTION_CODE[distinctKinds[0]] ?? REJECTION_CODES.routeValidationFailed) : REJECTION_CODES.routeValidationFailed;
  const directives = routeErrorDirectives(errors);
  return makeRejection({
    code,
    reason: routeRejectionReason(errors),
    hint: directives.filter(Boolean).join(' '),
    detail: routeRejectionDetail(errors),
    issuePaths: errors.flatMap(e => (e.path ? [e.path] : [])),
    resend: [...new Set(errors.flatMap(error => error.alternatives ?? []))],
    errors: errors.map((error, index) => ({ path: error.path ?? error.id, issue: directives[index] ? `${/[.!?]$/.test(error.reason) ? error.reason : `${error.reason}.`} ${directives[index]}` : error.reason,
      ...(error.alternatives ? { alternatives: error.alternatives } : {}),
      ...(error.allowed_values ? { allowed: error.allowed_values } : {}), ...(error.when ? { when: error.when } : {}) })),
  });
}

/** Repair guidance of each failure from the complete validation result, `undefined` where an earlier failure already states it. Independent errors deduplicate by kind; conflict alternatives retain the neighbor identity and honor its prune refusal. Raw reasons, paths and details remain unchanged. */
function routeErrorDirectives(errors: readonly InvalidRoute[]): Array<string | undefined> {
  const refusedPrunes = new Set(errors.filter(error => error.kind !== 'prune_question_conflict'
    && error.path?.startsWith('prune_neighbors.')).map(error => error.id));
  const shown = new Set<string>();
  return errors.map(error => {
    if (error.kind === 'prune_unsupported' && errors.some(other => other.kind === 'prune_question_conflict' && other.id === error.id)) return undefined;
    const key = error.kind === 'prune_question_conflict' ? `${error.kind}:${error.id}` : error.kind;
    if (shown.has(key)) return undefined;
    shown.add(key);
    if (error.kind === 'prune_question_conflict') {
      return refusedPrunes.has(error.id)
        ? `For neighbor \`${error.id}\`, keep its question and remove its prune_neighbors entry.`
        : `For neighbor \`${error.id}\`, keep its questions entry or its prune_neighbors entry, not both.`;
    }
    return ROUTE_REJECTION_DIRECTIVE[error.kind];
  });
}

/** One reason line per route/column failure: its path and what was wrong. */
function routeRejectionReason(errors: readonly InvalidRoute[]): string {
  return errors.map(error => error.path ? `${error.path}: ${error.reason}` : error.reason).join('\n');
}

/** The route/column failures as rejection `detail` data. */
function routeRejectionDetail(errors: readonly InvalidRoute[]): Array<Record<string, unknown>> {
  return errors.map(e => ({
    kind: e.kind,
    id: e.id,
    ...(e.path ? { path: e.path } : {}),
    reason: e.reason,
    ...(e.allowed_values !== undefined ? { allowed_values: e.allowed_values } : {}),
    ...(e.when ? { when: e.when } : {}),
  }));
}

