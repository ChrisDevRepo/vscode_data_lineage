/**
 * Centralized repository for SQL regex fragments and compositional builders.
 *
 * @remarks
 * Shared regex constants and building blocks keep the parsing engine's patterns ReDoS-safe.
 *
 * @packageDocumentation
 */

/**
 * Matches a bracketed identifier like `[schema]` or `[table]`.
 *
 * @remarks
 * SQL Server uses square brackets to escape identifiers that contain spaces
 * or are reserved keywords. A literal `]` inside the name is written `]]`, so
 * `[a]]b]` is the single identifier `a]b`; ending the name at the first `]`
 * truncates it and leaves the rest of the statement misread.
 */
const BRACKET_IDENT = /\[(?:[^\]]|\]\])+\]/;

/** Matches a regular SQL identifier: Unicode letters, then letters/digits or _/@/#/$. */
const WORD_IDENT = /[\p{L}_@#][\p{L}\p{Nd}_@$#]*/u;

/** Matches either a bracketed or plain identifier. */
export const ANY_IDENT = new RegExp(`(?:${BRACKET_IDENT.source}|${WORD_IDENT.source})`, 'u');

/** Matches a schema-qualified name like `[s].[t]`, `s.t`, `[s].t`, or `s.[t]`. */
export const QUALIFIED_NAME = new RegExp(
  `(?:${ANY_IDENT.source}\\.)+${ANY_IDENT.source}`, 'u'
);

/**
 * Matches a bracketed identifier (group 1, kept as is) or whitespace around the period between
 * two identifier parts, as in `dbo . T` or `[dbo] .[T]`.
 *
 * @remarks
 * The part before the period must be a whole regular identifier or a closing bracket, and the
 * part after it must start an identifier, so numbers (`1. AS`) and text inside brackets are left
 * unchanged. A match starts at the first character after the name part, so the leading
 * lookbehind rejects every later position of a whitespace run before the run is scanned again.
 */
export const NAME_PERIOD_SPACING_RE = new RegExp(
  `(${BRACKET_IDENT.source})|(?<!\\s)(?=\\s+\\.|\\.\\s)(?<=(?:^|[^\\p{L}\\p{Nd}_@$#])${WORD_IDENT.source}|\\])(?:\\s+\\.\\s*|\\.\\s+)(?=[\\p{L}_@#\\[])`, 'gu'
);

/**
 * Reserved keywords of Transact-SQL, which never name an object, alias or CTE unless delimited.
 *
 * @remarks
 * Source: "Reserved Keywords (Transact-SQL)",
 * https://learn.microsoft.com/sql/t-sql/language-elements/reserved-keywords-transact-sql, less the
 * listed words the SQL Server 2025 parser accepts as an undelimited alias (`DISK`, `DUMP`, `LABEL`,
 * `LOAD`, `PRECISION`, `SECURITYAUDIT`, `WITHIN`). Words that are not reserved, such as `THROW`,
 * `SOURCE` or `TARGET`, stay valid identifiers.
 */
const RESERVED_KEYWORDS = `add all alter and any as asc authorization backup begin between break browse bulk by cascade case check
  checkpoint close clustered coalesce collate column commit compute constraint contains containstable
  continue convert create cross current current_date current_time current_timestamp current_user cursor
  database dbcc deallocate declare default delete deny desc distinct distributed double drop else end
  errlvl escape except exec execute exists exit external fetch file fillfactor for foreign freetext
  freetexttable from full function goto grant group having holdlock identity identity_insert identitycol
  if in index inner insert intersect into is join key kill left like lineno merge national nocheck
  nonclustered not null nullif of off offsets on open opendatasource openquery openrowset openxml option
  or order outer over percent pivot plan primary print proc procedure public raiserror read readtext
  reconfigure references replication restore restrict return revert revoke right rollback rowcount
  rowguidcol rule save schema select semantickeyphrasetable semanticsimilaritydetailstable
  semanticsimilaritytable session_user set setuser shutdown some statistics system_user table
  tablesample textsize then to top tran transaction trigger truncate try_convert tsequal union unique
  unpivot update updatetext use user values varying view waitfor when where while with writetext`.split(/\s+/);

/** Matches a whole regular identifier that is a reserved keyword; a delimited one never matches. */
export const KEYWORDS_RE = new RegExp(`^(?:${RESERVED_KEYWORDS.join('|')})$`, 'i');

/**
 * Pass 1 Cleansing: leftmost-match pattern to neutralize strings and comments.
 *
 * @remarks
 * This regex is the core of the pre-processing pipeline. It identifies
 * structures that should be ignored or normalized before extraction rules run:
 * 1. Brackets: preserved (YAML rules need them for structure); the `]]` escape is honoured as in
 *    {@link BRACKET_IDENT}, and an unterminated `[` consumes to the end of input once, so a
 *    run of unbalanced `[` is scanned in linear time
 * 2. Double-quoted identifiers: identified for bracket conversion; `""` is an escaped quote
 * 3. Single-quoted strings: identified for neutralization; `''` is an escaped quote
 * 4. Comments: identified for removal
 */
export const PASS1_CLEANSE_RE = new RegExp(
  `\\[(?:[^\\]]|\\]\\])*(?:\\]|$)|"(?:""|[^"])*"|'(?:''|[^'])*'|--[^\\r\\n]*`, 'g'
);
