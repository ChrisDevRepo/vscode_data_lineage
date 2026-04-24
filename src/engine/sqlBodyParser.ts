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

import { splitSqlName } from '../utils/sql';
import { CLR_TYPE_METHODS } from './shared/sqlMetadata';
import { 
  QUALIFIED_NAME, ANY_IDENT, KEYWORDS_RE, 
  PASS1_CLEANSE_RE, TABLE_REF_WITH_ALIAS, FROM_TERMINATOR_RE 
} from './shared/sqlRegex';
import type { ExternalRef } from './types';

/**
 * Represents the extracted SQL dependencies from a parsed SQL body.
 * 
 * @remarks
 * Categorizes discovered database objects into read/write operations and 
 * execution calls.
 */
export interface ParsedDependencies {
  /** 
   * Schema-qualified names of objects read from (e.g., `[dbo].[Table]`). 
   * Captured from SELECT and JOIN clauses.
   */
  sources: string[];
  /** 
   * Schema-qualified names of objects written to (e.g., `[dbo].[Table]`). 
   * Captured from INSERT, UPDATE, DELETE, and MERGE statements.
   */
  targets: string[];
  /** 
   * Schema-qualified names of stored procedures executed (e.g., `[dbo].[Proc]`). 
   * Captured from EXEC/EXECUTE calls.
   */
  execCalls: string[];
  /** 
   * Full 3-part names of cross-database sources (e.g., `db.schema.object`). 
   * These are tracked separately from local references.
   */
  crossDbSources: string[];
  /** 
   * Full 3-part names of cross-database targets (e.g., `db.schema.object`). 
   * Tracked for cross-DB lineage analysis.
   */
  crossDbTargets: string[];
}

/**
 * Defines a single regex-based extraction rule for SQL parsing.
 * 
 * @remarks
 * Rules are the atomic unit of extraction in the engine. They use named capture 
 * groups to identify pertinent identifiers in the SQL text.
 */
export interface ParseRule {
  /** 
   * Unique identifier for the rule. 
   * Used for debugging and configuration overrides.
   */
  name: string;
  /** 
   * Whether the rule is actively applied during parsing. 
   */
  enabled: boolean;
  /** 
   * Execution order (lower priority runs earlier). 
   * Crucial for rules that depend on previous preprocessing passes.
   */
  priority: number;
  /** 
   * Categorizes how the rule's matches are classified in {@link ParsedDependencies}.
   */
  category: 'preprocessing' | 'source' | 'target' | 'exec' | 'external_ref';
  /** 
   * The regular expression string to evaluate against the SQL body. 
   * Must contain at least one capture group for the identifier.
   */
  pattern: string;
  /** 
   * Regex flags (e.g., 'gi') applied to the pattern. 
   */
  flags: string;
  /** 
   * Replacement string for 'preprocessing' category rules. 
   * Allows transforming SQL text before extraction.
   */
  replacement?: string;
  /** 
   * Defines the type of external reference. 
   * Required if category is 'external_ref'.
   */
  kind?: string;
  /** 
   * Human-readable explanation of the rule's purpose. 
   */
  description: string;
}

/**
 * Configuration wrapper for loading multiple parse rules.
 */
export interface ParseRulesConfig {
  /** An array of parse rules to load into the engine. */
  rules: ParseRule[];
}

/**
 * Result of attempting to load and validate a set of parse rules.
 * 
 * @remarks
 * Provides telemetry on how many rules were successfully loaded and 
 * details on any validation failures.
 */
export interface LoadRulesResult {
  /** The number of rules successfully validated and loaded. */
  loaded: number;
  /** Names of rules that failed validation and were skipped. */
  skipped: string[];
  /** Detailed error messages for the rules that failed validation. */
  errors: string[];
  /** True if the engine fell back to default rules due to critical errors. */
  usedDefaults: boolean;
  /** Counts of loaded rules grouped by their category for monitoring. */
  categoryCounts: Record<string, number>;
}

/** 
 * Internal store for the active parsing ruleset. 
 * @internal 
 */
let activeRules: ParseRule[] = [];

/** 
 * Set of allowed rule categories for validation. 
 * @internal 
 */
