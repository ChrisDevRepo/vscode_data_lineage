/**
 * @module ModelFilters
 * Utility functions for filtering the `DatabaseModel` to refine the visual graph: exclusion
 * patterns (regex) hiding objects or schemas, removal of isolated nodes, and node allowlists
 * (typically for focused tracing or selection).
 */

import { DatabaseModel } from './types';
import { compileExclusionMatcher } from '../utils/sql';

export { applyIsolationFilter } from './shared/modelFilters';

/**
 * The admit/refuse comparison behind {@link checkObjectLimit}, for a surface with only a count (the
 * wizard's schema preview) and no built model yet; `limit` is the configured
 * `dataLineageViz.maxNodes`.
 */
export function exceedsObjectLimit(count: number, limit: number): boolean {
  return count > limit;
}

/** Result of {@link checkObjectLimit}: the model admitted, or the count that refused it. */
export type ObjectLimitCheck =
  | { ok: true; model: DatabaseModel }
  | { ok: false; count: number; limit: number };

/**
 * Verifies a model's object count against `dataLineageViz.maxNodes` before it is loaded or
 * rendered. The single owner of the admit/refuse decision: every surface that can exceed the limit
 * (host load paths, the wizard, in-canvas schema filters) calls it instead of re-deriving the
 * comparison.
 *
 * @param model - The candidate model, already filtered to the selection under evaluation.
 * @returns `ok: true` with the model when within `limit`; otherwise `ok: false` with the node count
 *   and the limit that refused it.
 */
export function checkObjectLimit(model: DatabaseModel, limit: number): ObjectLimitCheck {
  const count = model.nodes.length;
  if (exceedsObjectLimit(count, limit)) return { ok: false, count, limit };
  return { ok: true, model };
}

/**
 * Builds the one user-facing message for an object-count refusal, shared by every surface that
 * reports it (the host's error toast or inline `db-error`, the wizard, the webview's warning).
 */
export function formatObjectLimitMessage(count: number, limit: number): string {
  return `${count.toLocaleString()} objects selected (limit ${limit.toLocaleString()}, set by dataLineageViz.maxNodes). Select fewer schemas or raise the setting.`;
}

/**
 * Removes nodes (and their edges) matching any regex exclusion pattern, tested against both the
 * `schema.name` format and the `fullName`.
 *
 * @param onInvalidPattern - Optional callback per unparseable pattern so the caller can surface it
 *   via its own logger or UI; invalid patterns are skipped.
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

/** Filters the model to the nodes explicitly present in the allowlist; an empty allowlist keeps no node. */
export function applyAllowlistFilter(model: DatabaseModel, allowlist: Set<string> | undefined): DatabaseModel {
  if (!allowlist) return model;
  const nodes = model.nodes.filter((n) => allowlist.has(n.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = model.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  return { ...model, nodes, edges };
}
