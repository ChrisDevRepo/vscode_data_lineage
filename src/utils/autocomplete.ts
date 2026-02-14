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
  return nodes
    .filter(n => n.name.toLowerCase().includes(lower))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(lower);
      const bStarts = b.name.toLowerCase().startsWith(lower);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}
