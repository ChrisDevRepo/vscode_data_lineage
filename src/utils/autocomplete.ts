import type { ObjectType } from '../engine/types';
import { searchCatalog } from './modelSearch';

/** Searchable node fields required by autocomplete. */
export interface AutocompleteNode {
  /** Unique identifier of the node (schema.object). */
  id: string;
  /** Name of the database object. */
  name: string;
  /** Schema name the object belongs to. */
  schema: string;
  /** The type of database object (e.g., Table, View). */
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
