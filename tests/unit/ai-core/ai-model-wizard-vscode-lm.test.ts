/**
 * The Add / Edit AI Model wizard's "VS Code language model" source and Update AI Model Key: the
 * entry is written with a selector and the visible sampling defaults, no key is read, stored or
 * asked for, and an entry that takes no key is not offered for a key.
 */
import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAiModelCommands } from '../../../src/host/aiModelCommands';
import { Logger } from '../../../src/utils/log';

const host = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  models: [] as unknown[],
  picks: [] as Array<(items: Array<Record<string, any>>) => unknown>,
  keyPrompts: [] as string[],
  quickPicks: [] as Array<Record<string, any>>,
}));

vi.mock('../../../src/host/wizardSteps', async (importActual) => ({
  ...(await importActual<typeof import('../../../src/host/wizardSteps')>()),
  wizardPrompts: () => ({
    askPick: async ({ items }: { items: Array<Record<string, any>> }) => host.picks.shift()!(items),
    askInput: async (options: { value?: string; password?: boolean }) => {
      if (options.password) host.keyPrompts.push('key');
      return options.value;
    },
  }),
}));

vi.mock('vscode', async (importActual) => ({
  ...(await importActual<object>()),
  commands: { registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => { host.handlers.set(id, handler); return { dispose: () => {} }; }, executeCommand: vi.fn() },
  window: {
    showInformationMessage: vi.fn(async () => undefined),
    showQuickPick: async (items: Array<Record<string, any>>) => { host.quickPicks = items; return undefined; },
  },
  workspace: { getConfiguration: () => ({ get: () => host.models, update: async (_key: string, value: unknown[]) => { host.models = value; } }) },
  ConfigurationTarget: { Global: 1 },
}));

const API = { id: 'api', name: 'Api', url: 'https://example.test/v1/', model: 'm', apiType: 'chat-completions', maxInputTokens: 1000, maxOutputTokens: 100 };
const LM = { id: 'lm-entry', name: 'Mine', apiType: 'vscode-lm', selector: { vendor: 'v', family: 'f2' } };
const lmModels = [
  { id: 'a', name: 'Model A', vendor: 'v', family: 'f1', version: '1', maxInputTokens: 100 },
  { id: 'b', name: 'Model B', vendor: 'v', family: 'f2', version: '1', maxInputTokens: 200 },
];

function register() {
  const secrets = { get: vi.fn(), store: vi.fn(), delete: vi.fn() };
  registerAiModelCommands({ secrets } as never, Logger.create({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } as never, 'AI'));
  return { secrets, run: (command: string, ...args: unknown[]) => host.handlers.get(command)!(...args) };
}

beforeEach(() => {
  host.models = [];
  host.picks = [];
  host.keyPrompts = [];
  host.quickPicks = [];
  (vscode.lm as unknown as { models: unknown[] }).models = lmModels;
});

describe('Add AI Model with the VS Code language model source', () => {
  it('writes the selector and the visible sampling defaults, and asks for and stores no key', async () => {
    const { secrets, run } = register();
    host.picks = [(items) => items.find((item) => item.label === 'VS Code language model'), (items) => items[1]];
    expect(await run('dataLineageViz.addAiModel')).toBe('model-b');
    expect(host.models).toEqual([{
      id: 'model-b', name: 'Model B', apiType: 'vscode-lm',
      selector: { vendor: 'v', family: 'f2', id: 'b' },
      requestBody: { temperature: 0.1, top_p: 1 },
    }]);
    expect(host.keyPrompts).toEqual([]);
    expect(secrets.get).not.toHaveBeenCalled();
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it('saves nothing and says so when VS Code lists no model', async () => {
    const { run } = register();
    (vscode.lm as unknown as { models: unknown[] }).models = [];
    host.picks = [(items) => items.find((item) => item.label === 'VS Code language model')];
    expect(await run('dataLineageViz.addAiModel')).toBeUndefined();
    expect(host.models).toEqual([]);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('No VS Code language model'));
  });

  it('edits only the model and the name of a language model entry and keeps its other fields', async () => {
    const { secrets, run } = register();
    host.models = [{ ...LM, requestBody: { temperature: 0.5 }, maxOutputTokens: 300 }];
    host.picks = [(items) => { expect(items.map((item) => item.label)).toEqual(['Model A', 'Model B']); return items[0]; }];
    await run('dataLineageViz.editAiModel', 'lm-entry');
    expect(host.models).toEqual([{ ...LM, selector: { vendor: 'v', family: 'f1', id: 'a' }, requestBody: { temperature: 0.5 }, maxOutputTokens: 300 }]);
    expect(host.keyPrompts).toEqual([]);
    expect(secrets.store).not.toHaveBeenCalled();
  });
});

describe('Update AI Model Key', () => {
  it('lists only the entries that take a key', async () => {
    const { run } = register();
    host.models = [LM, API];
    await run('dataLineageViz.updateAiModelKey');
    expect(host.quickPicks.map((item) => item.description)).toEqual(['api']);
  });

  it('stores no key for a language model entry named by id', async () => {
    const { secrets, run } = register();
    host.models = [LM];
    expect(await run('dataLineageViz.updateAiModelKey', 'lm-entry')).toBe(false);
    expect(secrets.store).not.toHaveBeenCalled();
  });
});
