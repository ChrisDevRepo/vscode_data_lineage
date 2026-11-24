import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ProviderModelPort } from '../../../src/ai/model/providerModelPort';
import type { WireRecord } from '../../../src/ai/observability/wireLog';
import { countTokens } from '../../../src/ai/support/tokenCount';
import { StructuredOutputError } from '../../../src/ai/providers/structuredOutput';
import type { VscodeLmModelEntry } from '../../../src/ai/providers/modelEntries';
import { createVscodeLmTransport, loadLmCatalog, onLmModelsChanged, preferredStartModel } from '../../../src/ai/providers/vscodeLmTransport';

/**
 * The `vscode-lm` transport against a mocked `vscode.lm` model: the message and part mapping, the
 * tool mode, `modelOptions`, error and cancellation mapping, and the structured-output round trip
 * through the port's forced synthetic tool. No real language model is called.
 */
const ENTRY: VscodeLmModelEntry = { id: 'e', name: 'Entry', apiType: 'vscode-lm', selector: { vendor: 'v' }, requestBody: { temperature: 0.1, top_p: 1 }, maxOutputTokens: 500 };
const LIVE_ENTRY: VscodeLmModelEntry = { id: 'lm:v/m', name: 'M', apiType: 'vscode-lm', selector: {} };
const tools: Array<{ name: string; description: string; inputSchema: z.ZodType }> = [{ name: 'lineage_search', description: 'd', inputSchema: z.object({ q: z.string() }) }];

type Part = vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | { mimeType: string; data: Uint8Array } | { value: string };
interface Sent { messages: vscode.LanguageModelChatMessage[]; options: Record<string, unknown>; token: vscode.CancellationToken }

function fakeModel(reply: (token: vscode.CancellationToken) => AsyncIterable<Part>) {
  const sent: Sent[] = [];
  const model = {
    id: 'm', name: 'M', vendor: 'v', family: 'f', version: '1', maxInputTokens: 1000,
    countTokens: vi.fn(async (text: string) => text.length),
    sendRequest: vi.fn(async (messages: vscode.LanguageModelChatMessage[], options: Record<string, unknown>, token: vscode.CancellationToken) => {
      sent.push({ messages, options, token });
      return { stream: reply(token) };
    }),
  };
  return { model: model as unknown as vscode.LanguageModelChat, sent, raw: model };
}

const replying = (...parts: Part[]) => () => (async function* () { for (const part of parts) yield part; })();

function portOver(reply: (token: vscode.CancellationToken) => AsyncIterable<Part>, entry: VscodeLmModelEntry = ENTRY, wires?: WireRecord[]) {
  const fake = fakeModel(reply);
  const port = new ProviderModelPort(createVscodeLmTransport(entry, fake.model), wires ? { wireLog: (record) => { wires.push(record); }, requestId: 'r' } : {});
  return { ...fake, port };
}

const text = (part: unknown) => (part as vscode.LanguageModelTextPart).value;

afterEach(() => { (vscode.lm as unknown as { reset(): void }).reset(); });

