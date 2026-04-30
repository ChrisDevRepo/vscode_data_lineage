import type { ObjectType, ColumnDef } from '../engine/types';

/**
 * Represents a node structure optimized for search and filtering operations.
 */
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
export interface DdlMatch {
  /** The node that contains the match. */
  node: SearchableNode;
  /** A formatted snippet showing the context of the match. */
  snippet: string;
}

/**
 * Compiles a search pattern into a safe, case-insensitive Regular Expression.
 *
 * @param pattern - The raw regex string to compile.
 * @returns A compiled `RegExp` object, or `null` if the pattern is invalid or risky.
 *
 * @remarks
 * Architectural Remark:
 * Includes a heuristic ReDoS (Regular Expression Denial of Service) guard.
 * If execution on a 200-character sample string exceeds 5ms, the pattern
 * is rejected as potentially catastrophic.
 */
export function safeRegex(pattern: string): RegExp | null {
  try {
    const r = new RegExp(pattern, 'i');
    // Heuristic ReDoS guard: reject patterns that take >5ms on a 200-char string.
    // Uses performance.now() (sub-ms precision) instead of Date.now() (1ms / 15ms on Windows).
    const sample = 'a'.repeat(200);
    const start = performance.now();
    r.test(sample);
    if (performance.now() - start > 5) return null;
    return r;
  } catch {
    return null;
  }
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
  limit: number = 20,
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
  contextLines: number = 2,
  limit: number = 100,
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
  limit: number = 100,
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
