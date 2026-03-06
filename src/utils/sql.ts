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