const VALID_CATEGORIES = new Set(['preprocessing', 'source', 'target', 'exec', 'external_ref']);

/**
 * Validates a single parse rule for structural and regex correctness.
 * 
 * @remarks
 * Checks for required fields, valid categories, and ensures the regex 
 * pattern doesn't cause infinite loops by matching empty strings.
 * 
 * @param rule - The raw rule object to validate.
 * @param index - The index of the rule in the configuration array.
 * @returns A validation result indicating success or failure with an error message.
 * @internal
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

  // Test-compile the regex and check for empty-match patterns
  try {
    const testRegex = new RegExp(r.pattern as string, r.flags as string);
    if (testRegex.test('')) {
      return { valid: false, name, error: `${name}: regex matches empty string — this would cause infinite loops` };
    }
  } catch (e) {
    return { valid: false, name, error: `${name}: invalid regex — ${e instanceof Error ? e.message : String(e)}` };
  }

  return { valid: true, name };
}

/**
 * Loads rules from a parsed configuration (built-in or custom) with validation.
 *
 * @remarks
 * This function is the primary entry point for configuring the parsing engine.
 * It sorts rules by priority to ensure correct execution order.
 * 
 * @param config - The configuration object containing the rules to load.
 * @returns A summary of the load operation, including success counts and any validation errors.
 */
export function loadRules(config: ParseRulesConfig): LoadRulesResult {
  const result: LoadRulesResult = { loaded: 0, skipped: [], errors: [], usedDefaults: false, categoryCounts: {} };

  if (!config?.rules || !Array.isArray(config.rules)) {
    result.errors.push('YAML missing "rules" array');
    result.usedDefaults = true;
    resetRules();
    return result;
  }

  const validRules: ParseRule[] = [];
  for (let i = 0; i < config.rules.length; i++) {
    const raw = config.rules[i];

    if (raw && typeof raw === 'object' && (raw as ParseRule).enabled === false) continue;

    const check = validateRule(raw, i);
    if (check.valid) {
      validRules.push(raw as ParseRule);
    } else {
      result.skipped.push(check.name);
      result.errors.push(check.error);
    }
  }

  if (validRules.length === 0) {
    result.errors.push('No valid rules found');
    result.usedDefaults = true;
    resetRules();
    return result;
  }

  activeRules = validRules.sort((a, b) => a.priority - b.priority);
  result.loaded = validRules.length;
  for (const r of validRules) {
    result.categoryCounts[r.category] = (result.categoryCounts[r.category] || 0) + 1;
  }
  return result;
}

/**
 * Clears all active parsing rules from memory.
 *
 * @remarks
 * Used during teardown or when switching project configurations. The extension host is
 * responsible for providing a new configuration after resetting.
 */
function resetRules(): void {
  activeRules = [];
}
/**
 * Find the base table a CTE references via paren-balanced body detection.
 * 
 * @remarks
 * Works on cleaned SQL (Pass 0+1 removed comments/strings before this runs).
 * SQL Server enforces that updatable CTEs are simple (no aggregates, no DISTINCT,
 * no GROUP BY) — the first FROM is always the base table or another simple CTE.
 * 
 * @param sql - Cleaned SQL text to search within.
 * @param bodyStart - Position in the string right after the opening `(` of `AS (`.
 * @returns The schema-qualified table name, unqualified CTE name, or `null` if not found.
 * @internal
 */
function resolveCteFromTarget(sql: string, bodyStart: number): string | null {
  // Find CTE body end — paren balancing on cleaned SQL
  let depth = 1;
  let bodyEnd = -1;
  for (let i = bodyStart; i < sql.length; i++) {
    if (sql[i] === '[') { while (i < sql.length && sql[i] !== ']') i++; continue; }
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') { depth--; if (depth === 0) { bodyEnd = i; break; } }
  }
  if (bodyEnd < 0) return null;

  const body = sql.slice(bodyStart, bodyEnd);

  // Schema-qualified FROM first (e.g. FROM [schema].[table])
  const qual = body.match(new RegExp(`\\bFROM\\s+(${QUALIFIED_NAME.source})(?![\\w\\.])`, 'i'));
  if (qual) return qual[1];

  // Fallback: unqualified FROM — another CTE in chain
  const unqual = body.match(new RegExp(`\\bFROM\\s+(${ANY_IDENT.source})(?!\\s*\\.)(?!\\s*\\()`, 'i'));
  if (unqual && !KEYWORDS_RE.test(unqual[1])) return unqual[1];

  return null;
}

