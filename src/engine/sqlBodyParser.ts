/**
 * SQL Body Parser — Regex-based dependency extraction from T-SQL bodies.
 *
 * Rules can be loaded from parseRules.yaml (user-editable) or fall back to
 * built-in defaults. Used to supplement XML BodyDependencies for stored
 * procedures where the dacpac may not fully capture all references.
 */

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
  skip_prefixes: string[];
  skip_keywords: string[];
}

// ─── Built-in defaults ──────────────────────────────────────────────────────

const DEFAULT_RULES: ParseRule[] = [
  // ── Preprocessing ──
  // Single-pass combined regex: strings and comments matched together, leftmost wins.
  // This prevents -- inside strings being treated as comments (and vice versa).
  // Uses function replacement in parseSqlBody() — the replacement field is not used.
  {
    name: 'clean_sql', enabled: true, priority: 1,
    category: 'preprocessing',
    pattern: "\\[[^\\]]+\\]|'(?:''|[^'])*'|--[^\\r\\n]*|\\/\\*[\\s\\S]*?\\*\\/",
    flags: 'g',
    description: 'Single-pass bracket/string/comment handling (built-in)',
  },
  // ── Source extraction ──
  {
    name: 'extract_sources_ansi', enabled: true, priority: 5,
    category: 'source',
    pattern: '\\b(?:FROM|(?:(?:INNER|LEFT|RIGHT|FULL|CROSS|OUTER)\\s+(?:OUTER\\s+)?)?JOIN)\\s+((?:(?:\\[[^\\]]+\\]|\\w+)\\.)*(?:\\[[^\\]]+\\]|\\w+))',
    flags: 'gi',
    description: 'FROM/JOIN sources (handles 2- and 3-part names)',
  },
  {
    name: 'extract_sources_tsql_apply', enabled: true, priority: 7,
    category: 'source',
    pattern: '\\b(?:CROSS|OUTER)\\s+APPLY\\s+((?:(?:\\[[^\\]]+\\]|\\w+)\\.)*(?:\\[[^\\]]+\\]|\\w+))',
    flags: 'gi',
    description: 'CROSS/OUTER APPLY sources',
  },
  {
    name: 'extract_merge_using', enabled: true, priority: 9,
    category: 'source',
    pattern: '\\bMERGE\\b[\\s\\S]*?\\bUSING\\s+((?:(?:\\[[^\\]]+\\]|\\w+)\\.)*(?:\\[[^\\]]+\\]|\\w+))',
    flags: 'gi',
    description: 'MERGE ... USING source table',
  },
  {
    name: 'extract_udf_calls', enabled: true, priority: 10,
    category: 'source',
    pattern: '((?:(?:\\[[^\\]]+\\]|\\w+)\\.)+(?:\\[[^\\]]+\\]|\\w+))\\s*\\(',
    flags: 'gi',
    description: 'Inline scalar UDF calls (schema.func() — requires 2+ part name)',
  },
  // ── Target extraction ──
  {
    name: 'extract_targets_dml', enabled: true, priority: 6,
    category: 'target',
    pattern: '\\b(?:INSERT\\s+(?:INTO\\s+)?|UPDATE\\s+|MERGE\\s+(?:INTO\\s+)?)((?:(?:\\[[^\\]]+\\]|\\w+)\\.)*(?:\\[[^\\]]+\\]|\\w+))',
    flags: 'gi',
    description: 'INSERT/UPDATE/MERGE targets (DELETE/TRUNCATE excluded — they destroy data, not lineage)',
  },
  {
    name: 'extract_ctas', enabled: true, priority: 13,
    category: 'target',
    pattern: '\\bCREATE\\s+TABLE\\s+((?:(?:\\[[^\\]]+\\]|\\w+)\\.)*(?:\\[[^\\]]+\\]|\\w+))\\s+AS\\s+SELECT',
    flags: 'gi',
    description: 'CREATE TABLE AS SELECT target',
  },
  {
    name: 'extract_select_into', enabled: true, priority: 14,
    category: 'target',
    pattern: '\\bINTO\\s+((?:(?:\\[[^\\]]+\\]|\\w+)\\.)*(?:\\[[^\\]]+\\]|\\w+))\\s+FROM',
    flags: 'gi',
    description: 'SELECT INTO target',
  },
  // ── Exec calls ──
  {
    name: 'extract_sp_calls', enabled: true, priority: 8,
    category: 'exec',
    pattern: '\\bEXEC(?:UTE)?\\s+(?:@\\w+\\s*=\\s*)?((?:(?:\\[[^\\]]+\\]|\\w+)\\.)*(?:\\[[^\\]]+\\]|\\w+))',
    flags: 'gi',
    description: 'EXEC/EXECUTE procedure calls (including @var = proc pattern)',
  },
];

