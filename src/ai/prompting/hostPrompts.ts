/** Per-phase system-prompt composition for the **host** agent runtime. */

import {
  buildGeneralSystemPrompt,
  buildPhasePrompt,
  buildScreenStateSlot,
  type GeneralPromptContext,
  type PromptPhase,
} from './prompts';
import { UNKNOWN_DB_PLATFORM, type DatabaseModel } from '../../engine/types';
import type { SerializedFilterState } from '../../engine/projectStore';
import type { AiGateRefine } from '../../engine/shared/bridgeContract';
import { describeScreen } from '../tools/screenStatePresenter';
import { escapePromptText } from '../support/text';
import { ClassificationValueSchema } from '../tools/toolSchemas';

/** The grounding context surfaced in the system prompt's `## Context` block. */
export type StagePromptContext = GeneralPromptContext;

/** Derives the {@link StagePromptContext} from the loaded model + active filter. */
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
  const visibleNodes = filterSchemas.length > 0
    ? model.nodes.filter((n) => filterSchemas.includes(n.schema)).length
    : totalNodes;
  return {
    dbPlatform: model.dbPlatform?.trim() || UNKNOWN_DB_PLATFORM,
    filterSchemas,
    totalSchemaCount: model.schemas.length,
    visibleNodes,
    totalNodes,
    ...(model.identifierCaseSensitive && { identifierCaseSensitive: true }),
    ...(screen ? { screen } : {}),
  };
}

/** Composes the host system prompt for a phase: the grounded base + the phase protocol block. */
export function buildHostStageSystemPrompt(
  phase: PromptPhase,
  ctx: StagePromptContext,
  analysisMode: 'bb' | 'ct' = 'bb',
): string {
  const base = buildGeneralSystemPrompt(ctx);
  const phaseSpecific = buildPhasePrompt(phase, analysisMode);
  return [base, phaseSpecific].filter(Boolean).join('\n\n');
}

/** System prompt for the code-driven **entry detector** (one structured pre-loop call). */
export function buildEntryDetectorSystemPrompt(ctx: StagePromptContext): string {
  return [
    'Classify the latest user message of a SQL data-lineage chat into one entry route. Earlier turns only resolve references.',
    '- column_trace: user explicitly asks to trace, follow, or walk named columns; supply them in targetColumns.',
    '- visual_render: user explicitly asks to view, render, diagram, or preview a lineage graph (targetColumns must be null).',
    '- discovery: all other questions or general inquiries (targetColumns must be null).',
    '',
    `Context: platform ${ctx.dbPlatform}; ${ctx.totalSchemaCount} schemas; ${ctx.visibleNodes} of ${ctx.totalNodes} objects visible.`,
    ...(ctx.screen ? buildScreenStateSlot(ctx.screen) : []),
  ].join('\n');
}

/** System prompt for one bounded discovery preview call. */
export function buildVisualPreviewSystemPrompt(ctx: StagePromptContext): string {
  return buildHostStageSystemPrompt('visual_preview', ctx);
}

/** Directive system prompt for the restricted **SM-entry** turn. */
export function buildSmEntrySystemPrompt(ctx: StagePromptContext, targetColumns?: string[]): string {
  const base = buildGeneralSystemPrompt(ctx);
  const ctLine = targetColumns?.length
    ? `Column trace: analysisMode "ct", targetColumns [${targetColumns.map((c) => `"${escapePromptText(c)}"`).join(', ')}].`
    : '';
  const directive = [
    '## Task: open the exploration',
    "Resolve the target object with `lineage_search_objects`. When `name_match` is `unique`, call `lineage_start_exploration` using its ID as `origin`. When `ambiguous`, reply in text naming matched IDs to ask the user, without a tool call. Otherwise, use the resolved candidate ID from search results. Set `depth`, exclusions (`excludeTypes`, `excludeSchemas`, `excludeNodeIds`), `classification`, `analysisMode`, `mission_brief`, and `scopeNotes` according to the user request and schema descriptions.",
    ClassificationValueSchema.description,
    ctLine,
    'The user then reviews your proposal at an approval gate.',
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
    'Reuse canonical IDs already present there. Do not search for or re-resolve the unchanged origin.',
    'Use `lineage_search_objects` only when the requested edit needs resolution, such as a typo, ambiguous name, name pattern, or newly named object.',
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
    `Call \`lineage_start_exploration\` with \`proposalRevision: ${proposalRevision}\` and only the fields changed by requested edits.`,
    'Preserve unchanged `origin`, `depth` (direction is derived from it), filters, `analysisMode`, `classification`, and `targetColumns` by omitting them. `mission_brief` is kept only when `origin`, `analysisMode`, `targetColumns`, and `depth` are unchanged; otherwise restate it. An analysis constraint that no other `lineage_start_exploration` field expresses goes in `scopeNotes`.',
  ].filter(Boolean).join('\n');
}

/** The leading user anchor the active-phase thread is reseeded to at approval and after every committed hop. */
export function buildActiveContinuationAnchor(): string {
  return 'Analyze `<current_task>` on the next agenda node.';
}
