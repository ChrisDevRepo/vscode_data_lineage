/** Source-policy SQL identifier normalization shared by model construction and its consumers. */
import {
  quoteIdentifier,
  schemaKey,
  splitSqlName,
  stripBrackets,
} from '../../utils/sql';

/** One SQL identifier part, including escaped bracket or double-quote delimiters. */
export const SQL_IDENTIFIER_PART = String.raw`(?:\[(?:[^\]]|\]\])+\]|"(?:[^"]|"")+"|[\p{L}_#@][\p{L}\p{N}\p{M}_@$#]*)`;
const COMPLETE_IDENTIFIER = new RegExp(
  String.raw`^\p{White_Space}*${SQL_IDENTIFIER_PART}(?:\p{White_Space}*\.\p{White_Space}*${SQL_IDENTIFIER_PART})*\p{White_Space}*$`,
  'u',
);

/** Lossless multipart comparison key for a supplied SQL identity. Only delimiters, outside whitespace and source-permitted case differ; empty qualifiers and unbalanced names reject. Unlike catalog construction, this never collapses remote qualifiers or supplies a schema. */
export function sqlIdentifierComparisonKey(
  name: string,
  identifierCaseSensitive = false,
): string | null {
  if (!COMPLETE_IDENTIFIER.test(name)) return null;
  return JSON.stringify(
    splitSqlName(name).map((part) => {
      const token = part.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
      return schemaKey(stripBrackets(token), identifierCaseSensitive);
    }),
  );
}

/** Normalizes a SQL name to a canonical quoted identifier under the source comparison policy. */
export function normalizeName(
  name: string,
  identifierCaseSensitive = false,
): string {
  const parts = splitSqlName(name).map((p) =>
    schemaKey(stripBrackets(p), identifierCaseSensitive),
  );
  const quotePart = quoteIdentifier;
  if (parts.length < 2) {
    return quotePart(parts[0] ?? '');
  }
  if (parts.length >= 4) {
    return `[__external__].${quotePart(parts[parts.length - 1])}`;
  }
  return parts.map(quotePart).join('.');
}
