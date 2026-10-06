/**
 * Pure markdown renderers for the `confirm_sm_start` gate: the full plan with its scope tree, and
 * the compact card the approval shows first.
 *
 * @remarks
 * Lives in its own file (no `vscode` import) so unit tests can exercise it without
 * the VS Code module surface. Single source of truth for the native gate markdown.
 */

import type { ScopeSummary } from '../sm/smTypes';
import type { PendingExplorationProposal } from '../session/session';
import { CLASSIFICATION_LABEL, type ClassificationValue } from '../session/classification';
import { escapeMarkdownText, pluralize } from '../support/text';
import { resolveModelNodeId } from '../../engine/shared/nodeIdResolution';
import { normalizeName } from '../../engine/shared/sqlIdentifier';
import { quoteIdentifier, schemaKey } from '../../utils/sql';

/** In-scope object types the card lists before folding the rest into one `…` line. */
const CARD_OBJECT_TYPE_LIMIT = 3;

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
 * Placement already says who bound the value (`From the question` vs `Plan`). An
 * `'approximate'` side is marked `≈`; an `'exact'` one is plain. Each side is placed on its own
 * exactness, so an approximate side sits under `Plan` beside an exact one. No parenthetical
 * about engine behaviour — that copy is not hop context and is not served after approval.
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
 * Wraps a raw name as an inline code span. Code spans render their content literally, so the
 * name must not be Markdown-escaped first; a fence one backtick longer than the name's longest
 * backtick run keeps a backtick inside the name from closing the span.
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

/**
 * Requested schema exclusions the named origin removed from the contract: the origin's own schema
 * is never excluded, so it drops out of the active filter.
 *
 * @param requested - The proposal's requested `excludeSchemas`.
 * @param active - The schemas the proposal's active filter still excludes.
 * @param identifierCaseSensitive - Checked catalog policy. Absent or false keeps case-insensitive comparison.
 */
export function schemaFiltersRemovedByOrigin(requested: readonly string[], active: readonly string[], identifierCaseSensitive: boolean | undefined): string[] {
  return requested.filter(schema => !active.some(kept => schemaKey(kept, identifierCaseSensitive) === schemaKey(schema, identifierCaseSensitive)));
}

/**
 * Requested object exclusions the named origin removed from the contract: the origin's own id is
 * never excluded, so it drops out of the active filter.
 *
 * @param requested - The proposal's requested `excludeNodeIds`.
 * @param origin - The proposal's origin id.
 * @param active - The object ids the proposal's active filter still excludes.
 * @param identifierCaseSensitive - Checked catalog policy. Absent or false keeps case-insensitive comparison.
 */
