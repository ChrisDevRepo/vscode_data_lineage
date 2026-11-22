/** Stage-scoped prompt assembly for the synthesis / active / discover phases. */

import { AI_SECTION_KEY_BY_ANGLE, SECTIONS_PLACEHOLDER, type AiOutputSections, type AiOutputTemplates, type AiSectionAngle } from '../session/types';
import type { ClassificationValue } from '../session/classification';
import { CLASSIFICATION_KEPT_ANGLES, sectionField } from '../session/classification';

/**
 * Stages at which a YAML instruction may be injected into the AI system prompt: `discover` (inline
 * chat first response, no SM engaged), `active` (per-hop section writing; one capture key per
 * fired `*_capture`), `synthesis` (present_result assembly; slot bodies arrive pre-formatted from
 * capture and are lifted as written, synthesis only assembles, groups and frames).
 */
type TemplateStage = 'discover' | 'active' | 'synthesis';

/**
 * Canonical, code-owned routing of YAML keys to stages. Authoritative: a `stages:` field in the
 * YAML is informational only (the loader never reads it; only `instruction` is overlaid), so a
 * disagreeing overlay is routed by this map. `general` is placement-only at synthesis: a captured
 * ⚠️ sits once in its section.
 *
 * `description` is absent on purpose: it is engine output (`orderAndAssemble` in
 * `presentResult.ts`), not an AI-writeable field. `sections`, `business_subsection` and
 * `technical_subsection` are absent too: their lift+group+label rule lives in
 * `buildSynthesisPrompt()`.
 */
const STAGE_BY_KEY: Readonly<Record<keyof AiOutputTemplates, readonly TemplateStage[]>> = {
  discovery_chat:       ['discover'],
  summary:              ['synthesis'],
  title:                ['synthesis'],
  intro:                ['synthesis'],
  closing:              ['synthesis'],
  highlights:           ['synthesis'],
  notes:                ['synthesis'],
  shared_capture:       ['active'],
  business_capture:     ['active'],
  technical_capture:    ['active'],
  structural_callouts:  ['active'],
  structural_summary:   ['active'],
  general:              ['synthesis'],
  loading_pattern:      ['synthesis'],
  column_trace_capture: ['active'],
};

/**
 * Classification-gated keys fire only when the session classification matches a listed value;
 * absent keys are always on. A fresh exploration locks classification before the approval gate, so
 * `undefined` is a defensive case for pre-gate/legacy callers: every gated capture key fires rather
 * than silently dropping an evidence angle.
 */
const CLASSIFICATION_GATED: Readonly<Record<string, readonly ClassificationValue[]>> = {
  business_capture:     ['business', 'both'],
  technical_capture:    ['technical', 'both'],
  loading_pattern:      ['technical', 'both'],
};

/**
 * CT-mode-gated keys fire only when the approved runtime mode is CT (CT requires target columns; BB
 * must never carry them). Additive to classification gating: both gates must pass.
 */
const CT_MODE_GATED: ReadonlySet<keyof AiOutputTemplates> = new Set([
  'column_trace_capture',
]);

/**
 * Per-FOCUS capture keys: which fires depends on the hop's focus node (bodied script vs non-bodied
 * table), so they are volatile per hop. They render into the per-hop worker message
 * (`render: 'per_focus'`), NEVER the active system prompt (`render: 'stable'`): swapping templates
 * per focus type would break the byte-stable prefix the provider-side prompt cache keys on.
 */
const PER_FOCUS_KEYS: ReadonlySet<keyof AiOutputTemplates> = new Set([
  'business_capture',
  'technical_capture',
  'structural_callouts',
  'shared_capture',
  'structural_summary',
]);

/**
 * The `submit_findings` section field each capture key writes. The per-focus recipe labels its
 * bullet with this value, not the YAML key, so the label is the literal the schema accepts.
 */
const CAPTURE_FIELD: Readonly<Partial<Record<keyof AiOutputTemplates, string>>> = {
  business_capture:  sectionField('business'),
  technical_capture: sectionField('technical'),
};

/**
 * The section fields the dispatched `submit_findings` schema serves, read from the same
 * {@link CLASSIFICATION_KEPT_ANGLES}, so prompt and schema never name different fields (a locked
 * mission told both would guess the excluded one and be rejected).
 */
function servedSectionFields(classification: ClassificationValue | undefined): string {
  const kept = classification ? CLASSIFICATION_KEPT_ANGLES[classification] : CLASSIFICATION_KEPT_ANGLES.both;
  return kept.map(angle => `\`${sectionField(angle)}\``).join(' and ');
}

/**
 * Header of the bodied per-focus capture recipe, shared by every capture key: the one home of the
 * one-field-per-angle rule, the exact-substring quoting rule and the `not established` wording, so
 * no capture key restates them.
 */
function captureRecipeHeader(classification: ClassificationValue | undefined): string {
  const target = classification && classification !== 'both' ? "that field's" : "each field's";
  return [
    '### Capture recipe',
    `Submit ${servedSectionFields(classification)}, and put every applicable item from the active capture instructions inside ${target} string value. Markdown without headings. Back each evidence-supported ⚠️ line with one short \`\`\`sql fence of its deciding expression, copied from \`bb_ddl\`; other SQL follows the SQL snippet rule; what the SQL does not establish reads \`not established from the available SQL\`. Skip an item the SQL lacks.`,
    'The recipe items are a coverage checklist, not disconnected output fragments. Write each substantive calculation, and each intermediate result another calculation builds on, once within its natural rule or transformation step: explain the inputs and affected rows, show the formula, explain its defined meaning and consequences there. In every angle, use a LaTeX `$$ … $$` block on its own lines, or a LaTeX `$ … $` formula in a table with a short description of its meaning; short formulas may also sit inline within their explanatory sentence. Describe a calculated value only when its defining expression is supplied. A formula carries every term and branch of the SQL it restates. A list of calculation names is not their explanation. Simple renames need no equation. Describe intermediate and final surviving grain separately; later deletion or validation can leave zero rows from an earlier partition.',
  ].join('\n\n');
}

