/**
 * Render helpers for the present_result description + stage-scoped prompt assembly.
 *
 * @remarks
 * The metadata band previously rendered In / Out object lists and a per-section
 * object table — both removed. Those were redundant with the graph view itself,
 * overwhelmed long sections, and leaked topology into prose. The only render
 * helper remaining here is the SP-only Loading Pattern line.
 */

import type { LineageNode } from '../engine/types';
import type { AiOutputTemplates } from './types';
import type { ClassificationValue } from './classification';

/** Map from node id (`[schema].[name]`) to the resolved node record. */
export type NodeMap = Map<string, LineageNode>;

/**
 * Returns `true` when the origin node is a stored procedure.
 *
 * @remarks
 * Views and UDFs never carry a loading pattern — a view is a read-time
 * projection and a UDF is a function; neither "loads" anything.
 *
 * @param originNode - The origin `LineageNode` (may be `undefined` if unresolved).
 * @returns `true` when a Loading Pattern line should be rendered.
 */
export function shouldEmitLoadingPattern(originNode: LineageNode | undefined): boolean {
  return originNode?.type === 'procedure';
}

/**
 * Renders the top-of-description metadata band. Currently only the optional
 * Loading Pattern line (SP-only). In / Out neighbor rows were removed — users
 * read topology from the graph view, not from text in the description.
 *
 * @param originId - The origin node id; used to look up the node type.
 * @param nodeMap - Map from node id to `LineageNode`.
 * @param loadingPattern - Optional AI-authored loading-pattern string. When
 * the origin is not a stored procedure this is ignored.
 * @returns A markdown block ready to be prepended to the description, or `''`.
 */
export function renderMetadataBand(
  originId: string,
  nodeMap: NodeMap,
  loadingPattern?: string,
): string {
  const originNode = nodeMap.get(originId);
  if (shouldEmitLoadingPattern(originNode) && loadingPattern && loadingPattern.trim()) {
    return `**Loading Pattern:** ${loadingPattern.trim()}`;
  }
  return '';
}

// ─── Stage-scoped prompt assembly ───────────────────────────────────────────

/**
 * Stages at which a YAML instruction may be injected into the AI system prompt.
 *
 * @remarks
 * - `discover`  = inline chat first response (no SM engaged).
 * - `active`    = per-hop `detail_analysis` writing — capture rules only.
 * - `synthesis` = present_result assembly — render rules + classification-gated
 *                 subsections.
 */
export type TemplateStage = 'discover' | 'active' | 'synthesis';

/**
 * Canonical, code-owned routing of YAML keys to stages.
 *
 * @remarks
 * Authoritative — any `stages:` field in the YAML (user overlay or shipped
 * default) is informational for human readers. If an overlay disagrees with
 * this map the loader warns and uses this routing. Engine invariant: only
 * `business_subsection` and `technical_subsection` reach the `active` phase;
 * render-only keys (title, intro, closing, ...) never inject during hops.
 */
export const STAGE_BY_KEY: Readonly<Record<keyof AiOutputTemplates, readonly TemplateStage[]>> = {
  summary:              ['discover', 'synthesis'],
  title:                ['synthesis'],
  intro:                ['synthesis'],
  description:          ['discover', 'synthesis'],
  sections:             ['synthesis'],
  closing:              ['synthesis'],
  highlights:           ['synthesis'],
  notes:                ['synthesis'],
  loading_pattern:      ['synthesis'],
  business_capture:     ['active'],
  business_subsection:  ['synthesis'],
  technical_capture:    ['active'],
  technical_subsection: ['synthesis'],
  general:              ['active', 'synthesis'],
  structural_summary:   ['active'],
};

/**
 * Classification-gated keys — fire only when the session classification
 * matches one of the listed values. Keys absent from this map are always on.
 *
 * @remarks
 * At the `active` phase the classification is typically `undefined` (inference
 * happens at the active→synthesis boundary). `resolveStagePrompt` fires all
 * gated keys when classification is undefined, so per-hop capture stays broad —
 * the AI captures both angles; synthesis filters by the resolved value.
 */
const CLASSIFICATION_GATED: Readonly<Record<string, readonly ClassificationValue[]>> = {
  business_capture:     ['business', 'both'],
  business_subsection:  ['business', 'both'],
  technical_capture:    ['technical', 'both'],
  technical_subsection: ['technical', 'both'],
};

