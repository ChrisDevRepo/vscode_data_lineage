/**
 * The ⚠️ structural-callout contract has one template home and ships once per bodied hop.
 *
 * Under classification `both` the business and technical capture recipes both fire on the same
 * hop; while each carried its own copy of the callout contract the model read it twice per hop
 * and the two copies could drift. `structural_callouts` is that contract's single owner: it rides
 * the per-focus render beside whichever capture recipes the classification fires, never on a
 * non-bodied focus, and never in the hop-invariant stable block.
 */

import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { rootPath } from '../helpers/testUtils';
import { parseAiOutputTemplatesYaml } from '../../../src/configCore';
import { resolveStagePrompt } from '../../../src/ai/prompting/templateRenderer';
import { EMPTY_AI_TEMPLATES, type AiOutputTemplates } from '../../../src/ai/session/types';
import type { ClassificationValue } from '../../../src/ai/session/classification';

const CONTRACT_ANCHOR = 'STRUCTURAL EXPOSURE';

function builtInTemplates(): AiOutputTemplates {
  const parsed = parseAiOutputTemplatesYaml(readFileSync(rootPath('assets/aiOutputTemplates.yaml'), 'utf-8')) as Record<string, { instruction?: string }>;
  const templates: AiOutputTemplates = { ...EMPTY_AI_TEMPLATES };
  for (const key of Object.keys(EMPTY_AI_TEMPLATES) as (keyof AiOutputTemplates)[]) {
    templates[key] = parsed[key]?.instruction ?? '';
  }
  return templates;
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('structural_callouts — one home, rendered once per bodied hop', () => {
  const templates = builtInTemplates();

  it('is the only template carrying the callout contract', () => {
    expect(count(templates.structural_callouts, CONTRACT_ANCHOR)).toBe(1);
    expect(templates.business_capture).not.toContain(CONTRACT_ANCHOR);
    expect(templates.technical_capture).not.toContain(CONTRACT_ANCHOR);
    expect(templates.business_capture).not.toContain('<structural_callouts>');
    expect(templates.technical_capture).not.toContain('<structural_callouts>');
  });

  // BOTH-TWO-FILES: a `both` hop writes two sections[] bodies. Neither recipe may say
  // "Submit one section", which was read as one body for the hop.
  it('does not tell a both hop to submit one section from either capture recipe', () => {
    expect(templates.business_capture).not.toContain('Submit one section');
    expect(templates.technical_capture).not.toContain('Submit one section');
    expect(templates.business_capture).toContain('one of two required');
    expect(templates.technical_capture).toContain('one of two required');
  });

  it.each<[ClassificationValue, string[]]>([
    ['both', ['business_capture', 'technical_capture', 'structural_callouts']],
    ['business', ['business_capture', 'structural_callouts']],
    ['technical', ['technical_capture', 'structural_callouts']],
  ])('ships the contract exactly once on a bodied hop under %s', (classification, shipped) => {
    const result = resolveStagePrompt(templates, 'active', classification, undefined, false, { scope: 'per_focus', focusKind: 'bodied' });
    expect(result.shippedKeys).toEqual(shipped);
    expect(count(result.prompt, CONTRACT_ANCHOR)).toBe(1);
  });

  it('stays off a non-bodied focus, where the structural summary replaces every capture recipe', () => {
    const result = resolveStagePrompt(templates, 'active', 'both', undefined, false, { scope: 'per_focus', focusKind: 'non_bodied' });
    expect(result.shippedKeys).toEqual(['structural_summary']);
    expect(result.gatedOut).toContainEqual({ key: 'structural_callouts', reason: 'focus_scope' });
  });

  it('stays out of the hop-invariant stable block, like every per-focus key', () => {
    const result = resolveStagePrompt(templates, 'active', 'both', undefined, false, { scope: 'stable' });
    expect(result.shippedKeys).not.toContain('structural_callouts');
    expect(result.gatedOut).toContainEqual({ key: 'structural_callouts', reason: 'focus_scope' });
  });
});
