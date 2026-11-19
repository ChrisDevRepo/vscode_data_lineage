/**
 * Shared prune validation and column-reference rejection policy for the Navigation Engine. Pure and
 * engine-state-free: maps a structural {@link InvalidRouteKind} to its machine error code and
 * verb-led corrective order, and builds the content-error rejection envelope. The engine consumes
 * {@link isAbsentKind} and {@link buildRouteValidationRejection}; absent/no-op references are
 * nonfatal notices and never reach the envelope.
 */

import type { InvalidRouteKind, InvalidRoute } from './smTypes';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { ISSUES, jsonPointer, makeRejection, type ToolRejection } from '../support/toolErrorEnvelope';

/** True for nonfatal drop/refuse-with-notice kinds. */
export function isAbsentKind(kind: InvalidRouteKind): boolean {
  return kind === 'absent_contributor'
    || kind === 'prune_absent' || kind === 'prune_noop_removed' || kind === 'prune_noop_visited'
    || kind === 'prune_noop_analyzed' || kind === 'prune_noop_queued' || kind === 'prune_noop_out_of_scope';
}

/**
 * Per-kind corrective order, keyed by {@link InvalidRouteKind} so a new kind is a compile error.
 * Each is a self-contained **verb-led imperative**, positive, with the legitimate alternative built
 * in so the model never guesses the nearest match; used for the content-error hint. A kind with its
 * own registry code states that code's table correction. The offending value is stated in the
 * rejection reason; column inventories stay machine-only until the final rejection.
 */
export const ROUTE_REJECTION_DIRECTIVE: Record<InvalidRouteKind, string> = {
  absent_contributor:
    'Record it as an unresolved upstream source in your analysis and keep the upstream columns that resolve — it is not in the loaded model.',
  bad_out_col: ISSUES[REJECTION_CODES.outColNotOnNode].correction,
  untracked_out_col: ISSUES[REJECTION_CODES.outColNotTracked].correction,
  bad_contributor_col: ISSUES[REJECTION_CODES.contributorColNotOnSource].correction,
  non_writer_continuation: ISSUES[REJECTION_CODES.continuationNotWriter].correction,
  self_loop_column: ISSUES[REJECTION_CODES.columnSelfLoop].correction,
  bad_return_target:
    'Supply one column_flow entry for each exact caller_output_targets destination, with returns_to matching that node and column and out_col matching its column. Do not use writes_to on scalar-return tasks; identify real contributors from the supplied caller and function SQL.',
  bad_caller_context:
    'Use questions[].caller_context only for a neighboring function with supplied caller SQL and an active real caller output; otherwise omit caller_context and keep the question.',
  bad_writes_to_target: ISSUES[REJECTION_CODES.writesToNamesReader].correction,
  pruned_contributor: ISSUES[REJECTION_CODES.prunedContributor].correction,
  column_out_of_scope: ISSUES[REJECTION_CODES.columnOutOfScope].correction,
  prune_absent:
    'This id is not in the loaded model — there is nothing to prune. Remove it from prune_neighbors.',
  prune_noop_removed:
    'This node was already pruned on an earlier hop. Remove it from prune_neighbors.',
  prune_noop_visited:
    'This node was already visited on an earlier hop — analyzed, or passed through as the carrier that led to this focus — and is retained; a prune cannot remove it. Remove it from prune_neighbors.',
  prune_noop_analyzed:
    'This node is already recorded as an analyzed (noted) node and is retained. Remove it from prune_neighbors.',
  prune_noop_queued:
    'This node is already queued for a hop of its own; prune_neighbors does not pull queued work. Remove it from prune_neighbors and let its own hop run.',
  prune_noop_out_of_scope:
    'This node is outside the approved scope (schema, direction, exclusion, or depth) and was never loaded into the graph — there is nothing to prune. Remove it from prune_neighbors.',
  question_not_neighbor:
    'A questions[] entry can only name a neighbor listed in `<hop_context>` for this focus; this node is not adjacent to it. Attach the question to the neighbor it is reached through, or remove the entry from questions.',
  prune_question_conflict:
    'Choose one action for this neighbor: remove it from prune_neighbors to investigate it, or remove its questions entry to prune it.',
  question_closed:
    'Remove questions[] entries for visited or pruned nodes. Attach new checks only to eligible unvisited neighbors; queued unvisited work can receive a question.',
};

/**
 * Repair order for an `untracked_out_col` whose reason names detached links (path
 * `.upstream_columns`).
 */