/**
 * Headings prepended to the stage-scoped system-prompt block.
 *
 * @remarks
 * Phase-neutral labels — the AI does not need the internal phase name (active,
 * synthesis, discover); it needs to know what to do with the block.
 */
const STAGE_HEADER: Readonly<Record<TemplateStage, string>> = {
  discover:  '### Chat response format',
  active:    '### Capture rules — write these into detail_analysis',
  synthesis: '### Presentation document rules',
};

/**
 * Human-readable section titles used inside a stage block. Keeps YAML key
 * identifiers out of the AI prompt — the AI sees readable titles, not the
 * internal snake_case names.
 */
const KEY_TITLE: Readonly<Record<keyof AiOutputTemplates, string>> = {
  summary:              'Card headline',
  title:                'Document heading',
  intro:                'Intro paragraph',
  description:          'Fallback document body',
  sections:             'Section grouping',
  closing:              'Closing note',
  highlights:           'Highlighted nodes',
  notes:                'Per-node captions',
  loading_pattern:      'Loading pattern (SP-only)',
  business_capture:     'Business angle',
  business_subsection:  'Business section body',
  technical_capture:    'Technical angle',
  technical_subsection: 'Technical section block',
  general:              'General guidance',
  structural_summary:   'Structural summary (non-code focus)',
};

/**
 * Assembles the stage-scoped template block for the AI system prompt.
 *
 * @remarks
 * Walks `STAGE_BY_KEY` and emits `#### <Human Title>\n<instruction>` for each
 * key that matches the given phase and classification gate. No pointers, no
 * phase labels, no snake_case identifiers — the AI reads clean human-readable
 * section headings and the instruction text directly.
 *
 * When `classification` is `undefined` (typical during active-phase hops)
 * every gated key fires unconditionally, which is what we want: the AI
 * captures both business and technical angles per node.
 *
 * At synthesis, if `classification` is known, a `**Mission type:** <value>`
 * one-liner is emitted before the section blocks. This is injected by the
 * code path rather than the YAML because the value is code-resolved.
 *
 * When `isStructuralFocus` is `true` (ACTIVE phase only), the `structural_summary`
 * template replaces the business / technical capture blocks: the starting
 * point is a non-bodied node, so the reduced template keeps the hop to
 * structural facts and forbids invented behaviour.
 *
 * @param templates - The loaded AI output templates (instruction strings).
 * @param phase - The current conversation phase.
 * @param classification - Optional mission-type signal; gates subsection firing.
 * @param isStructuralFocus - When `true` the reduced template swaps in; ACTIVE phase only.
 * @returns A markdown block ready to append to the phase-appropriate system prompt.
 */
export function resolveStagePrompt(
  templates: AiOutputTemplates,
  phase: TemplateStage,
  classification: ClassificationValue | undefined,
  isStructuralFocus: boolean = false,
): string {
  const structuralMode = isStructuralFocus && phase === 'active';
  const keys = (Object.keys(STAGE_BY_KEY) as (keyof AiOutputTemplates)[])
    .filter(key => STAGE_BY_KEY[key].includes(phase))
    .filter(key => {
      if (structuralMode) {
        // Reduced template swaps business/technical capture for structural_summary;
        // keep shared `general` guidance (unbounded depth, table rule, ⚠️ inline).
        return key === 'structural_summary' || key === 'general';
      }
      return key !== 'structural_summary';
    })
    .filter(key => {
      const gate = CLASSIFICATION_GATED[key];
      if (!gate) return true;
      if (!classification) return true;
      return gate.includes(classification);
    });

  const blocks = keys
    .filter(key => (templates[key] ?? '').trim().length > 0)
    .map(key => `#### ${KEY_TITLE[key]}\n${templates[key]}`);

  const missionLine = phase === 'synthesis' && classification
    ? `**Mission type:** ${classification}`
    : undefined;

  if (blocks.length === 0 && !missionLine) return '';

  const parts = [STAGE_HEADER[phase]];
  if (missionLine) parts.push(missionLine);
  parts.push(...blocks);
  return parts.join('\n\n');
}
