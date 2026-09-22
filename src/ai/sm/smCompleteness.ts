/**
 * CT column completeness guard for the Navigation Engine.
 *
 * @remarks
 * A pure set difference (`required − accounted`) over `normalizeColName` — the same normalizer
 * `ColumnTracer.validateColumnFlow` accepts a submitted `out_col` under, so a value one guard admits
 * can never be reported unaccounted by the other. BB neighbor completeness (`requiredNeighborIds` →
 * `missing_required_route`) is a separate, unrelated mechanism and does not use this module.
 */

import { normalizeColName } from '../../utils/sql';
import type { SubmitResult } from './smTypes';

/**
 * Items in `required` not present in `accounted`, compared case-insensitively and ignoring SQL brackets, order preserved.
 *
 * @remarks
 * Returns the original `required` casing so the caller can surface the offending values verbatim.
 */
export function computeUnaccounted(required: readonly string[], accounted: Iterable<string>): string[] {
  const acc = new Set<string>();
  for (const a of accounted) acc.add(normalizeColName(a));
  return required.filter(r => !acc.has(normalizeColName(r)));
}

/**
 * Builds the rejection envelope for an incomplete CT hop.
 *
 * @remarks
 * Two repairs exist, and only one of them is always open. A focus that declares none of the active
 * columns may end the chain with `verdict:'passthrough'` and `column_flow:[]`; a focus that
 * declares one of them may not, because there the claim is checkably false. `contradicted` carries
 * the active columns the focus declares, so the hint offers only the escape the engine will accept.
 *
 * @param available - Valid active columns exposed for correction, surfaced as `available_columns`.
 * @param contradicted - Active columns the focus itself declares; empty when it declares none.
 * @param appendHeldOrder - False when the caller merges this envelope with another fault family
 * and states the resubmission order itself once, covering both; true (default) preserves
 * the standalone envelope's own held-draft order.
 * @param traceDirection - Upstream names the missing column directly as `out_col`; downstream
 * accounts for it inside `upstream_columns` since the focus's own `out_col` may be a
 * rename/derivation.
 */
export function buildIncompleteRejection(
  focusId: string,
  unaccounted: string[],
  available: string[],
  contradicted: readonly string[] = [],
  appendHeldOrder = true,
  traceDirection: 'upstream' | 'downstream',
): SubmitResult {
  const held = `Your analysis is held: resend submit_findings with sections:[] and only the corrected column_flow to reuse your original sections and summary verbatim.`;
  const entryRepair = traceDirection === 'downstream'
    ? `Account for each by naming it in an upstream_columns entry whose out_col is the column this node derives or renames it into (out_col need not equal the missing column when this node transforms or renames it) — or add an entry with out_col equal to the column and upstream_columns: [] where it passes through unchanged`
    : `Add a column_flow entry for each: out_col is the column, upstream_columns its real upstream columns — or upstream_columns: [] where the column originates here`;
  const repair = contradicted.length > 0
    ? `${entryRepair}. ${focusId} declares [${contradicted.join(', ')}], so it carries the column and verdict:'passthrough' with column_flow:[] is not available here.`
    : `${entryRepair}, or return verdict:'passthrough' with column_flow:[].`;
  return {
    error: 'column_chain_incomplete',
    hint: `Tracked columns [${unaccounted.join(', ')}] are not accounted for at ${focusId}. ${repair}${appendHeldOrder ? ` ${held}` : ''}`,
    detail: contradicted.length > 0
      ? { unaccounted, available_columns: available, declared_here: [...contradicted] }
      : { unaccounted, available_columns: available },
  };
}