/**
 * Preprocessing pass to replace CTE aliases in UPDATE statements with the base table.
 * 
 * @remarks
 * Resolves CTE chains (e.g., `WITH c1 AS (...FROM T), c2 AS (...FROM c1)`) 
 * collapsing them down to the ultimate base table. This allows the simple 
 * extraction rules to correctly identify the target of an UPDATE statement.
 *
 * @param sql - Cleaned SQL text.
 * @returns SQL text with CTE aliases substituted for base tables in UPDATE contexts.
 * @internal
 */
function substituteCteUpdateAliases(sql: string): string {
  // Find CTE definitions: WITH name AS ( and , name AS ( (multi-CTE syntax)
  const cteMap = new Map<string, string>(); // cteName (lowercase) → base table or CTE ref
  const ctePattern = new RegExp(`(?:\\bWITH\\b|,)\\s*(${ANY_IDENT.source})\\s+AS\\s*\\(`, 'gi');

  let m: RegExpExecArray | null;
  while ((m = ctePattern.exec(sql)) !== null) {
    const cteName = m[1];
    if (KEYWORDS_RE.test(cteName)) continue;
    const bodyStart = m.index + m[0].length;
    const ref = resolveCteFromTarget(sql, bodyStart);
    if (ref) cteMap.set(cteName.toLowerCase(), ref);
  }

  // Resolve CTE chains: cte_A → cte_B → [schema].[table]
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (const [name, target] of cteMap) {
      if (!target.includes('.') && cteMap.has(target.toLowerCase())) {
        const resolved = cteMap.get(target.toLowerCase())!;
        if (resolved !== target) { cteMap.set(name, resolved); changed = true; }
      }
    }
    if (!changed) break;
  }
  // Remove unresolvable entries (still no schema dot after chaining)
  for (const [name, target] of cteMap) {
    if (!target.includes('.')) cteMap.delete(name);
  }

  if (cteMap.size === 0) return sql;

  // Rewrite UPDATE CTE_NAME SET → UPDATE [schema].[table] SET
  let result = sql.replace(new RegExp(`\\bUPDATE\\s+(${ANY_IDENT.source})\\s+SET\\b`, 'gi'), (match, alias) => {
    const baseTable = cteMap.get(alias.toLowerCase());
    return baseTable ? `UPDATE ${baseTable} SET` : match;
  });

  // Rewrite FROM CTE_NAME → FROM [schema].[table] for alias UPDATE patterns.
  for (const [cteName, baseTable] of cteMap) {
    result = result.replace(new RegExp(`\\bFROM\\s+${cteName}\\b`, 'gi'), `FROM ${baseTable}`);
  }

  return result;
}

/**
 * Normalizes ANSI comma-join FROM clauses to modern JOIN syntax.
 * 
 * @remarks
 * Transforms `FROM t1, t2, t3 WHERE` into `FROM t1 JOIN t2 JOIN t3 WHERE`.
 * This allows standard extraction rules to identify all tables without 
 * complex lookahead logic.
 *
 * @param sql - Cleaned SQL text.
 * @returns SQL with normalized JOIN syntax.
 * @internal
 */
function normalizeAnsiCommaJoins(sql: string): string {
  return sql.replace(
    new RegExp(
      `\\bFROM\\s+((?:${TABLE_REF_WITH_ALIAS.source}\\s*,\\s*)+${TABLE_REF_WITH_ALIAS.source})` +
      `(?=${FROM_TERMINATOR_RE.source})`,
      'gi'
    ),
    (_, tables: string) => 'FROM ' + tables.replace(/\s*,\s*/g, ' JOIN ')
  );
}

