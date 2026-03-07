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
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
