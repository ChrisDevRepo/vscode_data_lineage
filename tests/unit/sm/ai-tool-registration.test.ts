import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { rootPath } from '../helpers/testUtils';
import { TOOL_DEFS } from '../../../src/ai/tools/toolDefs';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';

type ManifestTool = {
  name: string;
  userDescription?: string;
  modelDescription?: string;
  inputSchema?: Record<string, unknown>;
};

const pkg = JSON.parse(readFileSync(rootPath('package.json'), 'utf8')) as {
  contributes: { languageModelTools?: ManifestTool[] };
};
const manifestTools = pkg.contributes.languageModelTools ?? [];
const externalDefs = TOOL_DEFS.filter(contract => contract.effect === 'read');

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [
        key,
        key === 'required' && Array.isArray(entry) ? [...entry].sort() : normalized(entry),
      ]),
  );
}

describe('AI tool registration', () => {
  it('keeps manifest names aligned with the read-only external catalog', () => {
    const manifestNames = manifestTools.map(tool => tool.name).sort();
    expect(manifestNames).toEqual(externalDefs.map(tool => tool.name).sort());
  });

  it.each(externalDefs)('$name manifest metadata and schema match the catalog', (contract) => {
    const manifest = manifestTools.find(tool => tool.name === contract.name);
    expect(manifest?.userDescription).toBe(contract.userDescription);
    expect(manifest?.modelDescription).toBe(contract.modelDescription);
    expect(contract.progressLabel).not.toBe('');
    expect(normalized(manifest?.inputSchema)).toEqual(
      normalized(toModelJsonSchema(contract.inputSchema)),
    );

    const jsonSchema = z.toJSONSchema(contract.inputSchema, {
      io: 'input',
      unrepresentable: 'throw',
    });
    const missingDescriptions = Object.entries(jsonSchema.properties ?? {})
      .filter(([, schema]) =>
        typeof schema !== 'object' || schema === null || !('description' in schema))
      .map(([field]) => field);
    expect(missingDescriptions).toEqual([]);
  });

  it('registers the read-only catalog through the filtered shared registry', () => {
    const source = readFileSync(
      rootPath('src', 'ai', 'tools', 'toolProvider.ts'),
      'utf8',
    );
    expect(source).toMatch(/\bTOOL_DEFS\b/);
    expect(source).toMatch(/external\.getTools\(\)/);
    expect(source).toMatch(/vscode\.lm\.registerTool\(/);
  });
});
