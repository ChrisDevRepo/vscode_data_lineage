import type { ObjectType } from '../engine/types';
import { searchCatalog } from './modelSearch';

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
  return searchCatalog(nodes, term, undefined, undefined, limit) as AutocompleteNode[];
}
