/** Stage-scoped prompt assembly for the synthesis / active / discover phases. */

import {
  AI_SECTION_KEY_BY_ANGLE,
  SECTIONS_PLACEHOLDER,
  type AiOutputSections,
  type AiOutputTemplates,
  type AiSectionAngle,
} from '../session/types';
import type { ClassificationValue } from '../session/classification';
import { CLASSIFICATION_KEPT_ANGLES } from '../session/classification';

/** KaTeX source rule shared by the hop capture recipe and the synthesis formula rule: names keep TeX special characters escaped and environments complete. */
export const LATEX_SOURCE_RULE =
  'In LaTeX, write `\\#`, `\\_`, `\\%` and `\\&` for those characters in names, and close every `\\begin{…}` with its `\\end{…}`.';

/** Stages at which a YAML instruction may be injected into the AI system prompt. */
type TemplateStage = 'discover' | 'active' | 'synthesis';

/** Canonical, code-owned routing of YAML keys to stages. */
const STAGE_BY_KEY: Readonly<
  Record<keyof AiOutputTemplates, readonly TemplateStage[]>
> = {
  discovery_chat: ['discover'],
  summary: ['synthesis'],
  title: ['synthesis'],
  intro: ['synthesis'],
  closing: ['synthesis'],
  highlights: ['synthesis'],
  notes: ['synthesis'],
  shared_capture: ['active'],
  business_capture: ['active'],
  technical_capture: ['active'],
  structural_callouts: ['active'],
  structural_summary: ['active'],
  general: ['synthesis'],
  loading_pattern: ['synthesis'],
  column_trace_capture: ['active'],
};

/** Classification-gated keys — fire only when the session classification matches one of the listed values. Keys absent from this map are always on. */
const CLASSIFICATION_GATED: Readonly<
  Record<string, readonly ClassificationValue[]>
> = {
  business_capture: ['business', 'both'],
  technical_capture: ['technical', 'both'],
  loading_pattern: ['technical', 'both'],
};

/** CT-mode-gated keys — fire only when the current hop is dispatched under the CT contract; a BB hop of a CT session renders without them. Additive to classification-gated templates; both gates must pass. */
const CT_MODE_GATED: ReadonlySet<keyof AiOutputTemplates> = new Set([
  'column_trace_capture',
]);

/** Per-FOCUS capture keys — which of these fires depends on the current hop's focus node (bodied script vs non-bodied table), so they are volatile per hop. They render into the per-hop worker message (`render: 'per_focus'`), NEVER into the active system prompt (`render: 'stable'`): a system prompt that swaps templates per focus type breaks the byte-stable prefix the provider-side implicit prompt cache keys on. */
const PER_FOCUS_KEYS: ReadonlySet<keyof AiOutputTemplates> = new Set([
  'shared_capture',
  'business_capture',
  'technical_capture',
  'structural_callouts',
  'structural_summary',
]);

/** The `sections` key each capture key writes. The per-focus recipe labels its bullet with this value, never the YAML key, so the label is the literal the `submit_findings` schema accepts. */
const CAPTURE_ANGLE: Readonly<
  Partial<Record<keyof AiOutputTemplates, 'business' | 'technical'>>
> = {
  business_capture: 'business',
  technical_capture: 'technical',
};

