import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { resolveStagePrompt } from '../../../src/ai/prompting/templateRenderer';
import { EMPTY_AI_SECTIONS, EMPTY_AI_TEMPLATES, type AiOutputTemplates } from '../../../src/ai/session/types';
import { rootPath } from '../helpers/testUtils';

const config = load(readFileSync(rootPath('assets', 'aiOutputTemplates.yaml'), 'utf8')) as
  Record<keyof AiOutputTemplates, { instruction: string }>;
const templates: AiOutputTemplates = { ...EMPTY_AI_TEMPLATES, ...Object.fromEntries(
  Object.entries(config).filter(([, value]) => typeof value?.instruction === 'string')
    .map(([key, value]) => [key, value.instruction]),
) };

describe('capture evidence at the rendered model boundary', () => {
  it.each(['business', 'technical', 'both'] as const)('gives %s contextual formulas and only its approved capture keys', classification => {
    const rendered=resolveStagePrompt(templates,'active',classification,undefined,false,
      {scope:'per_focus',focusKind:'bodied'}, EMPTY_AI_SECTIONS);
    expect(rendered.prompt).toContain('LaTeX `$$ … $$` block');
    expect(rendered.prompt).toContain('LaTeX `$ … $` formula in a table');
    expect(rendered.prompt).toContain('These math delimiters are required');
    expect(rendered.prompt).toContain('Do not create a separate Formulas subsection');
    const captureKeys=rendered.shippedKeys.filter(key=>key==='business_capture'||key==='technical_capture');
    expect(captureKeys).toEqual(classification==='both' ? ['business_capture','technical_capture'] : [`${classification}_capture`]);
    expect(rendered.prompt).toContain(classification==='both' ? '`{"business": …, "technical": …}`' : '`{"'+classification+'": …}`');
  });

  it.each(['business', 'technical', 'both'] as const)('ships complete callout grounding for %s without a positional reference', classification => {
    const rendered = resolveStagePrompt(templates, 'active', classification, undefined, false,
      { scope: 'per_focus', focusKind: 'bodied' }, EMPTY_AI_SECTIONS);
    expect(rendered.shippedKeys).toContain('structural_callouts');
    expect(rendered.prompt).toContain(templates.structural_callouts.trim());
    expect(templates.structural_callouts).not.toMatch(/\b(?:above|below)\b/i);
    expect(rendered.prompt).toContain('matching catalog, plan or runtime evidence');
    if (classification === 'business') expect(rendered.shippedKeys).not.toContain('technical_capture');
  });

  it('allows SQL-observable hints and grain while requiring evidence for execution claims', () => {
    const rendered = resolveStagePrompt(templates, 'active', 'technical', undefined, false,
      { scope: 'per_focus', focusKind: 'bodied' }, EMPTY_AI_SECTIONS);
    expect(rendered.prompt).toContain('Describe explicit SQL join hints, grouping and row grain as SQL facts');
    expect(rendered.prompt).toContain('SQL hints alone do not establish what the engine executed or its performance');
    expect(rendered.prompt).toContain('Do not invent physical access or execution steps from SQL syntax');
  });
});
