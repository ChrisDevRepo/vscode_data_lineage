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

// ─── Schema Filter Wrapping ─────────────────────────────────────────────────

/** Column to filter on for each Phase 2 DMV query. */
export const SCHEMA_FILTER_COLUMNS: Record<string, string> = {
  nodes: 'schema_name',
  columns: 'schema_name',
  constraints: 'schema_name',
  dependencies: 'referencing_schema',
};

/**
 * Wrap a DMV query with a WHERE schema filter.
 * Strips trailing ORDER BY (SQL Server disallows ORDER BY in subqueries
 * without TOP/OFFSET), then wraps as `SELECT * FROM (inner) AS _sub WHERE ...`.
 *
 * CTE queries (`WITH ... AS`) are handled specially: the CTE prefix stays
 * outside and only the final SELECT is wrapped as a subquery.
 *
 * For the `dependencies` query the filter uses OR to match BOTH referencing_schema
 * AND referenced_schema so inbound cross-schema edges are captured.
 */
export function wrapWithSchemaFilter(
  sql: string,
  schemaColumn: string,
  schemas: string[],
): string {
  const stripped = sql.replace(/\s+ORDER\s+BY\s+[\s\S]*$/i, '');
  const schemaList = schemas.map(s => `'${s.replace(/'/g, "''")}'`).join(', ');

  // CTE queries (WITH ... AS) cannot be wrapped in a subquery.
  // Keep the CTE prefix and wrap only the final SELECT after the last CTE definition.
  // Find the boundary: last ")\n" that closes a CTE body, then the next SELECT after it.
  const hasCte = /^\s*;?\s*WITH\s+/i.test(stripped);
  let finalSelectIdx = -1;
  if (hasCte) {
    // Find last closing paren followed by newline (end of last CTE definition)
    const lastCteParen = stripped.lastIndexOf(')\n');
    if (lastCteParen >= 0) {
      finalSelectIdx = stripped.indexOf('SELECT', lastCteParen);
    }
  }

  const prefix = finalSelectIdx >= 0 ? stripped.slice(0, finalSelectIdx) : '';
  const inner = finalSelectIdx >= 0 ? stripped.slice(finalSelectIdx) : stripped;

  if (schemaColumn === 'referencing_schema') {
    return (
      `${prefix}SELECT * FROM (\n${inner}\n) AS _sub\n` +
      `WHERE _sub.referencing_schema IN (${schemaList})\n` +
      `   OR _sub.referenced_schema  IN (${schemaList})`
    );
  }

  return `${prefix}SELECT * FROM (\n${inner}\n) AS _sub\nWHERE _sub.${schemaColumn} IN (${schemaList})`;
}
