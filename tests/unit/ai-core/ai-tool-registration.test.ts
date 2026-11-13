// Owner: src/ai/tools/toolDefs.ts, toolPolicy.ts and toolProvider.ts; registration and delivery
// contracts.
/**
 * Pins tool registration: the manifest's `languageModelTools` match the external stage of the core
 * tool policy, `vscode.lm` receives exactly that subset while the participant registry keeps the
 * full catalog, and the canonical registry rejects duplicates and unknown tools and passes raw
 * input through.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type * as VSCode from 'vscode';
import { z } from 'zod';

const { lmBindings, ToolResult } = vi.hoisted(() => ({
  lmBindings: new Map<string, VSCode.LanguageModelTool<unknown>>(),
  /** The shared vscode stub has no tool-result class; this one records the parts it is given. */
  ToolResult: class {
    constructor(public readonly content: unknown[]) {}
  },
}));
vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vscode')>();
  return {
    ...actual,
    LanguageModelToolResult: ToolResult,
    lm: {
      registerTool: (name: string, tool: VSCode.LanguageModelTool<unknown>) => {
        lmBindings.set(name, tool);
        return {
          dispose: () => {
            lmBindings.delete(name);
          },
        };
      },
    },
  };
});

import * as vscode from 'vscode';
import { rootPath } from '../helpers/testUtils';
import { ToolRegistry } from '../../../src/ai/tools/registry';
import { EXTERNAL_TOOL_DEFS, TOOL_DEFS } from '../../../src/ai/tools/toolDefs';
import {
  buildAiToolRegistry,
  createExternalToolSource,
  registerAiTools,
} from '../../../src/ai/tools/toolProvider';
import { EXTERNAL_TOOL_NAMES } from '../../../src/ai/tools/toolPolicy';
import { AiSession } from '../../../src/ai/session/session';
import { makeModel } from '../helpers/modelFixtures';
import { ISSUES } from '../../../src/ai/support/toolErrorEnvelope';

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

describe('AI tool registration', () => {
  // Manifest-to-catalog sync is owned by the gate's `generate-tool-manifest.mjs --check`.
  it('describes every model-visible input field of every tool', () => {
    const undescribed = TOOL_DEFS.flatMap((contract) =>
      Object.entries(
        z.toJSONSchema(contract.inputSchema, {
          io: 'input',
          unrepresentable: 'throw',
        }).properties ?? {},
      )
        .filter(
          ([, schema]) =>
            typeof schema !== 'object' ||
            schema === null ||
            !('description' in schema),
        )
        .map(([field]) => `${contract.name}.${field}`),
    );
    expect(undescribed).toEqual([]);
  });

  it('names every tool as service-prefixed snake_case verb_noun', () => {
    expect(
      TOOL_DEFS.map((contract) => contract.name).filter(
        (name) => !/^lineage_[a-z]+(?:_[a-z]+)+$/.test(name),
      ),
    ).toEqual([]);
  });

  it('binds exactly the external catalog to vscode.lm; the participant registry keeps every tool', async () => {
    const session = new AiSession();
    const channel = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as VSCode.LogOutputChannel;
    const participant = buildAiToolRegistry(
      () => session,
      channel,
      () => undefined,
    );
    const participantNames = participant.getTools().map((tool) => tool.name);
    expect(participantNames).toEqual(TOOL_DEFS.map((tool) => tool.name));

    const internalOnly = TOOL_DEFS.filter(
      (contract) => !EXTERNAL_TOOL_NAMES.has(contract.name),
    ).map((tool) => tool.name);
    expect(internalOnly.sort()).toEqual([
      'lineage_get_scope_bundle',
      'lineage_present_result',
      'lineage_prune_current',
      'lineage_start_exploration',
      'lineage_submit_findings',
    ]);
    // Callers outside a chat turn get read tools only.
    expect(externalDefs.map((tool) => tool.effect)).toEqual(
      externalDefs.map(() => 'read'),
    );

    lmBindings.clear();
    const disposables = registerAiTools(
      createExternalToolSource(
        () => session,
        channel,
        () => undefined,
      ),
    );
    try {
      expect(disposables).toHaveLength(externalDefs.length);
      expect([...lmBindings.keys()].sort()).toEqual(
        manifestTools.map((tool) => tool.name).sort(),
      );
      for (const name of internalOnly) expect(lmBindings.has(name)).toBe(false);

      const [first] = externalDefs;
      if (!first)
        throw new Error('registration precondition: expected an external tool');
      const binding = lmBindings.get(first.name)!;
      const tokenSource = new vscode.CancellationTokenSource();
      // VS Code receives the same one problem shape: the call-level fault under the stable code.
      const thrown = await Promise.resolve(
        binding.invoke(
          { input: {}, toolInvocationToken: undefined },
          tokenSource.token,
        ),
      ).then(
        () => null,
        (error: Error) => error,
      );
      expect(JSON.parse(thrown!.message)).toEqual({
        code: 'backend_fault',
        attempt: '2/3',
        errors: [
          {
            path: '',
            code: 'no_project',
            message: `${ISSUES.no_project.label}. ${ISSUES.no_project.correction}`,
          },
        ],
      });
      session.model = makeModel([], [], []);
      const result = await binding.invoke(
        { input: {}, toolInvocationToken: undefined },
        tokenSource.token,
      );
      tokenSource.dispose();
      expect(result).toBeInstanceOf(ToolResult);
      const [part] = (result as InstanceType<typeof ToolResult>).content;
      expect(part).toBeInstanceOf(vscode.LanguageModelTextPart);
      // The bound tool delivers the participant registry's result for the same input.
      expect((part as VSCode.LanguageModelTextPart).value).toBe(
        await participant.invoke(first.name, {}),
      );
    } finally {
      disposables.forEach((item) => item.dispose());
    }
    expect(lmBindings.size).toBe(0);
  });
});

describe('canonical tool registry', () => {
  it('rejects duplicate and unknown tools', () => {
    expect(new Set(TOOL_DEFS.map((tool) => tool.name)).size).toBe(
      TOOL_DEFS.length,
    );
    const descriptor = TOOL_DEFS.at(0);
    if (!descriptor)
      throw new Error(
        'registry precondition: expected a contributed descriptor',
      );

    const registry = new ToolRegistry();
    const tool = { ...descriptor, execute: (input: unknown) => input };
    registry.register(tool);
    expect(() => {
      registry.register(tool);
    }).toThrow(/duplicate/);
    expect(() => registry.invoke('lineage_not_registered', {})).toThrow(
      /no tool registered/i,
    );
  });

  it('dispatches the registered raw tool input through the canonical handler', async () => {
    const descriptor = TOOL_DEFS.at(0);
    if (!descriptor)
      throw new Error(
        'registry precondition: expected a contributed descriptor',
      );
    const registry = new ToolRegistry();
    const original = { nested: { value: 'original' } };
    registry.register({ ...descriptor, execute: (input) => input });

    expect(await registry.invoke(descriptor.name, original)).toBe(original);
    expect(original).toEqual({ nested: { value: 'original' } });
  });
});
