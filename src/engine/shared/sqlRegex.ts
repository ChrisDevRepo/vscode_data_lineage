/**
 * ─── SQL Regex Builder ──────────────────────────────────────────────────────
 *
 * Centralized repository for SQL regex fragments and compositional builders.
 * 
 * @remarks
 * This module ensures ReDoS safety and readability across the parsing engine 
 * by using shared regex constants and descriptive building blocks for complex 
 * SQL patterns.
 * 
 * @packageDocumentation
 */

/**
 * Matches a bracketed identifier like `[schema]` or `[table]`.
 * 
 * @remarks
 * SQL Server uses square brackets to escape identifiers that contain spaces 
 * or are reserved keywords.
 * 
 * @constant
 * @readonly
 */
export const BRACKET_IDENT: RegExp = /\[[^\]]+\]/;

/**
 * Matches a plain word identifier (no brackets), consisting only of word characters.
 * 
 * @remarks
 * Standard identifiers must start with a letter and contain only alphanumeric 
 * characters or underscores.
 * 
 * @constant
 * @readonly
 */
export const WORD_IDENT: RegExp = /\w+/;

/**
 * Matches either a bracketed or plain identifier.
 * 
 * @remarks
 * Composed using {@link BRACKET_IDENT} and {@link WORD_IDENT}.
 * 
 * @constant
 * @readonly
 */
export const ANY_IDENT: RegExp = new RegExp(`(?:${BRACKET_IDENT.source}|${WORD_IDENT.source})`);

/**
 * Matches a schema-qualified name like `[s].[t]`, `s.t`, `[s].t`, or `s.[t]`.
 * 
 * @remarks
 * Represents a multi-part identifier separated by dots. Used as a core building 
 * block for identifying table and view references.
 * 
 * @constant
 * @readonly
 */
export const QUALIFIED_NAME: RegExp = new RegExp(
  `(?:${ANY_IDENT.source}\\.)+${ANY_IDENT.source}`
);

/**
 * SQL keywords that should never be mistaken for identifiers in certain contexts.
 * 
 * @remarks
 * This list is used for validation and to prevent accidental extraction of 
 * keywords as table names during parsing.
 * 
 * @constant
 * @readonly
 */
export const SQL_KEYWORDS: string[] = [
  'select', 'insert', 'update', 'delete', 'from', 'join', 'where', 'set',
  'begin', 'end', 'values', 'exec', 'execute', 'top', 'distinct', 'all',
  'as', 'on', 'and', 'or', 'not', 'in', 'is', 'null', 'by', 'order',
  'group', 'having', 'into', 'case', 'when', 'then', 'else', 'return',
  'declare', 'table', 'index', 'view', 'proc', 'procedure', 'with'
];

/**
 * Regex to match any of the protected keywords as a distinct word boundary.
 * 
 * @remarks
 * Performs a case-insensitive match on the full word against {@link SQL_KEYWORDS}.
 * 
 * @constant
 * @readonly
 */
export const KEYWORDS_RE: RegExp = new RegExp(`^\\b(?:${SQL_KEYWORDS.join('|')})\\b$`, 'i');

/** 
 * Pass 1 Cleansing: leftmost-match pattern to neutralize strings and comments.
 * 
 * @remarks
 * This regex is the core of the pre-processing pipeline. It identifies 
 * structures that should be ignored or normalized before extraction rules run:
 * 1. Brackets: preserved (YAML rules need them for structure)
 * 2. Double-quoted strings: identified for bracket conversion
 * 3. Single-quoted strings: identified for neutralization
 * 4. Comments: identified for removal
 * 
 * @constant
 * @readonly
 */
export const PASS1_CLEANSE_RE: RegExp = /\[[^\]]+\]|"[^"]*"|'(?:''|[^'])*'|--[^\r\n]*/g;

/**
 * ANSI-92 Comma Join pattern fragments.
 * 
 * @remarks
 * Matches a fully qualified table reference, optionally followed by an alias.
 * Used during the normalization of comma-joins into explicit `JOIN` syntax.
 * 
 * @constant
 * @readonly
 */
export const TABLE_REF_WITH_ALIAS: RegExp = new RegExp(
  `${ANY_IDENT.source}\\.${ANY_IDENT.source}(?:\\s+(?:AS\\s+)?${WORD_IDENT.source})?`
);

/**
 * Keywords that terminate a `FROM` clause in SQL statements.
 * 
 * @remarks
 * Private constant used to build {@link FROM_TERMINATOR_RE}.
 */
const FROM_KEYWORDS: string[] = [
  'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER',
  'ON', 'ORDER', 'GROUP', 'HAVING', 'WITH', 'SET'
];

/**
 * Punctuation characters and line anchors that terminate a `FROM` clause.
 */
const FROM_PUNCTUATION: string[] = [';', '\\)', '$'];

/**
 * Regular expression matching tokens that terminate a `FROM` clause.
 * 
 * @remarks
 * Word-boundary `\b` is applied only to keyword terminators; punctuation 
 * and anchors do not use word boundaries. This pattern detects where a 
 * table list in a `FROM` clause ends.
 * 
 * @constant
 * @readonly
 */
export const FROM_TERMINATOR_RE: RegExp = new RegExp(
  `\\s*(?:${FROM_KEYWORDS.map(k => k + '\\b').join('|')}|${FROM_PUNCTUATION.join('|')})`, 'i'
);
