/** Shared prune validation and column-reference rejection policy for the Navigation Engine. */

import type { InvalidRouteKind, InvalidRoute } from './smTypes';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { makeRejection, type IssueCode, type ToolRejection } from '../support/toolErrorEnvelope';

/** The issue code of each route fault; the renderer states its fault and correction (D-103). */
const ROUTE_ISSUE = {
  absent_contributor: 'not_neighbor',
  bad_out_col: 'unknown_column',
  bad_contributor_col: 'unknown_column',
  self_loop_column: 'self_loop',
  bad_caller_context: 'bad_caller_output',
  pruned_contributor: 'closed_neighbor',
  column_out_of_scope: 'column_out_of_scope',
  prune_absent: 'prune_target',
  prune_noop_removed: 'prune_target',
  prune_noop_visited: 'prune_target',
  prune_noop_analyzed: 'prune_target',
  prune_noop_queued: 'prune_target',
  prune_noop_out_of_scope: 'prune_target',
  prune_unsupported: 'prune_target',
  prune_question_conflict: 'conflict',
  question_not_neighbor: 'not_neighbor',
  question_closed: 'closed_neighbor',
  neighbor_outcome_missing: 'neighbor_undecided',
} as const satisfies Record<InvalidRouteKind, IssueCode>;

/** Builds the atomic content/action rejection envelope. */
export function buildRouteValidationRejection(errors: InvalidRoute[]): ToolRejection {
  return makeRejection({
    code: REJECTION_CODES.invalidInput,
    reason: routeRejectionReason(errors),
    detail: routeRejectionDetail(errors),
    issuePaths: errors.flatMap(e => (e.path ? [e.path] : [])),
    resend: [...new Set(errors.flatMap(error => error.alternatives ?? []))],
    // A missing outcome names its neighbor: the subject of the fault, never a submitted value.
    errors: errors.map(error => ({ path: error.path ?? '', code: ROUTE_ISSUE[error.kind],
      ...(error.kind === 'neighbor_outcome_missing' ? { values: [error.id] } : error.allowed_values ? { values: error.allowed_values } : {}) })),
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

