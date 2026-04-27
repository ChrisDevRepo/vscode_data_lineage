/**
 * Stage-scoped prompt assembly for the synthesis / active / discover phases.
 */

import type { LineageNode } from '../engine/types';
import type { AiOutputTemplates } from './types';
import type { ClassificationValue } from './classification';

/** Map from node id (`[schema].[name]`) to the resolved node record. */
export type NodeMap = Map<string, LineageNode>;

// ─── Stage-scoped prompt assembly ───────────────────────────────────────────

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
export type TemplateStage = 'discover' | 'active' | 'synthesis';

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
 * `orderAndAssemble` in `tools.ts` from title + intro + sections[] + closing),
 * not an AI-writeable field. Do not add it back without first restoring the
 * full AI-input plumbing in `tools.ts` and resolving the conflict with engine
 * assembly.
 *
 * `sections`, `business_subsection`, `technical_subsection` are also intentionally
 * absent — the lift+group+label rule for sections[] lives in
 * `buildSynthesisPrompt()` to avoid duplication with the synthesis cue.
 */
export const STAGE_BY_KEY: Readonly<Record<keyof AiOutputTemplates, readonly TemplateStage[]>> = {
  summary:              ['synthesis'],
  title:                ['synthesis'],
  intro:                ['synthesis'],
  closing:              ['synthesis'],
  highlights:           ['synthesis'],
  notes:                ['synthesis'],
  business_capture:     ['active'],
  technical_capture:    ['active'],
  structural_summary:   ['active'],
};

/**
 * Classification-gated keys — fire only when the session classification
 * matches one of the listed values. Keys absent from this map are always on.
 *
 * @remarks
 * Active-phase classification is typically `undefined` (inference happens at
 * the active→synthesis boundary). When classification is `undefined`, every
 * gated key fires unconditionally so per-hop capture stays broad — the AI
 * captures both angles into the slot. The synthesis turn lifts the slot
 * bodies as written; classification surfaces only via the
 * `**Mission type:** <value>` cue emitted at synthesis (referenced by the
 * `intro` template instruction).
 */
const CLASSIFICATION_GATED: Readonly<Record<string, readonly ClassificationValue[]>> = {
  business_capture:     ['business', 'both'],
  technical_capture:    ['technical', 'both'],
};

/**
 * Assembles the stage-scoped template block for the AI system prompt.
 *
 * @remarks
 * Walks `STAGE_BY_KEY` and emits one bullet per active key:
 * `- <key>: <instruction>`. One heading hierarchy — no per-key `####`
 * wrappers. The AI parses the bullet list directly.
 *
 * At synthesis, if `classification` is known, a `**Mission type:** <value>`
 * one-liner is emitted before the bullet list. The value is code-resolved;
 * the `intro` template instruction references it explicitly.
 *
 * @param templates - The loaded AI output templates (instruction strings).
 * @param phase - The current conversation phase.
 * @param classification - Optional mission-type signal; gates active-phase capture firing.
 * @returns A markdown block ready to append to the phase-appropriate system prompt.
 */
export function resolveStagePrompt(
  templates: AiOutputTemplates,
  phase: TemplateStage,
  classification: ClassificationValue | undefined,
  slotCount?: number,
): string {
  // `closing` is only useful when the analysis spans 5+ sections (per the YAML
  // instruction itself). Skip it on small graphs to save ~140 tokens.
  const CLOSING_MIN_SLOTS = 5;
  const keys = (Object.keys(STAGE_BY_KEY) as (keyof AiOutputTemplates)[])
    .filter(key => STAGE_BY_KEY[key].includes(phase))
    .filter(key => {
      const gate = CLASSIFICATION_GATED[key];
      if (!gate) return true;
      if (!classification) return true;
      return gate.includes(classification);
    })
    .filter(key => {
      if (key !== 'closing') return true;
      if (phase !== 'synthesis') return true;
      return slotCount === undefined || slotCount >= CLOSING_MIN_SLOTS;
    });

  const blocks = keys
    .filter(key => (templates[key] ?? '').trim().length > 0)
    .map(key => `- ${key}: ${templates[key].trim()}`);

  const missionLine = phase === 'synthesis' && classification
    ? `**Mission type:** ${classification}`
    : undefined;

  if (blocks.length === 0 && !missionLine) return '';

  const headerByPhase: Record<TemplateStage, string> = {
    discover:  '### Output templates (discovery)',
    active:    '### Capture rules — submit these as `sections[]` in submit_findings',
    synthesis: '### Output templates (synthesis)',
  };

  const parts: string[] = [];
  if (missionLine) parts.push(missionLine);
  parts.push(headerByPhase[phase]);
  parts.push(...blocks);
  return parts.join('\n\n');
}
