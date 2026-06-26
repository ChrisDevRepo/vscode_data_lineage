import type { DatabaseModel } from './types';

/**
 * Returns the schemas represented by a curated AI preview node set.
 */
export function deriveAiPreviewExpandedSchemas(
  model: DatabaseModel,
  nodeIds: ReadonlySet<string>,
): Set<string> {
  const schemas = new Set<string>();
  for (const node of model.nodes) {
    if (nodeIds.has(node.id)) schemas.add(node.schema);
  }
  return schemas;
}
