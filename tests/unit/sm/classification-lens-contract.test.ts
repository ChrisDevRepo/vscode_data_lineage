import { describe, expect, it } from 'vitest';
import { ClassificationValueSchema, StartExplorationFreshProviderInputSchema, StartExplorationInputSchema } from '../../../src/ai/tools/toolSchemas';
import { buildSmEntrySystemPrompt } from '../../../src/ai/prompting/hostPrompts';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';

describe('fresh exploration answer-lens contract', () => {
  it('serves business-first ambiguity policy from the shared enum without changing admitted values', () => {
    const schema = toModelJsonSchema(StartExplorationFreshProviderInputSchema);
    const classification = (schema.properties as Record<string, { enum: string[]; description: string }>).classification;
    const rendered = buildSmEntrySystemPrompt({ dbPlatform: 'SQL Server', filterSchemas: [], totalSchemaCount: 1, visibleNodes: 2, totalNodes: 2 });
    expect(rendered).toContain(ClassificationValueSchema.description);
    expect(classification.description).toBe(ClassificationValueSchema.description);
    expect(classification.enum).toEqual(['business', 'technical', 'both']);
    expect(classification.description).toContain('unspecified or ambiguous intent');
    expect(classification.description).toContain('"both" only when the user explicitly asks for both perspectives');
    const base = { origin: '[demo].[source]', analysisMode: 'bb', depth: { upstream: { levels: 1, exactness: 'exact' }, downstream: { levels: 0, exactness: 'exact' } } };
    for (const lens of ['business', 'technical', 'both']) {
      expect(StartExplorationFreshProviderInputSchema.safeParse({ ...base, classification: lens }).success).toBe(true);
      expect(StartExplorationInputSchema.safeParse({ ...base, classification: lens }).success).toBe(true);
    }
    expect(StartExplorationFreshProviderInputSchema.safeParse({ ...base, classification: 'default' }).success).toBe(false);
    expect(StartExplorationFreshProviderInputSchema.safeParse(base).success).toBe(false);
  });
});
