/** Returns a schema comparison key; exact casing requires checked source identifier metadata. */
export function schemaKey(name: string, identifierCaseSensitive = false): string {
  return identifierCaseSensitive ? name : name.toLowerCase();
}


/**
 * One delimited identifier, `[bracketed]` (`]]` escapes `]`) or `"quoted"`, or a single stray
 * delimiter left by an unbalanced name.
 */
const DELIMITED_PART = /\[(?:[^\]]|\]\])*\]|"(?:""|[^"])*"|[\[\]"]/g;

/**
 * Removes SQL-standard delimiters (`[]`, `""`) from an identifier, unescaping only the enclosing
 * delimiter's doubled form (`]]` in brackets, `""` in double quotes): `[dbo].[a]]b]` becomes
 * `dbo.a]b`.
 *
 * The single owner of identifier-text normalization; an escaped `]` survives as one literal
 * character, so a name containing `]` round-trips.
 */
export function stripBrackets(name: string): string {
  return name.replace(DELIMITED_PART, part => {
    if (part.length < 2) return '';
    const inner = part.slice(1, -1);
    return part.startsWith('[') ? inner.replace(/\]\]/g, ']') : inner.replace(/""/g, '"');
  });
}

/**
 * Bracket-quotes one identifier part for T-SQL, doubling every `]` so the name round-trips through
 * {@link stripBrackets}: `a]b` becomes `[a]]b]`.
 */
export function quoteIdentifier(name: string): string {
  return `[${name.replace(/\]/g, ']]')}]`;
}

/**
 * Canonical comparison form of a SQL **column** name: delimiters stripped ({@link stripBrackets}),
 * then case-folded, so a model-emitted `[ListPrice]` matches a DDL `ListPrice`. The single
 * normalizer for column-name equality in the column-trace path.
 *
 * Use this, not `normalizeName`, for a bare column: `normalizeName` is node-shaped
 * (`[schema].[object]`) and would read a dotted column as a qualified object.
 *
 * @param identifierCaseSensitive - Checked catalog policy; absent/false retains CI equality.
 * @returns Delimiter-free key, preserving casing only for a checked CS catalog.
 */
export function normalizeColName(name: string, identifierCaseSensitive = false): string {
  const input = name.trim();
  const normalized = /^(?:\[(?:[^\]]|\]\])*\]|"(?:""|[^"])*")$/.test(input) ? stripBrackets(input) : input;
  return schemaKey(normalized, identifierCaseSensitive);
}

/**
 * Splits a qualified SQL name into parts (Database, Schema, Object). Dots inside bracketed `[]` or
 * quoted `""` identifiers are not separators, and a doubled `]` (T-SQL's escape) does not close the
 * name.
 *
 * @example
 * ```typescript
 * splitSqlName("[schema].[obj.with.dot]") // returns ["[schema]", "[obj.with.dot]"]
 * splitSqlName("[dbo].[a]].b]") // returns ["[dbo]", "[a]].b]"]
 * ```
 */
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

/**
 * Expands a `{{SCHEMAS}}` placeholder in a SQL template into a comma-separated list of Unicode
 * `N'…'` schema-name literals, so a name outside the server code page keeps its characters:
 * `IN ({{SCHEMAS}})` becomes `IN (N'dbo', N'Sales')`.
 *
 * Safe for string-literal contexts only (`IN (…)`, `= '…'`); embedded `'` is escaped to `''`. Not
 * safe as a SQL identifier: never interpolate into `[schema]`/`"schema"`; an identifier context
 * needs a dedicated helper that validates against `sys.schemas` or bracket-escapes.
 */
export function expandSchemaPlaceholder(sql: string, schemas: string[]): string {
  if (!sql.includes(SCHEMA_PLACEHOLDER)) return sql;
  const list = schemas.map(s => `N'${s.replace(/'/g, "''")}'`).join(', ');
  return sql.replace(/\{\{SCHEMAS\}\}/g, () => list);
}

/**
 * Validates that a SQL template holds the schema placeholder its execution phase requires (Phase 2
 * needs it for filtering); returns a warning message, or `undefined` when valid.
 */
export function validateSchemaPlaceholder(name: string, sql: string, phase: number): string | undefined {
  if (phase === 2 && !sql.includes(SCHEMA_PLACEHOLDER)) {
    return `Phase 2 query '${name}' is missing ${SCHEMA_PLACEHOLDER} placeholder — results will be unfiltered`;
  }
  return undefined;
}


/**
 * Compiles an exclusion pattern into a case-insensitive RegExp; the `%` wildcard becomes `.*`, so
 * `%tmp%` matches any string containing "tmp".
 */
export function compileExclusionPattern(pattern: string): RegExp {
  return new RegExp(pattern.replace(/%/g, '.*'), 'i');
}

/**
 * Compiles exclusion patterns into one node predicate matching a node's `schema.name` or
 * `fullName`; the single matcher for every exclusion-pattern consumer.
 *
 * @param onInvalidPattern - Called for each pattern that does not compile; that pattern is skipped.
 * @returns The predicate, or `null` when no pattern compiles.
 */
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

/**
 * Normalizes a raw DDL script for display: removes blank lines, trims trailing whitespace, converts
 * tabs to two-space indentation.
 */
export function normalizeBodyScript(raw: string): string {
  return raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => line.trimEnd().replace(/\t/g, '  '))
    .join('\n');
}
