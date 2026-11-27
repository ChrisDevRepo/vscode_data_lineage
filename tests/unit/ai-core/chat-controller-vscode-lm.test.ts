/**
 * The chat host's model list and start model with VS Code language models: the live models the
 * picker offers with no entry, the Copilot start model of an upgraded 1.2.7 user, the kept last
 * pick, a set `ai.defaultModel` winning the start while the live models stay offered, and a `vscode-lm` entry that matches no model.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ModelPort } from '../../../src/ai/model/modelPort';
import type { LmCatalog, LmModelInfo } from '../../../src/ai/providers/vscodeLmTransport';
import { calibrateTurnBudget } from '../../../src/ai/support/tokenBudget';
import { AiSession } from '../../../src/ai/session/session';
import { ChatController } from '../../../src/bridge/chatHandlers';
import { NO_MODEL_MESSAGE, type ChatToWebviewMsg } from '../../../src/engine/shared/chatContract';
import { Logger } from '../../../src/utils/log';

const API = { id: 'api', name: 'Api', url: 'https://example.test/v1/', model: 'm', apiType: 'chat-completions', maxInputTokens: 100_000, maxOutputTokens: 4_000 };
const LM_ENTRY = { id: 'mine', name: 'Mine', apiType: 'vscode-lm', selector: { family: 'fc' } };
const SETTINGS = { discoveryNodeCap: 100, discoveryTokenBudget: 10_000, maxRounds: 5, maxTraceColumns: 50 };

const info = (vendor: string, id: string, maxInputTokens = 8_000): LmModelInfo => ({
  selectionId: `lm:${vendor}/${id}`, id, name: `${vendor} ${id}`, vendor, family: `f-${id}`, version: '1', maxInputTokens, model: {} as never,
});
const LIVE = [info('other', 'a'), info('copilot', 'c', 64_000), info('copilot', 'd')];

function setup(options: { provider?: 'vscode-lm' | 'api-key'; models?: unknown[]; vscodeLmModels?: unknown[]; defaultModel?: string; live?: readonly LmModelInfo[]; resolved?: Record<string, LmModelInfo>; lastPick?: string; loaded?: boolean } = {}) {
  const frames: ChatToWebviewMsg[] = [];
  const created: Array<{ entryId?: string; budget?: unknown }> = [];
  const lastPick = { value: options.lastPick, get: vi.fn(() => lastPick.value), update: vi.fn(async (id: string) => { lastPick.value = id; }) };
  const warnings: string[] = [];
  const catalog: LmCatalog | undefined = options.loaded === false ? undefined : { live: options.live ?? LIVE, resolved: new Map(Object.entries(options.resolved ?? {})) };
  const controller = new ChatController({
    runtime: { run: vi.fn(async ({ sink }) => { sink.result('ok'); return { outcome: 'ok' as const, modelCalls: 1 }; }), runSuggestions: vi.fn(), resumeGate: vi.fn() },
    getSession: () => new AiSession(),
    modelSources: () => ({ provider: options.provider, models: options.models, vscodeLmModels: options.vscodeLmModels, defaultModel: options.defaultModel, secrets: { get: async () => undefined }, lmModel: () => undefined }),
    turnSettings: () => SETTINGS,
    lmCatalog: () => catalog,
    lastPick,
    logger: Logger.create({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } as never, 'AI'),
    showErrorMessage: vi.fn(),
    showWarningMessage: (message) => { warnings.push(message); },
    runModelCommand: vi.fn(),
    createPort: async (_sources, portOptions) => { created.push(portOptions); return {} as ModelPort; },
  });
  controller.attachView({ post: (msg) => { frames.push(msg); } });
  const state = async () => {
    await controller.receive({ type: 'chat.ready' });
    return frames.filter((frame): frame is Extract<ChatToWebviewMsg, { type: 'chat.state' }> => frame.type === 'chat.state').at(-1)!;
  };
  const turn = async () => {
    await controller.receive({ type: 'chat.send', text: 'hello' });
    await vi.waitFor(() => { expect(frames.some((frame) => frame.type === 'chat.event' && frame.event.type === 'terminal')).toBe(true); });
  };
  return { controller, frames, created, lastPick, warnings, state, turn };
}

describe('chat model list with live VS Code models', () => {
  it('lists the live models and starts on the first Copilot one when ai.defaultModel is empty', async () => {
    const { state, turn, created } = setup();
    const shown = await state();
    expect(shown.models.map((model) => model.id)).toEqual(['lm:other/a', 'lm:copilot/c', 'lm:copilot/d']);
    expect(shown.selectedModelId).toBe('lm:copilot/c');
    await turn();
    expect(created[0].entryId).toBe('lm:copilot/c');
  });

  it('starts on the Copilot model even when API entries exist, listing them first', async () => {
    const { state } = setup({ models: [API] });
    const shown = await state();
    expect(shown.models.map((model) => model.id)).toEqual(['api', 'lm:other/a', 'lm:copilot/c', 'lm:copilot/d']);
    expect(shown.selectedModelId).toBe('lm:copilot/c');
  });

  it('starts on the first offered model when no live model is Copilot', async () => {
    const { state } = setup({ live: [LIVE[0]] });
    expect((await state()).selectedModelId).toBe('lm:other/a');
  });

  it('lets a set ai.defaultModel decide the start model while the live models stay offered', async () => {
    const { state } = setup({ models: [API], defaultModel: 'api' });
    const shown = await state();
    expect(shown.models.map((model) => model.id)).toEqual(['api', 'lm:other/a', 'lm:copilot/c', 'lm:copilot/d']);
    expect(shown.selectedModelId).toBe('api');
  });

  it('keeps the last pick in the store and starts on it later', async () => {
    const first = setup();
    await first.state();
    await first.controller.receive({ type: 'chat.selectModel', modelId: 'lm:other/a' });
    expect(first.lastPick.update).toHaveBeenCalledWith('lm:other/a');
    const later = setup({ lastPick: first.lastPick.value });
    expect((await later.state()).selectedModelId).toBe('lm:other/a');
  });

  it('falls back to the Copilot start model when the last pick is no longer offered', async () => {
    const { state } = setup({ lastPick: 'lm:gone/x' });
    expect((await state()).selectedModelId).toBe('lm:copilot/c');
  });

  it('rejects a selection of a model that is not offered', async () => {
    const { controller, lastPick, state } = setup();
    await state();
    await controller.receive({ type: 'chat.selectModel', modelId: 'lm:gone/x' });
    expect(lastPick.update).not.toHaveBeenCalled();
  });

  it('shows the no-model message when there is no entry and no live model', async () => {
    const { state, turn, frames, created } = setup({ live: [] });
    expect((await state()).selectedModelId).toBe('');
    await turn();
    expect(created).toEqual([]);
    expect(JSON.stringify(frames)).toContain(NO_MODEL_MESSAGE);
  });

  it('shows no live model before the catalog has loaded, and warns about no vscode-lm entry', async () => {
    const { state, warnings } = setup({ loaded: false, models: [LM_ENTRY] });
    const shown = await state();
    expect(shown.models).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('chat vscode-lm entries', () => {
  it('offers a resolved entry between the API entries and the live models', async () => {
    const { state } = setup({ models: [LM_ENTRY, API], resolved: { mine: LIVE[0] }, defaultModel: 'mine' });
    const shown = await state();
    expect(shown.models.map((model) => [model.id, model.name])).toEqual([['api', 'Api'], ['mine', 'Mine'], ['lm:other/a', 'other a'], ['lm:copilot/c', 'copilot c'], ['lm:copilot/d', 'copilot d']]);
    expect(shown.selectedModelId).toBe('mine');
  });

  it('names an unresolved entry in a warning and does not offer it', async () => {
    const { state, warnings } = setup({ models: [LM_ENTRY], defaultModel: 'mine', live: [] });
    const shown = await state();
    expect(shown.models).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"mine"');
  });

  it('sizes the turn budget from the catalog window of a live model and of an entry', async () => {
    const live = setup();
    await live.state();
    await live.turn();
    expect(live.created[0].budget).toEqual(calibrateTurnBudget(64_000, SETTINGS));
    const entry = setup({ models: [LM_ENTRY], resolved: { mine: info('other', 'a', 12_000) }, defaultModel: 'mine' });
    await entry.state();
    await entry.turn();
    expect(entry.created[0]).toMatchObject({ entryId: 'mine', budget: calibrateTurnBudget(12_000, SETTINGS) });
  });

  it('disambiguates duplicate live model display names with bracketed ids', async () => {
    const dupA = { ...info('copilot', 'gpt-4o-mini'), name: 'GPT-4o' };
    const dupB = { ...info('copilot', 'gpt-4o-2024'), name: 'GPT-4o' };
    const { state } = setup({ live: [dupA, dupB] });
    const shown = await state();
    expect(shown.models.map((m) => [m.id, m.name])).toEqual([
      ['lm:copilot/gpt-4o-mini', 'GPT-4o [gpt-4o-mini]'],
      ['lm:copilot/gpt-4o-2024', 'GPT-4o [gpt-4o-2024]'],
    ]);
  });

  it('isolates vscode-lm mode and api-key mode via the provider hard switch', async () => {
    const lmMode = setup({ provider: 'vscode-lm', models: [API], vscodeLmModels: [LM_ENTRY], resolved: { mine: LIVE[0] } });
    const lmState = await lmMode.state();
    expect(lmState.provider).toBe('vscode-lm');
    expect(lmState.models.map((m) => m.id)).toEqual(['mine', 'lm:other/a', 'lm:copilot/c', 'lm:copilot/d']);

    const apiMode = setup({ provider: 'api-key', models: [API], vscodeLmModels: [LM_ENTRY], resolved: { mine: LIVE[0] } });
    const apiState = await apiMode.state();
    expect(apiState.provider).toBe('api-key');
    expect(apiState.models.map((m) => m.id)).toEqual(['api']);
  });
});
