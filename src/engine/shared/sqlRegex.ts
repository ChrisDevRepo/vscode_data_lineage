/**
 * ─── SQL Regex Builder ──────────────────────────────────────────────────────
 *
 * Centralized repository for SQL regex fragments and compositional builders.
 * Ensures ReDoS safety and readability across the engine.
 */

/** Matches a bracketed identifier like [schema] or [table] */
export const BRACKET_IDENT = /\[[^\]]+\]/;

/** Matches a plain word identifier (no brackets) */
export const WORD_IDENT = /\w+/;

/** Matches either a bracketed or plain identifier */
export const ANY_IDENT = new RegExp(`(?:${BRACKET_IDENT.source}|${WORD_IDENT.source})`);

/** Matches a schema-qualified name like [s].[t], s.t, [s].t, or s.[t] */
export const QUALIFIED_NAME = new RegExp(
  `(?:${ANY_IDENT.source}\\.)+${ANY_IDENT.source}`
);

/** SQL keywords that should never be mistaken for identifiers in certain contexts */
export const SQL_KEYWORDS = [
  'select', 'insert', 'update', 'delete', 'from', 'join', 'where', 'set',
  'begin', 'end', 'values', 'exec', 'execute', 'top', 'distinct', 'all',
  'as', 'on', 'and', 'or', 'not', 'in', 'is', 'null', 'by', 'order',
  'group', 'having', 'into', 'case', 'when', 'then', 'else', 'return',
  'declare', 'table', 'index', 'view', 'proc', 'procedure', 'with'
];

/** Regex to match any of the protected keywords */
export const KEYWORDS_RE = new RegExp(`^\\b(?:${SQL_KEYWORDS.join('|')})\\b$`, 'i');

/** 
 * Pass 1 Cleansing: leftmost-match pattern to neutralize strings and comments.
 * 1. Brackets: preserved (YAML rules need them)
 * 2. Strings: neutralized to ''
 * 3. Comments: replaced with space
 */
export const PASS1_CLEANSE_RE = /\[[^\]]+\]|"[^"]*"|'(?:''|[^'])*'|--[^\r\n]*/g;

/**
 * ANSI-92 Comma Join pattern fragments.
 */
export const TABLE_REF_WITH_ALIAS = new RegExp(
  `${ANY_IDENT.source}\\.${ANY_IDENT.source}(?:\\s+(?:AS\\s+)?${WORD_IDENT.source})?`
);

/** Keywords that terminate a FROM clause */
const FROM_KEYWORDS = ['WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER',
  'ON', 'ORDER', 'GROUP', 'HAVING', 'WITH', 'SET'];
const FROM_PUNCTUATION = [';', '\\)', '$'];

// Word-boundary \b only on keyword terminators; punctuation/anchors must not have \b
// Expected: \s*(?:WHERE\b|JOIN\b|...|SET\b|;|\)|$)
export const FROM_TERMINATOR_RE = new RegExp(
  `\\s*(?:${FROM_KEYWORDS.map(k => k + '\\b').join('|')}|${FROM_PUNCTUATION.join('|')})`, 'i'
);
