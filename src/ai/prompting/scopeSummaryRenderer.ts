/**
 * Pure markdown renderer of the scope summary the `confirm_sm_start` gate shows. No `vscode`
 * import, so unit tests run without the VS Code module surface.
 */

import type { ScopeSummary } from '../sm/smTypes';
import { CLASSIFICATION_LABEL, type ClassificationValue } from '../session/classification';
import { escapeMarkdownText, pluralize } from '../support/text';
import { resolveModelNodeId } from '../../engine/shared/nodeIdResolution';
import { normalizeName } from '../../engine/shared/sqlIdentifier';
import { quoteIdentifier } from '../../utils/sql';

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
 * Renders the depth line for one side of the ask. Placement already says who bound the value
 * (`From the question` vs `Plan`); an `'approximate'` side is marked `≈`, an `'exact'` one is
 * plain, each on its own exactness. No parenthetical about engine behaviour: that copy is not hop
 * context and is not served after approval.
 */
function depthLine(levels: number | 'all', side: string, exact: boolean): string {
  return `- Depth: ${depthValue(levels, exact)} ${side}`;
}

/** One side's depth: `all levels`, a plain count when exact, `≈`-marked when approximate. */
function depthValue(levels: number | 'all', exact: boolean): string {
  if (levels === 'all') return 'all levels';
  return exact ? plural(levels, 'level') : `≈${plural(levels, 'level')}`;
}

/**
 * Wraps a raw name as an inline code span. Code spans render literally, so the name must not be
 * Markdown-escaped first; a fence one backtick longer than the name's longest backtick run keeps an
 * inner backtick from closing the span.
 */
