import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSynthesisInstruction } from '../../../src/ai/agent/stagePrompts';
import { deriveStagePromptContext } from '../../../src/ai/prompting/hostPrompts';
import { resolveStagePrompt } from '../../../src/ai/prompting/templateRenderer';
import { AiSession } from '../../../src/ai/session/session';
import { EMPTY_AI_TEMPLATES, SECTIONS_PLACEHOLDER, type AiOutputSections, type AiOutputTemplates } from '../../../src/ai/session/types';
import { parseAiOutputTemplatesYaml, readAiOutputSections, REQUIRED_AI_TEMPLATE_KEYS } from '../../../src/configCore';
import { rootPath } from '../helpers/testUtils';

const parsed = parseAiOutputTemplatesYaml(readFileSync(rootPath('assets', 'aiOutputTemplates.yaml'), 'utf8'));
const builtInTemplates: AiOutputTemplates = { ...EMPTY_AI_TEMPLATES };
for (const key of REQUIRED_AI_TEMPLATE_KEYS) builtInTemplates[key] = (parsed[key]?.instruction ?? '').trim();
const builtInSections = readAiOutputSections(parsed).sections;

const BUILT_IN_SENTENCE = 'use only these bold labels, in this order when applicable: **Purpose**, **Rules and branches**, **Grain**, '
  + '**Column mapping**, **Steps**, **Loading**, **Error handling**, **Gaps**. Embed';

/** Section-structure sentence a synthesis render serves, cut at the label list. */
function labelList(prompt: string): string {
  const match = /in this order when applicable: (.*?)\. Embed/.exec(prompt);
  expect(match, 'the Section structure sentence is served').not.toBeNull();
  return match![1];
}

const synthesis = (sections: AiOutputSections, classification?: 'business' | 'technical' | 'both', templates = builtInTemplates) =>
  resolveStagePrompt(templates, 'synthesis', classification, 5, false, { scope: 'stable' }, sections).prompt;

const withTechnicalOnlyLabel: AiOutputSections = {
  business: builtInSections.business,
  technical: ['Purpose', 'Rules and branches', 'Grain', 'Steps', 'Loading', 'Error handling', 'Operational checks', 'Gaps'],
};

describe('section labels: one home per recipe', () => {
  it('built-in file declares the labels on both capture recipes and the placeholder once in general', () => {
    expect(builtInSections.business).toHaveLength(8);
    expect(builtInSections.technical).toEqual(builtInSections.business);
    expect(builtInTemplates.general.split(SECTIONS_PLACEHOLDER)).toHaveLength(2);
    expect(builtInTemplates.general).not.toContain('**Purpose**');
  });

  it.each(['business', 'technical', 'both', undefined] as const)(
    'serves the built-in label sentence for classification %s', classification => {
      expect(synthesis(builtInSections, classification)).toContain(BUILT_IN_SENTENCE);
      expect(synthesis(builtInSections, classification)).not.toContain(SECTIONS_PLACEHOLDER);
    });

  it('serves a label declared only by the technical recipe to technical and both, never to business', () => {
    expect(labelList(synthesis(withTechnicalOnlyLabel, 'technical'))).toContain('**Operational checks**');
    expect(labelList(synthesis(withTechnicalOnlyLabel, 'both'))).toContain('**Operational checks**');
    expect(labelList(synthesis(withTechnicalOnlyLabel, 'business'))).not.toContain('Operational checks');
  });

  it('serves the ordered union for both, first occurrence winning and each recipe order kept', () => {
    const sections: AiOutputSections = { business: ['Purpose', 'Steps', 'Gaps'], technical: ['Purpose', 'Mechanics', 'Steps'] };
    expect(labelList(synthesis(sections, 'both'))).toBe('**Purpose**, **Mechanics**, **Steps**, **Gaps**');
    expect(labelList(synthesis(sections, 'business'))).toBe('**Purpose**, **Steps**, **Gaps**');
    expect(labelList(synthesis(sections, 'technical'))).toBe('**Purpose**, **Mechanics**, **Steps**');
  });

  it('serves the union while the classification is unlocked', () => {
    expect(labelList(synthesis(withTechnicalOnlyLabel, undefined))).toContain('**Operational checks**');
  });

  it('sends an old-style general (labels listed in the instruction, no placeholder) as written', () => {
    const oldStyle = 'Write the report. **Section structure**: use only **Purpose**, **Legacy label**, **Gaps**.';
    const templates = { ...builtInTemplates, general: oldStyle };
    for (const sections of [builtInSections, withTechnicalOnlyLabel, {}]) {
      for (const classification of ['business', 'technical', 'both'] as const) {
        expect(synthesis(sections, classification, templates)).toContain(`- general: ${oldStyle}`);
      }
    }
  });

  it('never leaks the placeholder when no labels are declared', () => {
    expect(synthesis({}, 'business')).not.toContain(SECTIONS_PLACEHOLDER);
  });

  it('does not alter the hop capture recipes', () => {
    const hop = resolveStagePrompt(builtInTemplates, 'active', 'both', 5, false, { scope: 'per_focus', focusKind: 'bodied' }, withTechnicalOnlyLabel).prompt;
    expect(hop).not.toContain('Operational checks');
    expect(hop).toContain(builtInTemplates.business_capture);
    expect(hop).toContain(builtInTemplates.technical_capture);
  });

  it('reaches the model through the session synthesis instruction', () => {
    const ctx = deriveStagePromptContext(null, null);
    const build = (classification: 'business' | 'technical') => {
      const session = new AiSession(builtInTemplates, withTechnicalOnlyLabel);
      session.setClassification(classification);
      return buildSynthesisInstruction(session, ctx).system;
    };
    expect(labelList(build('technical'))).toContain('**Operational checks**');
    expect(labelList(build('business'))).not.toContain('Operational checks');
  });
});

describe('readAiOutputSections', () => {
  const read = (yamlText: string) => readAiOutputSections(parseAiOutputTemplatesYaml(yamlText));

  it('reads a declared list per recipe, in order', () => {
    const result = read('business_capture:\n  sections: [A, B]\ntechnical_capture:\n  instruction: x\n  sections:\n    - C\n    - " D "\n');
    expect(result.sections).toEqual({ business: ['A', 'B'], technical: ['C', 'D'] });
    expect(result.rejected).toEqual([]);
  });

  it('contributes nothing for a file without the field (old-style file)', () => {
    expect(read('business_capture:\n  instruction: x\ngeneral:\n  instruction: y\n')).toEqual({ sections: {}, rejected: [] });
    expect(readAiOutputSections(undefined)).toEqual({ sections: {}, rejected: [] });
  });

  it.each([
    ['a scalar', 'sections: Purpose'],
    ['an empty list', 'sections: []'],
    ['a blank label', 'sections: [Purpose, " "]'],
    ['a non-string label', 'sections: [Purpose, 3]'],
    ['a map', 'sections: {a: b}'],
  ])('rejects %s without failing the file or the other recipe', (_name, field) => {
    const result = read(`business_capture:\n  ${field}\ntechnical_capture:\n  sections: [Mechanics]\n`);
    expect(result.rejected).toEqual(['business_capture']);
    expect(result.sections).toEqual({ technical: ['Mechanics'] });
  });
});

// Static contract check: keep the call unexecuted; the tests typecheck fails if sections becomes optional.
// @ts-expect-error -- sections is required
void (() => resolveStagePrompt(builtInTemplates, 'synthesis', 'both', 5, false, { scope: 'stable' }));
