/** Builds invocation labels for externally invoked contributed VS Code LM tools. */
export function getToolInvocationLabel(name: string, input: unknown): string {
  const inp = input as Record<string, unknown> | null | undefined;
  switch (name) {
    case 'lineage_get_context':
      return 'Loading lineage context…';
    case 'lineage_get_screen_state': {
      const recalled = inp?.ids;
      if (Array.isArray(recalled)) {
        return `Recalling ${recalled.length} object${recalled.length === 1 ? '' : 's'} from the stored run…`;
      }
      const listed = inp?.filter;
      if (typeof listed === 'string')
        return `Listing ${listed.replace(/_/g, ' ')} from the stored run…`;
      return 'Reading screen state…';
    }
    case 'lineage_search_objects':
      return `Searching for "${(inp?.query as string | undefined) ?? ''}"…`;
    case 'lineage_get_object_detail':
      return `Loading detail for ${(inp?.id as string | undefined) ?? '…'}…`;
    case 'lineage_detect_graph_patterns':
      return `Detecting graph patterns: ${(inp?.type as string | undefined) ?? ''}…`;
    case 'lineage_search_ddl':
      return `Searching DDL for "${(inp?.query as string | undefined) ?? ''}"…`;
    case 'lineage_get_neighbor_columns': {
      const ids = inp?.ids as unknown[] | undefined;
      const n = ids?.length ?? 0;
      return `Inspecting ${n} neighbor${n === 1 ? '' : 's'} for pruning…`;
    }
    default:
      return `Invoking ${name.replace('lineage_', '')}…`;
  }
}
