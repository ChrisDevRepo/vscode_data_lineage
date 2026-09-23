/**
 * Stage-scoped prompt assembly for the synthesis / active / discover phases.
 */

import type { AiOutputTemplates } from '../session/types';
import type { ClassificationValue } from '../session/classification';
import { CLASSIFICATION_KEPT_ANGLES } from '../session/classification';

/**
 * Stages at which a YAML instruction may be injected into the AI system prompt.
 *
 * @remarks
 * - `discover`  = inline chat first response (no SM engaged).
 * - `active`    = per-hop `sections[]` writing — capture rules (one entry per fired `*_capture`).
 * - `synthesis` = present_result assembly — render rules. Slot bodies arrive
 *                 pre-formatted from the active-phase capture and are lifted
 *                 as written; synthesis assembles, groups, frames.
 */
type TemplateStage = 'discover' | 'active' | 'synthesis';

/**
 * Canonical, code-owned routing of YAML keys to stages.
 *
 * @remarks
 * Authoritative — a `stages:` field in the YAML (default or overlay) is informational only; the
 * loader never reads it (`AiOutputTemplatesConfigSchema` passes it through, only `instruction` is
 * overlaid), so a disagreeing overlay is silently routed by this map instead. `general` is
 * placement-only at synthesis — a captured ⚠️ sits once in the section it belongs to.
 *
 * `description` is intentionally absent — it is engine output (`orderAndAssemble` in
 * `presentResult.ts` from title + intro + sections[] + closing), not an AI-writeable field; do not
 * add it back without restoring the full AI-input plumbing in `tools.ts` and resolving the
 * conflict with engine assembly. `sections`, `business_subsection`, `technical_subsection` are
 * also absent — their lift+group+label rule lives in `buildSynthesisPrompt()` to avoid
 * duplication with the synthesis cue.
 */
const STAGE_BY_KEY: Readonly<Record<keyof AiOutputTemplates, readonly TemplateStage[]>> = {
  discovery_chat:       ['discover'],
  summary:              ['synthesis'],
  title:                ['synthesis'],
  intro:                ['synthesis'],
  closing:              ['synthesis'],
  highlights:           ['synthesis'],
  notes:                ['synthesis'],
  business_capture:     ['active'],
  technical_capture:    ['active'],
  structural_callouts:  ['active'],
  structural_summary:   ['active'],
  general:              ['synthesis'],
  loading_pattern:      ['synthesis'],
  column_trace_capture: ['active'],
};

/**
 * Classification-gated keys — fire only when the session classification
 * matches one of the listed values. Keys absent from this map are always on.
 *
 * @remarks
 * A fresh exploration locks classification before the approval gate, so active
 * prompt assembly normally receives a concrete value. The `undefined` behavior
 * remains defensive for pre-gate/legacy callers: every gated capture key fires
 * rather than silently dropping an evidence angle.
 */
const CLASSIFICATION_GATED: Readonly<Record<string, readonly ClassificationValue[]>> = {
  business_capture:     ['business', 'both'],
  technical_capture:    ['technical', 'both'],
  loading_pattern:      ['technical', 'both'],
};

/**
 * CT-mode-gated keys — fire only when the approved runtime mode is CT.
 * CT requires target columns; BB must never carry them.
 * These are additive to classification-gated templates; both gates must pass.
 */
const CT_MODE_GATED: ReadonlySet<keyof AiOutputTemplates> = new Set([
  'column_trace_capture',
]);

/**
 * Per-FOCUS capture keys — which of these fires depends on the current hop's focus node
 * (bodied script vs non-bodied table), so they are volatile per hop. They render into the
 * per-hop worker message (`render: 'per_focus'`), NEVER into the active system prompt
 * (`render: 'stable'`): a system prompt that swaps templates per focus type breaks the
 * byte-stable prefix the provider-side implicit prompt cache keys on.
 */
const PER_FOCUS_KEYS: ReadonlySet<keyof AiOutputTemplates> = new Set([
  'business_capture',
  'technical_capture',
  'structural_callouts',
  'structural_summary',
]);

/**
 * The `sections[].angle` each capture key writes. The per-focus recipe labels its bullet with this
 * value, never the YAML key, so the label is the literal the `submit_findings` schema accepts.
 */
const CAPTURE_ANGLE: Readonly<Partial<Record<keyof AiOutputTemplates, 'business' | 'technical'>>> = {
  business_capture:  'business',
  technical_capture: 'technical',
};