/**
 * The one line the non-bodied per-focus render keeps from {@link captureRecipeHeader} (its
 * SQL-evidence rules do not apply to a schema-only node). Without it the model free-labels the
 * entry from the summary's own bullet names (`Purpose`, `Upstream sources`, ...), which
 * `lineage_submit_findings` rejects.
 */
function bareSummaryAngleClause(classification: ClassificationValue | undefined): string {
  return `Submit this under ${servedSectionFields(classification)} — never a descriptive label.`;
}

/**
 * The ordered bold section labels the active angle(s) write, as one list for the synthesis
 * `general` instruction. Reads the `sections` each capture recipe declares for the angles
 * {@link CLASSIFICATION_KEPT_ANGLES} keeps: one angle gives its list, `both` the ordered union
 * (first occurrence wins), unlocked keeps every angle. A label declared only by an angle the
 * mission did not fire is never served.
 */
function activeSectionLabels(sections: AiOutputSections, classification: ClassificationValue | undefined): string {
  const angles: readonly AiSectionAngle[] = classification
    ? CLASSIFICATION_KEPT_ANGLES[classification]
    : (Object.keys(AI_SECTION_KEY_BY_ANGLE) as AiSectionAngle[]);
  const labels = new Set(angles.flatMap(angle => sections[angle] ?? []));
  return [...labels].map(label => `**${label}**`).join(', ');
}

/** Render scope for {@link resolveStagePrompt}: hop-invariant system block vs per-focus block. */
export type StageRenderScope =
  | { readonly scope: 'stable' }
  | { readonly scope: 'per_focus'; readonly focusKind: 'bodied' | 'non_bodied' };

/** Result of {@link resolveStagePrompt}: the prompt block plus a gating trail for diagnostics. */
export interface StagePromptResult {
  /** Final markdown block ready to splice into the system prompt. Empty if no keys ship. */
  prompt: string;
  /** YAML keys that passed stage, classification and slot-count gating and have instructions. */
  shippedKeys: string[];
  /** Keys filtered out, with the reason they were dropped — for diagnostic logging. */
  gatedOut: Array<{ key: string; reason: 'stage' | 'classification' | 'slot_count' | 'empty_template' | 'ct_mode' | 'focus_scope' }>;
}

/**
 * Assembles the stage-scoped template block for the AI system prompt: one bullet per active key,
 * `- <key>: <instruction>` (walking `STAGE_BY_KEY`). A capture key is labelled with its section
 * field instead (`CAPTURE_FIELD`); a per-focus recipe key with no angle of its own (e.g.
 * `structural_callouts`) folds into whichever angle fired, per {@link captureRecipeHeader}, never
 * its own line; `shared_capture` precedes the recipes once, unlabelled. One heading
 * hierarchy, no per-key `####` wrappers. The non-bodied per-focus render is the exception:
 * `structural_summary` ships bare with no `### ` header, keeping only
 * {@link bareSummaryAngleClause} ahead of it. At synthesis a known `classification` adds a
 * code-resolved `**Mission type:** <value>` line before the list.
 *
 * @param classification - Optional mission-type signal; gates active-phase capture firing.
 * @param slotCount - Detail slots collected so far; suppresses the `closing` template at synthesis
 *   below `CLOSING_MIN_SLOTS` (3).
 * @param sections - Section labels declared by the capture recipes; at synthesis they replace
 *   {@link SECTIONS_PLACEHOLDER} in the `general` instruction, for the active angle only. Required,
 *   so a render never serves the placeholder an empty list by omission; an instruction without the
 *   placeholder renders as written.
 * @returns The assembled prompt block, shipped keys and dropped keys.
 */
export function resolveStagePrompt(
  templates: AiOutputTemplates,
  phase: TemplateStage,
  classification: ClassificationValue | undefined,
  slotCount: number | undefined,
  isCtMode: boolean | undefined,
  /**
   * Which slice of the active stage to render. Default `{ scope: 'stable' }`: every hop-invariant
   * key, per-focus capture keys excluded. `{ scope: 'per_focus', focusKind }` renders ONLY the
   * recipe matching the focus (bodied `*_capture`, non-bodied `structural_summary`) for the per-hop
   * worker message. A no-op for non-active stages.
   */
  render: StageRenderScope = { scope: 'stable' },
  sections: AiOutputSections,
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
      if ((key === 'business_capture' || key === 'technical_capture' || key === 'structural_callouts' || key === 'shared_capture') && render.focusKind === 'non_bodied') {
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
    if (key === 'general') {
      const instruction = templates[key].trim().split(SECTIONS_PLACEHOLDER).join(activeSectionLabels(sections, classification));
      return `- ${key}: ${instruction}`;
    }
    const field = CAPTURE_FIELD[key];
    if (field) return `- ${field}: ${templates[key].trim()}`;
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
      ? captureRecipeHeader(classification)
      : '### Active-phase templates',
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
