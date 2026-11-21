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
 * Filters the model to the nodes explicitly present in the allowlist; an empty allowlist keeps no
 * node.
 */
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
 * Whether a node survives the External References filter: a real object always, a virtual `file`
 * or `db` reference only when external refs are shown and its kind is selected. The one rule the
 * webview build and {@link userFilterAdmits} share.
 */
export function externalRefAdmits(showExternalRefs: boolean, externalRefTypes: ReadonlySet<string>): (n: LineageNode) => boolean {
  return n => (n.externalType !== 'file' && n.externalType !== 'db') || (showExternalRefs && externalRefTypes.has(n.externalType));
}

/**
 * The type, External References and name-exclusion parts of the user filter as one node
 * predicate; the schema part is {@link filterBySchemas} (edge-aware).
 */
function attributeAdmits(activeFilter: SerializedFilterState): (n: LineageNode) => boolean {
  const types = activeFilter.types?.length ? new Set<string>(activeFilter.types) : null;
  const isExcluded = compileExclusionMatcher(activeFilter.exclusionPatterns ?? []);
  const externalAdmits = externalRefAdmits(activeFilter.showExternalRefs, new Set(activeFilter.externalRefTypes));
  return n => (!types || types.has(n.type)) && externalAdmits(n) && !isExcluded?.(n);
}

/**
 * The graph view's user filter as one per-node predicate over the scope {@link countVisibleNodes}
 * counts: the schema scope ({@link filterBySchemas}, with the external references it touches),
 * the allowlist, the object-type filter, the External References filter and the name-exclusion
 * patterns. Hide Isolated is a view-layout rule and stays out.
 */
export function userFilterAdmits(model: DatabaseModel, activeFilter: SerializedFilterState): (n: LineageNode) => boolean {
  const inSchemaScope = activeFilter.schemas?.length ? new Set(filterBySchemas(model, new Set(activeFilter.schemas)).nodes.map(n => n.id)) : null;
  const allowlist = activeFilter.allowlistNodeIds && new Set(activeFilter.allowlistNodeIds);
  const attributes = attributeAdmits(activeFilter);
  return n => (!inSchemaScope || inSchemaScope.has(n.id)) && (!allowlist || allowlist.has(n.id)) && attributes(n);
}

/**
 * Objects shown over the same schema scope and attributes as {@link userFilterAdmits}
 * ({@link filterBySchemas}), with Hide Isolated applied before the allowlist; every object when
 * no filter is active.
 */
export function countVisibleNodes(model: DatabaseModel, activeFilter?: SerializedFilterState | null): number {
  if (!activeFilter) return model.nodes.length;
  const bySchema = activeFilter.schemas?.length ? filterBySchemas(model, new Set(activeFilter.schemas)) : model;
  const scoped = bySchema.nodes.filter(attributeAdmits(activeFilter));
  const scopedIds = new Set(scoped.map(n => n.id));
  const scopedModel = {
    ...model,
    nodes: scoped,
    edges: bySchema.edges.filter(e => scopedIds.has(e.source) && scopedIds.has(e.target)),
  };
  const allowlist = activeFilter.allowlistNodeIds && new Set(activeFilter.allowlistNodeIds);
  return applyAllowlistFilter(applyIsolationFilter(scopedModel, activeFilter.hideIsolated ?? false), allowlist).nodes.length;
}
