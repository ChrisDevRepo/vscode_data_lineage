/**
 * Shared prune validation and column-reference rejection policy for the Navigation Engine.
 *
 * @remarks
 * Pure, engine-state-free: maps a structural {@link InvalidRouteKind} to its machine error code
 * and verb-led corrective order, and builds the content-error rejection envelope. The engine
 * consumes {@link isAbsentKind} and {@link buildRouteValidationRejection}. Absent/no-op references are
 * nonfatal notices and never reach the rejection envelope.
 */

import type { InvalidRouteKind, InvalidRoute } from './smTypes';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { keyedResendRule } from '../support/repairDraftStore';
import { HELD_FINDING_CALL_ORDER } from '../tools/toolSchemas';
import { makeRejection, type ToolRejection } from '../support/toolErrorEnvelope';

/** True for nonfatal drop/refuse-with-notice kinds. */
export function isAbsentKind(kind: InvalidRouteKind): boolean {
  return kind === 'absent_contributor'
    || kind === 'prune_absent' || kind === 'prune_noop_removed' || kind === 'prune_noop_visited'
    || kind === 'prune_noop_analyzed' || kind === 'prune_noop_queued' || kind === 'prune_noop_out_of_scope';
}

/**
 * Per-kind corrective order. Keyed by {@link InvalidRouteKind} so a new kind is a compile
 * error. Each value is a self-contained, **verb-led imperative** — positive, with the
 * legitimate alternative built in so the model never has to guess the nearest match. Used for
 * the content-error hint. The offending value
 * is stated in the rejection reason; column inventories remain machine-only until the final rejection.
 */
export const ROUTE_REJECTION_DIRECTIVE: Record<InvalidRouteKind, string> = {
  absent_contributor:
    'Record it as an unresolved upstream source in your analysis and keep the upstream columns that resolve — it is not in the loaded model.',
  bad_out_col:
    'Recheck the exact object and column identity against the supplied SQL; do not guess a replacement.',
  untracked_out_col:
    'Set column_flow[].out_col to a tracked column from the `<column_trace> Active columns` list supplied for this hop — the named column exists on this node but the trace does not follow it — or submit column_flow: [] if this node carries no tracked column.',
  bad_contributor_col:
    'Recheck the exact object and column identity against the supplied SQL; do not guess a replacement.',
  non_writer_continuation:
    'This focus node has no body of its own, so its column_flow declares continuation: name only the neighbours on this focus\'s carrier side, using the valid routes named in the rejection reason, carrying the tracked column unchanged; the column is attributed on that node\'s own hop, where its body is in view. Remove entries naming any other neighbour.',
  self_loop_column:
    'Remove the upstream_columns entry identical to its output destination; keep a SQL-proved writes_to unchanged and explain any existing-destination read in sections.',
  bad_return_target:
    'Supply one column_flow entry for each exact caller_output_targets destination, with returns_to matching that node and column and out_col matching its column. Do not use writes_to on scalar-return tasks; identify real contributors from the supplied caller and function SQL.',
  bad_caller_context:
    'Use questions[].caller_context only for a neighboring function with supplied caller SQL and an active real caller output; otherwise omit caller_context and keep the question.',
  bad_writes_to_target:
    'Set writes_to to the table and column this hop\'s SQL writes, or to null when it writes no table. A downstream reader is never a write destination: remove that node from writes_to; every open neighbor you do not prune is visited anyway.',
  pruned_contributor:
    'This upstream node was already pruned earlier this run and cannot supply the column — a removed node stays removed. Name a different, still-reachable supplier for this upstream_columns entry, or submit upstream_columns: [] and account for the column ending here.',
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

/** Repair order for an `untracked_out_col` whose reason names detached links (path `.upstream_columns`). */
const DETACHED_LINK_DIRECTIVE =
  'Attach each named tuple to a tracked column, or leave it out of column_flow and keep it in sections; do not invent a write.';

/**
 * Resubmission order for a rejection made only of field-scoped content errors (a column or prune
 * reference the reason names). The engine holds the draft for that set, so the prose the model
 * authored survives the correction instead of being re-authored from scratch.
 */
export const HELD_CORRECTION_ORDER =
  `Your analysis is held: ${HELD_FINDING_CALL_ORDER}. ${keyedResendRule('sections', 'angle')} Omit summary to keep the held summary.`;

/**
 * Machine error code per validation kind. Used when one kind dominates the rejection so the
 * model gets a specific, structured classification; mixed kinds fall back to the generic code.
 * Exported so a nonfatal (absent-kind) notice can be logged to `host.log` with the same code the
 * model would have received had the kind been fatal — one machine-code source for both surfaces.
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

/** One model-facing reason line for a validation failure: the offending path, what was wrong, without column inventories. */
function routeErrorLine(error: InvalidRoute): string {
  return [
    error.path ? `${error.path}: ${error.reason}` : error.reason,
    ...(error.available_routes ? [`available routes: ${error.available_routes.join(', ') || '(none)'}`] : []),
  ].join('; ');
}

/**
 * Builds the content/action rejection envelope after nonfatal notices were removed.
 *
 * @remarks
 * Each kind is emitted by one policy owner, so no message-text inference or mode branch is needed.
 * `code` is the specific per-kind code when one kind dominates; `hint` is the verb-led
 * order(s) followed by the held-correction order, since the engine holds the draft of every
 * rejected submission; `reason` states each failure with its valid set as one line per error;
 * `detail` carries the same facts as data.
 *
 * @param errors - Field-resolved validation failures accumulated before commit; at least one.
 * @returns A stable structured rejection without a second repair protocol.
 */
export function buildRouteValidationRejection(errors: InvalidRoute[]): ToolRejection {
  const distinctKinds = [...new Set(errors.map(e => e.kind))];
  const code = distinctKinds.length === 1 ? ROUTE_REJECTION_CODE[distinctKinds[0]] : REJECTION_CODES.routeValidationFailed;
  const hint = [
    ...distinctKinds.filter(kind => kind !== 'untracked_out_col'
      || errors.some(error => error.kind === kind && error.path?.endsWith('.out_col')))
      .map(kind => ROUTE_REJECTION_DIRECTIVE[kind]),
    errors.some(error => error.kind === 'untracked_out_col' && error.path?.endsWith('.upstream_columns')) ? DETACHED_LINK_DIRECTIVE : '',
    HELD_CORRECTION_ORDER,
  ].filter(Boolean).join(' ');
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
    })),
    issuePaths: errors.flatMap(e => (e.path ? [e.path] : [])),
  });
}

