/**
 * Per-phase system-prompt composition for the **host** agent runtime.
 *
 * @remarks
 * The single place the grounded, phase-aware system prompt is assembled. It composes the shared,
 * pure builders in {@link ./prompts} ({@link buildGeneralSystemPrompt} + {@link buildPhasePrompt}),
 * so the grounding rules, routing, and phase protocol stay single-sourced (DRY) and no chat surface
 * builds a prompt of its own.
 *
 * Intentionally omits the YAML stage template + SM-protocol blocks needed for `active`/`synthesis`
 * output formatting — `agent/stagePrompts.ts` layers those in per phase.
 * VS Code-free: pure data in, string out.
 */

import {
  buildGeneralSystemPrompt,
  buildPhasePrompt,
  type GeneralPromptContext,
  type PromptPhase,
} from './prompts';
import { UNKNOWN_DB_PLATFORM, type DatabaseModel } from '../../engine/types';
import type { SerializedFilterState } from '../../engine/projectStore';
import type { AiGateRefine } from '../../engine/shared/bridgeContract';
import { describeScreen } from '../tools/screenStatePresenter';

/**
 * The grounding context surfaced in the system prompt's `## Context` block.
 *
 * @remarks
 * Derived from the loaded model and active filter so every phase receives the same grounded
 * counts and platform metadata. Same shape as `GeneralPromptContext` in `./prompts` — that module
 * is the one-directional source, this is the name callers in this file (and its consumers) use.
 */
export type StagePromptContext = GeneralPromptContext;

/**
 * Answers the small class of questions whose facts are owned completely by the host snapshot.
 *
 * @remarks
 * This is intentionally narrower than lineage intent classification. It handles only aggregate
 * application context already rendered in every prompt (platform, schema count, visible object
 * count). Questions about object types, named objects, dependencies, or lineage stay model/tool
 * routed so this helper cannot invent semantic database facts.
 */
