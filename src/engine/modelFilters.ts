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
import { compileExclusionMatcher } from '../utils/sql';

export { applyIsolationFilter } from './shared/modelFilters';

/** Result of {@link checkObjectLimit}: the model admitted, or the count that refused it. */
export type ObjectLimitCheck =
  | { ok: true; model: DatabaseModel }
  | { ok: false; count: number; limit: number };

/**
 * Verifies a model's object count against `dataLineageViz.maxNodes` before it is loaded or
 * rendered. This is the single owner of the admit/refuse decision — every surface that can
 * exceed the limit (host load paths, the wizard, in-canvas schema filters) calls it instead of
 * re-deriving the comparison.
 *
 * @param model - The candidate model, already filtered to the selection under evaluation.
 * @param limit - The configured `dataLineageViz.maxNodes` value.
 * @returns `ok: true` with the model when its node count is within `limit`; otherwise `ok: false`
 *   with the node count and the limit that refused it.
 */
export function checkObjectLimit(model: DatabaseModel, limit: number): ObjectLimitCheck {
  const count = model.nodes.length;
  if (count > limit) return { ok: false, count, limit };
  return { ok: true, model };
}

/**
 * Builds the one user-facing message for an object-count refusal, shared by every surface that
 * reports it (the host's error toast or inline `db-error`, the wizard, the webview's warning).
 *
 * @param count - The refused object count.
 * @param limit - The configured `dataLineageViz.maxNodes` value.
 */
export function formatObjectLimitMessage(count: number, limit: number): string {
  return `${count.toLocaleString()} objects selected (limit ${limit.toLocaleString()}, set by dataLineageViz.maxNodes). Select fewer schemas.`;
}

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

  const isExcluded = compileExclusionMatcher(patterns, onInvalidPattern);
  if (!isExcluded) return model;

  const nodes = model.nodes.filter((n) => !isExcluded(n));
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
