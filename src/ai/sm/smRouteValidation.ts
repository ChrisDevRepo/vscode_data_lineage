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

import type { InvalidRouteKind, InvalidRoute, SubmitResult } from './smTypes';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { buildIncompleteRejection } from './smCompleteness';

/** True for nonfatal drop/refuse-with-notice kinds. */
export function isAbsentKind(kind: InvalidRouteKind): boolean {
  return kind === 'absent_contributor'
    || kind === 'prune_absent' || kind === 'prune_noop_removed' || kind === 'prune_noop_visited'
    || kind === 'prune_noop_analyzed' || kind === 'prune_noop_queued' || kind === 'prune_noop_out_of_scope'
    || kind === 'question_on_pruned_neighbor';
}

/**
 * Per-kind corrective order. Keyed by {@link InvalidRouteKind} so a new kind is a compile
 * error. Each value is a self-contained, **verb-led imperative** — positive, with the
 * legitimate alternative built in so the model never has to guess the nearest match. Used for
 * the content-error hint. The offending value
 * and the valid set live in `detail` (facts/data), not here (the order).
 */
export const ROUTE_REJECTION_DIRECTIVE: Record<InvalidRouteKind, string> = {
  absent_contributor:
    'Record it as an unresolved upstream source in your analysis and keep the upstream columns that resolve — it is not in the loaded model.',
  bad_out_col:
    'Declare column_flow only for an active tracked column this node carries. Every active tracked column still needs its own entry — continued with its upstream sources, or ended here with upstream_columns: []. Submit column_flow: [] only where this node declares none of them.',
  untracked_out_col:
    'Set column_flow[].out_col to a tracked column from the `<column_trace> Active columns` list this hop was given, repeated in detail.available_columns — the named column exists on this node but the trace does not follow it — or submit column_flow: [] if this node carries no tracked column.',
  bad_contributor_col:
    'Set upstream_columns[].col to a real upstream column the contributor node itself READS — detail.available_columns lists them — never a column that node computes or writes out, even one named like out_col. Do not use literals, NULLs, parameters, or generated values here; explain those in sections[].text, remove that upstream column, or use upstream_columns: [] when the active column terminates here.',
  non_writer_continuation:
    'This focus node has no body of its own, so its column_flow declares continuation: name only the neighbours on this focus\'s carrier side — detail.available_routes lists them — carrying the tracked column unchanged; the column is attributed on that node\'s own hop, where its body is in view. Remove entries naming any other neighbour.',
  self_loop_column:
    'Point writes_to at the real downstream target this node writes to, or omit writes_to so it defaults to the focus node - an upstream_columns entry cannot be identical to its own writes_to target (see detail for the offending node.col). Keep the rest of column_flow, sections, and summary as submitted.',
  bad_writes_to_target:
    'Point writes_to at the node and column this hop actually writes — usually the focus itself, so omit writes_to and let it default. A downstream reader is never a write destination: remove that node from writes_to; every open neighbor you do not prune is visited anyway. Keep the rest of column_flow, sections, and summary as submitted.',
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
    'This node is outside the approved scope (schema, direction, exclusion, or depth) and was never loaded into the graph — there is nothing to prune. Remove it from prune_neighbors; ask a question about it instead, recorded as a deferred follow-up.',
  prune_origin_forbidden:
    'The origin node anchors the lineage and cannot be pruned. Remove it from prune_neighbors.',
  prune_carries_tracked_column:
    'A committed column_flow names this node for the tracked columns in detail.available_columns, so it stays in the result for the rest of the run. Remove it from prune_neighbors; when it is this focus, submit analyze or passthrough with a column_flow entry for each of those columns (upstream_columns: [] where a column ends here) instead of end_branch.',
  question_not_neighbor:
    'A questions[] entry can only name a neighbor listed in `<hop_context>` for this focus; this node is not adjacent to it. Attach the question to the neighbor it is reached through, or remove the entry from questions.',
  question_on_pruned_neighbor:
    'This node was named in both prune_neighbors and questions in one submission, so its question was dropped. Name a neighbor in one of the two, never both.',
};

/**
 * Resubmission order for a rejection made only of field-scoped content errors (a column or prune
 * reference the detail names). The engine holds the draft for that set, so the prose the model
 * authored survives the correction instead of being re-authored from scratch.
 */
const HELD_CORRECTION_ORDER =
  'Your analysis is held: resend submit_findings with `sections: []` and the fields detail names corrected to reuse your original sections and summary verbatim.';
/**
 * Shared "nothing is held" resubmission order, used when a verdict-level fault rides along with
 * another repair, so the held-draft shortcut is not offered.
 */
const FULL_RESUBMIT_ORDER =
  'Nothing is held here: resend submit_findings whole, carrying your sections and summary over unchanged alongside both repairs.';
/**
 * Resubmission order for a rejection carrying several fault families at once, all of them
 * field-scoped. Stated once for the whole envelope: the repairs differ, the prose does not, and a
 * model that re-authored its sections because a second fault rode along would pay for the
 * co-report the co-report exists to save.
 */
const MULTI_FAULT_HELD_ORDER =
  'Your analysis is held: resend submit_findings with `sections: []` and every repair above applied in the same submission, to reuse your original sections and summary verbatim.';

/**
 * True for a correctable field-scoped content error. The engine holds the finding draft for a
 * rejection made only of these, and {@link buildRouteValidationRejection} states that hold.
 */
function isContentKind(kind: InvalidRouteKind): boolean {
  return !isAbsentKind(kind);
}

/**
 * Machine error code per validation kind. Used when one kind dominates the rejection so the
 * model gets a specific, structured classification; mixed kinds fall back to the generic code.
 */
