/**
 * Route/column validation rejection policy for the Navigation Engine (BB xor CT, mode-pure).
 *
 * @remarks
 * Pure, engine-state-free: maps a structural {@link InvalidRouteKind} to its machine error code
 * and verb-led corrective order, and builds the content-error rejection envelope. Extracted from
 * `smBase.ts` so the policy is one focused, independently-testable unit; the engine consumes
 * {@link isAbsentKind} and {@link buildRouteValidationRejection}. Absent/no-op references are
 * nonfatal notices and never reach the rejection envelope.
 */

import type { InvalidRouteKind, InvalidRoute, SubmitResult } from './smTypes';
import { REJECTION_CODES } from '../support/rejectionCodes';
import { buildIncompleteRejection } from './smCompleteness';

/** True for nonfatal drop/refuse-with-notice kinds. */
export function isAbsentKind(kind: InvalidRouteKind): boolean {
  return kind === 'absent_route' || kind === 'absent_contributor'
    || kind === 'prune_absent' || kind === 'prune_noop_removed' || kind === 'prune_noop_visited'
    || kind === 'prune_noop_analyzed' || kind === 'prune_noop_queued';
}

/**
 * Per-kind corrective order. Keyed by {@link InvalidRouteKind} so a new kind is a compile
 * error. Each value is a self-contained, **verb-led imperative** — positive, with the
 * legitimate alternative built in so the model never has to guess the nearest match. Used for
 * the content-error hint. The offending value
 * and the valid set live in `detail` (facts/data), not here (the order).
 */
export const ROUTE_REJECTION_DIRECTIVE: Record<InvalidRouteKind, string> = {
  absent_route:
    'Record it as an unresolved upstream source in your analysis — it is not in the loaded model.',
  absent_contributor:
    'Record it as an unresolved upstream source in your analysis and keep the upstream columns that resolve — it is not in the loaded model.',
  bad_out_col:
    'Declare column_flow only for an active tracked column this node carries. Every active tracked column still needs its own entry — continued with its upstream sources, or ended here with upstream_columns: []. Submit column_flow: [] only where this node declares none of them.',
  untracked_out_col:
    'Set column_flow[].out_col to a tracked column from the `<column_trace> Active columns` list this hop was given, repeated in detail.available_columns — the named column exists on this node but the trace does not follow it — or submit column_flow: [] if this node carries no tracked column.',
  bad_contributor_col:
    'Set upstream_columns[].col to a real upstream column the contributor node itself READS — detail.available_columns lists them — never a column that node computes or writes out, even one named like out_col. Do not use literals, NULLs, parameters, generated values, or filter-only columns here; explain those in sections[].text, remove that upstream column, or use upstream_columns: [] when the active column terminates here.',
  non_writer_continuation:
    'This focus node has no body of its own, so its column_flow declares continuation: name only the neighbours on this focus\'s carrier side — detail.available_routes lists them — carrying the tracked column unchanged; the column is attributed on that node\'s own hop, where its body is in view. Remove entries naming any other neighbour.',
  missing_required_route:
    'Account for each required neighbor listed in detail by adding it to `route_requests`.',
  self_loop_column:
    'Point writes_to at the real downstream target this node writes to, or omit writes_to so it defaults to the focus node - an upstream_columns entry cannot be identical to its own writes_to target (see detail for the offending node.col). Keep the rest of column_flow, sections, and summary as submitted.',
  bad_writes_to_target:
    'Point writes_to at the node and column this hop actually writes — usually the focus itself, so omit writes_to and let it default. A downstream reader is never a write destination: remove that node from writes_to and declare it in route_requests instead when the question asks for consumers. Keep the rest of column_flow, sections, and summary as submitted.',
  pruned_contributor:
    'This upstream node was already pruned earlier this run and cannot supply the column — a removed node stays removed. Name a different, still-reachable supplier for this upstream_columns entry, or submit upstream_columns: [] and account for the column ending here.',
  prune_absent:
    'This id is not in the loaded model — there is nothing to prune. Remove it from prune_neighbors.',
  prune_noop_removed:
    'This node was already pruned on an earlier hop. Remove it from prune_neighbors.',
  prune_noop_visited:
    'This node was already analyzed on an earlier hop and is retained; a prune cannot remove committed analysis. Remove it from prune_neighbors.',
  prune_noop_analyzed:
    'This node is already recorded as an analyzed (noted) node and is retained. Remove it from prune_neighbors.',
  prune_noop_queued:
    'This node is already queued for a hop of its own; prune_neighbors does not pull queued work. Remove it from prune_neighbors and let its own hop run.',
  prune_origin_forbidden:
    'The origin node anchors the lineage and cannot be pruned. Remove it from prune_neighbors.',
  prune_would_orphan:
    'Pruning this node would orphan a committed node from the origin. Keep it and remove it from prune_neighbors.',
  prune_route_conflict:
    'This id appears in both route_requests and prune_neighbors — a node cannot be routed and pruned in one submit. Keep one verdict: remove it from prune_neighbors to route it (a required neighbor resolves by route), or remove it from route_requests when the prune verdict applies to this node.',
  route_columns_flow_conflict:
    'Make route_requests[].columns for this neighbor agree with this submission\'s column_flow[].upstream_columns: list the columns detail.available_columns names, or remove the upstream_columns entries that name it. Detail names the neighbor and the conflicting columns.',
};

