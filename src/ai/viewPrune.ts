/**
 * Pure prune helper for `present_result`.
 *
 * Kept in its own module (no `vscode` imports) so unit tests can exercise it
 * from plain Node without the VS Code extension host.
 */

/**
 * Removes nodes listed in `pruneIds` and drops every edge touching a pruned node.
 *
 * @remarks
 * Intentionally does NOT reconnect edges across pruned nodes. A prior passthrough
 * rewrite fabricated phantom edges between unrelated siblings of a shared hub
 * (pruning a staging table produced `upstream_source → downstream_sink` edges that
 * never existed). Simple filtering matches the 0.9.8 behavior callers rely on.
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