describe('vscode-lm transport message mapping', () => {
  it('sends the system prompt as the first User message and maps human, assistant call and tool result', async () => {
    const { port, sent } = portOver(replying(new vscode.LanguageModelTextPart('ok')));
    await port.generateToolTurn({
      system: 'SYS',
      messages: [
        new HumanMessage({ content: 'hi', name: 'u' }),
        new AIMessage({ content: 'looking', tool_calls: [{ id: 'c1', name: 'lineage_search', args: { q: 'x' }, type: 'tool_call' }] }),
        new ToolMessage({ tool_call_id: 'c1', content: 'found' }),
      ],
      tools,
      phase: 't',
    });
    const [first, human, assistant, result] = sent[0].messages;
    expect(first.role).toBe(vscode.LanguageModelChatMessageRole.User);
    expect(first.content.map(text)).toEqual(['SYS']);
    expect(human).toMatchObject({ role: vscode.LanguageModelChatMessageRole.User, name: 'u' });
    expect(human.content.map(text)).toEqual(['hi']);
    expect(assistant.role).toBe(vscode.LanguageModelChatMessageRole.Assistant);
    expect(assistant.content[0]).toBeInstanceOf(vscode.LanguageModelTextPart);
    expect(assistant.content[1]).toMatchObject({ callId: 'c1', name: 'lineage_search', input: { q: 'x' } });
    expect(result.role).toBe(vscode.LanguageModelChatMessageRole.User);
    expect(result.content[0]).toMatchObject({ callId: 'c1' });
    expect((result.content[0] as vscode.LanguageModelToolResultPart).content.map(text)).toEqual(['found']);
  });

  it('rejects an assistant call without an id and non-text content as invalid_request', async () => {
    const noId = portOver(replying());
    const missing = await noId.port.generateToolTurn({
      messages: [new AIMessage({ content: '', tool_calls: [{ name: 'lineage_search', args: {}, type: 'tool_call' }] })], tools, phase: 't',
    });
    expect(missing).toMatchObject({ status: 'error', turnStop: { code: 'invalid_request' } });
    expect(noId.raw.sendRequest).not.toHaveBeenCalled();
    const image = portOver(replying());
    const rejected = await image.port.generateToolTurn({
      messages: [new HumanMessage({ content: [{ type: 'image_url', image_url: { url: 'x' } }] })], tools, phase: 't',
    });
    expect(rejected).toMatchObject({ status: 'error', turnStop: { code: 'invalid_request' } });
    expect(image.raw.sendRequest).not.toHaveBeenCalled();
  });
});

describe('vscode-lm transport stream mapping', () => {
  it('turns text and tool call parts into chunks and ends with a streamEnd, usage as providerUsage', async () => {
    const usage = new TextEncoder().encode(JSON.stringify({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }));
    const wires: WireRecord[] = [];
    const { port } = portOver(
      replying(
        new vscode.LanguageModelTextPart('thin'), new vscode.LanguageModelTextPart('king'),
        new vscode.LanguageModelToolCallPart('c1', 'lineage_search', { q: 'x' }),
        { mimeType: 'usage', data: usage }, { value: 'reasoning' },
      ),
      ENTRY, wires,
    );
    const deltas: string[] = [];
    const result = await port.generateToolTurn({ messages: [new HumanMessage('go')], tools, phase: 't', onTextDelta: (delta) => deltas.push(delta) });
    if (result.status !== 'completed') throw new Error('turn failed');
    expect(deltas.join('')).toBe('thinking');
    expect(result.finishReason).toBe('tool-calls');
    expect(result.toolCalls).toEqual([{ valid: true, callId: 'c1', toolName: 'lineage_search', input: { q: 'x' } }]);
    const response = wires.find((record) => record.type === 'wire-response');
    expect(response).toMatchObject({ text: 'thinking', toolCalls: [{ callId: 'c1', name: 'lineage_search', input: { q: 'x' } }], usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } });
    expect(response).toMatchObject({ otherParts: [{ type: 'other' }] });
    expect(wires.find((record) => record.type === 'generation')).toMatchObject({ finishReason: 'tool-calls', usage: { totalTokens: 10 } });
  });
});

describe('vscode-lm transport tool mode', () => {
  const modeOf = async (choice: Parameters<ProviderModelPort['generateToolTurn']>[0]['toolChoice'], offered = tools) => {
    const { port, sent } = portOver(replying(new vscode.LanguageModelTextPart('x')));
    await port.generateToolTurn({ messages: [new HumanMessage('go')], tools: offered, toolChoice: choice, phase: 't' });
    return sent[0].options;
  };

  it('forces Required for one named tool and for a required choice, Auto otherwise', async () => {
    const two = [...tools, { name: 'other', description: 'd', inputSchema: z.object({}) }];
    expect(await modeOf({ type: 'tool', toolName: 'lineage_search' }, two)).toMatchObject({ toolMode: vscode.LanguageModelChatToolMode.Required, tools: [{ name: 'lineage_search' }] });
    expect(await modeOf('required', two)).toMatchObject({ toolMode: vscode.LanguageModelChatToolMode.Required });
    expect((await modeOf('required', two)).tools).toHaveLength(2);
    expect(await modeOf(undefined, two)).toMatchObject({ toolMode: vscode.LanguageModelChatToolMode.Auto });
  });

  it('sends no tools and no toolMode when none are offered', async () => {
    const { port, sent } = portOver(replying(new vscode.LanguageModelTextPart('hello')));
    expect(await port.completeText({ messages: [new HumanMessage('go')], phase: 't' })).toBe('hello');
    expect(sent[0].options).not.toHaveProperty('tools');
    expect(sent[0].options).not.toHaveProperty('toolMode');
  });
});

