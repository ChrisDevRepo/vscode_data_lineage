/**
 * Pins tool registration: the manifest's `languageModelTools` match the external stage of the core
 * tool policy, `vscode.lm` receives exactly that subset while the participant registry keeps the full catalog,
 * and the canonical registry rejects duplicates and unknown tools and passes raw input through.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type * as VSCode from 'vscode';
import { z } from 'zod';

const { lmBindings, ToolResult } = vi.hoisted(() => ({
  lmBindings: new Map<string, VSCode.LanguageModelTool<unknown>>(),
  /** The shared vscode stub has no tool-result class; this one records the parts it is given. */
  ToolResult: class { constructor(public readonly content: unknown[]) {} },
}));
vi.mock('vscode', async importOriginal => {
  const actual = await importOriginal<typeof import('vscode')>();
  return {
    ...actual,
    LanguageModelToolResult: ToolResult,
    lm: {
      registerTool: (name: string, tool: VSCode.LanguageModelTool<unknown>) => {
        lmBindings.set(name, tool);
        return { dispose: () => { lmBindings.delete(name); } };
      },
    },
  };
});

import * as vscode from 'vscode';
import { rootPath } from '../helpers/testUtils';
import { ToolRegistry } from '../../../src/ai/tools/registry';
import { EXTERNAL_TOOL_DEFS, TOOL_DEFS, type ToolContract } from '../../../src/ai/tools/toolDefs';
import { toModelJsonSchema } from '../../../src/ai/tools/jsonSchema';
import { buildAiToolRegistry, createExternalToolSource, registerAiTools } from '../../../src/ai/tools/toolProvider';
import { EXTERNAL_TOOL_NAMES } from '../../../src/ai/tools/toolPolicy';
import { AiSession } from '../../../src/ai/session/session';
import { makeModel } from './helpers/fixtures';

type ManifestTool = {
  name: string;
  displayName?: string;
  userDescription?: string;
  modelDescription?: string;
  tags?: string[];
  inputSchema?: Record<string, unknown>;
};

const pkg = JSON.parse(readFileSync(rootPath('package.json'), 'utf8')) as {
  contributes: { languageModelTools?: ManifestTool[] };
};
const manifestTools = pkg.contributes.languageModelTools ?? [];
const externalDefs = EXTERNAL_TOOL_DEFS;

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
  it('keeps manifest names aligned with the external tool policy', () => {
    const manifestNames = manifestTools.map(tool => tool.name).sort();
    expect(manifestNames).toEqual(externalDefs.map(tool => tool.name).sort());
  });

  it.each(externalDefs)('$name manifest metadata and schema match the catalog', (contract) => {
    const manifest = manifestTools.find(tool => tool.name === contract.name);
    expect(manifest?.displayName).toBe(contract.title);
    expect(manifest?.userDescription).toBe(contract.userDescription);
    expect(manifest?.modelDescription).toBe(contract.modelDescription);
    expect(manifest?.tags).toEqual(contract.tags);
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

  it.each(TOOL_DEFS as readonly ToolContract[])('$name follows the tool naming standard', (contract) => {
    // Service-prefixed snake_case verb_noun within the 64-character provider limit.
    expect(contract.name).toMatch(/^lineage_[a-z]+(?:_[a-z]+)+$/);
    expect(contract.name.length).toBeLessThanOrEqual(64);
  });

  it.each(externalDefs)('$name speaks to any caller, not only the @lineage chat', (contract) => {
    const text = `${contract.modelDescription} ${JSON.stringify(toModelJsonSchema(contract.inputSchema))}`;
    for (const chatOnly of ['@lineage', 'approv', 'hop-by-hop', 'Synthesis Phase', 'Completed Phase', 'engine-owned', 'this turn', 'this stage', 'output template', 'detail slot', 'exploration']) {
      expect(text, `${contract.name} mentions "${chatOnly}"`).not.toContain(chatOnly);
    }
  });

  it('binds exactly the external catalog to vscode.lm; the participant registry keeps every tool', async () => {
    const session = new AiSession();
    const channel = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as VSCode.LogOutputChannel;
    const participantNames = buildAiToolRegistry(() => session, channel, () => undefined)
      .getTools().map(tool => tool.name);
    expect(participantNames).toEqual(TOOL_DEFS.map(tool => tool.name));

    const internalOnly = TOOL_DEFS.filter(contract => !EXTERNAL_TOOL_NAMES.has(contract.name)).map(tool => tool.name);
    expect(internalOnly.sort()).toEqual(['lineage_get_neighbor_columns', 'lineage_start_exploration', 'lineage_submit_findings']);

    lmBindings.clear();
    const disposables = registerAiTools(createExternalToolSource(() => session, channel, () => undefined));
    try {
      expect(disposables).toHaveLength(externalDefs.length);
      expect([...lmBindings.keys()].sort()).toEqual(manifestTools.map(tool => tool.name).sort());
      for (const name of internalOnly) expect(lmBindings.has(name)).toBe(false);

      const [first] = externalDefs;
      if (!first) throw new Error('registration precondition: expected an external tool');
      const binding = lmBindings.get(first.name)!;
      const tokenSource = new vscode.CancellationTokenSource();
      // No project is loaded, so the call is rejected: a thrown error whose message is the reason and
      // the hint, the way VS Code shows a tool failure to the calling model.
      await expect(binding.invoke({ input: {}, toolInvocationToken: undefined }, tokenSource.token))
        .rejects.toThrow(/^No project is loaded in the Data Lineage panel/);
      session.model = makeModel([], [], []);
      const result = await binding.invoke({ input: {}, toolInvocationToken: undefined }, tokenSource.token);
      tokenSource.dispose();
      expect(result).toBeInstanceOf(ToolResult);
      const [part] = (result as InstanceType<typeof ToolResult>).content;
      expect(part).toBeInstanceOf(vscode.LanguageModelTextPart);
      expect((part as VSCode.LanguageModelTextPart).value).not.toBe('');
    } finally {
      disposables.forEach(item => item.dispose());
    }
    expect(lmBindings.size).toBe(0);
  });
});

describe('canonical tool registry', () => {
  it('rejects duplicate and unknown tools', () => {
    expect(TOOL_DEFS.length).toBeGreaterThan(0);
    expect(new Set(TOOL_DEFS.map(tool => tool.name)).size).toBe(TOOL_DEFS.length);
    const descriptor = TOOL_DEFS.at(0);
    if (!descriptor) throw new Error('registry precondition: expected a contributed descriptor');

    const registry = new ToolRegistry();
    const tool = { ...descriptor, execute: (input: unknown) => input };
    registry.register(tool);
    expect(() => { registry.register(tool); }).toThrow(/duplicate/);
    expect(() => registry.invoke('lineage_not_registered', {})).toThrow(/no tool registered/i);
  });

  it('dispatches the registered raw tool input through the canonical handler', async () => {
    const descriptor = TOOL_DEFS.at(0);
    if (!descriptor) throw new Error('registry precondition: expected a contributed descriptor');
    const registry = new ToolRegistry();
    const original = { nested: { value: 'original' } };
    registry.register({ ...descriptor, execute: input => input });

    expect(await registry.invoke(descriptor.name, original)).toBe(original);
    expect(original).toEqual({ nested: { value: 'original' } });
  });
});