export function nodeFiltersRemovedByOrigin(requested: readonly string[], origin: string, active: readonly string[], identifierCaseSensitive: boolean | undefined): string[] {
  const originOnly = new Map([[origin, true]]);
  if (active.some(kept => resolveModelNodeId(kept, originOnly, identifierCaseSensitive) !== null)) return [];
  return requested.filter(id => resolveModelNodeId(id, originOnly, identifierCaseSensitive) !== null);
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

/**
 * States the card's full schema selection in whichever wording is shortest: `All` when nothing is
 * excluded, `All except x, y` when naming the exclusions is shorter than naming the inclusions,
 * otherwise the included list. The schema set is the union already on the summary — every excluded
 * schema plus every schema carrying in-scope nodes — never a persisted project-wide list.
 */
function schemasLine(summary: ScopeSummary): string {
  const included = schemasInPlanOrder(summary);
  const excluded = summary.activeFilters.schemas;
  if (excluded.length === 0) return 'All';
  if (excluded.length < included.length) {
    return `All except ${excluded.map(code).join(', ')}`;
  }
  return included.map(([schema, entry]) => `${code(schema)} (${entry.scope})`).join(', ');
}

/** One in-scope object type's names and node count, summed across every schema. */
interface CardObjectGroup {
  readonly type: string;
  readonly scope: number;
  readonly names: string[];
  readonly omitted: number;
}

/**
 * Rolls up `bySchema` into one entry per object type, schema grouping dropped from the layout —
 * except that a name recurring in more than one schema of the loaded model
 * ({@link ScopeSummary.ambiguousObjectNames}) is schema-qualified so it stays traceable to one
 * object once the grouping is gone.
 */
function objectsByType(summary: ScopeSummary): CardObjectGroup[] {
  const groups = new Map<string, CardObjectGroup>();
  for (const [schema, schemaEntry] of Object.entries(summary.bySchema)) {
    for (const [type, leaf] of Object.entries(schemaEntry.byType)) {
      const group = groups.get(type) ?? { type, scope: 0, names: [], omitted: 0 };
      const ambiguous = summary.ambiguousObjectNames?.[type];
      const names = leaf.nodeNames.map(name =>
        ambiguous?.includes(schemaKey(name, summary.identifierCaseSensitive)) ? `${schema}.${name}` : name,
      );
      groups.set(type, {
        type,
        scope: group.scope + leaf.scope,
        names: [...group.names, ...names],
        omitted: group.omitted + leaf.omitted,
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.scope - a.scope || a.type.localeCompare(b.type));
}

/** The plan's heading, stamped with the revision from the second round on. */
function planHeading(revision?: number): string {
  return revision && revision > 1 ? `### Exploration plan · revision ${revision}` : '### Exploration plan';
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
  _removedSchemaFilters: readonly string[] = [],
  _removedNodeFilters: readonly string[] = [],
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
      const names = leaf.nodeNames.map(name => {
        const fq = sourceNodeId(schema, name);
        return passNodes.has(fq) ? `${escapeMarkdownText(name)} _(pass)_` : escapeMarkdownText(name);
      }).join(', ');
      const omitted = leaf.omitted > 0 ? ` _(+${leaf.omitted} more)_` : '';
      lines.push(`  - ${typeLabel(type, leaf.scope)} (${plural(leaf.scope, 'node')}): ${names}${omitted}`);
    }
  }

  return lines.join('\n');
}

/**
 * Renders the compact approval card: fact lines only, with a **Show full plan** follow-up
 * carrying the model-authored prose (goal, discovery summary, noted constraints) and every
 * in-scope object.
 *
 * @remarks
 * No AI-authored text reaches the card — `mission_brief`, the discovery summary and
 * `scopeNotes` are full-plan-only. There is no separate direction line: the depth line names the
 * side(s) it covers directly (`N upstream`, `N upstream · N downstream`, or `N each way` for equal
 * bidirectional sides). The scope line carries only the estimated counts (`≈N hops · ≈N nodes`),
 * direction dropped. Schemas are always stated in full, in whichever wording is shortest
 * (`schemasLine`). In-scope objects are grouped by type across every schema and capped at
 * {@link CARD_OBJECT_TYPE_LIMIT} type lines, the rest folded into one `…` line; every other list
 * (excluded schemas and objects, keep-but-skip) renders in full — excluded object types are
 * full-plan-only, since the type filter is a rule and not itself an object list. A name that
 * recurs in more than one schema of the loaded model is schema-qualified (`objectsByType`) so
 * dropping the schema grouping never leaves two distinct objects reading as one bare name; a
 * unique name stays bare.
 *
 * @param proposal - The stored proposal the card shows.
 * @returns The card markdown.
 */
export function renderScopeCardMd(
  proposal: Pick<PendingExplorationProposal, 'revision' | 'init' | 'classification' | 'summary'>,
): string {
  const { summary } = proposal;
  const lines: string[] = [planHeading(proposal.revision), ''];

  const { upstream, downstream } = summary.depthIntent;
  const sidesEqual = upstream.levels === downstream.levels && upstream.exactness === downstream.exactness;
  const depth = summary.direction === 'bidirectional' && sidesEqual
    ? `${depthValue(upstream.levels, upstream.exactness === 'exact')} each way`
    : (summary.direction === 'bidirectional' ? ['upstream', 'downstream'] as const : [summary.direction])
      .map(side => `${depthValue(summary.depthIntent[side].levels, summary.depthIntent[side].exactness === 'exact')} ${side}`)
      .join(' · ');
  lines.push(`- **Depth:** ${depth}`);
  lines.push(`- **Scope:** ≈${plural(summary.hopCount, 'hop')} · ≈${plural(summary.scopeCount, 'node')}`);
  lines.push(`- **Schemas:** ${schemasLine(summary)}`);
  const columns = summary.analysisMode === 'ct' && summary.targetColumns?.length
    ? ` — columns: ${summary.targetColumns.map(code).join(', ')}`
    : '';
  lines.push(`- **Tracing:** ${summary.analysisMode === 'ct' ? 'Column-Trace' : 'Blackboard'}${columns}`);
  lines.push(`- **Analysis:** ${CLASSIFICATION_LABEL[proposal.classification]}`);

  const objectGroups = objectsByType(summary);
  if (objectGroups.length > 0) {
    lines.push('- **Objects:**');
    for (const group of objectGroups.slice(0, CARD_OBJECT_TYPE_LIMIT)) {
      const names = group.names.map(code).join(', ');
      const omitted = group.omitted > 0 ? ` _(+${group.omitted} more)_` : '';
      lines.push(`  - ${typeLabel(group.type, group.scope)}: ${names}${omitted}`);
    }
    if (objectGroups.length > CARD_OBJECT_TYPE_LIMIT) lines.push('  - …');
  }

  const filters = summary.activeFilters;
  const excluded = [
    filters.schemas.length > 0 ? `schemas ${filters.schemas.map(code).join(', ')}` : '',
    filters.nodeIds.length > 0 ? `objects ${filters.nodeIds.map(code).join(', ')}` : '',
  ].filter(Boolean);
  if (excluded.length > 0) lines.push(`- **Excluded:** ${excluded.join('; ')}`);
  if (filters.passNodeIds.length > 0) lines.push(`- **Keep but skip:** ${filters.passNodeIds.map(code).join(', ')}`);
  return lines.join('\n');
}

/**
 * Renders the **Show full plan** reply: the discovery summary (when the proposal has one) ahead
 * of the plan, every in-scope object the stored proposal carries.
 *
 * @remarks
 * Built directly from the held proposal rather than reused from the gate's stored `detail` —
 * that string is the model-facing tool-response copy (discovery summary trailing, not leading)
 * and stays exactly as the backend built it. This is a separate, user-facing rendering of the
 * same underlying scope data.
 *
 * @param proposal - Stored proposal containing the effective approved scope.
 * @returns The user-facing plan markdown.
 */
export function renderFullPlanMd(
  proposal: Pick<PendingExplorationProposal, 'revision' | 'init' | 'classification' | 'summary' | 'discoverySummary'>,
): string {
  const plan = renderScopeSummaryMd(proposal.summary, proposal.revision, proposal.classification);
  return proposal.discoverySummary ? `${proposal.discoverySummary}\n\n${plan}` : plan;
}

/**
 * Interactive frame the native chat host renders around {@link renderScopeCardMd}'s output.
 *
 * @remarks
 * Single source of truth for this wrapper: `lineageParticipant.ts` writes it straight to the chat
 * stream (never through a model call), and `chatHistoryAdapter.ts` matches the same constant to
 * recognize and neutralize it before replaying history — a UI-only frame is not a message either
 * side of the model ever produced.
 */
export const GATE_CARD_HEADER = '\n\n---\n**Confirm exploration**\n\n';

/**
 * Closing line of a pending approval card, written ahead of the card's buttons.
 *
 * @remarks
 * The turn has to close for VS Code to release the chat input, so this line states that the
 * card's buttons and a chat reply both still act on the proposal. It is part of the card rather
 * than a trailer: VS Code folds every part before a completed response's last markdown into a
 * collapsed disclosure, so any text after the buttons would hide the card. Matched by name in
 * `chatHistoryAdapter.ts` for the same reason as {@link GATE_CARD_HEADER}.
 */
export const HOLD_GATE_NOTICE =
  '\n\nApprove, change or cancel with the buttons below, or reply here.';

/** Chat line for a typed gate reply whose reading failed: no action is taken on the user's behalf. */
export const UNREAD_GATE_REPLY =
  'That reply could not be read as approve, change or cancel — the proposal is still pending. Use the buttons above, or rephrase.';
