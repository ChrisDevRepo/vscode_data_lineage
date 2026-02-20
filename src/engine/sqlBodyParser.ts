// Regex-based T-SQL dependency extraction; rules loaded from YAML at runtime.

import { splitSqlName } from '../utils/sql';



export interface ParsedDependencies {
  sources: string[];
  targets: string[];
  execCalls: string[];
}

export interface ParseRule {
  name: string;
  enabled: boolean;
  priority: number;
  category: 'preprocessing' | 'source' | 'target' | 'exec';
  pattern: string;
  flags: string;
  replacement?: string;
  description: string;
}

export interface ParseRulesConfig {
  rules: ParseRule[];
}

// ─── SQL Cleansing — runs BEFORE all YAML rules ─────────────────────────────
//
// Rule authors do NOT need to think about comment removal or string literals.
// The cleansing pipeline neutralizes all of that before any regex rule sees the SQL.
//
// Pass 0 — removeBlockComments(): counter-based O(n) scan
//   Handles nested block comments: /* outer /* inner */ still outer */
//   Regex cannot solve this (finite automaton, no stack) — TypeScript scanner required.
//
// Pass 1 — leftmost-match regex (applied inside parseSqlBody):
//   /\[[^\]]+\]|'(?:''|[^'])*'|--[^\r\n]*/g
//   • [bracket identifiers] → preserved as-is (YAML rules can still match them)
//   • 'string literals'    → neutralized to ''  (content can't trigger false matches)
//   • -- line comments     → replaced with space (already removed by pass 0 for block)
//   Block comments (/* */) are NOT in this regex — pass 0 has already removed them.

/** Pass 0: counter-scan removes block comments including nested ones correctly. O(n), no regex. */
function removeBlockComments(sql: string): string {
  let out = '';
  let i = 0;
  let depth = 0;
  while (i < sql.length) {
    if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; continue; }
    if (sql[i] === '*' && sql[i + 1] === '/' && depth > 0) { depth--; i += 2; continue; }
    if (depth === 0) out += sql[i];
    i++;
  }
  return out;
}

// ─── Active config ──────────────────────────────────────────────────────────
// Initialized empty — populated by loadRules() when config arrives from extension host.

let activeRules: ParseRule[] = [];

export interface LoadRulesResult {
  loaded: number;
  skipped: string[];       // rule names that failed validation
  errors: string[];        // human-readable error messages
  usedDefaults: boolean;   // true if fell back to defaults entirely
  categoryCounts: Record<string, number>;  // e.g. { preprocessing: 1, source: 4, target: 3, exec: 1 }
}

const VALID_CATEGORIES = new Set(['preprocessing', 'source', 'target', 'exec']);

