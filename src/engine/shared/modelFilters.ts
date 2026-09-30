/**
 * Isolated-node filtering shared by the extension host, the AI subsystem and the webview.
 *
 * @remarks
 * This lives under `src/engine/shared/` — the VS Code-free surface both bundles may import —
 * because `src/ai/tools/tools.ts` needs it too, without opening a new `src/ai -> src/engine`
 * coupling the architecture rule gates forbid. `src/engine/modelFilters.ts` re-exports it so
 * existing callers (the webview's `useGraphology`) are unaffected.
 */
import { DatabaseModel } from '../types';

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
