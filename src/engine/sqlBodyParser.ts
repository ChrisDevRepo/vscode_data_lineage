/**
 * ─── SQL Body Parser ────────────────────────────────────────────────────────
 *
 * Regex-based T-SQL dependency extraction engine.
 *
 * @remarks
 * This parser uses a high-performance, multi-pass cleansing pipeline to
 * neutralize comments, strings, and complex SQL structures (like CTEs and
 * comma-joins) before applying rule-based extraction for lineage analysis.
 *
 * Extraction rules are loaded from YAML at runtime to allow for extensibility
 * without modifying the core engine logic.
 *
 * @packageDocumentation
 */

import { normalizeColName, quoteIdentifier, schemaKey, splitSqlName, stripBrackets } from '../utils/sql';
import { CLR_TYPE_METHODS } from './shared/sqlMetadata';
import { SQL_BLOCK_COMMENT, SQL_CODE, sqlCommentMask } from './shared/sqlSpans';
import {
  QUALIFIED_NAME, ANY_IDENT, KEYWORDS_RE,
  PASS1_CLEANSE_RE, NAME_PERIOD_SPACING_RE
} from './shared/sqlRegex';
import type { ExternalRef } from './types';

/**
 * Represents the extracted SQL dependencies from a parsed SQL body.
 *
 * @remarks
 * Categorizes discovered database objects into read/write operations and
 * execution calls.
 */
interface ParsedDependencies {
  /** Schema-qualified names of objects read from (e.g. `[dbo].[Table]`), from SELECT and JOIN. */
  sources: string[];
  /** Schema-qualified names of objects written to (e.g. `[dbo].[Table]`), from INSERT/UPDATE. */
  targets: string[];
  /** Schema-qualified names of procedures executed (e.g. `[dbo].[Proc]`), from EXEC/EXECUTE. */
  execCalls: string[];
  /** Full 3-part names of cross-database sources (`db.schema.object`), apart from local reads. */
  crossDbSources: string[];
  /** Full 3-part names of cross-database targets (`db.schema.object`), for cross-DB lineage. */
  crossDbTargets: string[];
  /** Labels of {@link PARTIAL_SUPPORT} constructs in the body. */
  unsupported: string[];
}

/**
 * Body constructs that are not analysed; the references the other rules capture around them still
 * count.
 */
const PARTIAL_SUPPORT: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
  ['Cursor', /(?<![[@\w])CURSOR\b(?!\])/i],
  ['Dynamic SQL', /\bEXEC(?:UTE)?\s*\(|\bsp_executesql\b/i],
];

/**
 * Defines a single regex-based extraction rule for SQL parsing.
 *
 * @remarks
 * Rules are the atomic unit of extraction in the engine. They use named capture
 * groups to identify pertinent identifiers in the SQL text.
 */
interface ParseRule {
  /** Unique identifier for the rule. Used for debugging and configuration overrides. */
  name: string;
  enabled: boolean;
  /** Execution order (lower runs earlier); matters for rules depending on earlier preprocessing. */
  priority: number;
  /** Categorizes how the rule's matches are classified in {@link ParsedDependencies}. */
  category: 'preprocessing' | 'source' | 'target' | 'exec' | 'external_ref';
  /** Regex string evaluated against the SQL body; needs one capture group for the identifier. */
  pattern: string;
  /**
   * Regex flags (e.g., 'gi') applied to the pattern. Must include `g`: every consumer scans or
   * rewrites the whole body, and a non-global pattern either never terminates or matches once.
   */
  flags: string;
  /** Replacement string of 'preprocessing' rules, which transform SQL text before extraction. */
  replacement?: string;
  /** Defines the type of external reference. Required if category is 'external_ref'. */
  kind?: string;
  description: string;
}

/**
 * Raw, unvalidated configuration accepted by {@link loadRules}. `loadRules` is the per-rule
 * validator, so its input is loose (YAML-shaped candidates; invalid entries are skipped with
 * diagnostics).
 */
export interface RawParseRulesConfig {
  /** Candidate rules; each entry stays `unknown` until `validateRule` accepts it. */
  readonly rules?: readonly unknown[];
}

/**
 * Result of attempting to load and validate a set of parse rules.
 *
 * @remarks
 * Provides telemetry on how many rules were successfully loaded and
 * details on any validation failures.
 */
interface LoadRulesResult {
  loaded: number;
  /** Names of rules that failed validation and were skipped. */
  skipped: string[];
  /** Detailed error messages for the rules that failed validation. */
  errors: string[];
  /** True when the configuration held no valid rule, so the fallback rules (if any) were loaded. */
  usedDefaults: boolean;
}

/** Active parsing rules, replaced atomically by {@link loadRules}. */
let activeRules: ParseRule[] = [];

/** Rule categories accepted by the configuration boundary. */
const VALID_CATEGORIES = new Set(['preprocessing', 'source', 'target', 'exec', 'external_ref']);

/**
 * Validates one parse rule for structure and the two regex properties every scan depends on: the
 * pattern must not match the empty string and the flags must include `g`. Both are termination
 * conditions, not style.
 *
 * @param index - Index of the rule in the configuration array.
 * @returns Success, or failure with an error message.
 */