/**
 * Header of the bodied per-focus capture recipe, shared by every capture key: the one home of the
 * one-`sections[]`-entry-per-schema-angle rule (`classification_lock_violation` — each capture
 * bullet is labelled with its `sections[].angle` value), the exact-substring quoting rule and
 * the `not established` wording, so no capture key restates them.
 */
const CAPTURE_RECIPE_HEADER = [
  '### Capture recipe',
  'Submit one `sections[]` entry per angle this mission fires, with that angle in `angle`, and put every bullet below — including the ⚠️ callout bullet — inside that entry\'s `text`. Markdown without headings. Back each grain predicate, formula and ⚠️ line with one short ```sql fence of its deciding expression, an exact substring of `bb_ddl`; what the SQL does not establish reads `not established from the available SQL`. Skip an item the SQL lacks.',
].join('\n\n');

/**
 * Bare-summary angle clause — the one line the non-bodied per-focus render keeps from
 * {@link CAPTURE_RECIPE_HEADER} when it drops the rest of that header (its SQL-evidence rules do
 * not apply to a schema-only node with no body). Without it the model has no cue that
 * `sections[].angle` is a fixed schema literal and free-labels the entry from the summary's own
 * bullet names (`Purpose`, `Upstream sources`, …), which `lineage_submit_findings` rejects.
 *
 * @remarks
 * Unlocked (`classification` undefined) states every angle the mode ever accepts. A locked
 * classification with one kept angle ({@link CLASSIFICATION_KEPT_ANGLES}) states only that angle:
 * the per-dispatch `submit_findings` schema (`toolSchemas.ts`
 * `capturedSectionSchemaForClassification`) hard-rejects the excluded one, so naming it here
 * would only buy the model a rejection it cannot act on. `both` keeps every angle, same as
 * unlocked.
 */
const BARE_SUMMARY_ANGLE_CLAUSE_UNLOCKED =
  'Submit this as one `sections[]` entry per angle this mission keeps (`business`, `technical`, or both), with that literal — never a descriptive label — in `angle`.';

/**
 * Resolves {@link BARE_SUMMARY_ANGLE_CLAUSE_UNLOCKED} to the angle(s) the locked classification
 * actually keeps, reading the same {@link CLASSIFICATION_KEPT_ANGLES} the dispatched schema
 * narrows to — one source, so the prompt line and the schema can never name different angles.
 */
function bareSummaryAngleClause(classification: ClassificationValue | undefined): string {
  if (!classification) return BARE_SUMMARY_ANGLE_CLAUSE_UNLOCKED;
  const kept = CLASSIFICATION_KEPT_ANGLES[classification];
  if (kept.length === 2) return BARE_SUMMARY_ANGLE_CLAUSE_UNLOCKED;
  return `Submit this as one \`sections[]\` entry with \`angle: "${kept[0]}"\` — never a descriptive label.`;
}

/** Render scope for {@link resolveStagePrompt}: hop-invariant system block vs per-focus hop block. */
export type StageRenderScope =
  | { readonly scope: 'stable' }
  | { readonly scope: 'per_focus'; readonly focusKind: 'bodied' | 'non_bodied' };

/** Result of {@link resolveStagePrompt}: the assembled prompt block plus a gating trail for diagnostics. */
export interface StagePromptResult {
  /** Final markdown block ready to splice into the system prompt. Empty if no keys ship. */
  prompt: string;
  /** YAML keys that survived stage + classification + slot-count gating and have non-empty instructions. */
  shippedKeys: string[];
  /** Keys filtered out, with the reason they were dropped — for diagnostic logging. */
  gatedOut: Array<{ key: string; reason: 'stage' | 'classification' | 'slot_count' | 'empty_template' | 'ct_mode' | 'focus_scope' }>;
}

/**
 * Assembles the stage-scoped template block for the AI system prompt.
 *
 * @remarks
 * Walks `STAGE_BY_KEY` and emits one bullet per active key: `- <key>: <instruction>`, a capture key
 * labelled with its `sections[].angle` instead (`CAPTURE_ANGLE`), and a per-focus recipe key with
 * no angle of its own (e.g. `structural_callouts`) labelled with neither — it folds into whichever
 * angle fired, per {@link CAPTURE_RECIPE_HEADER}, never its own `- <key>:` line. One heading
 * hierarchy — no per-key `####` wrappers. The AI parses the bullet list directly.
 * The non-bodied per-focus render is the exception: `structural_summary` ships bare, with no
 * `### ` header, keeping only {@link bareSummaryAngleClause} ahead of it.
 *
 * At synthesis, if `classification` is known, a `**Mission type:** <value>` one-liner is emitted
 * before the bullet list. The value is code-resolved; the `intro` template instruction references
 * it explicitly.
 *
 * @param templates - The loaded AI output templates (instruction strings).
 * @param phase - The current conversation phase.
 * @param classification - Optional mission-type signal; gates active-phase capture firing.
 * @param slotCount - Number of detail slots collected so far; suppresses the `closing` template at synthesis when below the `CLOSING_MIN_SLOTS` threshold (3).
 * @param isCtMode - True if column trace mode is active.
 * @param render - The render scope configuration.
 * @returns An object containing the assembled prompt block, shipped keys, and dropped keys.
 */