/** Header of the bodied per-focus capture recipe, shared by every capture key: the one home of the one-key-per-schema-angle rule (each capture bullet is labelled with the `sections` key it writes), the exact-substring quoting rule and the `not established` wording, so no capture key restates them. */
function captureRecipeHeader(
  classification: ClassificationValue | undefined,
): string {
  const kept = classification
    ? CLASSIFICATION_KEPT_ANGLES[classification]
    : undefined;
  const shape = !kept
    ? 'an object keyed by angle (`{business, technical}`), one key per angle this mission fires'
    : kept.length === 2
      ? '`{"business": …, "technical": …}` — classification=both keeps both keys, one key per angle'
      : '`{"' +
        kept[0] +
        '": …}` — classification=' +
        classification +
        ' keeps only this key';
  return [
    '### Capture recipe',
    `Submit \`sections\` as ${shape}, and put every applicable item from the active capture instructions inside that key's string value. Markdown without headings. Back each grain predicate, formula and any evidence-supported ⚠️ line with one short \`\`\`sql fence of its deciding expression, an exact substring of \`ddl\`; what the SQL does not establish reads \`not established from the available SQL\`. Skip an item the SQL lacks.`,
    'Formatting instructions describe the decoded section string. In tool-call JSON, encode its line breaks, double quotes and backslashes as JSON string escapes so the SQL and LaTeX decode unchanged; keep structural JSON quotes unescaped and omit trailing commas.',
    'The recipe items are a coverage checklist, not disconnected output fragments. Write each substantive calculation, and each intermediate result another calculation builds on, once within its natural rule or transformation step: explain the inputs and affected rows, show the formula, explain its defined meaning and consequences, and quote the deciding SQL there. In every angle, use a LaTeX `$$ … $$` block on its own lines, or a LaTeX `$ … $` formula in a table with a short description of its meaning; short formulas may also sit inline within their explanatory sentence. Arithmetic, aggregate and window expressions in the supplied SQL define calculations; they do not establish observed statistics, counts, elapsed time or performance. Describe a calculated value only when its defining expression is supplied; report a measured result only when matching data or runtime evidence is supplied. These math delimiters are required. ' +
      LATEX_SOURCE_RULE +
      ' A formula carries every term and branch of the SQL it restates. Do not create a separate Formulas subsection. Capture this complete explanation in detail memory; a list of calculation names is not their explanation. Simple renames need no equation. Keep SQL quotes contiguous and verbatim: omit unrelated SQL by choosing a shorter quote, never by inserting ellipses. Describe intermediate and final surviving grain separately; later deletion or validation can leave zero rows from an earlier partition.',
  ].join('\n\n');
}

/** Bare-summary angle clause — the one line the non-bodied per-focus render keeps from {@link captureRecipeHeader} when it drops the rest of that header (its SQL-evidence rules do not apply to a schema-only node with no body). Without it the model has no cue that `sections` is a fixed schema key set and free-labels the entry from the summary's own bullet names (`Purpose`, `Upstream sources`, …), which `lineage_submit_findings` rejects. */
const BARE_SUMMARY_ANGLE_CLAUSE_UNLOCKED =
  'Submit this under the matching `sections` key (`business`, `technical`, or both) — never a descriptive label.';

/** Resolves {@link BARE_SUMMARY_ANGLE_CLAUSE_UNLOCKED} to the angle(s) the locked classification keeps, reading the same {@link CLASSIFICATION_KEPT_ANGLES} the dispatched schema narrows to — one source, so the prompt line and the schema can never name different angles. */
function bareSummaryAngleClause(
  classification: ClassificationValue | undefined,
): string {
  if (!classification) return BARE_SUMMARY_ANGLE_CLAUSE_UNLOCKED;
  const kept = CLASSIFICATION_KEPT_ANGLES[classification];
  if (kept.length === 2)
    return 'Submit this under both `sections` keys, `business` and `technical` — never a descriptive label.';
  return `Submit this under \`sections.${kept[0]}\` — never a descriptive label.`;
}

/** The ordered bold section labels the active angle(s) write, as one list for the synthesis `general` instruction. */
function activeSectionLabels(
  sections: AiOutputSections,
  classification: ClassificationValue | undefined,
): string {
  const angles: readonly AiSectionAngle[] = classification
    ? CLASSIFICATION_KEPT_ANGLES[classification]
    : (Object.keys(AI_SECTION_KEY_BY_ANGLE) as AiSectionAngle[]);
  const labels: string[] = [];
  for (const angle of angles) {
    let after = -1;
    for (const label of sections[angle] ?? []) {
      const at = labels.indexOf(label);
      if (at >= 0) {
        after = at;
        continue;
      }
      labels.splice(++after, 0, label);
    }
  }
  return labels.map((label) => `**${label}**`).join(', ');
}

