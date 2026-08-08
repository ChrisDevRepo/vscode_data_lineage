import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import {
  VscodeLangChainBridge,
  toVscodeMessage,
} from '../../../src/ai/model/vscodeLangChainBridge';
import { VscodeModelPort } from '../../../src/ai/model/vscodeModelPort';
import {
  describePortContract,
  type ContractPort,
  type PortContractHarness,
  type PortScript,
  type ScriptedPart,
} from './helpers/portContract';

/**
 * Scripts the `vscode.lm` transport for the shared port-contract suite.
 *
 * @remarks
 * The suite runs unchanged against this port and against the harness's OpenAI-compatible HTTP port;
 * this adapter is the only VS Code specific part of that arrangement, and it deliberately scripts
 * the *transport* (`sendRequest`) rather than the port, so the port's own conversion, validation and
 * accounting all stay under test.
 */
const vscodeHarness: PortContractHarness = {
  portName: 'VscodeModelPort',
  createPort(script: PortScript): ContractPort {
    const sendRequest = vi.fn();
    if (script.failure === 'request') {
      sendRequest.mockRejectedValue(Object.assign(new Error('429 rate limit'), { code: 'Blocked' }));
    } else if (script.failure === 'mid-response') {
      sendRequest.mockImplementation(async () => ({
        stream: {
          async *[Symbol.asyncIterator]() {
            yield new vscode.LanguageModelTextPart('partial');
            throw new Error('connection reset');
          },
        },
      }));
    } else {
      const parts = (script.parts ?? []).map(toNativePart);
      sendRequest.mockImplementation(async () => ({ stream: asyncIterable(parts) }));
    }
    return {
      port: new VscodeModelPort({ ...modelIdentity(), sendRequest } as never),
      providerAttempts: () => sendRequest.mock.calls.length,
    };
  },
};

function toNativePart(part: ScriptedPart): unknown {
  return part.type === 'text'
    ? new vscode.LanguageModelTextPart(part.text)
    : new vscode.LanguageModelToolCallPart(part.callId, part.toolName, part.input);
}

describePortContract(vscodeHarness);

