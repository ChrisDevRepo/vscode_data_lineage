/**
 * Single source of truth for the user-facing label that announces a tool invocation.
 *
 * @remarks
 * Consumed by both `prepareInvocation()` in toolProvider.ts AND the chat participant's
 * progress writer. Keeping one definition prevents the two surfaces from drifting.
 * The `submit_findings` branch returns the static fallback; the participant overrides
 * it with a hop-aware "Hop N / M — analyzing X…" line that needs SM state which
 * `prepareInvocation` cannot see.
 */
export function getToolInvocationLabel(name: string, input: unknown): string {
  const inp = input as Record<string, unknown> | null | undefined;
  switch (name) {
    case 'lineage_get_context':
      return 'Loading lineage context…';
    case 'lineage_search_objects':
      return `Searching for "${(inp?.query as string | undefined) ?? ''}"…`;
    case 'lineage_get_scope_bundle':
      return `Bundling scope for ${(inp?.origin as string | undefined) ?? '…'}…`;
    case 'lineage_start_exploration':
      return 'Starting exploration…';
    case 'lineage_present_result':
      return 'Creating AI lineage view…';
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
    case 'lineage_submit_findings': {
      if (Array.isArray(input)) {
        return `Analyzing batch of ${input.length} objects…`;
      }
      const focus = (inp?.focus_node_id as string | undefined)?.split('.').pop()?.replace(/[\[\]]/g, '') ?? 'node';
      return `Analyzing ${focus}…`;
    }
    default:
      return `Invoking ${name.replace('lineage_', '')}…`;
  }
}