const DETACHED_LINK_DIRECTIVE =
  'Attach each named tuple to a tracked column, or leave it out of column_flow and keep it in sections; do not invent a write.';

/**
 * Machine error code per validation kind, used when one kind dominates the rejection (mixed kinds
 * fall back to the generic code). Exported so a nonfatal (absent-kind) notice is logged to
 * `host.log` with the code the model would have received had it been fatal: one machine-code source
 * for both surfaces.
 */
export const ROUTE_REJECTION_CODE: Record<InvalidRouteKind, string> = {
  absent_contributor: REJECTION_CODES.routeValidationFailed,
  bad_out_col: REJECTION_CODES.outColNotOnNode,
  untracked_out_col: REJECTION_CODES.outColNotTracked,
  bad_contributor_col: REJECTION_CODES.contributorColNotOnSource,
  non_writer_continuation: REJECTION_CODES.continuationNotWriter,
  self_loop_column: REJECTION_CODES.columnSelfLoop,
  bad_return_target: REJECTION_CODES.routeValidationFailed,
  bad_caller_context: REJECTION_CODES.routeValidationFailed,
  bad_writes_to_target: REJECTION_CODES.writesToNamesReader,
  pruned_contributor: REJECTION_CODES.prunedContributor,
  column_out_of_scope: REJECTION_CODES.columnOutOfScope,
  prune_absent: REJECTION_CODES.routeValidationFailed,
  prune_noop_removed: REJECTION_CODES.routeValidationFailed,
  prune_noop_visited: REJECTION_CODES.routeValidationFailed,
  prune_noop_analyzed: REJECTION_CODES.routeValidationFailed,
  prune_noop_queued: REJECTION_CODES.routeValidationFailed,
  prune_noop_out_of_scope: REJECTION_CODES.routeValidationFailed,
  question_not_neighbor: REJECTION_CODES.routeValidationFailed,
  prune_question_conflict: REJECTION_CODES.routeValidationFailed,
  question_closed: REJECTION_CODES.routeValidationFailed,
};

/** One model-facing reason line per validation failure: the offending path and what was wrong. */
function routeErrorLine(error: InvalidRoute): string {
  return [
    error.path ? `${jsonPointer(error.path.split('.'))}: ${error.reason}` : error.reason,
    ...(error.available_routes ? [`available routes: ${error.available_routes.join(', ') || '(none)'}`] : []),
  ].join('; ');
}

/** The verb-led corrective order of each distinct failure kind. */
export function routeDirectives(errors: readonly InvalidRoute[]): string[] {
  const kinds = [...new Set(errors.map(e => e.kind))];
  return [
    ...kinds.filter(kind => kind !== 'untracked_out_col'
      || errors.some(error => error.kind === kind && error.path?.endsWith('.out_col')))
      .map(kind => ROUTE_REJECTION_DIRECTIVE[kind]),
    errors.some(error => error.kind === 'untracked_out_col' && error.path?.endsWith('.upstream_columns')) ? DETACHED_LINK_DIRECTIVE : '',
  ].filter(Boolean);
}

/**
 * Builds the content/action rejection envelope after nonfatal notices were removed. Each kind is
 * emitted by one policy owner, so no message-text inference or mode branch is needed. `code` is the
 * per-kind code when one kind dominates; `hint` is the verb-led order(s), the held line being the
 * engine's to add where it holds the draft; `reason` states each
 * failure with its valid set, one line per error; `detail` carries the same facts as data.
 *
 * @param errors - Field-resolved validation failures accumulated before commit; at least one.
 */
export function buildRouteValidationRejection(errors: InvalidRoute[]): ToolRejection {
  const distinctKinds = [...new Set(errors.map(e => e.kind))];
  const code = distinctKinds.length === 1 ? ROUTE_REJECTION_CODE[distinctKinds[0]] : REJECTION_CODES.routeValidationFailed;
  const hint = routeDirectives(errors).join(' ');
  return makeRejection({
    code,
    reason: errors.map(routeErrorLine).join('\n'),
    hint,
    detail: errors.map(e => ({
      id: e.id,
      ...(e.path ? { path: e.path } : {}),
      reason: e.reason,
      ...(e.available_columns ? { available_columns: e.available_columns } : {}),
      ...(e.actual_columns ? { actual_columns: e.actual_columns } : {}),
      ...(e.available_routes ? { available_routes: e.available_routes } : {}),
      ...(e.alternatives ? { alternatives: e.alternatives } : {}),
    })),
    issuePaths: errors.flatMap(e => (e.path ? [e.path] : [])),
  });
}