describe('vscode-lm transport structured output', () => {
  const schema = z.object({ answer: z.string() });
  const structured = (...parts: Part[]) => portOver(replying(...parts)).port.generateStructured({ messages: [new HumanMessage('go')], schema, phase: 't' });

  it('round-trips through the forced synthetic tool', async () => {
    const { port, sent } = portOver(replying(new vscode.LanguageModelToolCallPart('s1', 'structured_output', { answer: 'yes' })));
    expect(await port.generateStructured({ messages: [new HumanMessage('go')], schema, phase: 't' })).toEqual({ answer: 'yes' });
    expect(sent[0].options).toMatchObject({ toolMode: vscode.LanguageModelChatToolMode.Required, tools: [{ name: 'structured_output' }] });
  });

  it('rejects an invalid and an empty payload with a located error', async () => {
    await expect(structured(new vscode.LanguageModelToolCallPart('s1', 'structured_output', { answer: 3 }))).rejects.toBeInstanceOf(StructuredOutputError);
    await expect(structured(new vscode.LanguageModelToolCallPart('s1', 'structured_output', {}))).rejects.toBeInstanceOf(StructuredOutputError);
  });
});

describe('vscode-lm transport modelOptions', () => {
  it('sends requestBody plus max_tokens, and the wire body equals what was sent', async () => {
    const wires: WireRecord[] = [];
    const { port, sent } = portOver(replying(new vscode.LanguageModelTextPart('x')), ENTRY, wires);
    await port.completeText({ messages: [new HumanMessage('go')], phase: 't' });
    expect(sent[0].options.modelOptions).toEqual({ max_tokens: 500, temperature: 0.1, top_p: 1 });
    expect(wires.find((record) => record.type === 'wire-request')).toMatchObject({ body: sent[0].options.modelOptions });
  });

  it('lets requestBody override max_tokens', async () => {
    const { port, sent } = portOver(replying(new vscode.LanguageModelTextPart('x')), { ...ENTRY, requestBody: { max_tokens: 9 } });
    await port.completeText({ messages: [new HumanMessage('go')], phase: 't' });
    expect(sent[0].options.modelOptions).toEqual({ max_tokens: 9 });
  });

  it('sends no modelOptions key for a live selection', async () => {
    const wires: WireRecord[] = [];
    const { port, sent } = portOver(replying(new vscode.LanguageModelTextPart('x')), LIVE_ENTRY, wires);
    await port.completeText({ messages: [new HumanMessage('go')], phase: 't' });
    expect(sent[0].options).not.toHaveProperty('modelOptions');
    expect(wires.find((record) => record.type === 'wire-request')).not.toHaveProperty('body');
  });
});

describe('vscode-lm transport identity and counting', () => {
  it('takes the identity from the model and counts with the one shared counter', async () => {
    const { port, raw } = portOver(replying());
    expect(port.identity).toEqual({ id: 'e', name: 'Entry', vendor: 'v', family: 'f', version: '1' });
    expect(await port.getNumTokens('abcd')).toBe(countTokens('abcd'));
    expect(raw.countTokens).not.toHaveBeenCalled();
  });
});

