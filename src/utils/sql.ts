/** Returns a schema comparison key; exact casing requires checked source identifier metadata. */
export function schemaKey(name: string, identifierCaseSensitive = false): string {
  return identifierCaseSensitive ? name : name.toLowerCase();
}


/** Matches one delimited identifier — `[bracketed]` (with `]]` as an escaped `]`) or `"quoted"` — or a single stray delimiter left over from an unbalanced name. */
const DELIMITED_PART = /\[(?:[^\]]|\]\])*\]|"(?:""|[^"])*"|[\[\]"]/g;

/** Removes SQL-standard delimiters (brackets `[]` and double-quotes `""`) from an identifier and unescapes only the matching delimiter: `]]` inside brackets, `""` inside double quotes. */
export function stripBrackets(name: string): string {
  return name.replace(DELIMITED_PART, part =>
    part.length > 1 ? part.slice(1, -1).replace(part.startsWith('[') ? /\]\]/g : /""/g, part.startsWith('[') ? ']' : '"') : ''
  );
}

/** Bracket-quotes one identifier part for T-SQL, doubling every `]` so the name round-trips through {@link stripBrackets}. The inverse of the unescaping done there. */
export function quoteIdentifier(name: string): string {
  return `[${name.replace(/\]/g, ']]')}]`;
}

/** Canonical comparison form for a SQL **column** name: strip delimiters (reusing {@link stripBrackets}) then case-fold, so a model-emitted `[ListPrice]` / `ListPrice` matches a DDL `ListPrice`. The single normalizer for column-name equality across the column-trace path. */
export function normalizeColName(name: string, identifierCaseSensitive = false): string {
  const input = name.trim();
  const normalized = /^(?:\[(?:[^\]]|\]\])*\]|"(?:""|[^"])*")$/.test(input) ? stripBrackets(input) : input;
  return schemaKey(normalized, identifierCaseSensitive);
}

/** Splits a qualified SQL name into its constituent parts (Database, Schema, Object). */
export function splitSqlName(name: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inBracket = false;
  let inQuote = false;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch === '[' && !inQuote) { inBracket = true; current += ch; }
    else if (ch === ']' && inBracket) {
      if (name[i + 1] === ']') { current += ']]'; i++; continue; }
      inBracket = false; current += ch;
    }
    else if (ch === '"' && !inBracket) {
      if (inQuote && name[i + 1] === '"') { current += '""'; i++; continue; }
      inQuote = !inQuote; current += ch;
    }
    else if (ch === '.' && !inBracket && !inQuote) {
      if (current) { parts.push(current); current = ''; }
    }
    else { current += ch; }
  }
  if (current) parts.push(current);
  return parts;
}

/** Escapes special characters in a string for safe interpolation into HTML. */
export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


const SCHEMA_PLACEHOLDER = '{{SCHEMAS}}';

/** Expands a `{{SCHEMAS}}` placeholder within a SQL template with a comma-separated list of Unicode (`N'…'`) schema-name literals, so a name outside the server code page keeps its characters. */
export function expandSchemaPlaceholder(sql: string, schemas: string[]): string {
  if (!sql.includes(SCHEMA_PLACEHOLDER)) return sql;
  const list = schemas.map(s => `N'${s.replace(/'/g, "''")}'`).join(', ');
  return sql.replace(/\{\{SCHEMAS\}\}/g, list);
}

/** Validates that a SQL template contains the required schema placeholder for its execution phase. */
export function validateSchemaPlaceholder(name: string, sql: string, phase: number): string | undefined {
  if (phase === 2 && !sql.includes(SCHEMA_PLACEHOLDER)) {
    return `Phase 2 query '${name}' is missing ${SCHEMA_PLACEHOLDER} placeholder — results will be unfiltered`;
  }
  return undefined;
}


/** Compiles a simple exclusion pattern into a case-insensitive regular expression. Supports the `%` wildcard character, which is converted to `.*`. */
export function compileExclusionPattern(pattern: string): RegExp {
  return new RegExp(pattern.replace(/%/g, '.*'), 'i');
}

/** Compiles exclusion patterns into one node predicate that matches a node's `schema.name` or its `fullName` — the single matcher for every exclusion-pattern consumer. */
export function compileExclusionMatcher(
  patterns: readonly string[],
  onInvalidPattern?: (pattern: string, err: unknown) => void,
): ((node: { schema: string; name: string; fullName: string }) => boolean) | null {
  const regexes: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      regexes.push(compileExclusionPattern(pattern));
    } catch (err) {
      onInvalidPattern?.(pattern, err);
    }
  }
  if (regexes.length === 0) return null;
  return (node) => {
    const name = `${node.schema}.${node.name}`;
    return regexes.some((r) => r.test(name) || r.test(node.fullName));
  };
}

/** Escapes a string so it can be safely used as a literal part of a regular expression. */
export function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalizes a raw DDL script for display in the UI. - Removes blank lines. - Trims trailing whitespace. - Converts tabs to two-space indentation. */
export function normalizeBodyScript(raw: string): string {
  return raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => line.trimEnd().replace(/\t/g, '  '))
    .join('\n');
}
