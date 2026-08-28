/**
 * Pure markdown renderer for the `confirm_sm_start` gate's scope tree.
 *
 * @remarks
 * Lives in its own file (no `vscode` import) so unit tests can exercise it without
 * the VS Code module surface. Single source of truth for the native gate markdown.
 */

import type { ClassificationValue } from '../session/classification';
import type { ScopeSummary } from '../sm/smTypes';
import { pluralize } from '../support/text';

/**
 * User-facing wording for the locked classification.
 *
 * @remarks
 * Named for its consequence rather than its enum value: the classification decides which capture
 * angles survive commit, so the gate states what the answer will and will not cover. Without this
 * line the one scope field that discards analysis is the only one the user cannot correct.
 */
const CLASSIFICATION_LABELS: Record<ClassificationValue, string> = {
  business: 'business logic (technical-only findings are dropped)',
  technical: 'technical mechanics (business findings, incl. data-quality caveats, are dropped)',
  both: 'business logic and technical mechanics',
};

/** Formats a count with its noun; the suffix rule itself lives in the shared `pluralize`. */
function plural(n: number, noun: string): string {
  return `${n} ${pluralize(n, noun)}`;
}

/** Capitalizes and pluralizes an object-type label for display in the scope tree. */
function typeLabel(type: string, count: number): string {
  const capitalized = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
  return count === 1 ? capitalized : `${capitalized}s`;
}

/**
 * Renders the depth line for one side of the ask.
 *
 * @remarks
 * Wording carries the consequence, not a label: a border the user fixed says the trace stops,
 * a depth the assistant chose says it may move, and an unbounded side says there is no stop at all.
 * The caller decides which block it lands in.
 */
function depthLine(levels: number | 'all', side: string, binding: boolean): string {
  if (levels === 'all') return `- Depth: all levels ${side} — no depth limit`;
  const value = binding ? plural(levels, 'level') : `≈${plural(levels, 'level')}`;
  const suffix = binding
    ? ' — I will not go past this'
    : ' — my estimate, I may extend it if the trace needs it';
  return `- Depth: ${value} ${side}${suffix}`;
}

/**
 * Renders a self-contained main-equivalent approval summary for native chat.
 *
 * @param summary - The proposed scope to render.
 * @param revision - Proposal revision; stamped in the heading from the second round on so a
 * re-approval is distinguishable from the first.
 * @returns The assembled scope-summary markdown.
 */
export function renderScopeSummaryMd(summary: ScopeSummary, revision?: number): string {
  const lines: string[] = [];
  const direction = summary.direction === 'bidirectional' ? 'bidirectional' : summary.direction;
  const columns = summary.targetColumns?.length
    ? ` — columns: [${summary.targetColumns.join(', ')}]`
    : '';
  const tracing = summary.analysisMode === 'ct' ? `Column-Trace${columns}` : 'Blackboard';

  // A depth the user stated binds the run; one the assistant inferred does not. The block a line
  // sits in is what tells the user which it is — so the same fact is never rendered ambiguously.
  const intent = summary.depthIntent;
  const depthIsBinding = intent.kind === 'explicit' || intent.kind === 'asymmetric';
  const stated: string[] = [];
  const chosen: string[] = [];
  const depthTarget = depthIsBinding ? stated : chosen;
  const depthSide = direction === 'bidirectional' ? 'each way' : direction;
  if (intent.kind === 'asymmetric') {
    depthTarget.push(depthLine(intent.upstream, 'upstream', true));
    depthTarget.push(depthLine(intent.downstream, 'downstream', true));
  } else if (intent.kind === 'full_frontier') {
    depthTarget.push(depthLine('all', depthSide, false));
  } else if (summary.depth !== null) {
    depthTarget.push(depthLine(summary.depth, depthSide, depthIsBinding));
  }

  // A filter is the assistant's mechanization of the request, never the request itself. Rendering
  // it beside the user's own words under one "from your question" heading claims an origin the
  // engine cannot know, so a field the assistant picked reads as one the user asked for.
  const readAs: string[] = [];
  const filters = summary.activeFilters;
  if (filters.nodeIds.length > 0) {
    readAs.push(`- Exclude: ${filters.nodeIds.map(x => `\`${x}\``).join(', ')} — removed from the graph`);
  }
  if (filters.passNodeIds.length > 0) {
    readAs.push(`- Keep but skip: ${filters.passNodeIds.map(x => `\`${x}\``).join(', ')} — stays in the graph, not analysed`);
  }
  if (filters.schemas.length > 0) {
    readAs.push(`- Schemas excluded: ${filters.schemas.map(x => `\`${x}\``).join(', ')}`);
  }
  if (filters.types.length > 0) {
    readAs.push(`- Types excluded: ${filters.types.map(x => `\`${x}\``).join(', ')}`);
  }
  // The user's own words, verbatim. Placed next to the mechanization above so a misreading is
  // visible side by side while the user can still correct it — after approval the run is autonomous.
  for (const note of summary.scopeNotes) {
    stated.push(`- Noted: "${note}"`);
  }

  const heading = revision && revision > 1
    ? `### Exploration plan (proposed · revision ${revision})`
    : '### Exploration plan (proposed)';
  lines.push(heading);
  lines.push('');
  if (stated.length > 0) {
    lines.push('**From your question**');
    lines.push(...stated);
    lines.push('');
  }
  if (readAs.length > 0) {
    lines.push('**How I read it**');
    lines.push(...readAs);
    lines.push('');
  }
  lines.push('**My plan**');
  lines.push(...chosen);
  lines.push(`- **${plural(summary.hopCount, 'hop')}** · **${plural(summary.scopeCount, 'node')} in scope** · ${direction}`);
  lines.push(`- **Tracing:** ${tracing}`);
  if (summary.classification) lines.push(`- **Reporting on:** ${CLASSIFICATION_LABELS[summary.classification]}`);
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
      // A type group with no bodied node is auto-passed by the engine — it carries no body to read,
      // so it stays in the graph unanalysed whether or not anyone asked. Saying so here is what
      // makes "keep it but skip it" visibly already satisfied, instead of an edit the user retries.
      const autoPassed = leaf.hops === 0 ? ' · kept, not analysed' : '';
      lines.push(`  - ${typeLabel(type, leaf.scope)} (${plural(leaf.scope, 'node')}${autoPassed}): ${names}${omitted}`);
    }
  }

  return lines.join('\n');
}
