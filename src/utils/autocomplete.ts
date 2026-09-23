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

/**
 * Filters and ranks autocomplete suggestions based on a search term.
 *
 * @param limit - The maximum number of suggestions to return (defaults to 10).
 *
 * @remarks
 * Suggestions are only generated if the search term is at least 2 characters long,
 * to prevent excessive computation and UI noise.
 */
export function filterSuggestions(
  nodes: AutocompleteNode[],
  term: string,
  limit = 10,
): AutocompleteNode[] {
  if (term.length < 2) return [];
  return searchCatalog(nodes, term, undefined, undefined, limit);
}