export function tryBuildDeterministicContextAnswer(
  prompt: string,
  ctx: StagePromptContext,
): string | null {
  const normalized = prompt
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) return null;

  const asksCount = /\b(?:how many|number of|count of|object count|schema count)\b/.test(normalized);
  const asksLineage = /\b(?:feed|feeds|source|sources|upstream|downstream|depend|dependency|dependencies|lineage|impact|column|columns|read|reads|write|writes|use|uses)\b/.test(normalized);
  const namesObjectType = /\b(?:table|tables|view|views|procedure|procedures|function|functions)\b/.test(normalized);

  if (asksCount && /\bobjects?\b/.test(normalized) && !asksLineage && !namesObjectType) {
    if (ctx.filterSchemas.length === 1) {
      return `The current \`${ctx.filterSchemas[0]}\` schema has **${ctx.visibleNodes} objects**.`;
    }
    if (ctx.filterSchemas.length > 1) {
      return `The active schemas (${ctx.filterSchemas.map(schema => `\`${schema}\``).join(', ')}) contain **${ctx.visibleNodes} objects**.`;
    }
    return `The loaded snapshot contains **${ctx.totalNodes} objects** across **${ctx.totalSchemaCount} schemas**.`;
  }

  if (asksCount && /\bschemas?\b/.test(normalized) && !asksLineage) {
    return `The loaded snapshot contains **${ctx.totalSchemaCount} schemas**.`;
  }

  const asksPlatform = /\b(?:what|which)\b/.test(normalized)
    && /\b(?:database platform|db platform|sql platform|database type|sql dialect)\b/.test(normalized);
  if (asksPlatform) return `The loaded snapshot platform is **${ctx.dbPlatform}**.`;

  return null;
}

/**
 * Derives the {@link StagePromptContext} from the loaded model + active filter.
 *
 * @remarks
 * When a schema filter is active, `visibleNodes` counts only nodes in those schemas.
 * Degrades cleanly to zeros when no model is loaded, so the discovery prompt still renders.
 * `dbPlatform` stays platform-typed in that case rather than carrying a "no model" sentence:
 * it is rendered under a `- Platform:` label, so a non-platform value reads as a category
 * error to the model, and the zeroed counts already state that nothing is loaded.
 *
 * @param model - The session's loaded model, or `null` when none is loaded.
 * @param filter - The active serialized filter, or `null`.
 * @param uiState - Raw UI-state payload passed to {@link describeScreen}; absent or unrecognized
 *   shapes simply omit the `screen` field.
 * @returns The prompt grounding values derived from the current model and filter.
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
  const visibleNodes = filterSchemas.length > 0
    ? model.nodes.filter((n) => filterSchemas.includes(n.schema)).length
    : totalNodes;
  return {
    dbPlatform: model.dbPlatform?.trim() || UNKNOWN_DB_PLATFORM,
    filterSchemas,
    totalSchemaCount: model.schemas.length,
    visibleNodes,
    totalNodes,
    ...(screen ? { screen } : {}),
  };
}

/**
 * Composes the host system prompt for a phase: the grounded base + the phase protocol block.
 *
 * @param phase - The lifecycle phase whose protocol to render.
 * @param ctx - The grounding context (see {@link deriveStagePromptContext}).
 * @returns The assembled system-prompt string.
 */
export function buildHostStageSystemPrompt(phase: PromptPhase, ctx: StagePromptContext): string {
  const base = buildGeneralSystemPrompt(phase, ctx);
  const phaseSpecific = buildPhasePrompt(phase);
  return [base, phaseSpecific].filter(Boolean).join('\n\n');
}

/**
 * System prompt for the code-driven **entry detector** (one structured pre-loop call).
 *
 * @remarks
 * Classifies semantic intent only. `visual_render` selects approval-gated BB exploration; the
 * host-owned preview action remains a separate RuntimeFrame fact for the bounded preview route.
 *
 * @param ctx - Grounding context (see {@link deriveStagePromptContext}).
 * @returns The detector system-prompt string.
 */
export function buildEntryDetectorSystemPrompt(ctx: StagePromptContext): string {
  return [
    'You are a routing classifier for a SQL data-lineage tool. Classify the user request into one entry route.',
    '',
    "Return 'column_trace' only when the user clearly names one or more specific columns to follow. Extract those exact names into targetColumns.",
    "Return 'visual_render' when the user explicitly asks to see, show, render, draw, preview, or open a lineage graph, diagram, canvas, or panel. This means approval-gated hop-by-hop exploration. Set targetColumns to null.",
    "Return 'discovery' for everything else: broad dependency questions that do not explicitly request a visual, and questions about what is already on screen — \"what am I looking at\", \"explain this view\", \"has anything changed since\" — because those are answered from the current screen state, not by opening a new exploration. Set targetColumns to null.",
    "TIEBREAKER — when in doubt, do NOT choose 'column_trace'. Column tracing requires an unambiguous, specifically named column; if the request names only an object/table with no column, choose 'discovery'. But a request that DOES name a specific column — even one described as a calculation or metric — is not ambiguous: choose 'column_trace'. Column trace is the exception only for vague requests, never for an explicitly named column.",
    '',
    'The conversation may include earlier turns. Classify ONLY the latest user message; use earlier turns solely to resolve what it refers to (e.g. resolving which object a bare column name belongs to).',
    '',
    `Context: platform ${ctx.dbPlatform}; ${ctx.totalSchemaCount} schemas; ${ctx.visibleNodes} of ${ctx.totalNodes} objects visible.${ctx.screen ? ` On screen: ${ctx.screen}.` : ''}`,
  ].join('\n');
}

/**
 * System prompt for one bounded discovery preview call.
 *
 * @remarks
 * Composed exactly like every other stage — {@link buildHostStageSystemPrompt} — rather than
 * appending a directive of its own. Building the block here instead is what let the preview stage
 * drift out of the shared presentation contract while still being judged by it.
 */
export function buildVisualPreviewSystemPrompt(ctx: StagePromptContext): string {
  return buildHostStageSystemPrompt('visual_preview', ctx);
}

/**
 * Directive system prompt for the restricted **SM-entry** turn.
 *
 * @remarks
 * Paired with a 3-tool registry (`lineage_get_screen_state` + `lineage_search_objects` + `lineage_start_exploration`) and
 * a graph-enforced required terminal tool, so a weak model can only resolve the origin and open the exploration
 * → the `confirm_sm_start` gate fires deterministically (instead of answering in prose). For a
 * column trace, the detected columns are surfaced so the model passes them as `targetColumns`.
 *
 * @param ctx - Grounding context.
 * @param targetColumns - Columns to trace when the entry route is `column_trace`; omitted otherwise.
 * @returns The SM-entry system-prompt string.
 */
export function buildSmEntrySystemPrompt(ctx: StagePromptContext, targetColumns?: string[]): string {
  const base = buildGeneralSystemPrompt('discover', ctx);
  const ctLine = targetColumns?.length
    ? `This is a column trace — set analysisMode:"ct" and pass targetColumns: [${targetColumns.map((c) => `"${c}"`).join(', ')}].`
    : 'Set analysisMode:"bb" unless the user clearly requested tracing specific column(s). When unclear, choose "bb". Do not pass targetColumns in BB mode.';
  const directive = [
    '## Start the exploration',
    'Resolve the origin object, then call `lineage_start_exploration`. Do not answer in prose.',
    '1. Call `lineage_search_objects` to resolve the user-named object to its exact id.',
    '2. Call `lineage_start_exploration` with `origin` set to that id, `analysisMode` (bb or ct), and a `classification` (business, technical, or both).',
    'This is a fresh exploration: set `origin`; do not set the `supplement` field (that is only for extending a finished exploration).',
    'Set `direction` from the request: upstream for sources/inputs ("all the way up", "show sources"), downstream for usage/impact, bidirectional when the user wants both.',
    'Pass a depth only when the user stated one — a level count (e.g. "3 levels"), "all" for the whole chain, or a per-side ask (e.g. "2 up, 1 down") as {upstream, downstream}. If the user gave no depth, omit it.',
    ctLine,
    'The `confirm_sm_start` gate fires after step 2 — that is expected control flow, not an error to retry around.',
  ].filter(Boolean).join('\n');
  return [base, directive].join('\n\n');
}

/** Builds the system prompt for a same-turn revision of an already resolved proposal. */
export function buildGateRefineSystemPrompt(ctx: StagePromptContext): string {
  const base = buildGeneralSystemPrompt('discover', ctx);
  const directive = [
    '## Refine the pending exploration',
    'Revise the interrupted proposal and call `lineage_start_exploration`. Do not answer in prose.',
    'The current proposal, revision, and requested edit are supplied in the trailing user message.',
    'Reuse canonical IDs already present there. Do not search for or re-resolve the unchanged origin.',
    'Use `lineage_search_objects` only when the requested edit needs resolution, such as a typo, ambiguous name, name pattern, or newly named object.',
    'Call `lineage_start_exploration` with the current proposalRevision and only fields changed by the edit; omitted fields are inherited mechanically.',
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
  const fmt = (values?: string[]): string => values?.length ? values.join(', ') : '(none)';
  const targetLine = refine.analysisMode === 'bb'
    ? '- targetColumns: omit for BB'
    : `- targetColumns: ${refine.targetColumns ? fmt(refine.targetColumns) : '(unchanged)'}`;
  return [
    'The user is refining the pending exploration scope. Do not start a new exploration or answer in prose.',
    '',
    'Current candidate scope (post-filter):',
    scopeSummaryMd,
    '',
    'Requested scope edits:',
    `- excludeTypes: ${fmt(refine.excludeTypes)}`,
    `- excludeSchemas: ${fmt(refine.excludeSchemas)}`,
    `- excludeNodeIds: ${fmt(refine.excludeNodeIds)}`,
    `- passNodeIds: ${fmt(refine.passNodeIds)}`,
    `- analysisMode: ${refine.analysisMode ?? '(unchanged)'}`,
    targetLine,
    refine.instruction ? `- instruction: "${refine.instruction}"` : '',
    '',
    `Call \`lineage_start_exploration\` with proposalRevision:${proposalRevision} and only the fields changed by the requested edits.`,
    'Omitted proposal fields are preserved mechanically. Preserve unchanged origin, question, mission brief, direction, depth, filters, mode, classification, and columns by omitting them.',
    'Use `lineage_search_objects` only when the requested edit needs resolution, such as a typo, ambiguous name, name pattern, or newly named object.',
    'Reuse canonical IDs already present in the current proposal context. Do not search for or re-resolve the unchanged origin.',
    'Do not repeat entry detection, discovery, scope-bundle retrieval, or the original origin search.',
    'The backend merges the patch, recomputes an unpublished preview, and re-emits the gate for review.',
    'A CT-to-BB patch removes targetColumns. A BB-to-CT patch must include at least one named targetColumns value.',
  ].filter(Boolean).join('\n');
}

/**
 * The leading user anchor seeded into active-phase history after a sliding-memory wipe.
 *
 * @remarks
 * Once the host wipes the active history (hop 2+), the trimmed array is reseeded as
 * `[anchor, last-tool-call, last-tool-result]`. The anchor keeps the
 * conversation leading with a `user` turn (strict providers reject a leading assistant turn) and
 * points the model at the next agenda node — the hop protocol, agenda, and rolling
 * `<short_term_memory>` all live in the re-rendered `system`, so this stays a one-line continuation
 * directive, not a per-hop task config.
 *
 * @returns The anchor user-message text.
 */
export function buildActiveContinuationAnchor(): string {
  return 'Continue the hop-by-hop analysis: address the next node on the agenda per the protocol above.';
}
