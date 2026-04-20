/** 
 * Internal configuration flag for case-sensitivity mode across the engine.
 * 
 * - 'CI': Case-Insensitive (SQL Server default). Schema keys are lowercased for comparison.
 * - 'CS': Case-Sensitive. Exact casing is used for all object and schema identification.
 * 
 * @internal This is not a user-facing setting. It serves as the single source of truth 
 * for future case-sensitivity support.
 */
export const CASE_MODE: 'CI' | 'CS' = 'CI';

/** 
 * Computes a canonical comparison key for a SQL schema or object name.
 * 
 * When `CASE_MODE` is 'CI', the name is lowercased to ensure that 'dbo', 'DBO', 
 * and '[dbo]' (after bracket stripping) are treated as identical.
 * 
 * @param name - The raw SQL identifier name.
 * @returns The normalized key for use in Maps and sets.
 */
export function schemaKey(name: string): string {
  return CASE_MODE === 'CI' ? name.toLowerCase() : name;
}


/** 
 * Removes SQL-standard delimiters (brackets `[]` and double-quotes `""`) from an identifier.
 * 
 * Example: `[dbo].[Table]` becomes `dbo.Table`.
 * 
 * @param name - The delimited SQL identifier.
 * @returns The raw, unquoted identifier name.
 */
export function stripBrackets(name: string): string {
  return name.replace(/[\[\]"]/g, '');
}

/**
 * Splits a qualified SQL name into its constituent parts (Database, Schema, Object).
 * 
 * This function correctly handles dots contained within bracketed `[]` or 
 * double-quoted `""` identifiers, ensuring they are not treated as part separators.
 *
 * @example
 * ```typescript
 * splitSqlName("[schema].[obj.with.dot]") // returns ["[schema]", "[obj.with.dot]"]
 * splitSqlName("db.schema.obj")           // returns ["db", "schema", "obj"]
 * ```
 * 
 * @param name - The fully qualified SQL name to split.
 * @returns An array of identifier parts.
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

/** 
 * Escapes special characters in a string for safe interpolation into HTML.
 * 
 * @param s - The raw string to escape.
 * @returns The HTML-safe escaped string.
 */
export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


const SCHEMA_PLACEHOLDER = '{{SCHEMAS}}';

/**
 * Expands a `{{SCHEMAS}}` placeholder within a SQL template with a comma-separated list
 * of single-quoted schema names.
 *
 * Example: `SELECT * FROM sys.tables WHERE schema_name IN ({{SCHEMAS}})`
 * becomes `SELECT * FROM sys.tables WHERE schema_name IN ('dbo', 'Sales')`.
 *
 * @remarks
 * Safe for string-literal (`IN (…)`, `= '…'`) contexts only. Embedded `'` characters are
 * SQL-escaped to `''`. The output is **not** safe to use as a SQL identifier — do not
 * interpolate into `[schema]`/`"schema"` positions. If an identifier context is ever
 * needed, add a dedicated helper that validates against `sys.schemas` or brackets with
 * `]`-escaping.
 *
 * @param sql - The SQL template string containing the placeholder.
 * @param schemas - The list of schema names to inject.
 * @returns The expanded SQL query.
 */
export function expandSchemaPlaceholder(sql: string, schemas: string[]): string {
  if (!sql.includes(SCHEMA_PLACEHOLDER)) return sql;
  const list = schemas.map(s => `'${s.replace(/'/g, "''")}'`).join(', ');
  return sql.replace(/\{\{SCHEMAS\}\}/g, list);
}

/** 
 * Validates that a SQL template contains the required schema placeholder for its execution phase.
 * 
 * @param name - The name of the query being validated.
 * @param sql - The SQL template content.
 * @param phase - The execution phase (Phase 2 requires the placeholder for filtering).
 * @returns A warning message if validation fails, otherwise `undefined`.
 */
export function validateSchemaPlaceholder(name: string, sql: string, phase: number): string | undefined {
  if (phase === 2 && !sql.includes(SCHEMA_PLACEHOLDER)) {
    return `Phase 2 query '${name}' is missing ${SCHEMA_PLACEHOLDER} placeholder — results will be unfiltered`;
  }
  return undefined;
}


/**
 * Compiles a simple exclusion pattern into a case-insensitive regular expression.
 * Supports the `%` wildcard character, which is converted to `.*`.
 * 
 * @example `%tmp%` matches any string containing "tmp".
 * 
 * @param pattern - The pattern string to compile.
 * @returns A compiled `RegExp` object.
 */
export function compileExclusionPattern(pattern: string): RegExp {
  return new RegExp(pattern.replace(/%/g, '.*'), 'i');
}

/**
 * Compiles a SQL-style `LIKE` pattern into a case-insensitive regular expression.
 * Only the `%` character acts as a wildcard (matching zero or more characters).
 * All other special regex characters are escaped to ensure literal matching.
 * 
 * @example `test%` matches "test", "testing", but not "mytest".
 * 
 * @param pattern - The SQL LIKE pattern string.
 * @returns A compiled `RegExp` object anchored to the start and end of the string.
 */
export function compileSqlLikePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/%/g, '.*');
  return new RegExp(`^${regexStr}$`, 'i');
}

/**
 * Compiles an array of SQL-style `LIKE` patterns into an array of regular expressions.
 * 
 * @param patterns - The list of patterns to compile.
 * @returns An array of `RegExp` objects, or `null` if the input is empty or undefined.
 */
export function compileSqlLikePatterns(patterns: string[] | undefined): RegExp[] | null {
  if (!patterns || patterns.length === 0) return null;
  return patterns.map(p => compileSqlLikePattern(p));
}

/**
 * Checks if a value matches any of the provided regular expression matchers.
 * 
 * @param value - The string value to test.
 * @param matchers - The array of compiled `RegExp` objects to test against.
 * @returns `true` if at least one matcher matches the value; otherwise `false`.
 */
export function matchesAnySqlLike(value: string, matchers: RegExp[]): boolean {
  return matchers.some(r => r.test(value));
}

/** 
 * Escapes a string so it can be safely used as a literal part of a regular expression.
 * 
 * @param s - The string to escape.
 * @returns The escaped string.
 */
export function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalizes a raw DDL script for display in the UI.
 * - Removes blank lines.
 * - Trims trailing whitespace.
 * - Converts tabs to two-space indentation.
 * 
 * @param raw - The raw DDL script content.
 * @returns The normalized, clean script string.
 */
export function normalizeBodyScript(raw: string): string {
  return raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => line.trimEnd().replace(/\t/g, '  '))
    .join('\n');
}
