/** Source-policy SQL identifier normalization shared by model construction and its consumers. */
import { quoteIdentifier, schemaKey, splitSqlName, stripBrackets } from '../../utils/sql';

/**
 * Normalizes a SQL name to a canonical quoted identifier under the source comparison policy.
 *
 * @param name - Name to use.
 * @param identifierCaseSensitive - True only when checked catalog metadata requires exact casing.
 * @returns Canonical quoted key; legacy/default comparison lowercases identifiers.
 */
export function normalizeName(name: string, identifierCaseSensitive = false): string {
  const parts = splitSqlName(name).map(p => schemaKey(stripBrackets(p), identifierCaseSensitive));
  const quotePart = quoteIdentifier;
  if (parts.length < 2) {
    return quotePart(parts[0] ?? '');
  }
  if (parts.length >= 4) {
    return `[__external__].${quotePart(parts[parts.length - 1])}`;
  }
  return parts.map(quotePart).join('.');
}
