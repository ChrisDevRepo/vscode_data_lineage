import type { ObjectType } from '../engine/types';
import { searchCatalog } from './modelSearch';

/** Searchable node fields required by autocomplete. */
export interface AutocompleteNode {
  id: string;
  name: string;
  schema: string;
  type: ObjectType;
}

/** Filters and ranks autocomplete suggestions based on a search term. */
export function filterSuggestions(
  nodes: AutocompleteNode[],
  term: string,
  limit = 10,
): AutocompleteNode[] {
  if (term.length < 2) return [];
  return searchCatalog(nodes, term, undefined, undefined, limit);
}