/** 
 * Removes block comments from SQL text using a nested-aware counter scan.
 * 
 * @remarks
 * Regex cannot easily handle nested comments (e.g., `/* ... /* ... *\/ ... *\/`). 
 * This O(n) scan ensures perfect removal regardless of nesting depth.
 *
 * @param sql - Raw SQL text.
 * @returns SQL with all block comments removed.
 * @internal
 */
function removeBlockComments(sql: string): string {
  const parts: string[] = [];
  let i = 0;
  let depth = 0;
  let start = 0; // start of current non-comment range
  while (i < sql.length) {
    if (sql[i] === '/' && sql[i + 1] === '*') {
      if (depth === 0) parts.push(sql.substring(start, i));
      depth++; i += 2; continue;
    }
    if (sql[i] === '*' && sql[i + 1] === '/' && depth > 0) {
      depth--; i += 2;
      if (depth === 0) start = i;
      continue;
    }
    i++;
  }
  if (depth === 0) parts.push(sql.substring(start, i));
  return parts.join('');
}

/**
 * Parses a raw T-SQL string to extract dependencies using the active ruleset.
 *
 * @remarks
 * The parsing process follows these passes:
 * 1.  **Pass 0**: Nested-aware block comment removal.
 * 2.  **Pass 1**: Neutralization of string literals and line comments using the 
 *     "Best Regex Trick" (leftmost match).
 * 3.  **Pass 1.5**: ANSI-92 comma-join normalization.
 * 4.  **Pass 1.6**: CTE alias substitution for UPDATE targets.
 * 5.  **Extraction**: Rule-based matching against the cleaned SQL.
 *
 * @param sql - The raw SQL statement or script body to parse.
 * @returns A categorization of all discovered dependencies.
 */
export function parseSqlBody(sql: string): ParsedDependencies {
  // Pass 0: Remove block comments (including nested) before the regex sees the SQL.
  let clean = removeBlockComments(sql);

  // Pass 1: Leftmost-match regex — brackets, strings, and line comments.
  clean = clean.replace(PASS1_CLEANSE_RE, (match) => {
    if (match.startsWith('[')) return match;                         // preserve [bracket identifiers]
    if (match.startsWith('"')) return `[${match.slice(1, -1)}]`;   // "double-quote" → [bracket]
    if (match.startsWith("'")) return "''";                         // neutralize 'string literals'
    return ' ';                                                       // remove -- line comments
  });

  // Pass 1.5: Normalize ANSI comma-join FROM clauses to modern JOIN syntax.
  clean = normalizeAnsiCommaJoins(clean);

  // Pass 1.6: Substitute CTE aliases in UPDATE statements with the CTE's base table.
  clean = substituteCteUpdateAliases(clean);

  // Step 1b: Additional user-defined preprocessing rules
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

  // Step 2: Extraction rules
  const udfSources = new Set<string>();

  for (const rule of activeRules) {
    if (rule.category === 'preprocessing') continue;

    const regex = new RegExp(rule.pattern, rule.flags);

    const dest =
      rule.name === 'extract_udf_calls' ? udfSources :
      rule.category === 'source' ? sources :
      rule.category === 'target' ? targets :
      execCalls;

    collectMatches(clean, regex, dest);

    // Also collect 3-part+ names (cross-DB refs)
    if (rule.category === 'source' || rule.name === 'extract_udf_calls') {
      collectCrossDbMatches(clean, new RegExp(rule.pattern, rule.flags), crossDbSources);
    } else if (rule.category === 'target') {
      collectCrossDbMatches(clean, new RegExp(rule.pattern, rule.flags), crossDbTargets);
    }
  }

  // Add UDF sources that aren't already targets
  for (const u of udfSources) {
    if (!targets.has(u)) sources.add(u);
  }

  return {
    sources: Array.from(sources),
    targets: Array.from(targets),
    execCalls: Array.from(execCalls),
    crossDbSources: Array.from(crossDbSources),
    crossDbTargets: Array.from(crossDbTargets),
  };
}

/** 
 * Maximum number of matches allowed per rule to prevent runaway execution. 
 * @internal 
 */
const MAX_MATCHES_PER_RULE = 10_000;