function validateRule(rule: unknown, index: number): { valid: true; name: string } | { valid: false; name: string; error: string } {
  const r = rule as Record<string, unknown>;
  const name = typeof r?.name === 'string' ? r.name : `rule[${index}]`;

  if (!r || typeof r !== 'object') return { valid: false, name, error: `${name}: not an object` };
  if (typeof r.name !== 'string' || !r.name) return { valid: false, name, error: `${name}: missing 'name'` };
  if (typeof r.pattern !== 'string' || !r.pattern) return { valid: false, name, error: `${name}: missing 'pattern'` };
  if (typeof r.category !== 'string' || !VALID_CATEGORIES.has(r.category)) {
    return { valid: false, name, error: `${name}: invalid category '${r.category}' (must be: preprocessing, source, target, exec, external_ref)` };
  }
  if (r.category === 'external_ref' && (typeof r.kind !== 'string' || !r.kind)) {
    return { valid: false, name, error: `${name}: external_ref rules require a non-empty 'kind' field` };
  }
  if (typeof r.priority !== 'number') return { valid: false, name, error: `${name}: missing or invalid 'priority'` };
  if (typeof r.flags !== 'string') return { valid: false, name, error: `${name}: missing 'flags'` };
  if (!r.flags.includes('g')) {
    return { valid: false, name, error: `${name}: flags '${r.flags}' must include 'g' — a non-global pattern hangs or silently under-matches` };
  }

  try {
    const testRegex = new RegExp(r.pattern, r.flags);
    if (testRegex.test('')) {
      return { valid: false, name, error: `${name}: regex matches empty string — this would cause infinite loops` };
    }
  } catch (e) {
    return { valid: false, name, error: `${name}: invalid regex — ${e instanceof Error ? e.message : String(e)}` };
  }

  return { valid: true, name };
}

/**
 * Loads and validates rules from a parsed configuration (built-in or custom), sorted by priority so
 * execution order is independent of source-file order. A configuration with no valid rule loads
 * `fallback` instead; with none, no rule stays active.
 *
 * @returns Success counts and any validation errors, the fallback's included.
 */
export function loadRules(config: RawParseRulesConfig, fallback?: RawParseRulesConfig): LoadRulesResult {
  const result: LoadRulesResult = { loaded: 0, skipped: [], errors: [], usedDefaults: false };
  const validRules: ParseRule[] = [];

  if (!config?.rules || !Array.isArray(config.rules)) {
    result.errors.push('YAML missing "rules" array');
  } else {
    for (let i = 0; i < config.rules.length; i++) {
      const raw = config.rules[i];

      if (raw && typeof raw === 'object' && (raw as ParseRule).enabled === false) continue;

      const check = validateRule(raw, i);
      if (check.valid) {
        validRules.push({ ...(raw as ParseRule) });
      } else {
        result.skipped.push(check.name);
        result.errors.push(check.error);
      }
    }
    if (validRules.length === 0) result.errors.push('No valid rules found');
  }

  if (validRules.length === 0) {
    result.usedDefaults = true;
    if (!fallback) {
      activeRules = [];
      return result;
    }
    const replacement = loadRules(fallback);
    return {
      ...replacement,
      skipped: [...result.skipped, ...replacement.skipped],
      errors: [...result.errors, ...replacement.errors],
      usedDefaults: true,
    };
  }

  activeRules = validRules.sort((a, b) => a.priority - b.priority);
  result.loaded = validRules.length;
  return result;
}