/** Render scope for {@link resolveStagePrompt}: hop-invariant system block vs per-focus hop block. */
export type StageRenderScope =
  | { readonly scope: 'stable' }
  | {
      readonly scope: 'per_focus';
      readonly focusKind: 'bodied' | 'non_bodied';
      /** False only when all kept section angles are valid and held; evidence limits still render. */
      readonly writeSections?: boolean;
    };

/** Result of {@link resolveStagePrompt}: the assembled prompt block plus a gating trail for diagnostics. */
export interface StagePromptResult {
  /** Final markdown block ready to splice into the system prompt. Empty if no keys ship. */
  prompt: string;
  /** YAML keys that survived stage + classification + slot-count gating and have non-empty instructions. */
  shippedKeys: string[];
  /** Keys filtered out, with the reason they were dropped — for diagnostic logging. */
  gatedOut: Array<{
    key: string;
    reason:
      | 'stage'
      | 'classification'
      | 'slot_count'
      | 'empty_template'
      | 'ct_mode'
      | 'focus_scope';
  }>;
}

/** Assembles the stage-scoped template block for the AI system prompt. */
export function resolveStagePrompt(
  templates: AiOutputTemplates,
  phase: TemplateStage,
  classification: ClassificationValue | undefined,
  slotCount: number | undefined,
  isCtMode: boolean | undefined,
  /** Which slice of the active stage to render. Default `{ scope: 'stable' }` — every hop-invariant key, per-focus capture keys excluded. `{ scope: 'per_focus', focusKind }` renders ONLY the capture recipe matching the current focus (bodied → `*_capture`, non-bodied → `structural_summary`) for the per-hop worker message. Non-active stages carry no per-focus keys, so the scope is a no-op there. */
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
    if (
      key === 'closing' &&
      phase === 'synthesis' &&
      slotCount !== undefined &&
      slotCount < CLOSING_MIN_SLOTS
    ) {
      gatedOut.push({ key, reason: 'slot_count' });
      continue;
    }
    if (render.scope === 'per_focus') {
      if (
        render.writeSections === false &&
        (key === 'shared_capture' ||
          key === 'structural_summary' ||
          CAPTURE_ANGLE[key])
      ) {
        gatedOut.push({ key, reason: 'focus_scope' });
        continue;
      }
      if (key === 'structural_summary' && render.focusKind !== 'non_bodied') {
        gatedOut.push({ key, reason: 'focus_scope' });
        continue;
      }
      if (
        (key === 'shared_capture' ||
          key === 'business_capture' ||
          key === 'technical_capture' ||
          key === 'structural_callouts') &&
        render.focusKind === 'non_bodied'
      ) {
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

  const bareSummary =
    render.scope === 'per_focus' && render.focusKind === 'non_bodied';
  const blocks = passing.map((key) => {
    if (bareSummary) return templates[key].trim();
    if (key === 'general') {
      const instruction = templates[key]
        .trim()
        .split(SECTIONS_PLACEHOLDER)
        .join(activeSectionLabels(sections, classification));
      return `- ${key}: ${instruction}`;
    }
    const angle = CAPTURE_ANGLE[key];
    if (angle) return `- ${angle}: ${templates[key].trim()}`;
    if (render.scope === 'per_focus') return `- ${templates[key].trim()}`;
    return `- ${key}: ${templates[key].trim()}`;
  });

  const missionLine =
    phase === 'synthesis' && classification
      ? `**Mission type:** ${classification}`
      : undefined;

  if (blocks.length === 0 && !missionLine) {
    return { prompt: '', shippedKeys: passing, gatedOut };
  }

  const headerByPhase: Record<TemplateStage, string> = {
    discover: '### Output templates (discovery)',
    active:
      render.scope === 'per_focus'
        ? render.writeSections === false
          ? '### Evidence limits'
          : captureRecipeHeader(classification)
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
