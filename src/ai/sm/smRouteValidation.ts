/** Shared prune validation and column-reference rejection policy for the Navigation Engine. */

import type { InvalidRouteKind, InvalidRoute } from './smTypes';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { makeRejection, type ToolRejection } from '../support/toolErrorEnvelope';

/** The fixed correction per fault code: the fault and the valid correction only (the allowed values ride on the error from feedback 2), never a leave-out remedy; the detail-memory callout comes only from the stage-3 fallback (D-105). Conflict alternatives are composed per neighbor by {@link routeErrorDirectives}; a refusal for that same neighbor can rule out pruning. */
const ROUTE_REJECTION_DIRECTIVE: Record<Exclude<InvalidRouteKind, 'prune_question_conflict'>, string> = {
  absent_contributor: 'Name a loaded eligible neighbor.',
  bad_out_col: 'Use a declared output column.',
  bad_contributor_col: 'Name a declared column of that supplier.',
  self_loop_column: 'A supplier cannot be its own output destination; name the column that feeds it.',
  bad_return_target: 'Name one supplied caller output.',
  bad_write_target: 'Name a table this object writes to.',
  bad_caller_context: 'Name an active declared caller output.',
  pruned_contributor: 'This supplier was pruned earlier; name a neighbor that is still open.',
  prune_absent: 'prune_neighbors takes only an id of a prunable neighbor.',
  prune_noop_removed: 'This id is already pruned; prune_neighbors takes only an id of a prunable neighbor.',
  prune_noop_visited: 'This neighbor is protected and cannot be pruned; prune_neighbors takes only an id of a prunable neighbor.',
  prune_noop_analyzed: 'This neighbor is already analyzed and cannot be pruned; prune_neighbors takes only an id of a prunable neighbor.',
  prune_noop_queued: 'This neighbor is already queued and cannot be pruned; prune_neighbors takes only an id of a prunable neighbor.',
  column_out_of_scope: 'Name a supplier and write target inside the approved scope.',
  prune_noop_out_of_scope: 'This id is outside the approved scope; prune_neighbors takes only an id of a prunable neighbor.',
  prune_unsupported: 'This neighbor is protected and cannot be pruned; prune_neighbors takes only an id of a prunable neighbor.',
  question_not_neighbor: 'Name an eligible neighbor.',
  question_closed: 'This neighbor is already visited or pruned; questions take only an open neighbor.',
  // The missing outcome names alternatives without invalidating a supplied field.
  neighbor_outcome_missing: '',
};

/** Machine error code per validation kind; unlisted kinds fall back to routeValidationFailed. */
const ROUTE_REJECTION_CODE: Partial<Record<InvalidRouteKind, string>> = {
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
    detail: routeRejectionDetail(errors),
    issuePaths: errors.flatMap(e => (e.path ? [e.path] : [])),
    resend: [...new Set(errors.flatMap(error => error.alternatives ?? []))],
    errors: errors.map((error, index) => ({ path: error.path ?? error.id, code: ROUTE_REJECTION_CODE[error.kind] ?? error.kind,
      message: directives[index] ? `${/[.!?]$/.test(error.reason) ? error.reason : `${error.reason}.`} ${directives[index]}` : error.reason,
      ...(error.alternatives ? { alternatives: error.alternatives } : {}),
      ...(error.allowed_values ? { allowed: error.allowed_values } : {}) })),
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
        ? `Neighbor \`${error.id}\` cannot be pruned; keep its question.`
        : `Neighbor \`${error.id}\` takes one decision: a questions entry or a prune_neighbors entry.`;
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

