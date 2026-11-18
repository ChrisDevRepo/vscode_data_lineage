/** Source-policy SQL identifier normalization shared by model construction and its consumers. */
import { quoteIdentifier, schemaKey, splitSqlName, stripBrackets } from '../../utils/sql';

/**
 * Normalizes a SQL name to a canonical quoted identifier under the source comparison policy.
 * `identifierCaseSensitive` is true only when checked catalog metadata requires exact casing; the
 * default lowercases identifiers.
 */
export function normalizeName(name: string, identifierCaseSensitive = false): string {
  const parts = splitSqlName(name).map(p => schemaKey(stripBrackets(p), identifierCaseSensitive));
  if (parts.length < 2) {
    return quoteIdentifier(parts[0] ?? '');
  }
  if (parts.length >= 4) {
    return `[__external__].${quoteIdentifier(parts[parts.length - 1])}`;
  }
  return parts.map(quoteIdentifier).join('.');
}
