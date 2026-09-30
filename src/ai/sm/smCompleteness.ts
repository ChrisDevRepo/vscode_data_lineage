/**
 * CT column completeness — informational accounting for the Navigation Engine.
 *
 * @remarks
 * A pure set difference (`required − accounted`) over `normalizeColName` — the same normalizer
 * `ColumnTracer.validateColumnFlow` accepts a submitted `out_col` under, so a value one guard admits
 * can never be reported unaccounted here. An unaccounted tracked column is never a rejection: the
 * engine only verifies that a recorded column_flow link joins two real columns; where a chain
 * starts or ends, whether new columns join, and whether the columns are complete is the AI's
 * decision. The unaccounted set is surfaced back
 * to the model as plain data (`unaccounted_columns` on the hop acknowledgement), never enforced.
 */

import { normalizeColName } from '../../utils/sql';

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