/**
 * Resubmission order for a rejection that carries `missing_required_route`. The engine holds the
 * draft only when neighbor incompleteness is the whole rejection, so the promise is emitted per
 * set composition: the held retry for a pure set, the full envelope when another repair rides
 * along and the sections have to come back with it.
 */
const HELD_RETRY_ORDER =
  'Your analysis is held: resend submit_findings with `sections: []` and only the corrected routing to reuse your original sections and summary verbatim.';
/**
 * Resubmission order for a rejection made only of field-scoped content errors (a column, route or
 * prune reference the detail names). The engine holds the draft for that set, so the prose the model
 * authored survives the correction instead of being re-authored from scratch.
 */
const HELD_CORRECTION_ORDER =
  'Your analysis is held: resend submit_findings with `sections: []` and the fields detail names corrected to reuse your original sections and summary verbatim.';
/**
 * Shared "nothing is held" resubmission order — used both here (mixed route-kind rejections) and
 * by the caller that merges a topology fault with a deferred CT completeness fault into one
 * envelope, where the same stricter policy applies for the same reason: another repair is
 * riding along, so the held-draft shortcut is not offered.
 */
export const FULL_RESUBMIT_ORDER =
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
 * True for a correctable field-scoped content error: a fatal kind that is neither neighbor
 * incompleteness nor a prune-topology fact. The engine holds the finding draft for a rejection made
 * only of these, and {@link buildRouteValidationRejection} states that hold.
 */
export function isContentKind(kind: InvalidRouteKind): boolean {
  return !isAbsentKind(kind) && kind !== 'prune_would_orphan' && kind !== 'missing_required_route';
}

/**
 * Machine error code per validation kind. Used when one kind dominates the rejection so the
 * model gets a specific, structured classification; mixed kinds fall back to the generic code.
 */
