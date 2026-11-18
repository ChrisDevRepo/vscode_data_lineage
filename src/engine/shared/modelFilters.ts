/**
 * Isolated-node filtering shared by the extension host, the AI subsystem and the webview. Lives
 * under `src/engine/shared/`, the VS Code-free surface both bundles may import, because
 * `src/ai/tools/tools.ts` needs it without opening a new `src/ai -> src/engine` coupling the
 * architecture gates forbid. `src/engine/modelFilters.ts` re-exports it.
 */
import { DatabaseModel } from '../types';

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