/** Index of the `)` closing the `(` at `open`, skipping quoted spans; `-1` when unbalanced. */
function closingParen(sql: string, mask: Uint8Array, open: number): number {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (mask[i] !== SQL_CODE) continue;
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Index just past `pattern` when it matches exactly at `at`; `-1` otherwise. */
function skip(sql: string, pattern: string, at: number): number {
  const re = new RegExp(pattern, 'iuy');
  re.lastIndex = at;
  return re.test(sql) ? re.lastIndex : -1;
}

/**
 * Same-length view of `sql[from, to)` for structural tests at its own nesting level: text inside
 * nested parentheses becomes spaces and every quoted span becomes `#`, so a keyword, comma or
 * parenthesis found in it belongs to that level and offsets still index into `sql`.
 */
function topLevelText(sql: string, mask: Uint8Array, from: number, to: number): string {
  let out = '';
  let depth = 0;
  for (let i = from; i < to; i++) {
    const ch = sql[i];
    if (mask[i] !== SQL_CODE) { out += depth > 0 ? ' ' : '#'; continue; }
    if (ch === ')' && depth > 0) depth--;
    out += depth > 0 ? ' ' : ch;
    if (ch === '(') depth++;
  }
  return out;
}

/** Replacement of `sql[from, to)` by `text`. */
interface TextEdit { from: number; to: number; text: string }

/** Applies non-overlapping edits to `sql`. */
function applyEdits(sql: string, edits: TextEdit[]): string {
  let result = '';
  let at = 0;
  for (const edit of edits.sort((a, b) => a.from - b.from)) {
    result += sql.slice(at, edit.from) + edit.text;
    at = edit.to;
  }
  return result + sql.slice(at);
}

/**
 * Preprocessing pass that rewrites the `FROM` of `IS [NOT] DISTINCT FROM` and of `TRIM([LEADING |
 * TRAILING | BOTH] characters FROM string)` to a comma: there `FROM` separates two operands and
 * opens no FROM clause, so no later pass or rule may read the operand after it as a table source.
 * One scan tracks open parentheses, so `FROM` belongs to `TRIM` only when the innermost open
 * parenthesis is the one `TRIM` opened.
 *
 * @param sql - Cleaned SQL text.
 */
function neutraliseOperandFrom(sql: string): string {
  const mask = sqlCommentMask(sql, { markLiterals: true });
  const operandFrom = new Set<number>();
  const trimOpen = new Set<number>();
  for (const operator of sql.matchAll(/(?<![@#$])\b(?:IS\s+(?:NOT\s+)?DISTINCT\s+(?=FROM\b)|TRIM\s*(?=\())/giu)) {
    if (mask[operator.index!] !== SQL_CODE) continue;
    const next = operator.index! + operator[0].length;
    (sql[next] === '(' ? trimOpen : operandFrom).add(next);
  }
  const awaitsFrom: boolean[] = [];
  for (const token of sql.matchAll(/[()]|(?<![@#$])\bFROM\b/giu)) {
    const at = token.index!;
    if (mask[at] !== SQL_CODE) continue;
    if (token[0] === '(') awaitsFrom.push(trimOpen.has(at));
    else if (token[0] === ')') awaitsFrom.pop();
    else if (awaitsFrom.at(-1) && !operandFrom.has(at)) {
      operandFrom.add(at);
      awaitsFrom[awaitsFrom.length - 1] = false;
    }
  }
  return applyEdits(sql, [...operandFrom].map(from => ({ from, to: from + 'FROM'.length, text: ',' })));
}

/**
 * Preprocessing pass that takes `TOP (expression) [PERCENT]` out of INSERT, UPDATE and MERGE, so
 * later passes and rules read the target directly after the statement keyword. The expression may
 * nest parentheses and hold a subquery or call; each is appended as a statement of its own so its
 * reads stay visible. An unbalanced parenthesis ends the pass.
 *
 * @param sql - Cleaned SQL text.
 */
function liftDmlTop(sql: string): string {
  const mask = sqlCommentMask(sql, { markLiterals: true });
  const edits: TextEdit[] = [];
  let lifted = '';
  let resumeAt = 0;
  for (const top of sql.matchAll(/\b(?:INSERT|UPDATE|MERGE)(\s+TOP\s*)(?=\()/giu)) {
    if (top.index! < resumeAt || mask[top.index!] !== SQL_CODE) continue;
    const open = top.index! + top[0].length;
    const close = closingParen(sql, mask, open);
    if (close < 0) break;
    const percent = /\s*PERCENT\b/iuy;
    percent.lastIndex = close + 1;
    resumeAt = percent.test(sql) ? percent.lastIndex : close + 1;
    edits.push({ from: open - top[1].length, to: resumeAt, text: ' ' });
    lifted += `;${sql.slice(open, close + 1)}`;
  }
  return applyEdits(sql, edits) + lifted;
}

/**
 * Preprocessing pass that removes the column list and WITH options between the table name of
 * `CREATE [EXTERNAL] TABLE` and `AS SELECT` / `AS WITH`. Only those two parenthesised groups may
 * stand there, so the CTAS rules match the name directly before `AS` and a plain `CREATE TABLE`
 * never pairs with a later statement's `AS`. An unbalanced parenthesis ends the pass.
 *
 * @param sql - Cleaned SQL text.
 */
function dropCtasOptions(sql: string): string {
  const mask = sqlCommentMask(sql, { markLiterals: true });
  const edits: TextEdit[] = [];
  const table = new RegExp(`\\bCREATE\\s+(?:EXTERNAL\\s+)?TABLE(?:\\s+|\\s*(?=\\[))(?:${ANY_IDENT.source}\\.)*${ANY_IDENT.source}`, 'giu');
  let resumeAt = 0;
  scan: for (const create of sql.matchAll(table)) {
    if (create.index! < resumeAt || mask[create.index!] !== SQL_CODE) continue;
    const from = create.index! + create[0].length;
    let at = from;
    for (const lead of ['\\s*(?=\\()', '\\s*WITH\\s*(?=\\()']) {
      const open = skip(sql, lead, at);
      if (open < 0) continue;
      const close = closingParen(sql, mask, open);
      if (close < 0) break scan;
      at = close + 1;
    }
    resumeAt = at;
    if (at > from && skip(sql, '\\s*AS\\s+(?:SELECT|WITH)\\b', at) >= 0) edits.push({ from, to: at, text: ' ' });
  }
  return applyEdits(sql, edits);
}

/**
 * Clauses that end a single-query FROM clause. WINDOW is left out: it is also a legal alias, and a
 * WINDOW clause after the table list adds no member.
 */
const FROM_CLAUSE_END_RE = /\b(?:WHERE|GROUP|HAVING|ORDER|OPTION|FOR)\b/iu;

/**
 * The one table a query expression reads in its own FROM clause, or `null` when its text names no
 * single table. Pure syntax: `sql[from, to)` must have exactly one FROM at its own level, no set
 * operator, and a FROM without APPLY, PIVOT or comma. A lone derived table resolves the same way. A
 * join list resolves only when exactly one member is a table reference and every other is a derived
 * table that cannot be written through ({@link isReadOnlyQuery}). Subqueries elsewhere never supply
 * the table. Returned as written: schema-qualified, or an unqualified name the caller may resolve
 * as an earlier CTE of the same list.
 */
function singleQueryTable(sql: string, mask: Uint8Array, from: number, to: number): string | null {
  const flat = topLevelText(sql, mask, from, to);
  if (SET_OPERATOR_RE.test(flat)) return null;
  const froms = [...flat.matchAll(/\bFROM\b/giu)];
  if (froms.length !== 1) return null;
  const clauseStart = froms[0].index! + 'FROM'.length;
  const clauseLength = flat.slice(clauseStart).search(FROM_CLAUSE_END_RE);
  const clause = flat.slice(clauseStart, clauseLength < 0 ? flat.length : clauseStart + clauseLength);
  if (/,|\b(?:APPLY|PIVOT|UNPIVOT)\b/iu.test(clause)) return null;
  const members = [...clause.matchAll(/(?:^|\bJOIN\b)\s*(?=\S)/giu)].map(member => from + clauseStart + member.index + member[0].length);
  if (members.length === 0) return null;
  let reference: string | null = null;
  for (const at of members) {
    if (sql[at] === '(') {
      const close = closingParen(sql, mask, at);
      if (close < 0 || close >= to) return null;
      if (members.length === 1) return singleQueryTable(sql, mask, at + 1, close);
      if (!isReadOnlyQuery(sql, mask, at + 1, close)) return null;
      continue;
    }
    const name = new RegExp(`(?:${QUALIFIED_NAME.source}|${ANY_IDENT.source})`, 'iuy');
    name.lastIndex = at;
    const member = name.exec(sql)?.[0];
    if (reference !== null || !member || KEYWORDS_RE.test(member)) return null;
    // In a join list a function call is no table reference.
    if (members.length > 1 && /^\s*\(/u.test(sql.slice(name.lastIndex, to))) return null;
    reference = member;
  }
  return reference;
}

/** Set operators between query expressions. */
const SET_OPERATOR_RE = /\b(?:UNION|EXCEPT|INTERSECT)\b/iu;

/**
 * Whether the derived-table query `sql[from, to)` can never be written through: a SELECT with
 * DISTINCT, GROUP BY or a set operator at its own level (SQL Server errors 4403 and 4406). A TOP
 * query stays writable.
 */
function isReadOnlyQuery(sql: string, mask: Uint8Array, from: number, to: number): boolean {
  const flat = topLevelText(sql, mask, from, to);
  return /^\s*SELECT\b/iu.test(flat) && (SET_OPERATOR_RE.test(flat) || /\bSELECT\s+DISTINCT\b|\bGROUP\s+BY\b/iu.test(flat));
}

/** One `name [(columns)] AS (query)` entry of a WITH list; `from`/`to` bound the query text. */
interface CteDefinition { name: string; from: number; to: number }

/**
 * Reads the CTE list of the `WITH` at `withAt`, returning its definitions and the index just past
 * the list, or `null` when the text there is not a CTE list.
 */
function readCteList(sql: string, mask: Uint8Array, withAt: number): { definitions: CteDefinition[]; end: number } | null {
  let at = skip(sql, 'WITH\\s*', withAt);
  const namespaces = skip(sql, 'XMLNAMESPACES\\s*(?=\\()', at);
  if (namespaces >= 0) {
    const close = closingParen(sql, mask, namespaces);
    if (close < 0) return null;
    at = skip(sql, '\\s*,\\s*', close + 1);
    if (at < 0) return null;
  }
  const definitions: CteDefinition[] = [];
  for (;;) {
    const nameRe = new RegExp(`(${ANY_IDENT.source})\\s*`, 'iuy');
    nameRe.lastIndex = at;
    const name = nameRe.exec(sql)?.[1];
    if (!name || KEYWORDS_RE.test(name)) return null;
    at = nameRe.lastIndex;
    if (sql[at] === '(') {
      const close = closingParen(sql, mask, at);
      if (close < 0) return null;
      at = skip(sql, '\\s*', close + 1);
    }
    at = skip(sql, 'AS\\s*(?=\\()', at);
    if (at < 0) return null;
    const close = closingParen(sql, mask, at);
    if (close < 0) return null;
    definitions.push({ name, from: at + 1, to: close });
    const next = skip(sql, '\\s*,\\s*', close + 1);
    if (next < 0) return { definitions, end: close + 1 };
    at = next;
  }
}

/**
 * Scans one statement from its leading keyword to the first top-level `;` or statement keyword.
 *
 * @param start - Index of the leading keyword.
 * @param keywordLength - Length of that keyword, which is not itself a boundary.
 * @returns The end index, the spans outside any parentheses, and whether every opened parenthesis
 *   is closed.
 */
function scanStatement(sql: string, codeMask: Uint8Array, start: number, keywordLength: number): { end: number; depth0Spans: Array<[number, number]>; closed: boolean } {
  let end = start + keywordLength;
  let depth = 0;
  const nextStatement = /(?<![\p{L}\p{Nd}_@$#.])(?:UPDATE|INSERT|DELETE|MERGE|SELECT|EXEC(?:UTE)?|TRUNCATE|CREATE|ALTER|DROP|DECLARE)(?![\p{L}\p{Nd}_@$#])/iyu;
  const depth0Spans: Array<[number, number]> = [];
  let spanStart = start;
  while (end < sql.length) {
    if (codeMask[end] !== SQL_CODE) { end++; continue; }
    const character = sql[end];
    if (character === '(') {
      if (depth === 0) depth0Spans.push([spanStart, end]);
      depth++;
    } else if (character === ')') {
      if (depth > 0) {
        depth--;
        if (depth === 0) spanStart = end + 1;
      }
    } else if (depth === 0) {
      if (character === ';') break;
      nextStatement.lastIndex = end;
      if (nextStatement.test(sql)) break;
    }
    end++;
  }
  if (depth === 0) depth0Spans.push([spanStart, end]);
  return { end, depth0Spans, closed: depth === 0 };
}

/**
 * Preprocessing pass that rewrites a CTE named by the UPDATE statement its WITH list introduces to
 * that CTE's single base table. A CTE is visible only to the statement directly after its WITH
 * list, so the rewrite is confined to that UPDATE: the name after `UPDATE`, `FROM` or `JOIN`, with
 * or without hint or alias. It resolves only when {@link singleQueryTable} finds one table in the
 * CTE's query (followed through earlier CTEs of the same list); joins, set operators and other
 * shapes stay unresolved, and the same name in another statement is never rewritten.
 *
 * @param sql - Cleaned SQL text.
 */
function substituteCteUpdateAliases(sql: string, identifierCaseSensitive: boolean): string {
  const aliasKey = (alias: string): string => normalizeColName(alias, identifierCaseSensitive);
  const isQualified = (reference: string): boolean => splitSqlName(reference).length > 1;
  const mask = sqlCommentMask(sql, { markLiterals: true });
  const edits: TextEdit[] = [];

  for (const withMatch of sql.matchAll(/\bWITH\b/giu)) {
    if (mask[withMatch.index!] !== SQL_CODE) continue;
    const list = readCteList(sql, mask, withMatch.index!);
    if (!list) continue;
    const statement = /\s*(UPDATE)\b/iuy;
    statement.lastIndex = list.end;
    const update = statement.exec(sql);
    if (!update) continue;
    const updateAt = statement.lastIndex - update[1].length;

    const bases = new Map<string, string | null>();
    for (const definition of list.definitions) {
      bases.set(aliasKey(definition.name), singleQueryTable(sql, mask, definition.from, definition.to));
    }
    const resolve = (name: string): string | null => {
      const seen = new Set<string>();
      let reference: string | null | undefined = name;
      while (reference && !isQualified(reference)) {
        const key = aliasKey(reference);
        if (seen.has(key)) return null;
        seen.add(key);
        reference = bases.get(key);
      }
      return reference ?? null;
    };

    const { end } = scanStatement(sql, mask, updateAt, update[1].length);
    const span = sql.slice(updateAt, end);
    for (const use of span.matchAll(new RegExp(`\\b(?:UPDATE|FROM|JOIN)(?:\\s+|\\s*(?=\\[))(${ANY_IDENT.source})(?![\\w.]|\\s*\\.)`, 'giu'))) {
      const baseTable = mask[updateAt + use.index!] === SQL_CODE ? resolve(use[1]) : null;
      if (!baseTable) continue;
      const at = updateAt + use.index! + use[0].length - use[1].length;
      edits.push({ from: at, to: at + use[1].length, text: baseTable });
    }
  }

  return applyEdits(sql, edits);
}

/** A dotted table name, each part regular or delimited; sticky, so a caller sets `lastIndex`. */
const TABLE_NAME_RE = /(?:\[(?:[^\]]|\]\])*\]|[\p{L}\p{Nd}_@$#]+)(?:\.(?:\[(?:[^\]]|\]\])*\]|[\p{L}\p{Nd}_@$#]*))*/uy;
/**
 * One token of the comma-list scan: a word, a delimited identifier or any other character; global,
 * skips blanks.
 */
const LIST_TOKEN_RE = /[\p{L}\p{Nd}_@$#]+|\[(?:[^\]]|\]\])*\]|\S/gu;
/** A token that can be an alias: a word or delimited identifier, never a number or an operator. */
const ALIAS_START_RE = /^[\p{L}_@#[]/u;

/**
 * Where the table list of one `FROM` stands: a member is due (`source`), its name is read
 * (`name`), `AS` awaits its alias (`as`), or its alias is read (`alias`).
 */
type ListState = 'source' | 'name' | 'as' | 'alias';

/**
 * Normalizes ANSI comma-join FROM clauses to JOIN syntax (`FROM t1, t2 WHERE` to `FROM t1 JOIN t2
 * WHERE`), whatever each member is (aliased or hinted table, function call, derived table). One
 * left-to-right pass keeps a list state per parenthesis depth. A member is a name, an optional `AS
 * alias` or bare alias, and parenthesised tails (arguments, `WITH (` hint, column list; `PIVOT
 * (`/`UNPIVOT (` too). The list ends at the first token continuing no member: a reserved word other
 * than `AS` or `WITH (`, a word after the alias, any operator, `;` or the closing parenthesis. The
 * member-position word is a name, so `output.T` and `window` stay tables, and a non-reserved clause
 * word after the alias (`OUTPUT`, `WINDOW`) ends the list. A comma after a `JOIN ... ON` condition
 * or an `APPLY` is not rewritten.
 *
 * @param sql - Cleaned SQL text.
 */
function normalizeAnsiCommaJoins(sql: string): string {
  const lists: Array<ListState | undefined> = [];
  const commas: TextEdit[] = [];
  let depth = 0;
  for (let at = 0; at < sql.length;) {
    LIST_TOKEN_RE.lastIndex = at;
    const token = LIST_TOKEN_RE.exec(sql);
    if (!token) break;
    const text = token[0];
    at = token.index + text.length;
    const state = lists[depth];
    if (/^from$/i.test(text) && sql[token.index - 1] !== '.') {
      lists[depth] = 'source';
    } else if (text === '(') {
      if (state === 'source') lists[depth] = 'name';
      lists[++depth] = undefined;
    } else if (text === ')') {
      lists[depth] = undefined;
      depth = Math.max(0, depth - 1);
    } else if (state === 'source') {
      if (text === ',') continue;
      TABLE_NAME_RE.lastIndex = token.index;
      const name = TABLE_NAME_RE.exec(sql);
      if (name) at = name.index + name[0].length;
      lists[depth] = 'name';
    } else if (state === undefined) {
      continue;
    } else if (text === ',') {
      commas.push({ from: token.index, to: at, text: ' JOIN ' });
      lists[depth] = 'source';
    } else if (/^with$/i.test(text) && /^\s*\(/.test(sql.slice(at, at + 16))) {
      continue;
    } else if ((state === 'name' || state === 'alias') && /^(?:un)?pivot$/i.test(text) && /^\s*\(/.test(sql.slice(at, at + 16))) {
      lists[depth] = 'name';
    } else if (state === 'name' && /^as$/i.test(text)) {
      lists[depth] = 'as';
    } else if (ALIAS_START_RE.test(text) && (state === 'as' || (state === 'name' && !KEYWORDS_RE.test(text)))) {
      lists[depth] = 'alias';
    } else {
      lists[depth] = undefined;
    }
  }
  return applyEdits(sql, commas);
}

/**
 * Masks every block comment, nested ones included, with spaces (line breaks kept), so a comment
 * between two tokens still separates them. Line comments and literals stay in place.
 *
 * @param sql - Raw SQL text.
 * @returns SQL of the same length with every block comment blanked.
 */
function maskBlockComments(sql: string): string {
  const mask = sqlCommentMask(sql);
  return sql.replace(/[^\r\n]/g, (ch, i: number) => (mask[i] === SQL_BLOCK_COMMENT ? ' ' : ch));
}

/**
 * Distance from a masked character to its original: masks lie in Supplementary Private Use Area-A.
 */
const MASK_OFFSET = 0xF0000;
/**
 * Characters of a delimited identifier that no rule may read as SQL: every BMP character that
 * cannot be part of a regular identifier, except `]` whose doubling is the escape.
 */
const MASKABLE_RE = /[^\p{L}\p{Nd}_@$#\]\u{10000}-\u{10FFFF}]/gu;
const MASKED_RE = /[\u{F0000}-\u{FFFFF}]/gu;

/**
 * Hides the content of a delimited identifier from the extraction rules: whitespace, periods,
 * parentheses and any other character that cannot belong to a regular identifier move one-to-one
 * into a private-use range, so `[x FROM dbo.X ok]` holds no keyword, name or call, and a
 * case-insensitive comparison of two masked names is unchanged. {@link unmaskIdentifier} restores
 * them when a captured name is read.
 *
 * @param delimited - A `[bracket]` identifier, delimiters included.
 */
function maskDelimitedContent(delimited: string): string {
  return `[${maskText(delimited.slice(1, -1))}]`;
}

/**
 * Hides every structural character of `text`; an unterminated `[` names nothing, so the rest is not
 * code.
 */
function maskText(text: string): string {
  return text.replace(MASKABLE_RE, c => String.fromCodePoint(c.codePointAt(0)! + MASK_OFFSET));
}

/** Restores the characters {@link maskDelimitedContent} hid. */
function unmaskIdentifier(text: string): string {
  return text.replace(MASKED_RE, c => String.fromCodePoint(c.codePointAt(0)! - MASK_OFFSET));
}

/**
 * Parses a raw T-SQL string to extract dependencies using the active ruleset. Passes, in order: 0
 * nested-aware block comment masking; 1 neutralization of string literals and line comments
 * (leftmost match; delimited identifier content masked); 1.4 whitespace around the period of a
 * multipart name removed (`dbo . T` to `dbo.T`); 1.45 `IS DISTINCT FROM` / `TRIM(... FROM ...)`
 * `FROM` becomes a comma; 1.47 `TOP (expression) [PERCENT]` leaves INSERT/UPDATE/MERGE; 1.48
 * CTAS/CETAS column list and WITH options removed; 1.5 ANSI-92 comma-join normalization; 1.6 CTE
 * alias substitution for UPDATE targets; then rule-based extraction on the cleaned SQL.
 *
 * @param sql - The raw SQL statement or script body.
 * @param onRuleFire - Optional `(ruleName, category, addedCount)` callback for each extraction rule
 *   that added at least one new ref (sample-mode diagnostics).
 * @param identifierCaseSensitive - Checked source catalog policy; absent retains CI normalization.
 */
export function parseSqlBody(
  sql: string,
  onRuleFire?: (ruleName: string, category: string, added: number) => void,
  identifierCaseSensitive = false,
): ParsedDependencies {
  let clean = maskBlockComments(sql);

  clean = clean.replace(PASS1_CLEANSE_RE, (match) => {
    if (match.startsWith('[')) return match.endsWith(']') ? maskDelimitedContent(match) : maskText(match);   // preserve [bracket identifiers]
    if (match.startsWith('"')) return maskDelimitedContent(quoteIdentifier(stripBrackets(match)));
    if (match.startsWith("'")) return "''";                         // neutralize 'string literals'
    return ' ';                                                       // remove -- line comments
  });

  clean = clean.replace(NAME_PERIOD_SPACING_RE, (_match, bracketed: string | undefined) => bracketed ?? '.');
  const unsupported = PARTIAL_SUPPORT.filter(([, pattern]) => pattern.test(clean)).map(([label]) => label);

  clean = neutraliseOperandFrom(clean);

  clean = liftDmlTop(clean);

  clean = dropCtasOptions(clean);

  clean = normalizeAnsiCommaJoins(clean);

  clean = substituteCteUpdateAliases(clean, identifierCaseSensitive);

  for (const rule of activeRules) {
    if (rule.category === 'preprocessing' && rule.name !== 'clean_sql' && rule.replacement !== undefined) {
      clean = clean.replace(new RegExp(rule.pattern, rule.flags), rule.replacement);
    }
  }

  const sources = new Set<string>();
  const targets = new Set<string>();
  const execCalls = new Set<string>();
  const crossDbSources = new Set<string>();
  const crossDbTargets = new Set<string>();

  const udfSources = new Set<string>();
  const crossDbUdfSources = new Set<string>();
  let aliasScan: AliasScan | undefined;

  for (const rule of activeRules) {
    if (rule.category === 'preprocessing') continue;

    const regex = new RegExp(rule.pattern, rule.flags);

    const dest =
      rule.name === 'extract_udf_calls' ? udfSources :
      rule.category === 'source' ? sources :
      rule.category === 'target' ? targets :
      execCalls;

    const before = dest.size;
    const capture = (raw: string, match: RegExpExecArray): string | null => rule.name === 'extract_update_alias_target'
      ? resolveUpdateAliasTarget(clean, aliasScan ??= { mask: sqlCommentMask(clean, { markLiterals: true }), unclosedFrom: Infinity }, match, identifierCaseSensitive) : raw;
    collectMatchesWith(clean, regex, dest, (raw, match) => {
      const reference = capture(raw, match);
      return reference === null ? null : normalizeCaptured(reference, identifierCaseSensitive);
    });
    const added = dest.size - before;

    const crossDbDest = rule.name === 'extract_udf_calls' ? crossDbUdfSources
      : rule.category === 'source' ? crossDbSources
      : rule.category === 'target' ? crossDbTargets
      : null;
    if (crossDbDest) collectMatchesWith(clean, new RegExp(rule.pattern, rule.flags), crossDbDest, (raw, match) => {
      const reference = capture(raw, match);
      return reference === null ? null : normalizeCrossDb(reference, identifierCaseSensitive);
    });

    if (onRuleFire && added > 0) onRuleFire(rule.name, rule.category, added);
  }

  for (const u of udfSources) {
    if (!targets.has(u)) sources.add(u);
  }
  for (const u of crossDbUdfSources) {
    if (!crossDbTargets.has(u)) crossDbSources.add(u);
  }

  return {
    sources: Array.from(sources),
    targets: Array.from(targets),
    execCalls: Array.from(execCalls),
    crossDbSources: Array.from(crossDbSources),
    crossDbTargets: Array.from(crossDbTargets),
    unsupported,
  };
}

/** Collects all matches of a regex into `out`, each passed through `normalize`. */
function collectMatchesWith(
  sql: string,
  regex: RegExp,
  out: Set<string>,
  normalize: (raw: string, match: RegExpExecArray) => string | null,
): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  const unicode = regex.unicode || regex.flags.includes('v');

  while ((match = regex.exec(sql)) !== null) {
    if (match[0].length === 0) {
      const next = sql.codePointAt(regex.lastIndex);
      regex.lastIndex += unicode && next !== undefined ? String.fromCodePoint(next).length : 1;
      continue;
    }
    const raw = match[1];
    if (!raw) continue;
    const normalized = normalize(raw, match);
    if (normalized !== null) out.add(normalized);
  }
}

/**
 * Code mask of the cleaned text, and the index of the first UPDATE that leaves a parenthesis open:
 * every later UPDATE lies inside that parenthesis and is no statement of its own.
 */
interface AliasScan { mask: Uint8Array; unclosedFrom: number }

/** Marks an UPDATE alias bound to a derived table that names no single table. */
const UNRESOLVED_BINDING = '\0';

/**
 * Resolves an UPDATE's alias against the FROM/JOIN bindings in its own statement: a table
 * reference, or a derived table whose query names one table ({@link singleQueryTable}). Any
 * other count of bindings leaves the alias unresolved.
 */
function resolveUpdateAliasTarget(sql: string, scan: AliasScan, match: RegExpExecArray, identifierCaseSensitive: boolean): string | null {
  if (match.index > scan.unclosedFrom) return null;
  const codeMask = scan.mask;
  // Read from the matched text, not a capture group: a custom rule file may capture something else.
  const alias = match[0].match(new RegExp(`^UPDATE(?:\\s+|\\s*(?=\\[))(${ANY_IDENT.source})(?:\\s+|(?<=\\])\\s*)SET\\b`, 'iu'))?.[1];
  if (!alias) return null;
  const aliasKey = normalizeColName(alias, identifierCaseSensitive);
  const { depth0Spans, closed } = scanStatement(sql, codeMask, match.index, 'UPDATE'.length);
  if (!closed) scan.unclosedFrom = match.index;
  const bindings = new RegExp(`\\b(?:FROM|JOIN)(?:\\s+|\\s*(?=\\[))(${QUALIFIED_NAME.source})(?:(?:\\s+(?:AS\\s+)?|(?<=\\])\\s*(?=\\[))(${ANY_IDENT.source}))?`, 'giu');
  const targets = new Set<string>();
  for (const [from, to] of depth0Spans) {
    if (from >= to) continue;
    collectMatchesWith(sql.slice(from, to), bindings, targets, (reference, binding) => {
      const hasAlias = binding[2] && !KEYWORDS_RE.test(binding[2]);
      if (binding[2] && !hasAlias) bindings.lastIndex -= binding[2].length;
      const tableAlias = hasAlias
        ? binding[2] : splitSqlName(binding[1]).at(-1)!;
      return normalizeColName(tableAlias, identifierCaseSensitive) === aliasKey ? reference : null;
    });
    if (sql[to] !== '(' || !/\b(?:FROM|JOIN)\s*$/iu.test(sql.slice(from, to))) continue;
    const close = closingParen(sql, codeMask, to);
    const derivedAlias = new RegExp(`\\s*(?:AS\\s+)?(${ANY_IDENT.source})`, 'iuy');
    derivedAlias.lastIndex = close + 1;
    const name = close < 0 ? undefined : derivedAlias.exec(sql)?.[1];
    if (!name || KEYWORDS_RE.test(name)) continue;
    if (normalizeColName(name, identifierCaseSensitive) !== aliasKey) continue;
    targets.add(singleQueryTable(sql, codeMask, to + 1, close) ?? UNRESOLVED_BINDING);
  }
  const [target, ...others] = targets;
  return target !== undefined && others.length === 0 && target !== UNRESOLVED_BINDING ? target : null;
}

/**
 * Whether the object part of a name is a temp table (`dbo.#t`, `tempdb.dbo.##g`), never a lineage
 * node.
 */
function isTempObject(parts: string[]): boolean {
  return parts.at(-1)?.startsWith('#') ?? false;
}

/**
 * Normalizes a raw regex capture to `[schema].[object]` for catalog lookup: brackets and quotes
 * removed, parts split, local variables and temporary tables excluded. `null` if invalid.
 */
function normalizeCaptured(raw: string, identifierCaseSensitive: boolean): string | null {
  const parts = splitSqlName(raw).map(p => unmaskIdentifier(stripBrackets(p)));
  const first = parts[0] ?? '';
  if (first.startsWith('@') || first.startsWith('#') || isTempObject(parts)) return null;
  if (parts.length < 2) return null;
  if (parts.length >= 3) return null;
  const schema = parts[0];
  const obj = parts[1];
  if (!schema || !obj) return null;
  return schemaKey(`${quoteIdentifier(schema)}.${quoteIdentifier(obj)}`, identifierCaseSensitive);
}

/** Normalizes a 3+ part name to `db.schema.object`, dropping CLR/XML calls; `null` if invalid. */
function normalizeCrossDb(raw: string, identifierCaseSensitive: boolean): string | null {
  const parts = splitSqlName(raw).map(p => unmaskIdentifier(stripBrackets(p)));
  const first = parts[0] ?? '';
  if (first.startsWith('@') || first.startsWith('#') || isTempObject(parts)) return null;
  if (parts.length < 3) return null;
  const pertinent = parts.length >= 4 ? parts.slice(-3) : parts;
  const object = pertinent[pertinent.length - 1];
  if (CLR_TYPE_METHODS.has(object.toLowerCase())) return null;
  return pertinent.map(p => {
    const name = schemaKey(p, identifierCaseSensitive);
    return /[.\[\]"]/.test(name) ? quoteIdentifier(name) : name;
  }).join('.');
}

/**
 * Extracts external file or URL references from raw SQL. Runs before the cleansing pipeline
 * neutralizes string literals, since references (like BULK INSERT paths) sit inside single quotes.
 * Scans through {@link collectMatchesWith} so every rule shares forward progress over zero-length
 * matches; the capture is verbatim because a path or URL is the reference, with no catalog
 * identifier to normalize.
 *
 * @param rawSql - Raw SQL before any preprocessing.
 */
export function extractExternalRefs(rawSql: string): ExternalRef[] {
  const seen = new Set<string>();
  const results: ExternalRef[] = [];
  const extRules = activeRules.filter(r => r.category === 'external_ref');

  for (const rule of extRules) {
    const urls = new Set<string>();
    collectMatchesWith(rawSql, new RegExp(rule.pattern, rule.flags), urls, raw => raw);
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      results.push({ url, kind: rule.kind! });
    }
  }

  return results;
}
