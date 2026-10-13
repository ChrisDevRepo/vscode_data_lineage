/**
 * Pure markdown renderers for the `confirm_sm_start` gate: the full plan with its scope tree, and
 * the compact card the approval shows first.
 *
 * @remarks
 * Lives in its own file (no `vscode` import) so unit tests can exercise it without
 * the VS Code module surface. Single source of truth for the native gate markdown.
 */

import type { ScopeExclusionGroup, ScopeSummary } from '../sm/smTypes';
import type { PendingExplorationProposal } from '../session/session';
import { CLASSIFICATION_LABEL, type ClassificationValue } from '../session/classification';
import { escapeMarkdownText, pluralize } from '../support/text';
import { resolveModelNodeId } from '../../engine/shared/nodeIdResolution';
import { normalizeName } from '../../engine/shared/sqlIdentifier';
import { quoteIdentifier, schemaKey } from '../../utils/sql';

/** Object names the card lists per type before folding the rest into `+N more`. */
const NAMES_PER_TYPE = 10;

/** Object names the full plan lists per type, in scope or excluded, before folding the rest into `+N more`. */
const PLAN_NAMES_PER_TYPE = 20;

/** Schema names the card lists before stating the selection as a count; the full plan names them all. */
const CARD_SCHEMA_NAMES = 10;

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

/**
 * Lists the first `cap` names as code spans and folds the rest into `+N more`.
 *
 * @param alreadyOmitted - Names the producer dropped before this list was built.
 */
function cappedNames(names: readonly string[], cap: number, alreadyOmitted = 0): string {
  const more = Math.max(0, names.length - cap) + alreadyOmitted;
  const shown = names.slice(0, cap).map(code).join(', ');
  return more > 0 ? `${shown} _+${more} more_` : shown;
}

/**
 * An object's name as the card shows it: schema-qualified when the loaded model holds more than
 * one object of that type by that name ({@link ScopeSummary.ambiguousObjectNames}), bare otherwise.
 */
function objectDisplayName(summary: ScopeSummary, type: string, schema: string, name: string): string {
  return summary.ambiguousObjectNames?.[type]?.includes(schemaKey(name, summary.identifierCaseSensitive)) ? `${schema}.${name}` : name;
}

/** One `Types (N): names` line per object type of an excluded group, largest type first. */
function exclusionTypeLines(summary: ScopeSummary, group: ScopeExclusionGroup, cap: number, indent: string): string[] {
  return Object.entries(group.byType)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([type, objects]) => {
      const names = objects.map(object => objectDisplayName(summary, type, object.schema, object.name));
      return `${indent}- ${typeLabel(type, objects.length)} (${objects.length}): ${cappedNames(names, cap)}`;
    });
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

/**
 * States the schema selection from its shorter side: `All` when nothing is excluded,
 * `All except x, y` when fewer schemas are excluded than selected, otherwise the selected list.
 * The two sides are {@link ScopeSummary.selectedSchemas} and `activeFilters.schemas`.
 *
 * @param nameCap - Names listed before the line states `N of M selected` instead.
 */
