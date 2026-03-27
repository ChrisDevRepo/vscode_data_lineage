// ─── Case Sensitivity Mode ───────────────────────────────────────────────────

/** Internal flag for case-sensitivity mode.
 *  'CI' = case-insensitive (SQL Server default — current mode).
 *  'CS' = case-sensitive (future: requires full regression on CS-collation databases).
 *  NOT user-facing. This is the single toggle point for a future CS release. */
export const CASE_MODE: 'CI' | 'CS' = 'CI';

/** Comparison key for schema names.
 *  CI: lowercase so 'dbo' === 'DBO' (SQL Server default behavior).
 *  CS: unchanged — displayName and key are the same; exact casing is authoritative. */
export function schemaKey(name: string): string {
  return CASE_MODE === 'CI' ? name.toLowerCase() : name;
}

// ─── SQL Name Utilities ──────────────────────────────────────────────────────

/** Remove SQL bracket and double-quote delimiters from a name: [dbo].[Table] → dbo.Table */
export function stripBrackets(name: string): string {
  return name.replace(/[\[\]"]/g, '');
}

/**
 * Split a SQL name on dots that are OUTSIDE bracket-quoted identifiers.
 * Dots inside brackets (e.g., [obj.name.with.dots]) are part of the identifier, not separators.
 * Double-quoted identifiers are treated the same as brackets.
 *
 * Examples:
 *   [schema].[obj]                → ['[schema]', '[obj]']
 *   [schema].[obj.with.dot]       → ['[schema]', '[obj.with.dot]']     ← dot inside name
 *   schema.obj                    → ['schema', 'obj']
 *   db.schema.obj                 → ['db', 'schema', 'obj']
 *   "schema"."obj"                → ['"schema"', '"obj"']
 */
export function splitSqlName(name: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inBracket = false;
  let inQuote = false;
  for (const ch of name) {
    if (ch === '[' && !inQuote) { inBracket = true; current += ch; }
    else if (ch === ']' && inBracket) { inBracket = false; current += ch; }
    else if (ch === '"' && !inBracket) { inQuote = !inQuote; current += ch; }
    else if (ch === '.' && !inBracket && !inQuote) {
      if (current) { parts.push(current); current = ''; }
    }
    else { current += ch; }
  }
  if (current) parts.push(current);
  return parts;
}

/** Escape a string for safe HTML interpolation. */
export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Schema Placeholder Expansion ───────────────────────────────────────────

const SCHEMA_PLACEHOLDER = '{{SCHEMAS}}';

/**
 * Expand `{{SCHEMAS}}` placeholders in a YAML-defined SQL query.
 * Replaces every occurrence with a SQL-safe quoted list: `'dbo', 'Sales'`.
 * If the query has no placeholder, returns it unchanged.
 */
export function expandSchemaPlaceholder(sql: string, schemas: string[]): string {
  if (!sql.includes(SCHEMA_PLACEHOLDER)) return sql;
  const list = schemas.map(s => `'${s.replace(/'/g, "''")}'`).join(', ');
  return sql.replace(/\{\{SCHEMAS\}\}/g, list);
}

/** Warn if a Phase 2 query is missing the `{{SCHEMAS}}` placeholder. */
export function validateSchemaPlaceholder(name: string, sql: string, phase: number): string | undefined {
  if (phase === 2 && !sql.includes(SCHEMA_PLACEHOLDER)) {
    return `Phase 2 query '${name}' is missing ${SCHEMA_PLACEHOLDER} placeholder — results will be unfiltered`;
  }
  return undefined;
}

// ─── Exclusion Pattern Compilation ──────────────────────────────────────────

/**
 * Compile an exclusion pattern to a case-insensitive RegExp.
 * Supports % wildcard syntax alongside standard regex:
 *   %tmp%   → .*tmp.*  (matches any name containing "tmp")
 *   dbo.%   → dbo..*  (matches any object in the dbo schema)
 * % characters are converted to .* before regex compilation.
 * All other characters are treated as literal regex syntax.
 */
export function compileExclusionPattern(pattern: string): RegExp {
  return new RegExp(pattern.replace(/%/g, '.*'), 'i');
}

/**
 * Compile a pure SQL LIKE pattern to a case-insensitive RegExp.
 * Only % and _ have special meaning; all other characters are treated as literals.
 *   test%      → anchored prefix match: "test", "test_data", "testing"
 *   %test%     → substring match: any name containing "test"
 *   test       → exact match (no wildcards)
 *   _test      → single-char prefix + "test"
 * Use for AI tool parameters (exclude_schemas etc.) where predictable behavior is required.
 */
export function compileSqlLikePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${regexStr}$`, 'i');
}

/**
 * Compile an array of SQL LIKE patterns. Returns null when the array is empty or undefined.
 * Use matchesAnySqlLike() to test a value against the compiled matchers.
 */
export function compileSqlLikePatterns(patterns: string[] | undefined): RegExp[] | null {
  if (!patterns || patterns.length === 0) return null;
  return patterns.map(p => compileSqlLikePattern(p));
}

/**
 * Test a value against an array of compiled SQL LIKE matchers.
 * Returns true if any matcher matches.
 */
export function matchesAnySqlLike(value: string, matchers: RegExp[]): boolean {
  return matchers.some(r => r.test(value));
}

/** Escape a literal string so it is safe to embed in a RegExp. */
export function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize a DDL body script for display: strips blank lines, trims trailing whitespace,
 * and converts tabs to 2-space indentation.
 */
export function normalizeBodyScript(raw: string): string {
  return raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => line.trimEnd().replace(/\t/g, '  '))
    .join('\n');
}