const ROUTE_REJECTION_CODE: Record<InvalidRouteKind, string> = {
  absent_route: 'route_validation_failed',
  absent_contributor: 'route_validation_failed',
  bad_out_col: 'out_col_not_on_node',
  untracked_out_col: 'out_col_not_tracked',
  bad_contributor_col: 'contributor_col_not_on_source',
  non_writer_continuation: 'continuation_not_writer',
  missing_required_route: 'missing_required_route',
  self_loop_column: 'column_self_loop',
  bad_writes_to_target: 'writes_to_names_reader',
  pruned_contributor: 'pruned_contributor',
  prune_absent: 'route_validation_failed',
  prune_noop_removed: 'route_validation_failed',
  prune_noop_visited: 'route_validation_failed',
  prune_noop_analyzed: 'route_validation_failed',
  prune_noop_queued: 'route_validation_failed',
  prune_origin_forbidden: 'prune_origin_forbidden',
  prune_would_orphan: REJECTION_CODES.pruneWouldOrphanNoted,
  prune_route_conflict: 'prune_route_conflict',
  route_columns_flow_conflict: 'route_columns_flow_conflict',
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
 * @returns A stable structured rejection without a second repair protocol.
 */
export function buildRouteValidationRejection(errors: InvalidRoute[], appendHoldOrder = true): SubmitResult {
  const distinctKinds = [...new Set(errors.map(e => e.kind))];
  const error = distinctKinds.length === 1 ? ROUTE_REJECTION_CODE[distinctKinds[0]] : 'route_validation_failed';
  const missingRouteErrors = errors.filter(e => e.kind === 'missing_required_route');
  const invalidlyPruned = missingRouteErrors.filter(e => e.invalidlyPruned).map(e => e.id).filter(Boolean);
  const missingRoutes = missingRouteErrors.filter(e => !e.invalidlyPruned).map(e => e.id).filter(Boolean);
  const missingRouteHint = missingRouteErrors.length > 0
    ? [
        invalidlyPruned.length > 0
          ? `Required neighbors submitted in prune_neighbors were refused: [${invalidlyPruned.join(', ')}]. Pruning them would orphan committed work — add these ids to route_requests, or prune them only once that no longer holds.`
          : '',
        missingRoutes.length > 0
          ? `Required neighbors not accounted for: [${missingRoutes.join(', ')}]. Add these ids to route_requests.`
          : '',
        ROUTE_REJECTION_DIRECTIVE.missing_required_route,
      ].filter(Boolean).join(' ')
    : '';
  const hint = [
    missingRouteHint,
    ...distinctKinds.filter(k => k !== 'missing_required_route').map(k => ROUTE_REJECTION_DIRECTIVE[k]),
    // Mirrors the engine's hold condition — pure neighbor incompleteness, or content errors only —
    // so the order the model follows is the one the engine will honour.
    !appendHoldOrder ? ''
      : missingRouteErrors.length > 0
        ? (missingRouteErrors.length === errors.length ? HELD_RETRY_ORDER : FULL_RESUBMIT_ORDER)
        : errors.length > 0 && errors.every(e => isContentKind(e.kind)) ? HELD_CORRECTION_ORDER : '',
  ].filter(Boolean).join(' ');
  // available_routes is the identical full required set on every missing_required_route entry, so
  // the envelope states it once — on the first such entry — instead of once per missing id.
  const firstMissingRouteIdx = errors.findIndex(e => e.kind === 'missing_required_route');
  return {
    error,
    hint,
    detail: errors.map((e, i) => ({
      id: e.id,
      ...(e.path ? { path: e.path } : {}),
      reason: e.reason,
      ...(e.available_columns ? { available_columns: e.available_columns } : {}),
      ...(e.available_routes && (e.kind !== 'missing_required_route' || i === firstMissingRouteIdx)
        ? { available_routes: e.available_routes }
        : {}),
    })),
  };
}

/**
 * Every fault one `submit_findings` payload carries, accumulated by the guard chain.
 *
 * @remarks
 * Four independent families, each of which used to own an immediate `return` inside the chain.
 * A family is present iff that fault is true of the payload; `repairWouldOwe` is disclosure, never
 * a fault, and never decides whether a rejection is produced.
 */
export interface SubmissionFaults {
  /** Route, prune-topology and column-reference faults; nonfatal notice kinds already removed. */
  routes: InvalidRoute[];
  /** `verdict:'prune'` submitted on the immutable exploration origin. */
  originPrune?: { focusId: string; keepClause: string };
  /** `verdict:'prune'` whose removal would disconnect a protected node from the origin. */
  focusOrphan?: { focusId: string; orphanId: string; keepClause: string };
  /**
   * `verdict:'prune'` carrying non-empty `sections`. A prune archives to `prunedDetails`,
   * which synthesis never reads, so authored findings on a prune verdict are silently lost;
   * a prune owes no account and findings belong on `analyze`.
   */
  pruneSections?: { focusId: string; sectionCount: number };
  /** CT column-chain completeness: tracked columns the payload left unaccounted. */
  columnChain?: { focusId: string; unaccounted: string[]; available: string[]; contradicted: readonly string[]; traceDirection?: 'upstream' | 'downstream' };
  /**
   * Required neighbours a non-prune repair of this payload would bring into play. Stated because a
   * `verdict:'prune'` payload is exempt from the neighbour demand: repairing the verdict is what
   * raises the obligation, so a rejection that hides it hands the model an obligation set that
   * appears only on the turn after the repair.
   */
  repairWouldOwe?: readonly string[];
}

/**
 * Composes ONE rejection envelope naming every fault the payload carries.
 *
 * @remarks
 * The guard chain accumulates and reports once instead of returning at the first fault. A first
 * fault that hides the rest makes the model repair one defect, resubmit, and be told about the
 * next — a cascade that spends the whole semantic budget on a payload with three faults in it.
 * `docs/AI_PROMPTS.md` already promises one complete rejection per submission; this is where the
 * promise is kept.
 *
 * A single-family payload keeps the exact code, hint and `detail` shape that family had as a
 * standalone rejection, so nothing about the established envelopes changes. A multi-family payload
 * reports under the first family's code, carries each family's `detail` under its own key, states
 * the resubmission order once, and holds nothing — another repair rides along, so the sections have
 * to come back with it, the same stricter policy a mixed route rejection already uses.
 *
 * @param faults - The accumulated faults; an empty set means the payload passed this chain.
 * @returns The envelope plus whether the finding draft is held for the retry, or `null` when there
 * is no fault to report.
 */
export function buildSubmissionRejection(
  faults: SubmissionFaults,
): { rejection: SubmitResult & { error: string }; hold: boolean } | null {
  const familyCount = (faults.routes.length > 0 ? 1 : 0)
    + (faults.originPrune ? 1 : 0) + (faults.focusOrphan ? 1 : 0) + (faults.columnChain ? 1 : 0)
    + (faults.pruneSections ? 1 : 0);
  if (familyCount === 0) return null;
  const single = familyCount === 1;

  const codes: string[] = [];
  const hints: string[] = [];
  const detail: Record<string, unknown> = {};
  let soleDetail: unknown;

  if (faults.originPrune) {
    codes.push('prune_origin_forbidden');
    hints.push(`Submit a complete analyze or passthrough finding for this focus. The exploration origin is immutable.${faults.originPrune.keepClause}`);
  }
  if (faults.focusOrphan) {
    const { focusId, orphanId, keepClause } = faults.focusOrphan;
    codes.push(REJECTION_CODES.pruneWouldOrphanNoted);
    hints.push(`Use verdict='passthrough' to keep it without pruning. Marking [${focusId}] prune would orphan node [${orphanId}], which nothing else keeps reachable from the origin.${keepClause}`);
  }
  if (faults.pruneSections) {
    const { focusId, sectionCount } = faults.pruneSections;
    codes.push('prune_with_sections');
    hints.push(`A prune verdict carries no analysis — its sections are never served to synthesis. [${focusId}] arrived with ${sectionCount} section(s): resubmit with verdict='analyze' to keep them as findings, or resubmit the prune with sections: [] to drop them and remove this focus bare.`);
  }
  if (faults.routes.length > 0) {
    const envelope = buildRouteValidationRejection(faults.routes, single);
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
  // Field-scoped in every family it is granted for, so the authored sections and summary stay
  // valid whether one family fired or three. Holding across a co-report is the point of the
  // co-report: a model told about two faults at once must not pay to re-author prose it already
  // wrote because the second fault arrived with the first.
  // `pruneSections` is excluded like the other verdict-level faults: the refused content IS
  // the authored sections, so holding the draft would merge them back into a bare-prune retry
  // via `applyHeldContent` (which restores held sections when the retry sends `sections: []`)
  // and resurrect exactly what was refused. Nothing is held; the resubmission order is the
  // full one.
  const holdEligible = (faults.originPrune === undefined && faults.focusOrphan === undefined
    && faults.pruneSections === undefined)
    && (faults.routes.length === 0
      || faults.routes.every(r => isContentKind(r.kind))
      || faults.routes.every(r => r.kind === 'missing_required_route'));

  if (faults.repairWouldOwe && faults.repairWouldOwe.length > 0) {
    hints.push(
      `A prune verdict owes no account of this focus's own neighbors. Repairing the verdict to 'analyze' or 'passthrough' brings [${faults.repairWouldOwe.join(', ')}] into play: route them, prune them, or leave them to the engine, which fills an unaccounted required neighbor rather than refusing the hop.`,
    );
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
