/**
 * Per-phase system-prompt composition for the **host** agent runtime: the single place the
 * grounded, phase-aware prompt is assembled, composing the shared pure builders in
 * {@link ./prompts} ({@link buildGeneralSystemPrompt} + {@link buildPhasePrompt}) so grounding
 * rules, routing and phase protocol stay single-sourced and no chat surface builds its own prompt.
 * Omits the YAML stage template and SM-protocol blocks needed for `active`/`synthesis` formatting;
 * `agent/stagePrompts.ts` layers those in. VS Code-free.
 */

import {
  buildGeneralSystemPrompt,
  buildPhasePrompt,
  buildScreenStateSlot,
  type GeneralPromptContext,
  type PromptPhase,
} from './prompts';
import { OBJECT_TYPES, UNKNOWN_DB_PLATFORM, type DatabaseModel } from '../../engine/types';
import { countVisibleNodes, userFilterAdmits } from '../../engine/shared/modelFilters';
import type { SerializedFilterState } from '../../engine/projectStore';
import type { AiGateRefine } from '../../engine/shared/bridgeContract';
import { describeScreen } from '../tools/screenStatePresenter';
import { escapePromptText } from '../support/text';

/**
 * The grounding context surfaced in the system prompt's `## Context` block, derived from the loaded
 * model and active filter so every phase gets the same counts and platform metadata. Same shape as
 * `GeneralPromptContext` in `./prompts`, the one-directional source.
 */
export type StagePromptContext = GeneralPromptContext;

/**
 * Derives the {@link StagePromptContext} from the loaded model + active filter. `visibleNodes`
 * counts what the view shows (the count `lineage_get_context` serves); `filterHides` is set when the
 * view's filters hide an object. With no model it degrades to zeros so
 * discovery still renders; `dbPlatform` stays platform-typed rather than carrying a "no model"
 * sentence, since it renders under a `- Platform:` label where a non-platform value reads as a
 * category error and the zero counts already say nothing is loaded.
 *
 * @param uiState - Raw UI-state payload for {@link describeScreen}; absent or unrecognized shapes
 *   omit the `screen` field.
 */
export function deriveStagePromptContext(
  model: DatabaseModel | null,
  filter: SerializedFilterState | null,
  uiState: unknown = null,
): StagePromptContext {
  const screen = describeScreen(uiState);
  if (!model) {
    return { dbPlatform: UNKNOWN_DB_PLATFORM, filterSchemas: [], totalSchemaCount: 0, visibleNodes: 0, totalNodes: 0, ...(screen ? { screen } : {}) };
  }
  const filterSchemas = filter?.schemas ?? [];
  const totalNodes = model.nodes.length;
  const visibleNodes = countVisibleNodes(model, filter);
  const admits = filter ? userFilterAdmits(model, filter) : null;
  const filterHides = filter && admits && model.nodes.some((n) => !admits(n))
    ? {
      types: filter.types?.length ? OBJECT_TYPES.filter((t) => !filter.types.includes(t)) : [],
      namePatterns: filter.exclusionPatterns ?? [],
    }
    : undefined;
  return {
    dbPlatform: model.dbPlatform?.trim() || UNKNOWN_DB_PLATFORM,
    filterSchemas,
    totalSchemaCount: model.schemas.length,
    visibleNodes,
    totalNodes,
    ...(filterHides && { filterHides }),
    ...(model.identifierCaseSensitive && { identifierCaseSensitive: true }),
    ...(screen ? { screen } : {}),
  };
}

/**
 * Composes the host system prompt for a phase: the grounded base + the phase protocol block.
 *
 * @param analysisMode - Hop or session mode forwarded to {@link buildPhasePrompt} so active and
 *   synthesis compose CT as BB plus a column rider.
 */
export function buildHostStageSystemPrompt(
  phase: PromptPhase,
  ctx: StagePromptContext,
  analysisMode: 'bb' | 'ct' = 'bb',
): string {
  const base = buildGeneralSystemPrompt(ctx);
  const phaseSpecific = buildPhasePrompt(phase, analysisMode, ctx.filterHides !== undefined);
  return [base, phaseSpecific].filter(Boolean).join('\n\n');
}

/**
 * System prompt for the code-driven **entry detector** (one structured pre-loop call). Classifies
 * semantic intent only: `visual_render` enters discovery like any free-text request; the host-owned
 * preview action stays a separate RuntimeFrame fact for the bounded preview route reached
 * afterward.
 */
