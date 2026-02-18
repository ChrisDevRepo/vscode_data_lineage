// Regex-based T-SQL dependency extraction; rules loaded from YAML at runtime.

import { stripBrackets } from '../utils/sql';

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
  let clean = sql;

  // Step 1: Built-in SQL cleaning — single-pass string/comment handling.
  // "The Best Regex Trick": leftmost match wins, so strings protect -- inside them.
  clean = clean.replace(/\[[^\]]+\]|'(?:''|[^'])*'|--[^\r\n]*|\/\*[\s\S]*?\*\//g, (match) => {
    return match.startsWith('[') ? match : match.startsWith("'") ? "''" : ' ';
  });

  // Step 1b: Additional user-defined preprocessing rules (skip built-in clean_sql)
  for (const rule of activeRules) {
    if (rule.category === 'preprocessing' && rule.name !== 'clean_sql' && rule.replacement !== undefined) {
      clean = clean.replace(new RegExp(rule.pattern, rule.flags), rule.replacement);
    }
  }

  // Step 2: Extract CTE names so they're skipped as table references
  const cteNames = extractCteNames(clean);

  const sources = new Set<string>();
  const targets = new Set<string>();
  const execCalls = new Set<string>();

  // Step 3: Extraction rules
  // UDF matches collected separately to filter false positives from INSERT INTO table(cols).
  const udfSources = new Set<string>();

  for (const rule of activeRules) {
    if (rule.category === 'preprocessing') continue;

    const dest =
      rule.name === 'extract_udf_calls' ? udfSources :
      rule.category === 'source' ? sources :
      rule.category === 'target' ? targets :
      execCalls;

    collectMatches(clean, new RegExp(rule.pattern, rule.flags), dest, cteNames);
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

/** Extract CTE names from WITH ... AS (...) patterns */
function extractCteNames(sql: string): Set<string> {
  const ctes = new Set<string>();
  // Match WITH keyword, then scan ahead for "name AS (" patterns
  // Use a greedy match to capture all CTEs before the main query body
  const withRegex = /\bWITH\b/gi;
  const nameRegex = /\b(\[?\w+\]?)\s+AS\s*\(/gi;
  let withMatch: RegExpExecArray | null;

  while ((withMatch = withRegex.exec(sql)) !== null) {
    // Scan from after WITH for all "name AS (" patterns
    // Stop when we hit a top-level SELECT/INSERT/UPDATE/DELETE/MERGE not inside parens
    const afterWith = sql.slice(withMatch.index + withMatch[0].length);
    nameRegex.lastIndex = 0;
    let nameMatch: RegExpExecArray | null;
    while ((nameMatch = nameRegex.exec(afterWith)) !== null) {
      const name = stripBrackets(nameMatch[1]).toLowerCase();
      ctes.add(name);
    }
  }
  return ctes;
}

const MAX_MATCHES_PER_RULE = 10_000;

function collectMatches(sql: string, regex: RegExp, out: Set<string>, cteNames?: Set<string>) {
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

    const normalized = stripBrackets(raw).trim();
    if (shouldSkip(normalized)) continue;
    if (cteNames?.has(normalized.toLowerCase())) continue;

    out.add(normalized);
  }
}

function shouldSkip(name: string): boolean {
  // Single-character unqualified names are always table aliases (a, b, t, etc.)
  if (!name.includes('.') && name.length === 1) return true;
  return false;
}
