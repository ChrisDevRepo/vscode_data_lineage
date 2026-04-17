import type { ObjectType } from '../engine/types';
import { searchCatalog } from './modelSearch';

/**
 * Represents a simplified node structure optimized for autocomplete operations.
 */
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
 * This function leverages the centralized `searchCatalog` logic to provide
 * consistent fuzzy and prefix-based searching across the application.
 *
 * @param nodes - The array of candidate nodes to search within.
 * @param term - The search query string entered by the user.
 * @param limit - The maximum number of suggestions to return (defaults to 10).
 * @returns A filtered and sorted array of `AutocompleteNode` objects.
 *
 * @remarks
 * Suggestions are only generated if the search term is at least 2 characters long
 * to prevent excessive computation and UI noise.
 */
export function filterSuggestions(
  nodes: AutocompleteNode[],
  term: string,
  limit: number = 10,
): AutocompleteNode[] {
  if (term.length < 2) return [];
  return searchCatalog(nodes, term, undefined, undefined, limit);
}
