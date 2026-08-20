/**
 * Pure markdown renderer for the `confirm_sm_start` gate's scope tree.
 *
 * @remarks
 * Lives in its own file (no `vscode` import) so unit tests can exercise it without
 * the VS Code module surface. Single source of truth for the native gate markdown.
 */

import type { ScopeSummary } from '../sm/smTypes';
import { pluralize } from '../support/text';

/** Formats a count with its noun; the suffix rule itself lives in the shared `pluralize`. */
function plural(n: number, noun: string): string {
  return `${n} ${pluralize(n, noun)}`;
}

/** Capitalizes and pluralizes an object-type label for display in the scope tree. */
function typeLabel(type: string, count: number): string {
  const capitalized = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
  return count === 1 ? capitalized : `${capitalized}s`;
}

/** Renders a self-contained main-equivalent approval summary for native chat. */
export function renderScopeSummaryMd(summary: ScopeSummary): string {
  const lines: string[] = [];
  const direction = summary.direction === 'bidirectional' ? 'bidirectional' : summary.direction;
  const depth = summary.depthIntent.kind === 'asymmetric'
    ? `depth u:${summary.depthIntent.upstream} d:${summary.depthIntent.downstream}`
    : (summary.depth !== null ? `depth ${summary.depth}` : 'unbounded depth');
  const columns = summary.targetColumns?.length
    ? ` — columns: [${summary.targetColumns.join(', ')}]`
    : '';
  const tracing = summary.analysisMode === 'ct' ? `Column-Trace${columns}` : 'Blackboard';

  lines.push('### Exploration plan (proposed)');
  lines.push('');
  lines.push(`- **${plural(summary.hopCount, 'hop')}** · **${plural(summary.scopeCount, 'node')} in scope** · ${depth}, ${direction}`);
  lines.push(`- **Tracing:** ${tracing}`);
  lines.push('');

  const passSet = new Set(summary.activeFilters.passNodeIds.map(nodeId => nodeId.toLowerCase()));
  const schemas = Object.entries(summary.bySchema).sort((a, b) => {
    const hopDifference = b[1].hops - a[1].hops;
    if (hopDifference !== 0) return hopDifference;
    const scopeDifference = b[1].scope - a[1].scope;
    return scopeDifference !== 0 ? scopeDifference : a[0].localeCompare(b[0]);
  });

  for (const [schema, schemaEntry] of schemas) {
    lines.push(`- **${schema}** — ${plural(schemaEntry.scope, 'node')}`);
    const types = Object.entries(schemaEntry.byType).sort((a, b) =>
      b[1].hops - a[1].hops || b[1].scope - a[1].scope || a[0].localeCompare(b[0]),
    );
    for (const [type, leaf] of types) {
      const names = leaf.nodeNames.map(name => {
        const fq = `[${schema.toLowerCase()}].[${name.toLowerCase()}]`;
        return passSet.has(fq) ? `${name} _(pass)_` : name;
      }).join(', ');
      const omitted = leaf.omitted > 0 ? ` _(+${leaf.omitted} more)_` : '';
      lines.push(`  - ${typeLabel(type, leaf.scope)} (${plural(leaf.scope, 'node')}): ${names}${omitted}`);
    }
  }

  const filters = summary.activeFilters;
  const hasFilters = filters.schemas.length > 0
    || filters.types.length > 0
    || filters.nodeIds.length > 0
    || filters.passNodeIds.length > 0;
  if (hasFilters) {
    lines.push('');
    lines.push('**Active filters**');
    if (filters.schemas.length > 0) lines.push(`- Schemas excluded: ${filters.schemas.map(x => `\`${x}\``).join(', ')}`);
    if (filters.types.length > 0) lines.push(`- Types excluded: ${filters.types.map(x => `\`${x}\``).join(', ')}`);
    if (filters.nodeIds.length > 0) lines.push(`- Nodes excluded: ${filters.nodeIds.map(x => `\`${x}\``).join(', ')}`);
    if (filters.passNodeIds.length > 0) lines.push(`- Nodes pass-through: ${filters.passNodeIds.map(x => `\`${x}\``).join(', ')}`);
  }

  return lines.join('\n');
}