const DEFAULT_SKIP_PREFIXES = [
  '#', '@',                                // temp tables, variables
  'sys.', 'sp_', 'xp_', 'fn_',           // system objects
  'information_schema.',                   // ANSI metadata
  'master.', 'msdb.', 'tempdb.', 'model.',// system databases
];
const DEFAULT_SKIP_KEYWORDS = new Set([
  'set', 'declare', 'print', 'return', 'begin', 'end', 'if', 'else',
  'while', 'break', 'continue', 'goto', 'try', 'catch', 'throw',
  'raiserror', 'waitfor', 'as', 'is', 'null', 'not', 'and', 'or',
  'select', 'where', 'group', 'order', 'having', 'top', 'distinct',
  'table', 'index', 'view', 'procedure', 'function', 'trigger',
  'values', 'output', 'with', 'nolock', 'on',
]);

// ─── Active config ──────────────────────────────────────────────────────────

let activeRules: ParseRule[] = [...DEFAULT_RULES];
let activeSkipPrefixes: string[] = [...DEFAULT_SKIP_PREFIXES];
let activeSkipKeywords: Set<string> = new Set(DEFAULT_SKIP_KEYWORDS);

export interface LoadRulesResult {
  loaded: number;
  skipped: string[];       // rule names that failed validation
  errors: string[];        // human-readable error messages
  usedDefaults: boolean;   // true if fell back to defaults entirely
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

  // Test-compile the regex
  try {
    new RegExp(r.pattern as string, r.flags as string);
  } catch (e) {
    return { valid: false, name, error: `${name}: invalid regex — ${e instanceof Error ? e.message : String(e)}` };
  }

  return { valid: true, name };
}

/** Load custom rules from parsed YAML config with validation */
export function loadRules(config: ParseRulesConfig): LoadRulesResult {
  const result: LoadRulesResult = { loaded: 0, skipped: [], errors: [], usedDefaults: false };

  if (!config?.rules || !Array.isArray(config.rules)) {
    result.errors.push('YAML missing "rules" array — using built-in defaults');
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
    result.errors.push('No valid rules found — using built-in defaults');
    result.usedDefaults = true;
    resetRules();
    return result;
  }

  activeRules = validRules.sort((a, b) => a.priority - b.priority);
  activeSkipPrefixes = config.skip_prefixes || DEFAULT_SKIP_PREFIXES;
  activeSkipKeywords = new Set(config.skip_keywords || DEFAULT_SKIP_KEYWORDS);
  result.loaded = validRules.length;
  return result;
}

/** Reset to built-in defaults */
export function resetRules() {
  activeRules = [...DEFAULT_RULES];
  activeSkipPrefixes = [...DEFAULT_SKIP_PREFIXES];
  activeSkipKeywords = new Set(DEFAULT_SKIP_KEYWORDS);
}

/** Get current active rules (for UI display) */
export function getActiveRules(): ParseRule[] {
  return activeRules;
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
      if (!activeSkipKeywords.has(name)) {
        ctes.add(name);
      }
    }
  }
  return ctes;
}

function collectMatches(sql: string, regex: RegExp, out: Set<string>, cteNames?: Set<string>) {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(sql)) !== null) {
    const raw = match[1];
    if (!raw) continue;

    const normalized = stripBrackets(raw).trim();
    if (shouldSkip(normalized)) continue;
    if (cteNames?.has(normalized.toLowerCase())) continue;

    out.add(normalized);
  }
}

function shouldSkip(name: string): boolean {
  const lower = name.toLowerCase();
  if (activeSkipKeywords.has(lower)) return true;
  if (activeSkipPrefixes.some((p) => lower.startsWith(p))) return true;
  // Single-character unqualified names are always table aliases (a, b, t, etc.)
  if (!name.includes('.') && name.length === 1) return true;
  return false;
}
