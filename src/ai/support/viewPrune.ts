/** Pure prune helper for `present_result`. */

/** Removes nodes listed in `pruneIds` and drops every edge touching a pruned node. */
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