describe('vscode-lm transport errors', () => {
  const failing = (error: unknown) => portOver(() => (async function* (): AsyncGenerator<Part> { throw error; })()).port;
  const codeOf = async (error: unknown) => {
    const result = await failing(error).generateToolTurn({ messages: [new HumanMessage('go')], tools, phase: 't' });
    if (result.status !== 'error') throw new Error(`expected an error, got ${result.status}`);
    return result.turnStop.code;
  };

  it('maps LanguageModelError codes to port codes, anything else to provider_error', async () => {
    expect(await codeOf(vscode.LanguageModelError.NoPermissions('no'))).toBe('no_permission');
    expect(await codeOf(vscode.LanguageModelError.Blocked('no'))).toBe('blocked');
    expect(await codeOf(vscode.LanguageModelError.NotFound('no'))).toBe('model_not_found');
    expect(await codeOf(new Error('boom'))).toBe('provider_error');
  });

  it('carries no secret sentinel in the message', async () => {
    const sentinel = 'sk-SENTINEL1234567890abcdefghijkl';
    const result = await failing(new Error(`bad Authorization: Bearer ${sentinel}`)).generateToolTurn({ messages: [new HumanMessage('go')], tools, phase: 't' });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('rejects a failing sendRequest as a port error', async () => {
    const fake = fakeModel(replying());
    fake.raw.sendRequest.mockRejectedValueOnce(vscode.LanguageModelError.NoPermissions('consent refused'));
    const transport = createVscodeLmTransport(ENTRY, fake.model);
    await expect((async () => { for await (const chunk of transport.stream({ messages: [new HumanMessage('go')], tools: [] })) void chunk; })())
      .rejects.toMatchObject({ name: 'ModelPortError', code: 'no_permission' });
  });
});

describe('vscode-lm transport cancellation', () => {
  it('cancels the token on abort, ends the iterator and reports a cancelled turn', async () => {
    const ended = vi.fn();
    const controller = new AbortController();
    // A provider ends its stream when the token it was given is cancelled.
    const reply = (token: vscode.CancellationToken) => (async function* (): AsyncGenerator<Part> {
      try {
        yield new vscode.LanguageModelTextPart('first');
        if (!token.isCancellationRequested) await new Promise<void>((resolve) => { token.onCancellationRequested(resolve); });
      } finally { ended(); }
    })();
    const { port, sent } = portOver(reply);
    const turn = port.generateToolTurn({
      messages: [new HumanMessage('go')], tools, phase: 't', signal: controller.signal,
      onTextDelta: () => controller.abort(),
    });
    await expect(turn).resolves.toMatchObject({ status: 'cancelled' });
    expect(sent[0].token.isCancellationRequested).toBe(true);
    expect(ended).toHaveBeenCalled();
  });

  it('does not send when the signal is already aborted', async () => {
    const fake = fakeModel(replying());
    const controller = new AbortController();
    controller.abort();
    const transport = createVscodeLmTransport(ENTRY, fake.model);
    await expect((async () => { for await (const chunk of transport.stream({ messages: [], tools: [], signal: controller.signal })) void chunk; })())
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(fake.raw.sendRequest).not.toHaveBeenCalled();
  });
});

describe('vscode-lm catalog', () => {
  const model = (over: Record<string, unknown>) => ({ id: 'a', name: 'A', vendor: 'other', family: 'fa', version: '1', maxInputTokens: 100, ...over });

  it('lists the live models, resolves each entry by its selector and keeps the host order', async () => {
    (vscode.lm as unknown as { models: unknown[] }).models = [model({}), model({ id: 'c', name: 'C', vendor: 'copilot', family: 'fc', maxInputTokens: 200 })];
    const catalog = await loadLmCatalog([{ ...ENTRY, id: 'mine', selector: { family: 'fc' } }, { ...ENTRY, id: 'lost', selector: { family: 'none' } }]);
    expect(catalog.live.map((info) => [info.selectionId, info.name, info.maxInputTokens])).toEqual([['lm:other/a', 'A', 100], ['lm:copilot/c', 'C', 200]]);
    expect(catalog.resolved.get('mine')?.id).toBe('c');
    expect(catalog.resolved.has('lost')).toBe(false);
    expect(preferredStartModel(catalog.live)?.selectionId).toBe('lm:copilot/c');
    expect(preferredStartModel(catalog.live.slice(0, 1))).toBeUndefined();
  });

  it('forwards the change event of the model list', () => {
    const changed = vi.fn();
    const subscription = onLmModelsChanged(changed);
    for (const listener of (vscode.lm as unknown as { changeListeners: Set<() => void> }).changeListeners) listener();
    expect(changed).toHaveBeenCalledOnce();
    subscription.dispose();
  });
});
