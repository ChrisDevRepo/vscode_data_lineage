import type { ObjectType } from '../engine/types';

export interface AutocompleteNode {
  id: string;
  name: string;
  schema: string;
  type: ObjectType;
}

/** Filter, sort (starts-with first), and cap autocomplete suggestions. */
export function filterSuggestions(
  nodes: AutocompleteNode[],
  term: string,
  limit: number = 10,
): AutocompleteNode[] {
  if (term.length < 2) return [];
  const lower = term.toLowerCase();
  const matches = nodes
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
