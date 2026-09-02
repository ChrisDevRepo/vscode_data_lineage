import type { ObjectType, ColumnDef } from '../engine/types';

/** Node fields required by catalog, DDL, and column search. */
export interface SearchableNode {
  /** Unique identifier of the node (schema.object). */
  id: string;
  /** Name of the database object. */
  name: string;
  /** Schema name the object belongs to. */
  schema: string;
  /** The type of database object (e.g., Table, View). */
  type: ObjectType;
  /** Optional secondary type for external references. */
  externalType?: string;
  /** The raw SQL definition or body script of the object. */
  bodyScript?: string;
  /** The collection of columns belonging to the object. */
  columns?: ColumnDef[];
}

/**
 * Represents a match found within a DDL body script or column list.
 */
interface DdlMatch {
  /** The node that contains the match. */
  node: SearchableNode;
  /** A formatted snippet showing the context of the match. */
  snippet: string;
}

/** Heuristic ReDoS guard budget, in milliseconds, shared by `safeRegex` and `regexRejectHint`. */
const REDOS_BUDGET_MS = 5;

/**
 * Runs `regex` against a bounded sample and reports whether it exceeded the ReDoS guard budget.
 *
 * @remarks
 * Uses `performance.now()` (sub-ms precision) instead of `Date.now()` (1ms / 15ms on Windows).
 */
function exceedsRedosBudget(regex: RegExp): boolean {
  const sample = 'a'.repeat(200);
  const start = performance.now();
  regex.test(sample);
  return performance.now() - start > REDOS_BUDGET_MS;
}

/**
 * Compiles a search pattern into a safe, case-insensitive Regular Expression.
 *
 * @param pattern - The raw regex string to compile.
 * @returns A compiled `RegExp` object, or `null` if the pattern is invalid or risky.
 *
 * @remarks Rejects patterns that fail to execute against a bounded sample within 5 ms.
 */
export function safeRegex(pattern: string): RegExp | null {
  try {
    const r = new RegExp(pattern, 'i');
    // Heuristic ReDoS guard: reject patterns that take too long on a 200-char string.
    if (exceedsRedosBudget(r)) return null;
    return r;
  } catch {
    return null;
  }
}

/**
 * Explains why `safeRegex` rejected a pattern and names the edit that fixes it.
 *
 * @param pattern - The raw regex string that `safeRegex` rejected.
 * @returns A hint describing the concrete repair, derived from the actual
 *   `SyntaxError` V8 raises for `pattern` (or from the ReDoS guard, when the
 *   pattern compiles but ran over budget).
 *
 * @remarks
 * `safeRegex` collapses two distinct rejection reasons — a compile failure and
 * a pattern that compiled but timed out against the ReDoS sample — into a
 * single `null`. This re-derives which one actually happened by recompiling
 * `pattern` and inspecting the real `SyntaxError`, instead of assuming one
 * fixed cause for every rejection. `searchCatalog`'s regex mode (and its
 * callers) always add the `i` flag, so patterns never need — and JavaScript
 * regular expressions never support — an inline case-insensitivity flag.
 */
export function regexRejectHint(pattern: string): string {
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, 'i');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\(\?P</.test(pattern) && message.includes('Invalid group')) {
      return 'Rename the named group from "(?P<name>...)" to "(?<name>...)" — that is the JavaScript syntax.';
    }
    if (/\(\?#/.test(pattern) && message.includes('Invalid group')) {
      return 'Remove the "(?#...)" comment group — JavaScript regular expressions do not support inline comments.';
    }
    if (/\(\?[a-zA-Z-]+[):]/.test(pattern) && message.includes('Invalid group')) {
      return 'Remove the inline flag group (e.g. "(?i)") — matches are already case-insensitive by default, and JavaScript regular expressions do not support inline flags.';
    }
    if (message.includes('Invalid group')) {
      return 'Remove or correct the unsupported "(?...)" group syntax — JavaScript does not recognize it.';
    }
    if (message.includes('Unterminated group')) {
      return 'Add the missing closing ")" — a "(" (or "(?<name>") was opened but never closed.';
    }
    if (message.includes("Unmatched ')'")) {
      return 'Remove the extra ")" or add the "(" it is meant to close.';
    }
    if (message.includes('Unterminated character class')) {
      return 'Add the missing closing "]" to the character class.';
    }
    if (message.includes('Range out of order in character class')) {
      return 'Reorder the character class range so the lower bound comes first (e.g. "[a-z]", not "[z-a]").';
    }
    if (message.includes('Duplicate capture group name')) {
      return 'Rename one of the duplicate "(?<name>...)" groups — each group name must be unique.';
    }
    if (message.includes('numbers out of order in {} quantifier')) {
      return 'Reorder the quantifier bounds so the minimum comes first (e.g. "{1,2}", not "{2,1}").';
    }
    if (message.includes('Nothing to repeat')) {
      return 'Remove or reposition the quantifier (*, +, ?, or {}) — it has nothing before it to repeat.';
    }
    if (message.includes('at end of pattern')) {
      return 'Remove the trailing "\\" or complete the escape sequence it starts.';
    }
    return `Fix the pattern: ${message.replace(/^Invalid regular expression: .*?: /, '')}.`;
  }

  // Compiled successfully — safeRegex must have rejected it for running over the ReDoS budget.
  if (exceedsRedosBudget(compiled)) {
    return 'Simplify the pattern — avoid nested quantifiers (e.g. "(a+)+") that can backtrack catastrophically.';
  }
  return 'Simplify the pattern.';
}

