/**
 * Internal configuration flag for case-sensitivity mode across the engine.
 *
 * - 'CI': Case-Insensitive (SQL Server default). Schema keys are lowercased for comparison.
 * - 'CS': Case-Sensitive. Exact casing is used for all object and schema identification.
 *
 * This is an internal normalization policy, not a user-facing setting.
 */
const CASE_MODE: 'CI' | 'CS' = 'CI';

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
 * Canonical comparison form for a SQL **column** name: strip delimiters (reusing {@link stripBrackets})
 * then case-fold, so a model-emitted `[ListPrice]` / `ListPrice` matches a DDL `ListPrice`. The single
 * normalizer for column-name equality across the column-trace path.
 *
 * @remarks
 * Use this — not `normalizeName` — for a bare column: `normalizeName` is node-shaped (`[schema].[object]`)
 * and would treat a dotted column as a qualified object.
 *
 * @param name - A column identifier, possibly bracketed/quoted or mixed-case.
 * @returns The delimiter-free, lower-cased form for equality checks.
 */
export function normalizeColName(name: string): string {
  return stripBrackets(name).trim().toLowerCase();
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

/** Storage options whose presence marks a `WITH (...)` block as physical rather than semantic. */
const PHYSICAL_WITH_OPTION = /\b(PAD_INDEX|FILLFACTOR|STATISTICS_NORECOMPUTE|IGNORE_DUP_KEY|ALLOW_ROW_LOCKS|ALLOW_PAGE_LOCKS|OPTIMIZE_FOR_SEQUENTIAL_KEY)\b/i;

/**
 * Removes `WITH (...)` blocks that carry physical storage options, matching parentheses by depth so
 * a nested option such as `DATA_COMPRESSION = PAGE ON PARTITIONS (1 TO 3)` never leaves a dangling
 * `)` behind. Blocks without a storage option (`WITH (EXECUTE AS ...)`, CTEs) are kept.
 *
 * @param sql - The DDL text to strip.
 * @returns The text with every matched block removed; an unbalanced block is left untouched.
 */
function stripPhysicalWithOptions(sql: string): string {
  const opener = /\bWITH\s*\(/gi;
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(sql)) !== null) {
    if (match.index < cursor) continue;
    let depth = 1;
    let end = opener.lastIndex;
    while (end < sql.length && depth > 0) {
      const ch = sql[end];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      end++;
    }
    if (depth !== 0) break;
    if (PHYSICAL_WITH_OPTION.test(sql.slice(match.index, end))) {
      result += sql.slice(cursor, match.index);
      cursor = end;
    }
    opener.lastIndex = end;
  }
  return result + sql.slice(cursor);
}

/**
 * Aggressively minifies a raw DDL script specifically for hop-by-hop LLM exploration.
 *
 * @param raw - The raw DDL script content.
 * @param preserveTechContext - If true, physical-storage tokens (CLUSTERED, COLLATE, WITH(...), ON PRIMARY) are retained.
 * @returns The minified DDL string.
 */
export function minifyDdlForHop(raw: string, preserveTechContext: boolean): string {
  let clean = raw;

  // 1. SSMS Headers
  clean = clean.replace(/\/\*\*\*\*\*\*[\s\S]*?\*\*\*\*\*\*\//g, '');
  // 2. Boilerplate Context
  // The database name class must exclude line breaks: `\s`/`[\w\s]` match `\n`, so a greedy
  // unbracketed `USE db` swallows every following word-only line up to the last reachable `$`,
  // silently deleting the `CREATE ...` header from the body handed to the model.
  clean = clean.replace(/^[\t ]*USE[\t ]+\[?[^\r\n\]]+\]?[\t ]*;?[\t ]*$/gmi, '');
  // 3. SET statements
  clean = clean.replace(/^[\t ]*SET\s+\w+\s+(ON|OFF)\s*;?[\t ]*$/gmi, '');
  // 4. GO batches
  clean = clean.replace(/^[\t ]*GO[\t ]*$/gmi, '');
  // 5. PRINT output statements
  clean = clean.replace(/^[\t ]*PRINT\s+N?'.*'[\t ]*;?[\t ]*$/gmi, '');
  // 6. Safely strip square brackets (only single words)
  clean = clean.replace(/\[([a-zA-Z_@][a-zA-Z0-9_@]*)\]/g, '$1');
  // CATCH blocks are NOT stripped — they carry real lineage (ErrorLog INSERTs) and business fallbacks.

  if (!preserveTechContext) {
    // Strip physical storage tokens
    clean = clean.replace(/\b(CLUSTERED|NONCLUSTERED)\b/gi, '');
    clean = clean.replace(/\bCOLLATE\s+[\w_]+\b/gi, '');
    clean = stripPhysicalWithOptions(clean);
    clean = clean.replace(/\bON\s*PRIMARY\b/gi, '');
    // ASC/DESC are NOT stripped — removing them silently corrupts ORDER BY / OVER() semantics the analyzer reads.
  }

  return clean
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => line.trimEnd().replace(/\t/g, '  '))
    .join('\n');
}
