/** Centralized repository for SQL regex fragments and compositional builders. */

/** Matches a bracketed identifier like `[schema]` or `[table]`. */
const BRACKET_IDENT = /\[(?:[^\]]|\]\])+\]/;

/** Matches a regular SQL identifier: Unicode letters, then letters/digits or _/@/#/$. */
const WORD_IDENT = /[\p{L}_@#][\p{L}\p{Nd}_@$#]*/u;

/** Matches either a bracketed or plain identifier. */
export const ANY_IDENT = new RegExp(
  `(?:${BRACKET_IDENT.source}|${WORD_IDENT.source})`,
  'u',
);

/** Matches a schema-qualified name like `[s].[t]`, `s.t`, `[s].t`, or `s.[t]`. */
export const QUALIFIED_NAME = new RegExp(
  `(?:${ANY_IDENT.source}\\.)+${ANY_IDENT.source}`,
  'u',
);

/** Matches a bracketed identifier (group 1, kept as is) or whitespace around the period between two identifier parts, as in `dbo . T` or `[dbo] .[T]`. */
export const NAME_PERIOD_SPACING_RE = new RegExp(
  `(${BRACKET_IDENT.source})|(?<!\\s)(?=\\s+\\.|\\.\\s)(?<=(?:^|[^\\p{L}\\p{Nd}_@$#])${WORD_IDENT.source}|\\])(?:\\s+\\.\\s*|\\.\\s+)(?=[\\p{L}_@#\\[])`,
  'gu',
);

/** Reserved keywords of Transact-SQL, which never name an object, alias or CTE unless delimited. */
const RESERVED_KEYWORDS =
  `add all alter and any as asc authorization backup begin between break browse bulk by cascade case check
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
  unpivot update updatetext use user values varying view waitfor when where while with writetext`.split(
    /\s+/,
  );

/** Matches a whole regular identifier that is a reserved keyword; a delimited one never matches. */
export const KEYWORDS_RE = new RegExp(
  `^(?:${RESERVED_KEYWORDS.join('|')})$`,
  'i',
);

/** Pass 1 Cleansing: leftmost-match pattern to neutralize strings and comments. */
export const PASS1_CLEANSE_RE = new RegExp(
  `\\[(?:[^\\]]|\\]\\])*(?:\\]|$)|"(?:""|[^"])*"|'(?:''|[^'])*'|--[^\\r\\n]*`,
  'g',
);