/**
 * Collects all matches for a regex and adds them to the provided set.
 *
 * @param sql - Cleaned SQL text to search within.
 * @param regex - Regular expression to execute.
 * @param out - Set to store the normalized matches.
 * @internal
 */
function collectMatches(sql: string, regex: RegExp, out: Set<string>): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  let iterations = 0;

  while ((match = regex.exec(sql)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    if (++iterations > MAX_MATCHES_PER_RULE) {
      break;
    }

    const raw = match[1];
    if (!raw) continue;

    const normalized = normalizeCaptured(raw);
    if (normalized === null) continue;

    out.add(normalized);
  }
}

/**
 * Normalizes a raw regex capture to `[schema].[object]` for catalog lookup.
 * 
 * @remarks
 * Removes brackets and quotes, splits the identifier parts, and ensures 
 * local variables or temporary tables are excluded.
 *
 * @param raw - The raw string captured by a regex.
 * @returns A normalized `[schema].[object]` string or `null` if invalid.
 * @internal
 */
function normalizeCaptured(raw: string): string | null {
  const parts = splitSqlName(raw).map(p => p.replace(/[\[\]"]/g, ''));
  const first = parts[0] ?? '';
  if (first.startsWith('@') || first.startsWith('#')) return null;
  if (parts.length < 2) return null;
  if (parts.length >= 3) return null;
  const schema = parts[0];
  const obj = parts[1];
  if (!schema || !obj) return null;
  return `[${schema}].[${obj}]`.toLowerCase();
}

/**
 * Normalizes a 3+ part name to cross-database format: `db.schema.object`.
 * 
 * @remarks
 * Filters out CLR/XML methods that look like 3-part names but are actually 
 * method calls.
 *
 * @param raw - The raw string captured by a regex.
 * @returns A normalized `db.schema.object` string or `null` if invalid.
 * @internal
 */
function normalizeCrossDb(raw: string): string | null {
  const parts = splitSqlName(raw).map(p => p.replace(/[\[\]"]/g, ''));
  const first = parts[0] ?? '';
  if (first.startsWith('@') || first.startsWith('#')) return null;
  if (parts.length < 3) return null;
  const pertinent = parts.length >= 4 ? parts.slice(-3) : parts;
  const object = pertinent[pertinent.length - 1];
  if (CLR_TYPE_METHODS.has(object.toLowerCase())) return null;
  return pertinent.map(p => p.toLowerCase()).join('.');
}

/**
 * Runs extraction rules specifically to collect 3+ part names (cross-DB references).
 *
 * @param sql - Cleaned SQL text.
 * @param regex - Regular expression to execute.
 * @param out - Set to store the normalized cross-DB matches.
 * @internal
 */
function collectCrossDbMatches(sql: string, regex: RegExp, out: Set<string>): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  let iterations = 0;

  while ((match = regex.exec(sql)) !== null) {
    if (match[0].length === 0) { regex.lastIndex++; continue; }
    if (++iterations > MAX_MATCHES_PER_RULE) break;
    const raw = match[1];
    if (!raw) continue;
    const normalized = normalizeCrossDb(raw);
    if (normalized !== null) out.add(normalized);
  }
}

/**
 * Extracts external file or URL references from raw SQL.
 *
 * @remarks
 * This function runs *before* the cleansing pipeline neutralizes string 
 * literals, as external references (like BULK INSERT paths) are often 
 * contained within single quotes.
 *
 * @param rawSql - The raw SQL text before any preprocessing or cleansing.
 * @returns A deduplicated array of discovered external references.
 */
export function extractExternalRefs(rawSql: string): ExternalRef[] {
  const seen = new Set<string>();
  const results: ExternalRef[] = [];
  const extRules = activeRules.filter(r => r.category === 'external_ref');

  for (const rule of extRules) {
    const regex = new RegExp(rule.pattern, rule.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(rawSql)) !== null) {
      if (match[0].length === 0) { regex.lastIndex++; continue; }
      const url = match[1];
      if (url && !seen.has(url)) {
        seen.add(url);
        results.push({ url, kind: rule.kind! });
      }
    }
  }

  return results;
}
