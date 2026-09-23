/**
 * Pure markdown renderer for the `confirm_sm_start` gate's scope tree.
 *
 * @remarks
 * Lives in its own file (no `vscode` import) so unit tests can exercise it without
 * the VS Code module surface. Single source of truth for the native gate markdown.
 */

import { DEFAULT_SM_START_DEPTH, type ScopeSummary } from '../sm/smTypes';
import { CLASSIFICATION_LABEL, type ClassificationValue } from '../session/classification';
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

/**
 * Renders the depth line for one side of the ask.
 *
 * @remarks
 * Placement already says who bound the value (`From your question` vs `My plan`). An assistant-
 * chosen depth is marked `≈`; a user-stated one is exact. Each asymmetric side is placed on its own
 * binding, so an unstated side is the `≈` seed under `My plan` beside a stated one. No parenthetical about engine behaviour
 * — that copy is not hop context and is not served after approval.
 */
function depthLine(levels: number | 'all', side: string, binding: boolean): string {
  if (levels === 'all') return `- Depth: all levels ${side}`;
  const value = binding ? plural(levels, 'level') : `≈${plural(levels, 'level')}`;
  return `- Depth: ${value} ${side}`;
}

/**
 * Renders a self-contained main-equivalent approval summary for native chat.
 *
 * @param summary - The proposed scope to render.
 * @param revision - Proposal revision; stamped in the heading from the second round on so a
 * re-approval is distinguishable from the first.
 * @param classification - The proposal's answer angle. It is part of the approved contract, so it
 * is stated in the plan beside the tracing mode — on the card the user approves and in the summary
 * a gate refine replays to the model.
 * @returns The assembled scope-summary markdown.
 */
export function renderScopeSummaryMd(
  summary: ScopeSummary,
  revision?: number,
  classification?: ClassificationValue,
): string {
  const lines: string[] = [];
  const direction = summary.direction === 'bidirectional' ? 'bidirectional' : summary.direction;
  const columns = summary.targetColumns?.length
    ? ` — columns: [${summary.targetColumns.join(', ')}]`
    : '';
  const tracing = summary.analysisMode === 'ct' ? `Column-Trace${columns}` : 'Blackboard';

  const intent = summary.depthIntent;
  const depthIsBinding = intent.kind === 'explicit';
  const stated: string[] = [];
  const chosen: string[] = [];
  const depthTarget = depthIsBinding ? stated : chosen;
  const depthSide = direction === 'bidirectional' ? 'each way' : direction;
  if (intent.kind === 'asymmetric') {
    for (const side of ['upstream', 'downstream'] as const) {
      const value = intent[side];
      if (value === null) chosen.push(depthLine(DEFAULT_SM_START_DEPTH, side, false));
      else stated.push(depthLine(value, side, true));
    }
  } else if (intent.kind === 'full_frontier') {
    depthTarget.push(depthLine('all', depthSide, false));
  } else if (summary.depth !== null) {
    depthTarget.push(depthLine(summary.depth, depthSide, depthIsBinding));
  }

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
  for (const note of summary.scopeNotes) {
    stated.push(`- Noted: "${note.replace(/\s+/g, ' ').trim()}"`);
  }

  const heading = revision && revision > 1
    ? `### Exploration plan · revision ${revision}`
    : '### Exploration plan';
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
  if (classification) lines.push(`- **Analysis:** ${CLASSIFICATION_LABEL[classification]}`);
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
      const autoPassed = leaf.hops === 0 ? ' · kept, not analysed' : '';
      lines.push(`  - ${typeLabel(type, leaf.scope)} (${plural(leaf.scope, 'node')}${autoPassed}): ${names}${omitted}`);
    }
  }

  return lines.join('\n');
}