/**
 * Searches the flat node catalog by object name with ranking and filtering.
 *
 * @param nodes - The catalog of nodes to search.
 * @param query - The search query string.
 * @param types - Optional set of allowed object types.
 * @param schemas - Optional set of allowed schema names.
 * @param limit - Maximum number of results to return (default: 20).
 * @param mode - Search mode: 'substring' (default) or 'regex'.
 *
 * @returns A ranked and filtered array of matching nodes.
 *
 * @remarks
 * In substring mode, results are ranked such that objects whose names
 * START with the query appear before objects that merely contain the query.
 */
export function searchCatalog(
  nodes: SearchableNode[],
  query: string,
  types?: Set<ObjectType>,
  schemas?: Set<string>,
  limit = 20,
  mode: 'substring' | 'regex' = 'substring',
): SearchableNode[] {
  if (query.length < 1) return [];
  let filtered = nodes;
  if (types && types.size > 0) filtered = filtered.filter(n => types.has(n.type));
  if (schemas && schemas.size > 0) filtered = filtered.filter(n => schemas.has(n.schema));

  // Regex mode: match against name or schema.name
  if (mode === 'regex') {
    const re = safeRegex(query);
    if (!re) return [];
    return filtered
      .filter(n => re.test(n.name) || re.test(`${n.schema}.${n.name}`))
      .slice(0, limit);
  }

  // Substring mode (default): case-insensitive, starts-with ranked first
  const lower = query.toLowerCase();
  const matches = filtered
    .map(n => ({ node: n, nameLower: n.name.toLowerCase(), idLower: n.id.toLowerCase() }))
    .filter(m => m.nameLower.includes(lower) || m.idLower.includes(lower));

  matches.sort((a, b) => {
    const aStarts = a.nameLower.startsWith(lower) || a.idLower.startsWith(lower);
    const bStarts = b.nameLower.startsWith(lower) || b.idLower.startsWith(lower);
    if (aStarts && !bStarts) return -1;
    if (!aStarts && bStarts) return 1;
    return a.node.name.localeCompare(b.node.name);
  });

  return matches.slice(0, limit).map(m => m.node);
}

/**
 * Searches the SQL DDL body scripts for a specific term.
 *
 * @param nodes - The catalog of nodes to search.
 * @param query - The term to search for (minimum 2 chars).
 * @param types - Optional set of allowed object types.
 * @param contextLines - Number of context lines to include in the snippet (default: 2).
 * @param limit - Maximum number of results to return (default: 100).
 *
 * @returns An array of matches, each containing a node and a context snippet.
 */
export function searchBodyScripts(
  nodes: SearchableNode[],
  query: string,
  types?: Set<ObjectType>,
  contextLines = 2,
  limit = 100,
): DdlMatch[] {
  if (query.length < 2) return [];
  const lower = query.toLowerCase();
  let filtered = nodes;
  if (types && types.size > 0) filtered = filtered.filter(n => n.bodyScript && types.has(n.type));

  const matches: DdlMatch[] = [];
  for (const node of filtered) {
    if (!node.bodyScript) continue;
    if (!node.bodyScript.toLowerCase().includes(lower)) continue;
    matches.push({ node, snippet: buildSnippet(node.bodyScript, query, contextLines) });
    if (matches.length >= limit) break;
  }
  return matches;
}

/**
 * Searches for nodes by matching column names.
 *
 * @param nodes - The catalog of nodes to search.
 * @param query - The column name term to search for.
 * @param limit - Maximum number of results to return.
 *
 * @returns An array of matches containing the node and a list of matching columns.
 */
export function searchColumns(
  nodes: SearchableNode[],
  query: string,
  limit = 100,
): DdlMatch[] {
  if (query.length < 2) return [];
  const lower = query.toLowerCase();
  const matches: DdlMatch[] = [];
  for (const node of nodes) {
    if (node.type !== 'table' && node.type !== 'external') continue;
    if (!node.columns?.length) continue;
    const matching = node.columns.filter(c => c.name.toLowerCase().includes(lower));
    if (matching.length === 0) continue;
    const snippet = matching.slice(0, 3).map(c => `${c.name} (${c.type})`).join(', ');
    matches.push({ node, snippet });
    if (matches.length >= limit) break;
  }
  return matches;
}

/**
 * Builds a formatted context snippet for a match found in a body script.
 *
 * @param body - The full SQL text.
 * @param term - The matched term.
 * @param contextLines - The number of lines around the match to include.
 * @returns A multi-line string containing the match context.
 */
function buildSnippet(body: string, term: string, contextLines: number): string {
  const lower = body.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx < 0) return '';

  const lines = body.split('\n');
  let charCount = 0;
  let matchLine = 0;
  for (let i = 0; i < lines.length; i++) {
    charCount += lines[i].length + 1;
    if (charCount > idx) { matchLine = i; break; }
  }

  const start = Math.max(0, matchLine - (contextLines - 1));
  const end = Math.min(lines.length, matchLine + contextLines);
  const termLower = term.toLowerCase();
  const LINE_CAP = 50; // sidebar panel is ~50 monospace chars wide
  return lines.slice(start, end).map(l => {
    const trimmed = l.trimEnd();
    const matchPos = trimmed.toLowerCase().indexOf(termLower);
    if (matchPos < 0 || trimmed.length <= LINE_CAP) return trimmed;
    // Trim long lines so the match stays within the visible panel width.
    const windowStart = Math.max(0, matchPos - 10);
    const windowEnd = Math.min(trimmed.length, windowStart + LINE_CAP);
    return (windowStart > 0 ? '\u2026' : '') +
      trimmed.slice(windowStart, windowEnd) +
      (windowEnd < trimmed.length ? '\u2026' : '');
  }).join('\n');
}
