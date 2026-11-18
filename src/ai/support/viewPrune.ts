/**
 * Pure prune helper for `present_result`, in its own module (no `vscode` imports) so unit tests run
 * in plain Node.
 */

/**
 * Removes nodes listed in `pruneIds` and every edge touching one. Deliberately does NOT reconnect
 * edges across pruned nodes: that would fabricate phantom edges between unrelated siblings of a
 * shared hub (pruning a staging table would yield `upstream_source → downstream_sink` edges absent
 * from the source model).
 */
export function prunePreserveOnly(
  nodeIds: ReadonlyArray<string>,
  edges: ReadonlyArray<[string, string, string]>,
  pruneIds: ReadonlyArray<string>,
): { nodeIds: string[]; edges: [string, string, string][] } {
  const pruneSet = new Set(pruneIds);
  return {
    nodeIds: nodeIds.filter(id => !pruneSet.has(id)),
    edges: edges.filter(([src, tgt]) => !pruneSet.has(src) && !pruneSet.has(tgt)),
  };
}
