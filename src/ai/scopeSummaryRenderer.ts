/**
 * Pure markdown renderer for the `confirm_sm_start` gate's scope tree.
 *
 * @remarks
 * Lives in its own file (no `vscode` import) so unit tests can exercise it without
 * the VS Code module surface. Single source of truth for the gate-detail markdown.
 */

import type { ScopeSummary } from './smTypes';

/** Pluralizes a noun based on count. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Capitalizes and pluralizes an object-type label for display in the scope tree. */
function typeLabel(t: string, n: number): string {
  const cap = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  return n === 1 ? cap : `${cap}s`;
}

/**
 * Renders a {@link ScopeSummary} as nested-bullet markdown for the `confirm_sm_start` gate.
 *
 * @remarks
 * Schemas are sorted by hop count desc, then scope desc; types within a schema by hops desc;
 * per-type names are alphabetized inside the snapshot. Pass-tagged nodes appear inline with
 * a `(pass)` marker; excluded items surface in a final "Active filters" block.
 *
 * @param s - Snapshot from `engine.getScopeSummary()`.
 */
export function renderScopeSummaryMd(s: ScopeSummary): string {
  const lines: string[] = [];
  const dirLabel = s.direction === 'bidirectional' ? 'bidirectional' : s.direction;
  const depthLabel = s.depth !== null ? `depth ${s.depth}` : 'unbounded depth';
  const modeLabel = s.inlineMode ? 'Inline (one-shot)' : 'Sliding-Memory (multi-hop)';
  const colLabel = s.targetColumns?.length ? ` — columns: [${s.targetColumns.join(', ')}]` : '';
  const traceLabel = s.columnAspectActive ? `Column-Trace${colLabel}` : 'Blackboard';

  lines.push('### Exploration plan (proposed)');
  lines.push('');
  lines.push(`- **${plural(s.hopCount, 'hop')}** · **${plural(s.scopeCount, 'node')} in scope** · ${depthLabel}, ${dirLabel}`);
  lines.push(`- **Mode:** ${modeLabel} · **Tracing:** ${traceLabel}`);
  lines.push('');

  const passSet = new Set(s.activeFilters.passNodeIds.map(n => n.toLowerCase()));

  const schemaEntries = Object.entries(s.bySchema).sort((a, b) => {
    const ds = b[1].scope - a[1].scope;
    if (ds !== 0) return ds;
    return a[0].localeCompare(b[0]);
  });

  for (const [schema, schEntry] of schemaEntries) {
    lines.push(`- **${schema}** — ${plural(schEntry.scope, 'node')}`);
    const typeEntries = Object.entries(schEntry.byType).sort((a, b) => b[1].scope - a[1].scope || a[0].localeCompare(b[0]));
    for (const [type, leaf] of typeEntries) {
      const label = typeLabel(type, leaf.scope);
      const countLabel = plural(leaf.scope, 'node');
      const annotated = leaf.nodeNames.map(name => {
        const fq = `[${schema.toLowerCase()}].[${name.toLowerCase()}]`;
        return passSet.has(fq) ? `${name} _(pass)_` : name;
      }).join(', ');
      const tail = leaf.omitted > 0 ? ` _(+${leaf.omitted} more)_` : '';
      lines.push(`  - ${label} (${countLabel}): ${annotated}${tail}`);
    }
  }

  const f = s.activeFilters;
  const hasFilters = f.schemas.length > 0 || f.types.length > 0 || f.nodeIds.length > 0 || f.passNodeIds.length > 0;
  if (hasFilters) {
    lines.push('');
    lines.push('**Active filters**');
    if (f.schemas.length > 0) lines.push(`- Schemas excluded: ${f.schemas.map(x => `\`${x}\``).join(', ')}`);
    if (f.types.length > 0) lines.push(`- Types excluded: ${f.types.map(x => `\`${x}\``).join(', ')}`);
    if (f.nodeIds.length > 0) lines.push(`- Nodes excluded: ${f.nodeIds.map(x => `\`${x}\``).join(', ')}`);
    if (f.passNodeIds.length > 0) lines.push(`- Nodes pass-through: ${f.passNodeIds.map(x => `\`${x}\``).join(', ')}`);
  }

  return lines.join('\n');
}
