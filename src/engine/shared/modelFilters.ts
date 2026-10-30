/** Isolated-node filtering shared by the extension host, the AI subsystem and the webview. */
import { DatabaseModel } from '../types';

/** Filters the model by removing isolated nodes (nodes with a total degree of zero). */
export function applyIsolationFilter(
  model: DatabaseModel,
  hideIsolated: boolean,
): DatabaseModel {
  if (!hideIsolated) return model;

  const connectedIds = new Set<string>();
  for (const e of model.edges) {
    connectedIds.add(e.source);
    connectedIds.add(e.target);
  }

  const nodes = model.nodes.filter((n) => connectedIds.has(n.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = model.edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
  );

  return { ...model, nodes, edges };
}
