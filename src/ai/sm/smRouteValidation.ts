/**
 * Prune/column validation rejection policy for the Navigation Engine (BB xor CT, mode-pure).
 *
 * @remarks
 * Pure, engine-state-free: maps a structural {@link InvalidRouteKind} to its machine error code
 * and verb-led corrective order, and builds the content-error rejection envelope. Extracted from
 * `smBase.ts` so the policy is one focused, independently-testable unit; the engine consumes
 * {@link isAbsentKind} and {@link buildSubmissionRejection}. Absent/no-op references are
 * nonfatal notices and never reach the rejection envelope.
 */

import type { InvalidRouteKind, InvalidRoute } from './smTypes';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { keyedResendRule } from '../support/repairDraftStore';
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
 * and the valid set are stated in the rejection reason (facts/data) that precedes it, not here (the order).
 */
export const ROUTE_REJECTION_DIRECTIVE: Record<InvalidRouteKind, string> = {
  absent_contributor:
    'Record it as an unresolved upstream source in your analysis and keep the upstream columns that resolve — it is not in the loaded model.',
  bad_out_col:
    'Declare column_flow only for an active tracked column this node carries — continued with its upstream sources, or ended here with upstream_columns: []. Remove the entry for any other column; submit column_flow: [] when this node carries none of them.',
  untracked_out_col:
    'Set column_flow[].out_col to a tracked column from the `<column_trace> Active columns` list this hop was given, repeated as the available columns above — the named column exists on this node but the trace does not follow it — or submit column_flow: [] if this node carries no tracked column.',
  bad_contributor_col:
    'Set upstream_columns[].col to a real upstream column the contributor node itself READS — the available columns above list them — never a column that node computes or writes out, even one named like out_col. Do not use literals, NULLs, parameters, or generated values here; explain those in `sections`, remove that upstream column, or use upstream_columns: [] when the active column terminates here.',
  non_writer_continuation:
    'This focus node has no body of its own, so its column_flow declares continuation: name only the neighbours on this focus\'s carrier side — the available routes above list them — carrying the tracked column unchanged; the column is attributed on that node\'s own hop, where its body is in view. Remove entries naming any other neighbour.',
  self_loop_column:
    'Point writes_to at the real downstream target this node writes to, or omit writes_to so it defaults to the focus node - an upstream_columns entry cannot be identical to its own writes_to target (the offending node.col is named above).',
  bad_writes_to_target:
    'Point writes_to at the node and column this hop actually writes — usually the focus itself, so omit writes_to and let it default. A downstream reader is never a write destination: remove that node from writes_to; every open neighbor you do not prune is visited anyway.',
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
  prune_carries_tracked_column: 'Remove it from prune_neighbors.',
  end_branch_carries_tracked_column:
    'Submit analyze or passthrough (upstream_columns: [] where a column ends here) instead of end_branch.',
  question_not_neighbor:
    'A questions[] entry can only name a neighbor listed in `<hop_context>` for this focus; this node is not adjacent to it. Attach the question to the neighbor it is reached through, or remove the entry from questions.',
};

/**
 * Resubmission order for a rejection made only of field-scoped content errors (a column or prune
 * reference the reason names). The engine holds the draft for that set, so the prose the model
 * authored survives the correction instead of being re-authored from scratch.
 */
export const HELD_CORRECTION_ORDER =
  `Your analysis is held: ${keyedResendRule('sections', 'angle')} Omit summary to keep the held summary.`;

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
  bad_writes_to_target: REJECTION_CODES.writesToNamesReader,
  pruned_contributor: REJECTION_CODES.prunedContributor,
  prune_absent: REJECTION_CODES.routeValidationFailed,
  prune_noop_removed: REJECTION_CODES.routeValidationFailed,
  prune_noop_visited: REJECTION_CODES.routeValidationFailed,
  prune_noop_analyzed: REJECTION_CODES.routeValidationFailed,
  prune_noop_queued: REJECTION_CODES.routeValidationFailed,
  prune_noop_out_of_scope: REJECTION_CODES.routeValidationFailed,
  prune_carries_tracked_column: REJECTION_CODES.pruneCarriesTrackedColumn,
  end_branch_carries_tracked_column: REJECTION_CODES.pruneCarriesTrackedColumn,
  question_not_neighbor: REJECTION_CODES.routeValidationFailed,
};

/** One model-facing reason line for a validation failure: the offending path, what was wrong, and the valid set. */
function routeErrorLine(error: InvalidRoute): string {
  return [
    error.path ? `${error.path}: ${error.reason}` : error.reason,
    ...(error.available_columns ? [`available columns: ${error.available_columns.join(', ') || '(none)'}`] : []),
    ...(error.available_routes ? [`available routes: ${error.available_routes.join(', ') || '(none)'}`] : []),
  ].join('; ');
}

/**
 * Builds the content/action rejection envelope after nonfatal notices were removed.
 *
 * @remarks
 * Each kind is emitted by one policy owner, so no message-text inference or mode branch is needed.
 * `code` is the specific per-kind code when one kind dominates; `hint` is the verb-led
 * order(s); `reason` states each failure with its valid set as one line per error; `detail` carries the
 * same facts as data.
 *
 * @param errors - Field-resolved validation failures accumulated before commit.
 * @param holdsDraft - Whether the engine holds the draft for this rejection; the held-correction
 * order is stated only when it does.
 * @returns A stable structured rejection without a second repair protocol.
 */
export function buildRouteValidationRejection(errors: InvalidRoute[], holdsDraft = true): ToolRejection {
  const distinctKinds = [...new Set(errors.map(e => e.kind))];
  const code = distinctKinds.length === 1 ? ROUTE_REJECTION_CODE[distinctKinds[0]] : REJECTION_CODES.routeValidationFailed;
  const hint = [
    ...distinctKinds.map(k => ROUTE_REJECTION_DIRECTIVE[k]),
    holdsDraft ? HELD_CORRECTION_ORDER : '',
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
      ...(e.available_routes ? { available_routes: e.available_routes } : {}),
    })),
    issuePaths: errors.flatMap(e => (e.path ? [e.path] : [])),
  });
}

/**
 * The fault one submission carries: route/column faults from `submit_findings`, or an `end_branch`
 * on the origin — `submitEndBranch` reports one or the other, never both.
 */
export interface SubmissionFaults {
  /** Prune and column-reference faults; nonfatal notice kinds already removed. */
  routes: InvalidRoute[];
  /** `verdict:'end_branch'` submitted on the immutable exploration origin. */
  originPrune?: { focusId: string };
}

/**
 * Composes the rejection envelope for a submission's fault.
 *
 * @param faults - The accumulated faults; none means the payload passed.
 * @param endBranch - True when the payload is an `end_branch` cut: it carries no prose, so no draft
 * is held and no held-retry order is offered.
 * @returns The envelope plus whether the finding draft is held for the retry, or `null` when there
 * is no fault to report.
 */
export function buildSubmissionRejection(
  faults: SubmissionFaults,
  endBranch = false,
): { rejection: ToolRejection; hold: boolean } | null {
  if (faults.originPrune) {
    return {
      rejection: makeRejection({
        code: REJECTION_CODES.pruneOriginForbidden,
        hint: 'end_branch never applies to the start object: submit analyze or passthrough for this focus, with sections and a summary.',
      }),
      hold: false,
    };
  }
  if (faults.routes.length === 0) return null;
  const hold = !endBranch;
  return { rejection: buildRouteValidationRejection(faults.routes, hold), hold };
}
