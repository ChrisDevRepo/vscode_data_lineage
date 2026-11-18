/**
 * @module ModelFilters
 * Utility functions for filtering the `DatabaseModel` to refine the visual graph: exclusion
 * patterns (regex) hiding objects or schemas, removal of isolated nodes, and node allowlists
 * (typically for focused tracing or selection).
 */

import { DatabaseModel } from './types';
import { compileExclusionMatcher, schemaKey } from '../utils/sql';
import { computeSchemas } from './shared/modelSchemas';

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

/**
 * Filters an existing DatabaseModel in memory to objects from specific schemas. Retains every
 * matching object and every external reference it touches; it never truncates. Callers that must
 * honor `dataLineageViz.maxNodes` check the result with {@link checkObjectLimit} before loading or
 * rendering it.
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
    nodes: filtered,
    edges,
    schemas: model.schemas.filter((s) => lowerSelected.has(schemaKey(s.name, model.identifierCaseSensitive))),
    catalog: model.catalog,
    neighborIndex: model.neighborIndex,
    parseStats: model.parseStats,
    warnings: model.warnings,
    identifierCaseSensitive: model.identifierCaseSensitive,
  };
}

/**
 * Removes nodes matching exclusion patterns and records the removed objects on the parse statistics
 * of surviving objects that referenced them. Node and edge exclusion is delegated to
 * {@link applyExclusionFilter} so load-time and graph-time paths cannot diverge; only the
 * parse-stat annotation is specific here. Invalid patterns are skipped and reported via
 * `onWarning`.
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

/**
 * Scopes a loaded model to the schemas chosen for Visualize, removes excluded objects, and
 * recounts the schema list from the surviving nodes.
 */
export function scopeModelForVisualize(
  model: DatabaseModel,
  selectedSchemas: Set<string>,
  patterns: string[],
  onWarning?: (msg: string) => void,
): DatabaseModel {
  const scoped = applyExclusionPatterns(filterBySchemas(model, selectedSchemas), patterns, onWarning);
  return { ...scoped, schemas: computeSchemas(scoped.nodes) };
}
