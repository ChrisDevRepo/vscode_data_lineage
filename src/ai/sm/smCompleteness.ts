/**
 * CT column completeness — informational accounting for the Navigation Engine.
 *
 * @remarks
 * A pure set difference (`required − accounted`) over `normalizeColName` — the same normalizer
 * `ColumnTracer.validateColumnFlow` accepts a submitted `out_col` under, so a value one guard admits
 * can never be reported unaccounted here. An unaccounted tracked column is never a rejection: the
 * engine only verifies that a recorded column_flow link joins two real columns; where a chain
 * starts or ends, whether new columns join, and whether the columns are complete is the AI's
 * decision. The unaccounted set is logged and returned as plain data (`unaccounted_columns` on the
 * hop acknowledgement, except on the final hop, whose acknowledgement is the completion envelope),
 * never enforced. An accepted submission ends the hop, so the model does not read that
 * acknowledgement; the set reaches only the debug log and the session hop log, neither a later hop
 * nor synthesis.
 */

import { normalizeColName } from '../../utils/sql';

/**
 * Items in `required` not present in `accounted`, ignoring SQL delimiters under the source case policy, order preserved.
 *
 * @remarks
 * Returns the original `required` casing so the caller can surface the offending values verbatim.
 */
export function computeUnaccounted(required: readonly string[], accounted: Iterable<string>, identifierCaseSensitive = false): string[] {
  const acc = new Set<string>();
  for (const a of accounted) acc.add(normalizeColName(a, identifierCaseSensitive));
  return required.filter(r => !acc.has(normalizeColName(r, identifierCaseSensitive)));
}