function schemasLine(summary: ScopeSummary, nameCap = Number.POSITIVE_INFINITY): string {
  const selected = summary.selectedSchemas ?? schemasInPlanOrder(summary).map(([schema]) => schema);
  const excluded = summary.activeFilters.schemas;
  if (excluded.length === 0) return 'All';
  const exceptExcluded = excluded.length < selected.length;
  const names = exceptExcluded ? excluded : selected;
  if (names.length > nameCap) return `${selected.length} of ${selected.length + excluded.length} selected`;
  return `${exceptExcluded ? 'All except ' : ''}${names.map(code).join(', ')}`;
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
      const names = leaf.nodeNames.map(name => objectDisplayName(summary, type, schema, name));
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
 * The `Read as` lines of the user-facing full plan: the same active filters as
 * {@link renderScopeSummaryMd}, with excluded objects grouped by the rule that excluded them and
 * each type capped at {@link PLAN_NAMES_PER_TYPE} names, and the schema filter stated from its shorter
 * side with every name ({@link schemasLine}).
 */
function fullPlanReadAs(summary: ScopeSummary): string[] {
  const readAs: string[] = [`- Schemas: ${schemasLine(summary)}`];
  const filters = summary.activeFilters;
  const exclusions = summary.exclusions;
  if (exclusions) {
    for (const rule of exclusions.rules) {
      readAs.push(`- Excluded by rule ${code(rule.pattern)} — ${plural(rule.count, 'object')}`);
      readAs.push(...exclusionTypeLines(summary, rule, PLAN_NAMES_PER_TYPE, '  '));
    }
    if (exclusions.named.count > 0) {
      readAs.push(`- Excluded by name — ${plural(exclusions.named.count, 'object')}`);
      readAs.push(...exclusionTypeLines(summary, exclusions.named, PLAN_NAMES_PER_TYPE, '  '));
    }
  } else if (filters.nodeIds.length > 0) {
    readAs.push(`- Exclude: ${cappedNames(filters.nodeIds, PLAN_NAMES_PER_TYPE)} — removed from the graph`);
  }
  if (filters.passNodeIds.length > 0) {
    readAs.push(`- Keep but skip: ${filters.passNodeIds.map(code).join(', ')} — stays in the graph, not analysed`);
  }
  if (filters.types.length > 0) {
    readAs.push(`- Types excluded: ${filters.types.map(code).join(', ')}`);
  }
  return readAs;
}

/**
 * Assembles the plan around caller-built `Read as` lines: goal, depth, counts and the in-scope tree.
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
 * direction dropped. Schemas are stated from the shorter side (`schemasLine`), as a count past
 * {@link CARD_SCHEMA_NAMES} names, so the `Excluded` line never repeats them. In-scope objects are
 * grouped by type across every schema, one line per type with its total, names capped at
 * {@link NAMES_PER_TYPE}. The `Excluded` line carries the GUI exclusion rule count, the excluded
 * object types and the count of objects excluded by name; the full plan names the excluded
 * objects. Keep-but-skip renders in full. A name that
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
  lines.push(`- **Schemas:** ${schemasLine(summary, CARD_SCHEMA_NAMES)}`);
  const columns = summary.analysisMode === 'ct' && summary.targetColumns?.length
    ? ` — columns: ${summary.targetColumns.map(code).join(', ')}`
    : '';
  lines.push(`- **Tracing:** ${summary.analysisMode === 'ct' ? 'Column-Trace' : 'Blackboard'}${columns}`);
  lines.push(`- **Analysis:** ${CLASSIFICATION_LABEL[proposal.classification]}`);

  const objectGroups = objectsByType(summary);
  if (objectGroups.length > 0) {
    lines.push('- **Objects:**');
    for (const group of objectGroups) {
      lines.push(`  - ${typeLabel(group.type, group.scope)} (${group.scope}): ${cappedNames(group.names, NAMES_PER_TYPE, group.omitted)}`);
    }
  }

  const filters = summary.activeFilters;
  const exclusions = summary.exclusions;
  const namedExcluded = exclusions ? exclusions.named.count : filters.nodeIds.length;
  const excluded = [
    exclusions && exclusions.rules.length > 0 ? plural(exclusions.rules.length, 'filter rule') : '',
    filters.types.length > 0 ? `types ${filters.types.map(code).join(', ')}` : '',
    namedExcluded > 0 ? `${plural(namedExcluded, 'object')} by name` : '',
  ].filter(Boolean);
  if (excluded.length > 0) lines.push(`- **Excluded:** ${excluded.join('; ')}`);
  if (filters.passNodeIds.length > 0) lines.push(`- **Keep but skip:** ${filters.passNodeIds.map(code).join(', ')}`);
  return lines.join('\n');
}

/**
 * Renders the **Show full plan** reply: the discovery summary (when the proposal has one) ahead
 * of the plan, every in-scope object the stored proposal carries, and the excluded objects grouped
 * by cause ({@link fullPlanReadAs}).
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
  const plan = renderPlanMd(proposal.summary, fullPlanReadAs(proposal.summary), proposal.revision, proposal.classification, PLAN_NAMES_PER_TYPE);
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
