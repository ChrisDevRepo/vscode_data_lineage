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

/** True for nonfatal drop/refuse-with-notice kinds. */
export function isAbsentKind(kind: InvalidRouteKind): boolean {
  return kind === 'absent_route' || kind === 'absent_contributor'
    || kind === 'prune_absent' || kind === 'prune_noop_removed' || kind === 'prune_noop_visited'
    || kind === 'prune_noop_analyzed' || kind === 'prune_noop_in_scope';
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
  bad_route_columns:
    'Request only columns that exist on the route target (see available_columns).',
  bad_out_col:
    'Declare column_flow only for an active tracked column this node carries, or submit column_flow: [] if it carries none.',
  bad_contributor_col:
    'Set upstream_columns[].col to a real upstream column. Do not use literals, NULLs, parameters, generated values, or filter-only columns here; explain those in sections[].text, remove that upstream column, or use upstream_columns: [] when the active column terminates here.',
  missing_required_route:
    'Account for each required neighbor listed in detail by adding it to `route_requests`. Required neighbors are approved in-scope continuation nodes, so do not place them in `prune_neighbors`. Your analysis is held: resend submit_findings with `sections: []` and only the corrected routing to reuse your original sections and summary verbatim.',
  self_loop_column:
    'Point writes_to at the real downstream target this node writes to, or omit writes_to so it defaults to the focus node - an upstream_columns entry cannot be identical to its own writes_to target (see detail for the offending node.col). Keep the rest of column_flow, sections, and summary as submitted.',
  prune_absent:
    'This id is not in the loaded model — there is nothing to prune. Remove it from prune_neighbors.',
  prune_noop_removed:
    'This node was already pruned on an earlier hop. Remove it from prune_neighbors.',
  prune_noop_visited:
    'This node was already analyzed on an earlier hop and is retained; a prune cannot remove committed analysis. Remove it from prune_neighbors.',
  prune_noop_analyzed:
    'This node is already recorded as an analyzed (noted) node and is retained. Remove it from prune_neighbors.',
  prune_noop_in_scope:
    'This node belongs to the approved exploration scope and is retained. Remove it from prune_neighbors.',
  prune_origin_forbidden:
    'The origin node anchors the lineage and cannot be pruned. Remove it from prune_neighbors.',
  prune_would_orphan:
    "Pruning this node would orphan a committed node from the origin. Keep it and remove it from prune_neighbors; if you meant to skip this focus, use verdict='passthrough'.",
  prune_route_conflict:
    'This id appears in both route_requests and prune_neighbors — a node cannot be routed and pruned in one submit. Remove it from one of them.',
};

/**
 * Machine error code per validation kind. Used when one kind dominates the rejection so the
 * model gets a specific, structured classification; mixed kinds fall back to the generic code.
 */
const ROUTE_REJECTION_CODE: Record<InvalidRouteKind, string> = {
  absent_route: 'route_validation_failed',
  absent_contributor: 'route_validation_failed',
  bad_route_columns: 'route_columns_not_on_target',
  bad_out_col: 'out_col_not_on_node',
  bad_contributor_col: 'contributor_col_not_on_source',
  missing_required_route: 'missing_required_route',
  self_loop_column: 'column_self_loop',
  prune_absent: 'route_validation_failed',
  prune_noop_removed: 'route_validation_failed',
  prune_noop_visited: 'route_validation_failed',
  prune_noop_analyzed: 'route_validation_failed',
  prune_noop_in_scope: 'route_validation_failed',
  prune_origin_forbidden: 'prune_origin_forbidden',
  prune_would_orphan: 'prune_would_orphan_noted',
  prune_route_conflict: 'prune_route_conflict',
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
 * @returns A stable structured rejection without a second repair protocol.
 */
export function buildRouteValidationRejection(errors: InvalidRoute[]): SubmitResult {
  const distinctKinds = [...new Set(errors.map(e => e.kind))];
  const error = distinctKinds.length === 1 ? ROUTE_REJECTION_CODE[distinctKinds[0]] : 'route_validation_failed';
  const missingRouteErrors = errors.filter(e => e.kind === 'missing_required_route');
  const invalidlyPruned = missingRouteErrors.filter(e => e.invalidlyPruned).map(e => e.id).filter(Boolean);
  const missingRoutes = missingRouteErrors.filter(e => !e.invalidlyPruned).map(e => e.id).filter(Boolean);
  const missingRouteHint = missingRouteErrors.length > 0
    ? [
        invalidlyPruned.length > 0
          ? `Required neighbors submitted in prune_neighbors: [${invalidlyPruned.join(', ')}]. Remove these ids from prune_neighbors and add them to route_requests.`
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