export function buildEntryDetectorSystemPrompt(ctx: StagePromptContext): string {
  return [
    'Classify the latest user message of a SQL data-lineage chat into one entry route. Earlier turns only resolve what it refers to.',
    '- column_trace: the user explicitly asks to trace, follow or walk one or more named columns as a new lineage request; put those names in targetColumns.',
    '- visual_render: the user explicitly asks to see, show, render, draw, preview or open a lineage graph, diagram or panel.',
    '- discovery: everything else, and whenever in doubt — including a follow-up that mentions a column already named, a question about what is on screen, or a bare "trace"/"explore" with no column. The user can still switch to a column trace at the approval step.',
    '',
    `Context: platform ${ctx.dbPlatform}; ${ctx.totalSchemaCount} schemas; ${ctx.visibleNodes} of ${ctx.totalNodes} objects visible.`,
    ...(ctx.screen ? buildScreenStateSlot(ctx.screen) : []),
  ].join('\n');
}

/**
 * System prompt for one bounded discovery preview call, composed like every other stage via
 * {@link buildHostStageSystemPrompt}, so it stays under the shared presentation contract.
 */
export function buildVisualPreviewSystemPrompt(ctx: StagePromptContext): string {
  return buildHostStageSystemPrompt('visual_preview', ctx);
}

/**
 * Directive system prompt for the restricted **SM-entry** turn, paired with a 4-tool registry
 * (`lineage_get_screen_state`, `lineage_search_objects`, `lineage_get_object_detail`,
 * `lineage_start_exploration`) under automatic tool choice: `lineage_start_exploration` opens the
 * `confirm_sm_start` gate and a text-only reply ends the turn as its answer. For a column trace the
 * detected columns are surfaced so the model passes them as `targetColumns`.
 *
 * @param targetColumns - Columns to trace when the entry route is `column_trace`; omitted
 *   otherwise.
 */
export function buildSmEntrySystemPrompt(ctx: StagePromptContext, targetColumns?: string[]): string {
  const base = buildGeneralSystemPrompt(ctx);
  const ctLine = targetColumns?.length
    ? `Column trace: analysisMode "ct", targetColumns [${targetColumns.map((c) => `"${escapePromptText(c)}"`).join(', ')}].`
    : '';
  const directive = [
    '## Task: open the exploration',
    "Resolve the object the user named with `lineage_search_objects`. When `name_match` is `unique`, call `lineage_start_exploration` once with its id as `origin`; when `ambiguous`, reply in text naming those ids and asking which, with no tool call; without `name_match`, call it with the id of the object the user named. Set every other field from the user's own words, as its description says, including a `mission_brief` stating the goal and what counts as relevant.",
    ctLine,
  ].filter(Boolean).join('\n');
  return [base, directive].join('\n\n');
}

/** Builds the system prompt for a same-turn revision of an already resolved proposal. */
export function buildGateRefineSystemPrompt(ctx: StagePromptContext): string {
  const base = buildGeneralSystemPrompt(ctx);
  const directive = [
    '## Refine the pending exploration',
    'Revise the interrupted proposal and call `lineage_start_exploration`.',
    'The current proposal, revision, and requested edit are supplied in the trailing user message.',
    'Do not search for or re-resolve the unchanged origin.',
    'Use `lineage_search_objects` only when the requested edit needs resolution, such as a typo, ambiguous name, name pattern, or newly named object.',
    'Call `lineage_start_exploration` with the current proposalRevision and only fields changed by the edit; an omitted field keeps the reviewed value, except mission_brief as the trailing message states.',
    'A successful patch re-emits the consent gate. That is expected control flow, not an error to retry around.',
  ].join('\n');
  return [base, directive].join('\n\n');
}

/** Builds the revision-bound user message used only to revise an interrupted approval proposal. */
export function buildGateRefinePrompt(
  scopeSummaryMd: string,
  refine: AiGateRefine,
  proposalRevision: number,
): string {
  return [
    'The user is refining the pending exploration scope. Do not start a new exploration.',
    '',
    'Current candidate scope (post-filter):',
    escapePromptText(scopeSummaryMd),
    '',
    `Requested change: "${escapePromptText(refine.instruction ?? '')}"`,
    '',
    `Call \`lineage_start_exploration\` with proposalRevision:${proposalRevision} and only the fields changed by the requested edits.`,
    'Preserve unchanged origin, question, depth (direction is derived from it), filters, mode, classification, and columns by omitting them. mission_brief is kept only when origin, analysisMode, targetColumns and depth are unchanged; otherwise restate it. An analysis constraint that no other `lineage_start_exploration` field expresses goes in `scopeNotes`.',
  ].filter(Boolean).join('\n');
}

/**
 * The leading user anchor the active-phase thread is reseeded to at approval and after every
 * committed hop; the thread then holds this message alone. Per-hop task, focus context and
 * `<short_term_memory>` ride the following worker message, hop protocol and session memo stay in
 * the stable `system`. The anchor keeps the conversation leading with a `user` turn (strict
 * providers reject a leading assistant turn), so it stays a one-line continuation directive, not
 * per-hop task config. The incomplete-stop path keeps the last tool pair instead
 * (`extractShortTermMemory`).
 */
export function buildActiveContinuationAnchor(): string {
  return 'Analyze `<current_task>` on `focus_node`.';
}
