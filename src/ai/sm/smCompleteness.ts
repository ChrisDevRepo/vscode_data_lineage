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
 * mechanism (`requiredNeighborIds` → the unconditional completeness guard in
 * `submitFindings` → `missing_required_route`) and does not use this module.
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
 * Two repairs exist, and only one of them is always open. A focus that declares none of the active
 * columns may end the chain with `verdict:'passthrough'` and `column_flow:[]`; a focus that
 * declares one of them may not, because there the claim is checkably false and the engine refuses
 * it. `contradicted` carries the active columns the focus declares, so the hint offers the escape
 * only where it will be accepted — a rejection that names a repair the engine rejects costs another
 * generation and teaches the model nothing.
 *
 * @param focusId - Canonical focus whose active columns were incomplete.
 * @param unaccounted - Active columns missing from the submitted flow.
 * @param available - Valid active columns exposed for correction.
 * @param contradicted - Active columns the focus itself declares; empty when it declares none.
 * @returns The narrow held-content retry envelope.
 */
export function buildIncompleteRejection(
  focusId: string,
  unaccounted: string[],
  available: string[],
  contradicted: readonly string[] = [],
): SubmitResult {
  const held = `Your analysis is held: resend submit_findings with sections:[] and only the corrected column_flow to reuse your original sections and summary verbatim.`;
  const repair = contradicted.length > 0
    ? `Add a column_flow entry for each. ${focusId} declares [${contradicted.join(', ')}], so it carries the column and verdict:'passthrough' with column_flow:[] is not available here.`
    : `Add a column_flow entry for each, or return verdict:'passthrough' with column_flow:[].`;
  return {
    error: 'column_chain_incomplete',
    hint: `Tracked columns [${unaccounted.join(', ')}] are not accounted for at ${focusId}. ${repair} ${held}`,
    detail: contradicted.length > 0
      ? { unaccounted, available_columns: available, declared_here: [...contradicted] }
      : { unaccounted, available_columns: available },
  };
}