function validateRule(rule: unknown, index: number): { valid: boolean; name: string; error?: string } {
  const r = rule as Record<string, unknown>;
  const name = typeof r?.name === 'string' ? r.name : `rule[${index}]`;

  if (!r || typeof r !== 'object') return { valid: false, name, error: `${name}: not an object` };
  if (typeof r.name !== 'string' || !r.name) return { valid: false, name, error: `${name}: missing 'name'` };
  if (typeof r.pattern !== 'string' || !r.pattern) return { valid: false, name, error: `${name}: missing 'pattern'` };
  if (typeof r.category !== 'string' || !VALID_CATEGORIES.has(r.category)) {
    return { valid: false, name, error: `${name}: invalid category '${r.category}' (must be: preprocessing, source, target, exec)` };
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

/** Load rules from parsed YAML config (built-in or custom) with validation */
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

    // Skip disabled rules silently
    if (raw && typeof raw === 'object' && (raw as ParseRule).enabled === false) continue;

    const check = validateRule(raw, i);
    if (check.valid) {
      validRules.push(raw as ParseRule);
    } else {
      result.skipped.push(check.name);
      result.errors.push(check.error!);
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

/** Clear active rules (extension host is responsible for providing config) */
export function resetRules() {
  activeRules = [];
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function parseSqlBody(sql: string): ParsedDependencies {
  // Pass 0: Remove block comments (including nested) before the regex sees the SQL.
  // This must run first — the leftmost-match regex below does NOT handle block comments.
  let clean = removeBlockComments(sql);

  // Pass 1: Leftmost-match regex — brackets, strings, and line comments.
  // Block comments already gone (Pass 0), so the pattern is shorter and faster.
  // "The Best Regex Trick": leftmost match wins, so strings protect -- inside them.
  // Double-quoted identifiers ("dbo"."Table") are normalized to bracket notation ([dbo].[Table])
  // so YAML rules only need to handle one quoting style.
  clean = clean.replace(/\[[^\]]+\]|"[^"]*"|'(?:''|[^'])*'|--[^\r\n]*/g, (match) => {
    if (match.startsWith('[')) return match;                         // preserve [bracket identifiers]
    if (match.startsWith('"')) return `[${match.slice(1, -1)}]`;   // "double-quote" → [bracket]
    if (match.startsWith("'")) return "''";                         // neutralize 'string literals'
    return ' ';                                                       // remove -- line comments
  });

  // Step 1b: Additional user-defined preprocessing rules (skip built-in clean_sql)
  for (const rule of activeRules) {
    if (rule.category === 'preprocessing' && rule.name !== 'clean_sql' && rule.replacement !== undefined) {
      clean = clean.replace(new RegExp(rule.pattern, rule.flags), rule.replacement);
    }
  }

  // CTEs (WITH name AS (...)) do not need explicit filtering:
  // normalizeCaptured() rejects all unqualified names (no dot), which covers all CTE aliases.
  // CTEs are virtual constructs — they never appear in the object catalog.

  const sources = new Set<string>();
  const targets = new Set<string>();
  const execCalls = new Set<string>();

  // Step 2: Extraction rules
  // UDF matches collected separately to filter false positives from INSERT INTO table(cols).
  const udfSources = new Set<string>();

  for (const rule of activeRules) {
    if (rule.category === 'preprocessing') continue;

    const dest =
      rule.name === 'extract_udf_calls' ? udfSources :
      rule.category === 'source' ? sources :
      rule.category === 'target' ? targets :
      execCalls;

    collectMatches(clean, new RegExp(rule.pattern, rule.flags), dest);
  }

  // Add UDF sources that aren't already targets (a function can't be an INSERT/UPDATE target).
  // This avoids false positives from INSERT INTO schema.table(col1, col2) where ( starts column list.
  for (const u of udfSources) {
    if (!targets.has(u)) sources.add(u);
  }

  return {
    sources: Array.from(sources),
    targets: Array.from(targets),
    execCalls: Array.from(execCalls),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const MAX_MATCHES_PER_RULE = 10_000;

function collectMatches(sql: string, regex: RegExp, out: Set<string>) {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  let iterations = 0;

  while ((match = regex.exec(sql)) !== null) {
    // Guard against zero-length matches causing infinite loops (user-provided regex)
    if (match[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    // Safety limit: abort runaway regex (ReDoS or overly broad user patterns)
    if (++iterations > MAX_MATCHES_PER_RULE) break;

    const raw = match[1];
    if (!raw) continue;

    const normalized = normalizeCaptured(raw);
    if (normalized === null) continue;

    out.add(normalized);
  }
}

/**
 * Normalize a raw regex capture to [schema].[object] for catalog lookup.
 * Returns null to signal "skip this capture".
 *
 * This function is the single normalization gate for all rule captures.
 * Rule authors do NOT need to handle any of these cases in their YAML patterns:
 *
 * - Bracket delimiters [schema].[object] → stripped
 * - Double-quote identifiers "schema"."object" → stripped
 * - @tableVariable / #TempTable → rejected (never in catalog)
 * - Unqualified names (no dot) → rejected (require schema.object minimum)
 * - CTE aliases → also rejected here (CTEs are unqualified, caught by the line above)
 * - 3-part names db.schema.object → takes last 2 parts (schema.object)
 * - 4-part+ names server.db.schema.object → rejected (linked server refs)
 * - Lowercased for case-insensitive catalog lookup
 */
function normalizeCaptured(raw: string): string | null {
  // Split bracket-aware: dots INSIDE [bracket identifiers] are part of the name, not separators.
  // Example: [STAGING_CADENCE].[spLoadReconciliation_Case4.5] → 2 parts, not 3.
  const parts = splitSqlName(raw).map(p => p.replace(/[\[\]"]/g, ''));
  const first = parts[0] ?? '';
  if (first.startsWith('@') || first.startsWith('#')) return null;  // vars, temp tables
  if (parts.length < 2) return null;                  // require schema.object minimum
  if (parts.length >= 4) return null;                 // reject linked-server 4-part names
  const schema = parts[parts.length - 2];
  const obj    = parts[parts.length - 1];
  if (!schema || !obj) return null;
  return `[${schema}].[${obj}]`.toLowerCase();
}