describe('selected VS Code model bridge acceptance', () => {
  it('uses exactly the supplied model, preserves LangChain role order and call IDs, and clones provider input', async () => {
    const rawInput = { nested: { value: 'provider-owned' } };
    const selected = selectedModel([
      new vscode.LanguageModelToolCallPart('call-42', 'lineage_present_result', rawInput),
    ]);
    const messages = [
      new SystemMessage('system one'),
      new HumanMessage('user one'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call-41', name: 'lineage_search_objects', args: { query: 'Orders' } }],
      }),
      new ToolMessage({
        tool_call_id: 'call-41',
        content: '{"results":[]}',
        name: 'lineage_search_objects',
      }),
    ];
    const native = messages.map(toVscodeMessage);
    expect(native.map(message => message.role)).toEqual([
      vscode.LanguageModelChatMessageRole.User,
      vscode.LanguageModelChatMessageRole.User,
      vscode.LanguageModelChatMessageRole.Assistant,
      vscode.LanguageModelChatMessageRole.User,
    ]);
    expect(native[2].content[0]).toMatchObject({
      callId: 'call-41', name: 'lineage_search_objects', input: { query: 'Orders' },
    });
    expect(native[3].content[0]).toMatchObject({
      callId: 'call-41', content: [expect.objectContaining({ value: '{"results":[]}' })],
    });

    const bridge = new VscodeLangChainBridge({
      model: selected as never,
      token: new vscode.CancellationTokenSource().token as never,
    });
    const chunks = [];
    for await (const chunk of bridge._streamResponseChunks(messages, {} as never)) {
      chunks.push(chunk);
    }

    expect(selected.sendRequest).toHaveBeenCalledTimes(1);
    // ChatGenerationChunk.message is declared as the wider BaseMessageChunk, but the
    // bridge always emits AIMessageChunk instances — narrow to reach tool_call_chunks.
    const call = (chunks[0].message as AIMessageChunk).tool_call_chunks?.[0];
    expect(call).toMatchObject({ id: 'call-42', name: 'lineage_present_result' });
    const cloned = JSON.parse(call?.args ?? '{}') as { nested: { value: string } };
    cloned.nested.value = 'bridge-owned';
    expect(rawInput).toEqual({ nested: { value: 'provider-owned' } });
  });

  it('maps auto, none, named, single-required, and multi-required tool choices exactly', async () => {
    const tools = [
      { name: 'lineage_first', description: 'first', inputSchema: { type: 'object' } },
      { name: 'lineage_second', description: 'second', inputSchema: { type: 'object' } },
    ];
    const cases = [
      {
        label: 'auto',
        tools,
        choice: 'auto',
        expectedNames: ['lineage_first', 'lineage_second'],
        expectedMode: vscode.LanguageModelChatToolMode.Auto,
      },
      {
        label: 'none',
        tools,
        choice: 'none',
        expectedNames: [],
        expectedMode: undefined,
      },
      {
        label: 'named',
        tools,
        choice: 'lineage_second',
        expectedNames: ['lineage_second'],
        expectedMode: vscode.LanguageModelChatToolMode.Required,
      },
      {
        label: 'single required',
        tools: tools.slice(0, 1),
        choice: 'any',
        expectedNames: ['lineage_first'],
        expectedMode: vscode.LanguageModelChatToolMode.Required,
      },
      {
        label: 'multi required',
        tools,
        choice: 'any',
        expectedNames: ['lineage_first', 'lineage_second'],
        expectedMode: vscode.LanguageModelChatToolMode.Required,
      },
    ] as const;

    for (const testCase of cases) {
      const selected = selectedModel([new vscode.LanguageModelTextPart(testCase.label)]);
      const bridge = new VscodeLangChainBridge({
        model: selected as never,
        token: new vscode.CancellationTokenSource().token as never,
      });
      await collect(bridge.bindTools([...testCase.tools], {
        tool_choice: testCase.choice,
      }).stream([new HumanMessage('choose')]));
      const requestOptions = selected.sendRequest.mock.calls[0][1] as {
        tools?: Array<{ name: string }>;
        toolMode?: vscode.LanguageModelChatToolMode;
      };
      expect(requestOptions.tools?.map((tool) => tool.name) ?? []).toEqual(
        testCase.expectedNames,
      );
      expect(requestOptions.toolMode).toBe(testCase.expectedMode);
    }
  });

  it('rejects an unsupported provider-specific tool-choice object instead of silently using auto', async () => {
    const selected = selectedModel([new vscode.LanguageModelTextPart('unused')]);
    const bridge = new VscodeLangChainBridge({
      model: selected as never,
      token: new vscode.CancellationTokenSource().token as never,
    });
    const tools = [
      { name: 'lineage_first', description: 'first', inputSchema: { type: 'object' } },
    ];

    const unsupported = bridge.bindTools(tools, {
      tool_choice: { type: 'provider-specific-without-a-name' },
    });
    await expect(collect(unsupported.stream([
      new HumanMessage('do not silently change this choice'),
    ]))).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Unsupported LangChain tool choice object.',
    });
    expect(selected.sendRequest).not.toHaveBeenCalled();
  });

  it('rejects an assistant history tool call without a pairable call ID', () => {
    const message = new AIMessage({
      content: '',
      tool_calls: [{
        name: 'lineage_search_objects',
        args: { query: 'Orders' },
      }],
    });

    expect(() => toVscodeMessage(message)).toThrowError(
      'Assistant tool call requires a non-empty call ID.',
    );
  });

  it('closes a non-EOF iterator exactly once for cancellation and returns a selected-model provider failure without fallback', async () => {
    const controller = new AbortController();
    let returns = 0;
    const iterator = {
      calls: 0,
      async next() {
        this.calls += 1;
        if (this.calls === 1) return { done: false, value: new vscode.LanguageModelTextPart('partial') };
        return { done: false, value: new vscode.LanguageModelTextPart('unreachable') };
      },
      async return() { returns += 1; return { done: true, value: undefined }; },
      [Symbol.asyncIterator]() { return this; },
    };
    const selected = {
      ...modelIdentity(),
      sendRequest: vi.fn().mockResolvedValue({ stream: iterator }),
    };
    const bridge = new VscodeLangChainBridge({
      model: selected as never,
      token: new vscode.CancellationTokenSource().token as never,
    });
    const stream = bridge._streamResponseChunks(
      [new HumanMessage('cancel me')],
      { signal: controller.signal } as never,
    );
    await stream.next();
    controller.abort();
    await expect(stream.next()).rejects.toMatchObject({ code: 'cancelled' });
    expect(returns).toBe(1);
    expect(selected.sendRequest).toHaveBeenCalledTimes(1);

    const onlySelected = {
      ...modelIdentity(),
      sendRequest: vi.fn().mockRejectedValue(new Error('provider failed')),
    };
    const failed = await new VscodeModelPort(onlySelected as never).generateToolTurn({
      messages: [], tools: [], phase: 'discover',
    });
    expect(failed).toMatchObject({ status: 'error' });
    expect(onlySelected.sendRequest).toHaveBeenCalledTimes(1);
  });

  it('skips an unrecognised stream part and still completes the turn', async () => {
    const selected = selectedModel([
      { kind: 'a-part-kind-this-version-does-not-know' },
      new vscode.LanguageModelTextPart('answer'),
    ]);
    const debugLog = vi.fn();
    const result = await new VscodeModelPort(selected as never, { debugLog }).generateToolTurn({
      messages: [new HumanMessage('explain')],
      tools: [],
      phase: 'discover',
    });

    expect(result).toMatchObject({ status: 'completed', text: 'answer', finishReason: 'stop' });
    expect(debugLog.mock.calls.map(([line]) => String(line))).not.toContainEqual(
      expect.stringContaining('stream-part-skipped'),
    );
  });

  it.each([
    ['NoPermissions', 'no_permission'],
    ['Blocked', 'blocked'],
    ['NotFound', 'model_not_found'],
  ] as const)('surfaces %s once as %s', async (nativeCode, portCode) => {
    const selected = {
      ...modelIdentity(),
      sendRequest: vi.fn().mockRejectedValue(
        Object.assign(new Error(`${nativeCode} provider failure`), { code: nativeCode }),
      ),
    };
    const port = new VscodeModelPort(selected as never);

    await expect(port.completeText({
      messages: [new HumanMessage('compose')],
      phase: 'compose',
    })).rejects.toMatchObject({ code: portCode });
    expect(selected.sendRequest).toHaveBeenCalledTimes(1);
  });

});

function selectedModel(parts: readonly unknown[]) {
  return {
    ...modelIdentity(),
    sendRequest: vi.fn().mockResolvedValue({ stream: asyncIterable(parts) }),
  };
}

function modelIdentity() {
  return {
    id: 'publisher.exact', name: 'Exact', vendor: 'test', family: 'scripted', version: '1',
  };
}

function asyncIterable<T>(values: readonly T[]): AsyncIterable<T> {
  return { async *[Symbol.asyncIterator]() { yield* values; } };
}

async function collect<T>(stream: Promise<AsyncIterable<T>>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of await stream) values.push(value);
  return values;
}
