/**
 * Shared prune validation and column-reference rejection policy for the Navigation Engine.
 *
 * @remarks
 * Pure, engine-state-free: maps a structural {@link InvalidRouteKind} to its machine error code
 * and verb-led corrective order, and builds the content-error rejection envelope. The engine
 * consumes {@link buildRouteValidationRejection}. Every invalid column reference or refused prune
 * rejects the submission atomically.
 */

import type { InvalidRouteKind, InvalidRoute } from './smTypes';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { makeRejection, type ToolRejection } from '../support/toolErrorEnvelope';

/**
 * Per-kind corrective order. Keyed by {@link InvalidRouteKind} so a new kind is a compile
 * error. Each value is a self-contained, **verb-led imperative** — positive, with the
 * legitimate alternative built in so the model never has to guess the nearest match. Used for
 * the content-error hint. The offending value
 * is stated in the rejection reason; the dispatcher discloses column choices from the second rejection.
 */
export const ROUTE_REJECTION_DIRECTIVE: Record<InvalidRouteKind, string> = {
  missing_task_decision:
    'Account for each listed assigned endpoint with its mapping or terminated_inputs entry. Supply an investigation question for each listed kept neighbor, including those carrying columns, or prune it.',
  invalid_task_decision:
    'terminated_inputs may name only an assigned incoming column (listed in the reason) that is not also mapped; remove or correct the entry.',
  absent_contributor:
    'Name only loaded objects connected to this focus: a writes_to target this hop writes, and upstream_columns contributors that are its neighbors or, for a caller-context investigation, read suppliers of the function or its declared callers. Remove the named reference and describe an unresolved source in sections.',
  bad_out_col:
    'Recheck the exact object and column identity against the supplied SQL; do not guess a replacement.',
  untracked_out_col:
    'Set column_flow[].out_col to an output connected to the qualified column tasks supplied for this hop, or submit column_flow: [] if this node carries no tracked column.',
  bad_contributor_col:
    'Recheck the exact object and column identity against the supplied SQL; do not guess a replacement.',
  non_writer_continuation:
    'upstream_columns always name value inputs, independent of exploration direction. Do not name downstream readers as inputs; remove unconfirmed contributors and describe the uncertainty in sections.',
  self_loop_column:
    'Remove the upstream_columns entry identical to its output destination; keep a SQL-proved writes_to unchanged and explain any existing-destination read in sections.',
  bad_return_target:
    'Supply one column_flow entry for each exact caller_output_targets destination, with returns_to matching that node and column and out_col matching its column. Do not use writes_to on scalar-return tasks; identify real contributors from the supplied caller and function SQL.',
  bad_caller_context:
    'Use questions[].caller_context only for a neighboring function with supplied caller SQL and an active real caller output; otherwise omit caller_context and keep the question.',
  bad_writes_to_target:
    'Set writes_to to the table and column this hop\'s SQL writes, or to null when it writes no table. A downstream reader is never a write destination: remove that node from writes_to.',
  pruned_contributor:
    'This upstream node was already pruned earlier this run and cannot supply the column — a removed node stays removed. Name a different, still-reachable supplier for this upstream_columns entry, or submit upstream_columns: [] and account for the column ending here.',
  prune_absent:
    'This id is not in the loaded model — there is nothing to prune. Remove it from prune_neighbors.',
  prune_noop_removed:
    'This node was already pruned on an earlier hop. Remove it from prune_neighbors.',
  prune_noop_visited:
    'This origin or visited node anchors the retained answer path. Remove it from prune_neighbors.',
  prune_noop_analyzed:
    'This node is already recorded as an analyzed (noted) node and is retained. Remove it from prune_neighbors.',
  prune_noop_queued:
    'This node is already queued for a hop of its own; prune_neighbors does not pull queued work. Remove it from prune_neighbors and let its own hop run.',
  column_out_of_scope:
    'This object is outside the approved scope, so the column trace does not reach it. Remove the reference from column_flow, record the finding in sections, and, if it is a listed neighbor, name the object in questions: a question to an out-of-scope object is kept as a follow-up question.',
  prune_noop_out_of_scope:
    'This node is outside the approved scope (schema, direction, exclusion, or depth) and cannot be pruned. Remove it from prune_neighbors.',
  prune_unsupported:
    'Removing this node would disconnect analysis already committed, or it is not an approved-scope node the prune can remove. Remove it from prune_neighbors and decide it as a kept neighbor.',
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
 * Machine error code per validation kind. Used when one kind dominates the rejection so the
 * model gets a specific, structured classification; mixed kinds fall back to the generic code.
 */
export const ROUTE_REJECTION_CODE: Record<InvalidRouteKind, string> = {
  missing_task_decision: REJECTION_CODES.incompleteTask,
  invalid_task_decision: REJECTION_CODES.routeValidationFailed,
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
  column_out_of_scope: REJECTION_CODES.routeValidationFailed,
  prune_noop_out_of_scope: REJECTION_CODES.routeValidationFailed,
  prune_unsupported: REJECTION_CODES.routeValidationFailed,
  question_not_neighbor: REJECTION_CODES.routeValidationFailed,
  prune_question_conflict: REJECTION_CODES.routeValidationFailed,
  question_closed: REJECTION_CODES.routeValidationFailed,
};

/**
 * Builds the atomic content/action rejection envelope.
 *
 * @remarks
 * Each kind is emitted by one policy owner, so no message-text inference or mode branch is needed.
 * `code` is the specific per-kind code when one kind dominates; `hint` is the verb-led
 * order(s) followed by the engine's repair order (`findingRepairOrder`), since the engine holds the draft of every
 * rejected submission; `reason` states each failure without choices as one line per error;
 * `detail` carries possible values for the dispatcher's shared escalation.
 *
 * @param errors - Field-resolved validation failures accumulated before commit; at least one.
 * @param repairOrder - The engine's sentence naming the held parts and the parts to resend.
 * @returns A stable structured rejection without a second repair protocol.
 */
export function buildRouteValidationRejection(errors: InvalidRoute[], repairOrder: string): ToolRejection {
  const distinctKinds = [...new Set(errors.map(e => e.kind))];
  const code = distinctKinds.length === 1 ? ROUTE_REJECTION_CODE[distinctKinds[0]] : REJECTION_CODES.routeValidationFailed;
  const hint = [routeRejectionDirectives(errors), repairOrder].filter(Boolean).join(' ');
  return makeRejection({
    code,
    reason: routeRejectionReason(errors),
    hint,
    detail: routeRejectionDetail(errors),
    issuePaths: errors.flatMap(e => (e.path ? [e.path] : [])),
  });
}

/**
 * The verb-led corrective orders for a set of route/column failures, one per distinct kind, without
 * the repair order; shared by {@link buildRouteValidationRejection} and a finding rejection
 * that also reports other faults of the same submission.
 */
export function routeRejectionDirectives(errors: readonly InvalidRoute[]): string {
  const distinctKinds = [...new Set(errors.map(e => e.kind))];
  return [
    ...distinctKinds.filter(kind => kind !== 'untracked_out_col'
      || errors.some(error => error.kind === kind && error.path?.endsWith('.out_col')))
      .map(kind => ROUTE_REJECTION_DIRECTIVE[kind]),
    errors.some(error => error.kind === 'untracked_out_col' && error.path?.endsWith('.upstream_columns')) ? DETACHED_LINK_DIRECTIVE : '',
  ].filter(Boolean).join(' ');
}

/** One reason line per route/column failure: its path and what was wrong. */
export function routeRejectionReason(errors: readonly InvalidRoute[]): string {
  return errors.map(error => error.path ? `${error.path}: ${error.reason}` : error.reason).join('\n');
}

/** The route/column failures as rejection `detail` data. */
export function routeRejectionDetail(errors: readonly InvalidRoute[]): Array<Record<string, unknown>> {
  return errors.map(e => ({
    id: e.id,
    ...(e.path ? { path: e.path } : {}),
    reason: e.reason,
    ...(e.allowed_values !== undefined ? { allowed_values: e.allowed_values } : {}),
    ...(e.when ? { when: e.when } : {}),
  }));
}

