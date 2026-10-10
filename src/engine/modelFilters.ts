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
import { compileExclusionMatcher, schemaKey } from '../utils/sql';

export { applyIsolationFilter } from './shared/modelFilters';

/**
 * The admit/refuse comparison behind {@link checkObjectLimit}, for a surface that has only a count
 * (the wizard's schema preview) and no built model yet.
 *
 * @param count - Object count of the selection.
 * @param limit - The configured `dataLineageViz.maxNodes` value.
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
  if (exceedsObjectLimit(count, limit)) return { ok: false, count, limit };
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
  return `${count.toLocaleString()} objects selected (limit ${limit.toLocaleString()}, set by dataLineageViz.maxNodes). Select fewer schemas or raise the setting.`;
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
 * @param allowlist - IDs to retain; absent leaves the model unscoped and empty retains no objects.
 * @returns A filtered DatabaseModel instance.
 */
export function applyAllowlistFilter(model: DatabaseModel, allowlist: Set<string> | undefined): DatabaseModel {
  if (!allowlist) return model;
  const nodes = model.nodes.filter((n) => allowlist.has(n.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = model.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  return { ...model, nodes, edges };
}

/**
 * Filters an existing DatabaseModel in memory to include only objects from specific schemas.
 *
 * @remarks
 * Retains every matching object and every external reference it touches — this never truncates.
 * Callers that must honor `dataLineageViz.maxNodes` check the result with
 * {@link checkObjectLimit} before loading or rendering it.
 *
 * @param selectedSchemas - Set of schema names to retain.
 * @returns A new DatabaseModel instance containing the filtered subset.
 */
export function filterBySchemas(
  model: DatabaseModel,
  selectedSchemas: Set<string>,
): DatabaseModel {
  const lowerSelected = new Set(Array.from(selectedSchemas).map(s => schemaKey(s, model.identifierCaseSensitive)));
  const schemaNodes = model.nodes.filter((n) => lowerSelected.has(schemaKey(n.schema, model.identifierCaseSensitive)));
  const schemaNodeIds = new Set(schemaNodes.map(n => n.id));

  const connectedVirtualIds = new Set<string>();
  for (const e of model.edges) {
    if (schemaNodeIds.has(e.target)) connectedVirtualIds.add(e.source);
    if (schemaNodeIds.has(e.source)) connectedVirtualIds.add(e.target);
  }
  const virtualNodes = model.nodes.filter((n) =>
    n.type === 'external' && connectedVirtualIds.has(n.id) && !schemaNodeIds.has(n.id)
  );
  const filtered = [...schemaNodes, ...virtualNodes];
  const nodeIds = new Set(filtered.map((n) => n.id));

  const edges = model.edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target)
  );

  return {
    ...model,
    nodes: filtered,
    edges,
    schemas: model.schemas.filter((s) => lowerSelected.has(schemaKey(s.name, model.identifierCaseSensitive))),
  };
}

/**
 * Removes nodes from a DatabaseModel that match specified exclusion patterns, and records
 * the removed objects on the parse statistics of the surviving objects that referenced them.
 *
 * @remarks
 * Node and edge exclusion is delegated to {@link applyExclusionFilter} so the load-time and
 * graph-time paths cannot diverge; only the parse-stat annotation is specific to this entry
 * point. Invalid patterns are skipped and reported, matching that function's contract.
 *
 * @param model - The DatabaseModel to filter.
 * @param patterns - Array of regex pattern strings.
 * @param onWarning - Callback receiving a formatted message for each invalid regex pattern.
 * @returns A new DatabaseModel with matching nodes and edges removed.
 */
export function applyExclusionPatterns(model: DatabaseModel, patterns: string[], onWarning?: (msg: string) => void): DatabaseModel {
  const filtered = applyExclusionFilter(model, patterns, (pattern, err) => {
    onWarning?.(`Invalid exclude pattern "${pattern}": ${err instanceof Error ? err.message : err}`);
  });
  if (filtered === model) return model;

  const { nodes } = filtered;
  const nodeIds = new Set(nodes.map((n) => n.id));
  const excludedNodes = model.nodes.filter((n) => !nodeIds.has(n.id));

  const excludedIds = new Set(excludedNodes.map((n) => n.id));
  const excludedNameById = new Map(excludedNodes.map((n) => [n.id, `${n.schema}.${n.name}`]));
  let parseStats = model.parseStats;
  if (parseStats && excludedIds.size > 0) {
    const allEdges = model.edges;

    const nameToIdMap = new Map<string, string>();
    for (const n of nodes) nameToIdMap.set(schemaKey(`${n.schema}.${n.name}`, model.identifierCaseSensitive), n.id);
    for (const n of excludedNodes) {
      const key = schemaKey(`${n.schema}.${n.name}`, model.identifierCaseSensitive);
      if (!nameToIdMap.has(key)) nameToIdMap.set(key, n.id);
    }

    const adjacency = new Map<string, string[]>();
    for (const e of allEdges) {
      if (excludedIds.has(e.target)) {
        let arr = adjacency.get(e.source);
        if (!arr) { arr = []; adjacency.set(e.source, arr); }
        arr.push(e.target);
      }
      if (excludedIds.has(e.source)) {
        let arr = adjacency.get(e.target);
        if (!arr) { arr = []; adjacency.set(e.target, arr); }
        arr.push(e.source);
      }
    }

    parseStats = {
      ...parseStats,
      spDetails: parseStats.spDetails.map((sp) => {
        const spId = nameToIdMap.get(schemaKey(sp.name, model.identifierCaseSensitive));
        if (!spId) return sp;
        const neighbors = adjacency.get(spId);
        if (!neighbors) return sp;
        const lost = neighbors.map(id => excludedNameById.get(id)!).filter(Boolean);
        return lost.length > 0 ? { ...sp, excluded: lost } : sp;
      }),
    };
  }

  return { ...filtered, parseStats };
}
