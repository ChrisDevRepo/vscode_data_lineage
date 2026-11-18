/**
 * CT column completeness: informational accounting for the Navigation Engine. A pure set difference
 * (`required − accounted`) over `normalizeColName`, the normalizer
 * `ColumnTracer.validateColumnFlow` accepts `out_col` under, so a value one guard admits is never
 * reported unaccounted here. An unaccounted tracked column is never a rejection: the engine only
 * verifies that a recorded column_flow link joins two real columns, and where a chain starts or
 * ends and whether the columns are complete is the AI's decision. The unaccounted set is returned
 * to the model as data (`unaccounted_columns` on the hop acknowledgement), never enforced.
 */

import { normalizeColName } from '../../utils/sql';

/**
 * Items in `required` not present in `accounted`, ignoring SQL delimiters under the source case
 * policy, order preserved; returns the original `required` casing so the caller can surface
 * offending values verbatim.
 */
export function computeUnaccounted(required: readonly string[], accounted: Iterable<string>, identifierCaseSensitive = false): string[] {
  const acc = new Set<string>();
  for (const a of accounted) acc.add(normalizeColName(a, identifierCaseSensitive));
  return required.filter(r => !acc.has(normalizeColName(r, identifierCaseSensitive)));
}