export function resolveStagePrompt(
  templates: AiOutputTemplates,
  phase: TemplateStage,
  classification: ClassificationValue | undefined,
  slotCount?: number,
  isCtMode?: boolean,
  /**
   * Which slice of the active stage to render. Default `{ scope: 'stable' }` — every
   * hop-invariant key, per-focus capture keys excluded. `{ scope: 'per_focus', focusKind }`
   * renders ONLY the capture recipe matching the current focus (bodied → `*_capture`,
   * non-bodied → `structural_summary`) for the per-hop worker message. Non-active stages
   * carry no per-focus keys, so the scope is a no-op there.
   */
  render: StageRenderScope = { scope: 'stable' },
): StagePromptResult {
  const CLOSING_MIN_SLOTS = 3;

  const allKeys = Object.keys(STAGE_BY_KEY) as (keyof AiOutputTemplates)[];
  const gatedOut: StagePromptResult['gatedOut'] = [];
  const passing: (keyof AiOutputTemplates)[] = [];

  for (const key of allKeys) {
    if (!STAGE_BY_KEY[key].includes(phase)) {
      gatedOut.push({ key, reason: 'stage' });
      continue;
    }
    const gate = CLASSIFICATION_GATED[key];
    if (gate && classification && !gate.includes(classification)) {
      gatedOut.push({ key, reason: 'classification' });
      continue;
    }
    if (CT_MODE_GATED.has(key) && !isCtMode) {
      gatedOut.push({ key, reason: 'ct_mode' });
      continue;
    }
    if (render.scope === 'stable' && PER_FOCUS_KEYS.has(key)) {
      gatedOut.push({ key, reason: 'focus_scope' });
      continue;
    }
    if (render.scope === 'per_focus' && !PER_FOCUS_KEYS.has(key)) {
      gatedOut.push({ key, reason: 'focus_scope' });
      continue;
    }
    if (key === 'closing' && phase === 'synthesis' && slotCount !== undefined && slotCount < CLOSING_MIN_SLOTS) {
      gatedOut.push({ key, reason: 'slot_count' });
      continue;
    }
    if (render.scope === 'per_focus') {
      if (key === 'structural_summary' && render.focusKind !== 'non_bodied') {
        gatedOut.push({ key, reason: 'focus_scope' });
        continue;
      }
      if ((key === 'business_capture' || key === 'technical_capture' || key === 'structural_callouts') && render.focusKind === 'non_bodied') {
        gatedOut.push({ key, reason: 'focus_scope' });
        continue;
      }
    }
    if (!(templates[key] ?? '').trim()) {
      gatedOut.push({ key, reason: 'empty_template' });
      continue;
    }
    passing.push(key);
  }

  const bareSummary = render.scope === 'per_focus' && render.focusKind === 'non_bodied';
  const blocks = passing.map(key => {
    if (bareSummary) return templates[key].trim();
    const angle = CAPTURE_ANGLE[key];
    if (angle) return `- ${angle}: ${templates[key].trim()}`;
    if (render.scope === 'per_focus') return `- ${templates[key].trim()}`;
    return `- ${key}: ${templates[key].trim()}`;
  });

  const missionLine = phase === 'synthesis' && classification
    ? `**Mission type:** ${classification}`
    : undefined;

  if (blocks.length === 0 && !missionLine) {
    return { prompt: '', shippedKeys: passing, gatedOut };
  }

  const headerByPhase: Record<TemplateStage, string> = {
    discover:  '### Output templates (discovery)',
    active:    render.scope === 'per_focus'
      ? CAPTURE_RECIPE_HEADER
      : '### Active-phase templates (write each key to its target field)',
    synthesis: '### Output templates (synthesis)',
  };

  const parts: string[] = [];
  if (missionLine) parts.push(missionLine);
  if (bareSummary) {
    parts.push(bareSummaryAngleClause(classification));
  } else {
    parts.push(headerByPhase[phase]);
  }
  parts.push(...blocks);
  return { prompt: parts.join('\n\n'), shippedKeys: passing, gatedOut };
}
