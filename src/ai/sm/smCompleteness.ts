/**
 * CT column completeness guard for the Navigation Engine.
 *
 * @remarks
 * Every tracked column the AI must account for at a hop is continued, terminal, or dropped —
 * anything left over means the chain was left incomplete, so the engine rejects and the worker
 * re-asks. The check is a pure set difference (`required − accounted`) over `normalizeColName` —
 * the same normalizer `ColumnTracer.validateColumnFlow` accepts a submitted `out_col` under, so a
 * value one guard admits can never be reported unaccounted by the other. No content judgment —
 * identifiers only. BB neighbor completeness is a separate, unrelated
 * mechanism (`requiredNeighborIds` → `BbStrategy.runRequiredNodesGuard` →
 * `missing_required_route`) and does not use this module.
 */

import { normalizeColName } from '../../utils/sql';
import type { SubmitResult } from './smTypes';

/**
 * Items in `required` not present in `accounted`, compared case-insensitively and ignoring SQL brackets, order preserved.
 *
 * @remarks
 * The pure core of the CT column completeness guard. Returns the original `required` casing so
 * the caller can surface the offending values verbatim.
 *
 * @param required - Active columns that the current hop must account for.
 * @param accounted - Column names represented by the submitted flow.
 * @returns Required columns absent from the submitted flow.
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
 * `available` is the valid set of active columns the AI may choose from, surfaced under
 * `available_columns` in `detail`.
 *
 * @param focusId - Canonical focus whose active columns were incomplete.
 * @param unaccounted - Active columns missing from the submitted flow.
 * @param available - Valid active columns exposed for correction.
 * @returns The narrow held-content retry envelope.
 */
export function buildIncompleteRejection(
  focusId: string,
  unaccounted: string[],
  available: string[],
): SubmitResult {
  return {
    error: 'column_chain_incomplete',
    hint: `REJECTED: Tracked columns [${unaccounted.join(', ')}] are not accounted for at ${focusId}. You MUST explicitly add a column_flow entry for each, or return verdict:'passthrough' with column_flow:[]. Your analysis is held: resend submit_findings with sections:[] and only the corrected column_flow to reuse your original sections and summary verbatim.`,
    detail: { unaccounted, available_columns: available },
  };
}