const ROUTE_REJECTION_CODE: Record<InvalidRouteKind, string> = {
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
  prune_origin_forbidden: REJECTION_CODES.pruneOriginForbidden,
  prune_carries_tracked_column: REJECTION_CODES.pruneCarriesTrackedColumn,
  question_not_neighbor: REJECTION_CODES.routeValidationFailed,
  question_on_pruned_neighbor: REJECTION_CODES.routeValidationFailed,
};

/**
 * Builds the content/action rejection envelope after nonfatal notices were removed.
 *
 * @remarks
 * Each kind is emitted by one policy owner, so no message-text inference or mode branch is needed.
 * `error` is the specific per-kind code when one kind dominates; `hint` is the verb-led
 * order(s); `detail` carries the facts + the valid column set.
 *
 * @param errors - Field-resolved validation failures accumulated before commit.
 * @param appendHoldOrder - False when the caller merges this envelope with another fault family
 * and states the resubmission order itself once, covering both; true (default) preserves
 * the standalone envelope's own order.
 * @param holdsDraft - Whether the engine holds the draft for this rejection; the held-correction
 * order is stated only when it does.
 * @returns A stable structured rejection without a second repair protocol.
 */
export function buildRouteValidationRejection(errors: InvalidRoute[], appendHoldOrder = true, holdsDraft = true): SubmitResult {
  const distinctKinds = [...new Set(errors.map(e => e.kind))];
  const error = distinctKinds.length === 1 ? ROUTE_REJECTION_CODE[distinctKinds[0]] : REJECTION_CODES.routeValidationFailed;
  const hint = [
    ...distinctKinds.map(k => ROUTE_REJECTION_DIRECTIVE[k]),
    appendHoldOrder && holdsDraft && errors.length > 0 && errors.every(e => isContentKind(e.kind)) ? HELD_CORRECTION_ORDER : '',
  ].filter(Boolean).join(' ');
  return {
    error,
    hint,
    detail: errors.map(e => ({
      id: e.id,
      ...(e.path ? { path: e.path } : {}),
      reason: e.reason,
      ...(e.available_columns ? { available_columns: e.available_columns } : {}),
      ...(e.available_routes ? { available_routes: e.available_routes } : {}),
    })),
  };
}

/**
 * Every fault one `submit_findings` payload carries, accumulated by the guard chain.
 *
 * @remarks
 * Independent families, each of which used to own an immediate `return` inside the chain. A family
 * is present iff that fault is true of the payload.
 */
export interface SubmissionFaults {
  /** Prune and column-reference faults; nonfatal notice kinds already removed. */
  routes: InvalidRoute[];
  /** `verdict:'end_branch'` submitted on the immutable exploration origin. */
  originPrune?: { focusId: string; keepClause: string };
  /** CT column-chain completeness: tracked columns the payload left unaccounted. */
  columnChain?: { focusId: string; unaccounted: string[]; available: string[]; contradicted: readonly string[]; traceDirection: 'upstream' | 'downstream' };
}

/**
 * Composes ONE rejection envelope naming every fault the payload carries.
 *
 * @remarks
 * The guard chain accumulates and reports once instead of returning at the first fault, so a
 * multi-fault payload is not spent on a resubmit cascade. A single-family payload keeps the exact
 * code, hint and `detail` shape that family had standalone; a multi-family payload reports under
 * the first family's code, carries each family's `detail` under its own key, and states one
 * resubmission order.
 *
 * @param faults - The accumulated faults; an empty set means the payload passed this chain.
 * @param endBranch - True when the payload is an `end_branch` cut: it carries no prose, so no draft
 * is held and no held-retry order is offered.
 * @returns The envelope plus whether the finding draft is held for the retry, or `null` when there
 * is no fault to report.
 */
export function buildSubmissionRejection(
  faults: SubmissionFaults,
  endBranch = false,
): { rejection: SubmitResult & { error: string }; hold: boolean } | null {
  const familyCount = (faults.routes.length > 0 ? 1 : 0)
    + (faults.originPrune ? 1 : 0) + (faults.columnChain ? 1 : 0);
  if (familyCount === 0) return null;
  const single = familyCount === 1;
  const holdEligible = !endBranch && faults.originPrune === undefined
    && faults.routes.every(r => isContentKind(r.kind));

  const codes: string[] = [];
  const hints: string[] = [];
  const detail: Record<string, unknown> = {};
  let soleDetail: unknown;

  if (faults.originPrune) {
    codes.push(REJECTION_CODES.pruneOriginForbidden);
    hints.push(`end_branch never applies to the start object: submit analyze or passthrough for this focus, with sections and a summary.${faults.originPrune.keepClause}`);
  }
  if (faults.routes.length > 0) {
    const envelope = buildRouteValidationRejection(faults.routes, single, holdEligible);
    if ('error' in envelope) {
      codes.push(envelope.error);
      if (envelope.hint) hints.push(envelope.hint);
      detail.route = envelope.detail;
      soleDetail = envelope.detail;
    }
  }
  if (faults.columnChain) {
    const { focusId, unaccounted, available, contradicted, traceDirection } = faults.columnChain;
    const envelope = buildIncompleteRejection(focusId, unaccounted, available, contradicted, single, traceDirection);
    if ('error' in envelope) {
      codes.push(envelope.error);
      if (envelope.hint) hints.push(envelope.hint);
      detail.column_chain = envelope.detail;
      soleDetail = envelope.detail;
    }
  }
  if (!single) hints.push(holdEligible ? MULTI_FAULT_HELD_ORDER : FULL_RESUBMIT_ORDER);

  return {
    rejection: {
      error: codes[0],
      hint: hints.filter(Boolean).join(' '),
      ...(single ? (soleDetail === undefined ? {} : { detail: soleDetail }) : { detail }),
    },
    hold: holdEligible,
  };
}
