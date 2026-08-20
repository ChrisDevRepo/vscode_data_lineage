/**
 * Stage-scoped prompt assembly for the synthesis / active / discover phases.
 */

import type { AiOutputTemplates } from '../session/types';
import type { ClassificationValue } from '../session/classification';

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
 * Authoritative — any `stages:` field in the YAML (user overlay or shipped
 * default) is informational for human readers. If an overlay disagrees with
 * this map the loader warns and uses this routing.
 *
 * Capture keys (`business_capture`, `technical_capture`) fire at active phase;
 * render keys fire at synthesis. There are no synthesis-side mirrors of the
 * capture keys — the slot body is the canonical surface.
 *
 * `description` is intentionally absent — it is engine output (built by
 * `orderAndAssemble` in `presentResult.ts` from title + intro + sections[] + closing),
 * not an AI-writeable field. Do not add it back without first restoring the
 * full AI-input plumbing in `tools.ts` and resolving the conflict with engine
 * assembly.
 *
 * `sections`, `business_subsection`, `technical_subsection` are also intentionally
 * absent — the lift+group+label rule for sections[] lives in
 * `buildSynthesisPrompt()` to avoid duplication with the synthesis cue.
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
  structural_summary:   ['active'],
  general:              ['discover', 'synthesis'],
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
  'structural_summary',
]);

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
 * Walks `STAGE_BY_KEY` and emits one bullet per active key: `- <key>: <instruction>`. One heading
 * hierarchy — no per-key `####` wrappers. The AI parses the bullet list directly.
 *
 * At synthesis, if `classification` is known, a `**Mission type:** <value>` one-liner is emitted
 * before the bullet list. The value is code-resolved; the `intro` template instruction references
 * it explicitly.
 *
 * @param templates - The loaded AI output templates (instruction strings).
 * @param phase - The current conversation phase.
 * @param classification - Optional mission-type signal; gates active-phase capture firing.
 * @param slotCount - Number of detail slots collected so far; suppresses the `closing` template at synthesis when below {@link CLOSING_MIN_SLOTS}.
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
  // `closing` is only useful when the analysis spans 5+ sections (per the YAML
  // instruction itself). Skip it on small graphs to save ~140 tokens.
  const CLOSING_MIN_SLOTS = 5;

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
    // Keeps the system prompt byte-identical across hops: focus-dependent keys ship only per-focus.
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
    // structural_summary replaces business/technical capture for non-bodied (table) focus nodes only.
    if (render.scope === 'per_focus') {
      if (key === 'structural_summary' && render.focusKind !== 'non_bodied') {
        gatedOut.push({ key, reason: 'focus_scope' });
        continue;
      }
      if ((key === 'business_capture' || key === 'technical_capture') && render.focusKind === 'non_bodied') {
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

  const blocks = passing.map(key => `- ${key}: ${templates[key].trim()}`);

  const missionLine = phase === 'synthesis' && classification
    ? `**Mission type:** ${classification}`
    : undefined;

  if (blocks.length === 0 && !missionLine) {
    return { prompt: '', shippedKeys: passing, gatedOut };
  }

  const headerByPhase: Record<TemplateStage, string> = {
    discover:  '### Output templates (discovery)',
    active:    render.scope === 'per_focus'
      ? '### Capture recipe for THIS focus node (write each key to its target field)'
      : '### Active-phase templates (write each key to its target field)',
    synthesis: '### Output templates (synthesis)',
  };

  const parts: string[] = [];
  if (missionLine) parts.push(missionLine);
  parts.push(headerByPhase[phase]);
  parts.push(...blocks);
  return { prompt: parts.join('\n\n'), shippedKeys: passing, gatedOut };
}
