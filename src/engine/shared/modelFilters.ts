/**
 * Isolated-node filtering and the user-filter visibility rule, shared by the extension host, the AI subsystem and the webview. Lives
 * under `src/engine/shared/`, the VS Code-free surface both bundles may import, because
 * `src/ai/tools/tools.ts` needs it without opening a new `src/ai -> src/engine` coupling the
 * architecture gates forbid. `src/engine/modelFilters.ts` re-exports it.
 */
import type { DatabaseModel, LineageNode } from '../types';
import type { SerializedFilterState } from './bridgeContract';
import { compileExclusionMatcher, schemaKey } from '../../utils/sql';

/** Removes isolated nodes (total degree zero) when `hideIsolated` is true. */
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
 * The graph view's user filter as one node predicate: the schema filter, the object-type filter and
 * the name-exclusion patterns. Hide Isolated is a view-layout rule and stays out.
 */
export function userFilterAdmits(model: DatabaseModel, activeFilter: SerializedFilterState): (n: LineageNode) => boolean {
  const schemaKeys = activeFilter.schemas?.length ? new Set(activeFilter.schemas.map(s => schemaKey(s, model.identifierCaseSensitive))) : null;
  const types = activeFilter.types?.length ? new Set<string>(activeFilter.types) : null;
  const isExcluded = compileExclusionMatcher(activeFilter.exclusionPatterns ?? []);
  return n => (!schemaKeys || schemaKeys.has(schemaKey(n.schema, model.identifierCaseSensitive)))
    && (!types || types.has(n.type))
    && !isExcluded?.(n);
}

/** Objects shown by the user filter ({@link userFilterAdmits}), then Hide Isolated. */
export function countVisibleNodes(model: DatabaseModel, activeFilter: SerializedFilterState): number {
  const scoped = model.nodes.filter(userFilterAdmits(model, activeFilter));
  const scopedIds = new Set(scoped.map(n => n.id));
  const scopedModel = {
    ...model,
    nodes: scoped,
    edges: model.edges.filter(e => scopedIds.has(e.source) && scopedIds.has(e.target)),
  };
  return applyIsolationFilter(scopedModel, activeFilter.hideIsolated ?? false).nodes.length;
}