function code(value: string): string {
  const longestRun = Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const pad = longestRun > 0 ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** Collapses whitespace so model-authored prose renders as one markdown paragraph. */
function oneParagraph(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Schemas in plan order: most hops first, then most nodes, then name. */
function schemasInPlanOrder(summary: ScopeSummary): Array<[string, ScopeSummary['bySchema'][string]]> {
  return Object.entries(summary.bySchema).sort((a, b) => {
    const hopDifference = b[1].hops - a[1].hops;
    if (hopDifference !== 0) return hopDifference;
    const scopeDifference = b[1].scope - a[1].scope;
    return scopeDifference !== 0 ? scopeDifference : a[0].localeCompare(b[0]);
  });
}

/** The plan's heading, stamped with the revision from the second round on. */
function planHeading(revision?: number): string {
  return revision && revision > 1 ? `### Exploration plan · revision ${revision}` : '### Exploration plan';
}

/**
 * Renders the self-contained approval summary for native chat.
 *
 * @param revision - Stamped in the heading from the second round on, so a re-approval is
 *   distinguishable from the first.
 * @param classification - The proposal's answer angle: part of the approved contract, so it is
 *   stated beside the tracing mode on the card and in the summary a gate refine replays to the
 *   model.
 */
export function renderScopeSummaryMd(
  summary: ScopeSummary,
  revision?: number,
  classification?: ClassificationValue,
): string {
  const readAs: string[] = [];
  const filters = summary.activeFilters;
  if (filters.nodeIds.length > 0) {
    readAs.push(`- Exclude: ${filters.nodeIds.map(code).join(', ')} — removed from the graph`);
  }
  if (filters.passNodeIds.length > 0) {
    readAs.push(`- Keep but skip: ${filters.passNodeIds.map(code).join(', ')} — stays in the graph, not analysed`);
  }
  if (filters.schemas.length > 0) {
    readAs.push(`- Schemas excluded: ${filters.schemas.map(code).join(', ')}`);
  }
  if (filters.types.length > 0) {
    readAs.push(`- Types excluded: ${filters.types.map(code).join(', ')}`);
  }
  return renderPlanMd(summary, readAs, revision, classification);
}

/**
 * Assembles the plan around caller-built `Read as` lines: goal, depth, counts and the in-scope
 * tree.
 *
 * @param namesPerType - Names listed per type line of the tree; the rest fold into `+N more`.
 */
function renderPlanMd(
  summary: ScopeSummary,
  readAs: readonly string[],
  revision?: number,
  classification?: ClassificationValue,
  namesPerType = Number.POSITIVE_INFINITY,
): string {
  const lines: string[] = [];
  const direction = summary.direction === 'bidirectional' ? 'bidirectional' : summary.direction;
  const columns = summary.targetColumns?.length
    ? ` — columns: [${summary.targetColumns.join(', ')}]`
    : '';
  const tracing = summary.analysisMode === 'ct' ? `Column-Trace${columns}` : 'Blackboard';

  const intent = summary.depthIntent;
  const stated: string[] = [];
  const chosen: string[] = [];
  const sidesEqual = intent.upstream.levels === intent.downstream.levels && intent.upstream.exactness === intent.downstream.exactness;
  if (direction === 'bidirectional' && sidesEqual) {
    const { levels, exactness } = intent.upstream;
    (exactness === 'exact' ? stated : chosen).push(depthLine(levels, 'each way', exactness === 'exact'));
  } else {
    const sides: Array<'upstream' | 'downstream'> = direction === 'bidirectional' ? ['upstream', 'downstream'] : [direction];
    for (const side of sides) {
      const { levels, exactness } = intent[side];
      (exactness === 'exact' ? stated : chosen).push(depthLine(levels, side, exactness === 'exact'));
    }
  }

  for (const note of summary.scopeNotes) {
    stated.push(`- Noted: "${oneParagraph(note)}"`);
  }

  lines.push(planHeading(revision));
  lines.push('');
  if (summary.missionBrief) {
    lines.push(`- **Goal:** ${oneParagraph(summary.missionBrief)}`);
    lines.push('');
  }
  if (stated.length > 0) {
    lines.push('**From the question**');
    lines.push(...stated);
    lines.push('');
  }
  if (readAs.length > 0) {
    lines.push('**Read as**');
    lines.push(...readAs);
    lines.push('');
  }
  lines.push('**Plan**');
  lines.push(...chosen);
  lines.push(`- **${plural(summary.hopCount, 'hop')}** · **${plural(summary.scopeCount, 'node')} in scope** · ${direction}`);
  lines.push(`- **Tracing:** ${tracing}`);
  if (classification) lines.push(`- **Analysis:** ${CLASSIFICATION_LABEL[classification]}`);
  lines.push('');

  const sourceNodeId = (schema: string, name: string) => normalizeName(`${quoteIdentifier(schema)}.${quoteIdentifier(name)}`, summary.identifierCaseSensitive);
  const sourceNodes = new Map(schemasInPlanOrder(summary).flatMap(([schema, entry]) =>
    Object.values(entry.byType).flatMap(leaf => leaf.nodeNames.map(name =>
      [sourceNodeId(schema, name), true] as const))));
  const passNodes = new Set(summary.activeFilters.passNodeIds.map(nodeId =>
    resolveModelNodeId(nodeId, sourceNodes, summary.identifierCaseSensitive)).filter(id => id !== null));
  for (const [schema, schemaEntry] of schemasInPlanOrder(summary)) {
    lines.push(`- **${escapeMarkdownText(schema)}** — ${plural(schemaEntry.scope, 'node')}`);
    const types = Object.entries(schemaEntry.byType).sort((a, b) =>
      b[1].hops - a[1].hops || b[1].scope - a[1].scope || a[0].localeCompare(b[0]),
    );
    for (const [type, leaf] of types) {
      const names = leaf.nodeNames.slice(0, namesPerType).map(name => {
        const fq = sourceNodeId(schema, name);
        return passNodes.has(fq) ? `${escapeMarkdownText(name)} _(pass)_` : escapeMarkdownText(name);
      }).join(', ');
      const more = leaf.omitted + Math.max(0, leaf.nodeNames.length - namesPerType);
      const omitted = more > 0 ? ` _(+${more} more)_` : '';
      lines.push(`  - ${typeLabel(type, leaf.scope)} (${plural(leaf.scope, 'node')}): ${names}${omitted}`);
    }
  }

  return lines.join('\n');
}

/** Chat line for a typed gate reply whose reading failed: no action is taken for the user. */
export const UNREAD_GATE_REPLY =
  'That reply could not be read as approve, change or cancel — the proposal is still pending. Use the buttons above, or rephrase.';
