import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ModelPortError } from '../../../src/ai/model/modelPort';
import { LIVE_MODEL_ID_PREFIX, parseModelEntries } from '../../../src/ai/providers/modelEntries';
import { createConfiguredModelPort } from '../../../src/ai/providers/modelPortFactory';
import type { LmModelInfo } from '../../../src/ai/providers/vscodeLmTransport';

/**
 * The `vscode-lm` variant of the `ai.models` entry and the factory branch that builds its port: a
 * valid entry parses, a field of the API kind is invalid on it, and the key is never read.
 */
const LM = { id: 'cp', name: 'Copilot', apiType: 'vscode-lm', selector: { vendor: 'copilot', family: 'gpt' }, requestBody: { temperature: 0.1 } };
const API = { id: 'api', name: 'Api', url: 'https://example.test/v1/', model: 'm', apiType: 'chat-completions', maxInputTokens: 1000, maxOutputTokens: 100 };

const invalidIssues = (entry: unknown) => parseModelEntries([entry]).invalid.flatMap((item) => item.issues);

describe('vscode-lm entry parsing', () => {
  it('parses a vscode-lm entry beside an API entry', () => {
    const read = parseModelEntries([LM, API]);
    expect(read.invalid).toEqual([]);
    expect(read.entries.map((entry) => entry.apiType)).toEqual(['vscode-lm', 'chat-completions']);
    expect(read.entries[0]).toMatchObject({ selector: { vendor: 'copilot', family: 'gpt' }, requestBody: { temperature: 0.1 } });
  });

  it('accepts an entry with only an id, a name and a selector', () => {
    expect(parseModelEntries([{ id: 'x', name: 'X', apiType: 'vscode-lm', selector: {} }]).invalid).toEqual([]);
  });

  it('defaults forcedToolChoice to true and accepts false on a vscode-lm entry', () => {
    const defaulted = parseModelEntries([LM]);
    expect(defaulted.invalid).toEqual([]);
    expect(defaulted.entries[0]).toMatchObject({ forcedToolChoice: true });

    const optedOut = parseModelEntries([{ ...LM, forcedToolChoice: false }]);
    expect(optedOut.invalid).toEqual([]);
    expect(optedOut.entries[0]).toMatchObject({ forcedToolChoice: false });
  });

  it('rejects url, key, model and maxInputTokens on a vscode-lm entry', () => {
    for (const extra of [{ url: 'https://example.test/v1/' }, { apiKey: 'k' }, { model: 'm' }, { maxInputTokens: 1000 }]) {
      expect(invalidIssues({ ...LM, ...extra }), JSON.stringify(extra)).not.toEqual([]);
    }
  });

  it('rejects an unknown selector key and a selector-less entry', () => {
    expect(invalidIssues({ ...LM, selector: { vendor: 'copilot', model: 'x' } })).not.toEqual([]);
    expect(invalidIssues({ id: 'x', name: 'X', apiType: 'vscode-lm' })).not.toEqual([]);
  });

  it('rejects a requestBody key the port owns, as on the API kind', () => {
    expect(invalidIssues({ ...LM, requestBody: { tools: [] } })).toEqual(['requestBody.tools: requestBody key "tools" is owned by the port']);
  });

  it('rejects the reserved live-model id prefix on either kind', () => {
    expect(invalidIssues({ ...LM, id: `${LIVE_MODEL_ID_PREFIX}x` })).not.toEqual([]);
    expect(invalidIssues({ ...API, id: `${LIVE_MODEL_ID_PREFIX}x` })).not.toEqual([]);
  });

  it('still requires the API fields on an API entry', () => {
    expect(invalidIssues({ ...API, url: undefined })).not.toEqual([]);
    expect(invalidIssues({ ...API, selector: {} })).not.toEqual([]);
  });
});

describe('createConfiguredModelPort with a vscode-lm entry', () => {
  const info = (over: Partial<LmModelInfo> = {}): LmModelInfo => ({
    selectionId: 'lm:copilot/gpt', id: 'gpt', name: 'GPT', vendor: 'copilot', family: 'gpt', version: '1', maxInputTokens: 5000,
    model: { id: 'gpt', name: 'GPT', vendor: 'copilot', family: 'gpt', version: '1', maxInputTokens: 5000, countTokens: async () => 1, sendRequest: vi.fn() } as unknown as vscode.LanguageModelChat,
    ...over,
  });

  it('builds the port without reading a key', async () => {
    const get = vi.fn();
    const port = await createConfiguredModelPort(
      { models: [LM], defaultModel: 'cp', secrets: { get }, lmModel: (id) => (id === 'cp' ? info() : undefined) },
    );
    expect(get).not.toHaveBeenCalled();
    expect(port.identity).toMatchObject({ id: 'cp', name: 'Copilot', vendor: 'copilot', family: 'gpt' });
  });

  it('names the entry when no language model matches it', async () => {
    const attempt = createConfiguredModelPort({ models: [LM], defaultModel: 'cp', secrets: { get: vi.fn() }, lmModel: () => undefined });
    await expect(attempt).rejects.toBeInstanceOf(ModelPortError);
    await expect(attempt).rejects.toMatchObject({ code: 'model_not_found', message: expect.stringContaining('"cp"') });
  });

  it('builds a port for a live selection, with no entry in settings', async () => {
    const port = await createConfiguredModelPort(
      { models: undefined, defaultModel: '', secrets: { get: vi.fn() }, lmModel: (id) => (id === 'lm:copilot/gpt' ? info() : undefined) },
      { entryId: 'lm:copilot/gpt' },
    );
    expect(port.identity).toMatchObject({ id: 'lm:copilot/gpt', name: 'GPT' });
  });

  it('names a live selection that is gone', async () => {
    await expect(createConfiguredModelPort(
      { models: undefined, defaultModel: '', secrets: { get: vi.fn() }, lmModel: () => undefined },
      { entryId: 'lm:copilot/gone' },
    )).rejects.toMatchObject({ code: 'model_not_found' });
  });
});
