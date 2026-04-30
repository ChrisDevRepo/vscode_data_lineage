/**
 * @module ModelFilters
 * Provides utility functions for filtering the `DatabaseModel` based on various criteria.
 *
 * These filters are used to refine the visual graph by:
 * - Applying exclusion patterns (regex) to hide specific objects or schemas.
 * - Removing isolated nodes that have no connections.
 * - Enforcing node allowlists (typically used during focused tracing or selection).
 */

import { DatabaseModel } from './types';
import { compileExclusionPattern } from '../utils/sql';

/**
 * Filters the model by removing nodes that match any of the provided regex exclusion patterns.
 * Matches are performed against both the `schema.name` format and the `fullName`.
 *
 * @param model - The database model to filter.
 * @param patterns - A list of regex strings defining the exclusion rules.
 * @param onInvalidPattern - Optional callback invoked for each unparseable pattern so the
 *   caller can surface the error via its own logger or UI. Invalid patterns are skipped.
 * @returns A new DatabaseModel instance with matching nodes and their associated edges removed.
 */
export function applyExclusionFilter(
  model: DatabaseModel,
  patterns: string[],
  onInvalidPattern?: (pattern: string, err: unknown) => void,
): DatabaseModel {
  if (!patterns || patterns.length === 0) return model;

  const regexes: RegExp[] = [];
  for (const p of patterns) {
    try {
      regexes.push(compileExclusionPattern(p));
    } catch (err) {
      onInvalidPattern?.(p, err);
    }
  }

  if (regexes.length === 0) return model;

  const nodes = model.nodes.filter((n) => {
    const name = `${n.schema}.${n.name}`;
    return !regexes.some((r) => r.test(name) || r.test(n.fullName));
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = model.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  return { ...model, nodes, edges };
}

/**
 * Filters the model by removing isolated nodes (nodes with a total degree of zero).
 * 
 * @param model - The database model to filter.
 * @param hideIsolated - If `true`, isolation filtering is applied.
 * @returns A filtered DatabaseModel instance.
 */
export function applyIsolationFilter(model: DatabaseModel, hideIsolated: boolean): DatabaseModel {
  if (!hideIsolated) return model;

  const connectedIds = new Set<string>();
  for (const e of model.edges) {
    connectedIds.add(e.source);
    connectedIds.add(e.target);
  }

  const nodes = model.nodes.filter((n) => connectedIds.has(n.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = model.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  return { ...model, nodes, edges };
}

/**
 * Filters the model to include only nodes explicitly present in the provided allowlist.
 * 
 * @param model - The database model to filter.
 * @param allowlist - A set of node IDs to retain.
 * @returns A filtered DatabaseModel instance.
 */
export function applyAllowlistFilter(model: DatabaseModel, allowlist: Set<string> | undefined): DatabaseModel {
  if (!allowlist || allowlist.size === 0) return model;
  const nodes = model.nodes.filter((n) => allowlist.has(n.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = model.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  return { ...model, nodes, edges };
}
