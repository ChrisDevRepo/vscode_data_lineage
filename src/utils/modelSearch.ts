import type { ObjectType } from '../engine/types';

export interface SearchableNode {
  id: string;
  name: string;
  schema: string;
  type: ObjectType;
  externalType?: string;
  bodyScript?: string;
}

export interface DdlMatch {
  node: SearchableNode;
  snippet: string;
}

/**
 * Compile a search pattern to a RegExp with case-insensitive flag.
 * Returns null if the pattern is invalid or triggers catastrophic backtracking.
 */
export function safeRegex(pattern: string): RegExp | null {
  try {
    const r = new RegExp(pattern, 'i');
    // Heuristic ReDoS guard: reject patterns that take >5ms on a 200-char string.
    // Uses performance.now() (sub-ms precision) instead of Date.now() (1ms / 15ms on Windows).
    // Not a complete defense — structural analysis would be needed for full coverage.
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
 * Search a flat list of nodes by name (starts-with ranked first), with optional
 * type and schema filters. Returns at most `limit` matches.
 */
export function searchCatalog(
  nodes: SearchableNode[],
  query: string,
  types?: Set<ObjectType>,
  schemas?: Set<string>,
  limit: number = 20,
): SearchableNode[] {
  if (query.length < 1) return [];
  const lower = query.toLowerCase();
  let filtered = nodes;
  if (types && types.size > 0) filtered = filtered.filter(n => types.has(n.type));
  if (schemas && schemas.size > 0) filtered = filtered.filter(n => schemas.has(n.schema));

  const matches = filtered
    .map(n => ({ node: n, lower: n.name.toLowerCase() }))
    .filter(m => m.lower.includes(lower));

  matches.sort((a, b) => {
    const aStarts = a.lower.startsWith(lower);
    const bStarts = b.lower.startsWith(lower);
    if (aStarts && !bStarts) return -1;
    if (!aStarts && bStarts) return 1;
    return a.node.name.localeCompare(b.node.name);
  });

  return matches.slice(0, limit).map(m => m.node);
}

/**
 * Search DDL body scripts of nodes for a term (case-insensitive substring).
 * Returns at most `limit` matches with a context snippet showing `contextLines` around the match.
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
  return lines.slice(start, end).map(l => l.trimEnd()).join('\n');
}
