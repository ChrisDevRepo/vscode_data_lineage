/**
 * Acceptance for the harness's OpenAI-compatible HTTP port: the shared model-port contract plus the
 * behaviour only this lane has.
 *
 * @remarks
 * No network is reached from any test in this file — every response is a canned body handed to the
 * port's injectable transport seam. The shared suite is the load-bearing part: it is the same
 * `describePortContract` that runs against `VscodeModelPort`, so a semantic drift between the lane
 * the users run and the lane the measurements run on fails here rather than in a live-provider run.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  OpenAiCompatiblePort,
  type FetchLike,
  type HttpRequestInit,
  type HttpResponseLike,
} from '../../harness/openAiCompatiblePort';
import { projectMessages, suspectsToolCallAsText } from '../../harness/openAiWire';
import { laneEnvNames, resolveLane } from '../../harness/lanes';
import {
  describePortContract,
  type ContractPort,
  type PortContractHarness,
  type PortScript,
  type ScriptedPart,
} from './helpers/portContract';
import type { WireRecord } from '../../../src/ai/observability/wireLog';

const BASE_URL = 'https://provider.invalid/v1';
const MODEL = 'vendor/canned-model';

/** One `/chat/completions` body assembled from the shared suite's scripted parts. */
function cannedBody(parts: readonly ScriptedPart[]): unknown {
  const text = parts
    .filter((part): part is Extract<ScriptedPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
  const toolCalls = parts
    .filter((part): part is Extract<ScriptedPart, { type: 'tool-call' }> => part.type === 'tool-call')
    .map((part) => ({
      id: part.callId,
      type: 'function',
      function: { name: part.toolName, arguments: JSON.stringify(part.input) },
    }));
  return {
    id: 'cmpl-canned',
    model: MODEL,
    choices: [{
      index: 0,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

/** Records every request and replays a fixed body, status, or failure. */
function recordingFetch(
  respond: (init: HttpRequestInit) => Promise<HttpResponseLike>,
): { fetchImpl: FetchLike; requests: HttpRequestInit[] } {
  const requests: HttpRequestInit[] = [];
  return {
    requests,
    fetchImpl: async (_url, init) => {
      requests.push(init);
      return respond(init);
    },
  };
}

function jsonResponse(body: unknown, status = 200): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
  };
}

const openAiHarness: PortContractHarness = {
  portName: 'OpenAiCompatiblePort',
  createPort(script: PortScript): ContractPort {
    const transport = recordingFetch(async () => {
      if (script.failure === 'request') throw new Error('fetch failed');
      if (script.failure === 'mid-response') {
        // The provider answered and then broke while the body was being read — the non-streamed
        // analogue of a stream that dies mid-flight.
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => { throw new Error('connection reset'); },
        };
      }
      return jsonResponse(cannedBody(script.parts ?? []));
    });
    return {
      port: new OpenAiCompatiblePort(
        { baseUrl: BASE_URL, model: MODEL, apiKey: 'test-key', laneId: 'canned' },
        { fetchImpl: transport.fetchImpl },
      ),
      providerAttempts: () => transport.requests.length,
    };
  },
};

describePortContract(openAiHarness);

/** Builds a port over a queue of canned bodies, one per generation. */
function portOver(bodies: readonly unknown[], overrides: {
  readonly capabilities?: { readonly echoReasoning?: boolean };
  readonly requestTuning?: {
    readonly reasoning?: { readonly enabled: false } | { readonly effort: 'low' | 'medium' | 'high' };
    readonly providerSort?: 'throughput' | 'latency' | 'price';
  };
  readonly traceVerbose?: boolean;
  readonly wireLog?: (record: WireRecord) => void;
} = {}) {
  let index = 0;
  const transport = recordingFetch(async () => jsonResponse(bodies[Math.min(index++, bodies.length - 1)]));
  const port = new OpenAiCompatiblePort(
    {
      baseUrl: BASE_URL,
      model: MODEL,
      apiKey: 'super-secret-key-value',
      laneId: 'canned',
      ...(overrides.capabilities ? { capabilities: overrides.capabilities } : {}),
      ...(overrides.requestTuning ? { requestTuning: overrides.requestTuning } : {}),
    },
    {
      fetchImpl: transport.fetchImpl,
      ...(overrides.traceVerbose !== undefined ? { traceVerbose: overrides.traceVerbose } : {}),
      ...(overrides.wireLog ? { wireLog: overrides.wireLog } : {}),
      requestId: 'req-1',
    },
  );
  return {
    port,
    requests: transport.requests,
    bodyOf: (call: number) => JSON.parse(transport.requests[call].body) as Record<string, unknown>,
  };
}

/** A body carrying one tool call with literal `arguments`, bypassing JSON serialization. */
function toolCallBody(callId: string, name: string, args: string, finishReason = 'tool_calls'): unknown {
  return {
    choices: [{
      finish_reason: finishReason,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name, arguments: args } }],
      },
    }],
  };
}

const presentTool = {
  name: 'lineage_present_result',
  description: 'present',
  inputSchema: z.object({ id: z.string() }).strict(),
};

describe('OpenAI-compatible lane specifics', () => {
  it('constructs without a VS Code host and refuses the reserved streaming seam', () => {
    expect(() => new OpenAiCompatiblePort(
      { baseUrl: BASE_URL, model: MODEL, apiKey: 'k' },
      { fetchImpl: async () => jsonResponse(cannedBody([])) },
    )).not.toThrow();

    expect(() => new OpenAiCompatiblePort(
      { baseUrl: BASE_URL, model: MODEL, apiKey: 'k', capabilities: { stream: true } },
      { fetchImpl: async () => jsonResponse(cannedBody([])) },
    )).toThrowError(/Streaming is not implemented/);

    expect(() => new OpenAiCompatiblePort(
      { baseUrl: BASE_URL, model: MODEL, apiKey: 'k', capabilities: { nativeToolCalling: false } },
      { fetchImpl: async () => jsonResponse(cannedBody([])) },
    )).toThrowError(/nativeToolCalling/);
  });

  it('sends reasoning and provider-sort tuning verbatim when the lane declares them', async () => {
    const tuned = portOver([cannedBody([{ type: 'text', text: 'done' }])], {
      requestTuning: { reasoning: { effort: 'low' }, providerSort: 'throughput' },
    });
    await tuned.port.completeText({ messages: [new HumanMessage('hello')] });
    expect(tuned.bodyOf(0)).toMatchObject({
      reasoning: { effort: 'low' },
      provider: { sort: 'throughput' },
    });

    // The fully-off variant goes out verbatim too — it stays available for experiments even though
    // the openrouter lane default is effort-low (fully off measurably broke schema self-repair).
    const off = portOver([cannedBody([{ type: 'text', text: 'done' }])], {
      requestTuning: { reasoning: { enabled: false } },
    });
    await off.port.completeText({ messages: [new HumanMessage('hello')] });
    expect(off.bodyOf(0)).toMatchObject({ reasoning: { enabled: false } });
    expect(off.bodyOf(0)).not.toHaveProperty('provider');

    // An untuned lane sends neither key — the body stays byte-identical to what it was before the
    // tuning seam existed, so azure-foundry and local-mlx traces are unaffected.
    const plain = portOver([cannedBody([{ type: 'text', text: 'done' }])]);
    await plain.port.completeText({ messages: [new HumanMessage('hello')] });
    expect(plain.bodyOf(0)).not.toHaveProperty('reasoning');
    expect(plain.bodyOf(0)).not.toHaveProperty('provider');
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['non-JSON', 'origin=Sales'],
    ['JSON array', '[1,2]'],
  ])('charges %s tool arguments to the call, not the generation', async (_label, args) => {
    const built = portOver([toolCallBody('call-bad', 'lineage_present_result', args)]);
    const result = await built.port.generateToolTurn({
      messages: [new HumanMessage('present')],
      tools: [presentTool],
      phase: 'synthesis',
    });

    // DIVERGENCE from VscodeModelPort, pinned deliberately: the whole generation stays completed so
    // the graph's repair loop — the thing under measurement — keeps running.
    expect(result.status).toBe('completed');
    expect(result.toolCalls[0]).toMatchObject({
      valid: false, callId: 'call-bad', code: 'invalid_tool_input',
    });
    expect(built.requests).toHaveLength(1);
  });

  it('classifies empty structured arguments as an empty payload and malformed ones as invalid', async () => {
    const empty = portOver([toolCallBody('call-e', 'structured_output', '')]);
    await expect(empty.port.generateStructured({
      messages: [new HumanMessage('classify')],
      schema: z.object({ entry: z.string() }).strict(),
      phase: 'detect_entry',
    })).rejects.toMatchObject({ code: 'empty_structured_output' });

    const malformed = portOver([toolCallBody('call-m', 'structured_output', 'entry: discovery')]);
    await expect(malformed.port.generateStructured({
      messages: [new HumanMessage('classify')],
      schema: z.object({ entry: z.string() }).strict(),
      phase: 'detect_entry',
    })).rejects.toMatchObject({ code: 'invalid_structured_output' });
  });

  it('honours the provider finish reason and keeps the verbatim string in the measurement row', async () => {
    const cases = [
      { raw: 'length', canonical: 'length' },
      { raw: 'content_filter', canonical: 'content-filter' },
      { raw: 'stop', canonical: 'stop' },
    ] as const;

    for (const testCase of cases) {
      const built = portOver([{
        choices: [{ finish_reason: testCase.raw, message: { role: 'assistant', content: 'partial answer' } }],
      }]);
      const result = await built.port.generateToolTurn({
        messages: [new HumanMessage('run')], tools: [presentTool], phase: 'discover',
      });

      expect(result, testCase.raw).toMatchObject({ status: 'completed', finishReason: testCase.canonical });
      expect(built.port.generations[0].finishReason, testCase.raw).toBe(testCase.raw);
    }
  });

  it('flags a tool call described in prose without changing the generation status', async () => {
    expect(suspectsToolCallAsText('plain prose about a table')).toBe(false);
    expect(suspectsToolCallAsText('<｜tool▁calls▁begin｜>lineage_get_context')).toBe(true);
    expect(suspectsToolCallAsText('```json\n{"name":"lineage_get_context","arguments":{}}\n```')).toBe(true);

    const built = portOver([{
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: '{"name":"lineage_present_result","arguments":{"id":"x"}}' },
      }],
    }]);
    const result = await built.port.generateToolTurn({
      messages: [new HumanMessage('present')], tools: [presentTool], phase: 'synthesis',
    });

    expect(result).toMatchObject({ status: 'completed', toolCalls: [], finishReason: 'stop' });
    expect(built.port.generations[0].suspectedToolCallAsText).toBe(true);
  });

  it('sends a real system role and the OpenAI message projection for every history type', () => {
    const projected = projectMessages('SYSTEM RULES', [
      new HumanMessage('trace Sales'),
      new AIMessage({
        content: 'calling',
        tool_calls: [{ id: 'call-1', name: 'lineage_get_context', args: { depth: 1 } }],
      }),
      new ToolMessage({ tool_call_id: 'call-1', name: 'lineage_get_context', content: '{"nodes":[]}' }),
    ]);

    expect(projected.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(projected[0].content).toBe('SYSTEM RULES');
    expect(projected[2].tool_calls).toEqual([
      { id: 'call-1', type: 'function', function: { name: 'lineage_get_context', arguments: '{"depth":1}' } },
    ]);
    expect(projected[3]).toMatchObject({ tool_call_id: 'call-1', content: '{"nodes":[]}' });
  });

  it('echoes reasoning_content back only when the lane declares the capability', async () => {
    const reasoned = {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          reasoning_content: 'chain of thought text',
          tool_calls: [{ id: 'call-r', type: 'function', function: { name: 'lineage_present_result', arguments: '{"id":"x"}' } }],
        },
      }],
    };
    const history = [
      new HumanMessage('present'),
      new AIMessage({ content: '', tool_calls: [{ id: 'call-r', name: 'lineage_present_result', args: { id: 'x' } }] }),
      new ToolMessage({ tool_call_id: 'call-r', name: 'lineage_present_result', content: '{"ok":true}' }),
    ];

    for (const echo of [true, false]) {
      const built = portOver([reasoned, cannedBody([{ type: 'text', text: 'done' }])], {
        capabilities: { echoReasoning: echo },
      });
      await built.port.generateToolTurn({
        messages: [new HumanMessage('present')], tools: [presentTool], phase: 'synthesis',
      });
      await built.port.generateToolTurn({ messages: history, tools: [presentTool], phase: 'synthesis' });

      const second = built.bodyOf(1).messages as Array<Record<string, unknown>>;
      const assistant = second.find((message) => message.role === 'assistant');
      expect(assistant?.reasoning_content, `echo=${echo}`).toBe(echo ? 'chain of thought text' : undefined);
    }
  });

  it('projects tool definitions and the tool choice, and omits both when no tool is callable', async () => {
    const built = portOver([cannedBody([{ type: 'text', text: 'ok' }]), cannedBody([{ type: 'text', text: 'ok' }])]);
    await built.port.generateToolTurn({
      messages: [new HumanMessage('run')],
      tools: [presentTool],
      toolChoice: { type: 'tool', toolName: 'lineage_present_result' },
      phase: 'synthesis',
    });
    const withTools = built.bodyOf(0);
    expect(withTools.stream).toBe(false);
    expect(withTools.model).toBe(MODEL);
    expect(withTools.tool_choice).toEqual({ type: 'function', function: { name: 'lineage_present_result' } });
    expect((withTools.tools as Array<{ function: { name: string; parameters: unknown } }>)[0]).toMatchObject({
      type: 'function',
      function: { name: 'lineage_present_result', parameters: { type: 'object' } },
    });

    await built.port.generateToolTurn({
      messages: [new HumanMessage('run')], tools: [presentTool], toolChoice: 'none', phase: 'discover',
    });
    const withoutTools = built.bodyOf(1);
    // A `tool_choice` without tools is rejected by several servers, so the pair is omitted together.
    expect(withoutTools.tools).toBeUndefined();
    expect(withoutTools.tool_choice).toBeUndefined();
  });

  it('emits one generation record per entry point, gates verbose capture, and never records headers', async () => {
    const records: WireRecord[] = [];
    const quiet = portOver(
      [
        cannedBody([{ type: 'text', text: 'answer' }]),
        toolCallBody('call-s', 'structured_output', '{"entry":"discovery"}'),
        cannedBody([{ type: 'text', text: 'composed' }]),
      ],
      { wireLog: (record) => { records.push(record); } },
    );
    await quiet.port.generateToolTurn({
      messages: [new HumanMessage('run')], tools: [], system: 'SYSTEM RULES', phase: 'discover',
    });
    await quiet.port.generateStructured({
      messages: [new HumanMessage('classify')],
      schema: z.object({ entry: z.string() }).strict(),
      system: 'SYSTEM RULES',
      phase: 'detect_entry',
    });
    await quiet.port.completeText({
      messages: [new HumanMessage('compose')], system: 'SYSTEM RULES', phase: 'compose',
    });

    expect(records.filter((record) => record.type === 'generation')).toHaveLength(3);
    expect(records.map((record) => record.generation)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
    const request = records.find((record) => record.type === 'wire-request');
    expect(request).toMatchObject({ requestId: 'req-1', phase: 'discover' });
    expect(request && 'systemHash' in request && request.systemHash).toMatch(/^[0-9a-f]{64}$/);
    expect(request !== undefined && 'system' in request).toBe(false);
    // Verbose is off: no provider bodies at all.
    expect(records.some((record) => record.type === 'provider-raw')).toBe(false);
    expect(records.find((record) => record.type === 'generation')).toMatchObject({
      modelId: MODEL, finishReason: 'stop', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    });

    const verboseRecords: WireRecord[] = [];
    const verbose = portOver([cannedBody([{ type: 'text', text: 'answer' }])], {
      traceVerbose: true,
      wireLog: (record) => { verboseRecords.push(record); },
    });
    await verbose.port.generateToolTurn({
      messages: [new HumanMessage('run')], tools: [], system: 'SYSTEM RULES', phase: 'discover',
    });

    const raw = verboseRecords.filter((record) => record.type === 'provider-raw');
    expect(raw.map((record) => record.type === 'provider-raw' && record.direction)).toEqual(['request', 'response']);
    const verboseRequest = verboseRecords.find((record) => record.type === 'wire-request');
    expect(verboseRequest && 'system' in verboseRequest && verboseRequest.system).toBe('SYSTEM RULES');
    // The credential is in the request headers and must appear in no record on any lane.
    const serialized = JSON.stringify([...records, ...verboseRecords]);
    expect(serialized).not.toContain('super-secret-key-value');
    expect(serialized.toLowerCase()).not.toContain('authorization');
    expect(serialized.toLowerCase()).not.toContain('bearer');
  });

  it('sends the credential as a Bearer header to the appended chat-completions path', async () => {
    const requests: HttpRequestInit[] = [];
    const port = new OpenAiCompatiblePort(
      { baseUrl: `${BASE_URL}/`, model: MODEL, apiKey: 'k-123' },
      {
        fetchImpl: async (url, init) => {
          expect(url).toBe(`${BASE_URL}/chat/completions`);
          requests.push(init);
          return jsonResponse(cannedBody([{ type: 'text', text: 'ok' }]));
        },
      },
    );
    await port.completeText({ messages: [new HumanMessage('compose')], phase: 'compose' });
    expect(requests[0].headers.authorization).toBe('Bearer k-123');
    expect(requests[0].method).toBe('POST');
  });

  it.each([
    [400, 'invalid_request'],
    [401, 'no_permission'],
    [403, 'no_permission'],
    [404, 'model_not_found'],
    [429, 'provider_error'],
    [503, 'provider_error'],
  ])('maps HTTP %i to %s in exactly one attempt', async (status, code) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'upstream said no' } }, status as number));
    const port = new OpenAiCompatiblePort(
      { baseUrl: BASE_URL, model: MODEL, apiKey: 'k' },
      { fetchImpl },
    );

    await expect(port.completeText({
      messages: [new HumanMessage('compose')], phase: 'compose',
    })).rejects.toMatchObject({ code });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(port.modelCalls).toBe(1);
  });

  it('surfaces a body that is not a completion as an unsupported response, once', async () => {
    const nonJson = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK', text: async () => 'not json at all',
    }));
    await expect(new OpenAiCompatiblePort(
      { baseUrl: BASE_URL, model: MODEL, apiKey: 'k' }, { fetchImpl: nonJson },
    ).completeText({ messages: [new HumanMessage('compose')], phase: 'compose' }))
      .rejects.toMatchObject({ code: 'unsupported_response' });
    expect(nonJson).toHaveBeenCalledTimes(1);

    const noChoices = vi.fn(async () => jsonResponse({ id: 'cmpl', choices: [] }));
    await expect(new OpenAiCompatiblePort(
      { baseUrl: BASE_URL, model: MODEL, apiKey: 'k' }, { fetchImpl: noChoices },
    ).completeText({ messages: [new HumanMessage('compose')], phase: 'compose' }))
      .rejects.toMatchObject({ code: 'unsupported_response' });
    expect(noChoices).toHaveBeenCalledTimes(1);
  });

  it('captures a failure body verbosely with any echoed credential redacted', async () => {
    const records: WireRecord[] = [];
    const port = new OpenAiCompatiblePort(
      { baseUrl: BASE_URL, model: MODEL, apiKey: 'super-secret-key-value' },
      {
        traceVerbose: true,
        wireLog: (record) => { records.push(record); },
        // A provider that echoes the rejected header back is exactly why a failure body is the one
        // capture that is sanitized rather than kept verbatim.
        fetchImpl: async () => jsonResponse(
          { error: { message: 'invalid key for Bearer super-secret-key-value' } },
          401,
        ),
      },
    );

    await expect(port.completeText({ messages: [new HumanMessage('compose')], phase: 'compose' }))
      .rejects.toMatchObject({ code: 'no_permission' });
    const raw = records.filter((record) => record.type === 'provider-raw');
    expect(raw.map((record) => record.type === 'provider-raw' && record.direction)).toEqual(['request', 'response']);
    expect(records.some((record) => record.type === 'wire-error')).toBe(true);
    expect(JSON.stringify(records)).not.toContain('super-secret-key-value');
  });

  it('abandons a request that exceeds the lane timeout and records it as a transport failure', async () => {
    const port = new OpenAiCompatiblePort(
      { baseUrl: BASE_URL, model: MODEL, apiKey: 'k', requestTimeoutMs: 5 },
      {
        fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      },
    );

    const result = await port.generateToolTurn({
      messages: [new HumanMessage('run')], tools: [], phase: 'discover',
    });
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.providerError.cause?.code).toBe('ETIMEDOUT');
  });
});

describe('live-provider lane resolution', () => {
  it('self-skips every lane whose API key is absent', () => {
    for (const id of ['azure-foundry', 'openrouter', 'local-mlx'] as const) {
      const names = laneEnvNames(id);
      expect(resolveLane(id, {})).toMatchObject({
        status: 'skipped',
        laneId: id,
        reason: `missing-env:${names.apiKey}`,
        message: `[e2e] SKIP lane=${id} reason=missing-env:${names.apiKey}`,
      });
    }
  });

  it('skips azure-foundry without a base URL because the resource name is never committed', () => {
    expect(resolveLane('azure-foundry', { LINEAGE_AZURE_FOUNDRY_API_KEY: 'k' })).toMatchObject({
      status: 'skipped',
      reason: 'missing-env:LINEAGE_AZURE_FOUNDRY_BASE_URL',
    });
  });

  it.each([
    'https://openrouter.ai/api/v1/chat/completions',
    'https://openrouter.ai/api/v1/responses',
    'https://openrouter.ai/api/v1/chat/completions/',
  ])('rejects a base URL that already names an endpoint (%s)', (baseUrl) => {
    const resolution = resolveLane('openrouter', {
      LINEAGE_OPENROUTER_API_KEY: 'secret-key-material',
      LINEAGE_OPENROUTER_BASE_URL: baseUrl,
    });

    expect(resolution.status).toBe('config-error');
    const message = resolution.status === 'config-error' ? resolution.message : '';
    expect(message).toContain('LINEAGE_OPENROUTER_BASE_URL');
    // Names the variable, never the value: an .env must not need manual inspection, and a log must
    // not become a place credentials or resource names leak.
    expect(message).not.toContain('secret-key-material');
    expect(message).not.toContain('openrouter.ai');
  });

  it('rejects a non-http base URL', () => {
    expect(resolveLane('local-mlx', {
      LINEAGE_LOCAL_MLX_API_KEY: 'k',
      LINEAGE_LOCAL_MLX_BASE_URL: 'ftp://127.0.0.1/v1',
    })).toMatchObject({ status: 'config-error' });
  });

  it('resolves a configured lane into a port configuration and warns about a bare model id', () => {
    const ready = resolveLane('openrouter', {
      LINEAGE_OPENROUTER_API_KEY: 'k',
      LINEAGE_OPENROUTER_MODEL: 'deepseek-chat',
    });

    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') return;
    expect(ready.lane).toMatchObject({
      laneId: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek-chat',
      apiKey: 'k',
      capabilities: { echoReasoning: true, nativeToolCalling: true },
    });
    // No lane declares request tuning by default — every tuned variant measurably distorted the
    // model behavior the harness measures (see lanes.ts). The seam is experiment-only.
    expect(ready.lane).not.toHaveProperty('requestTuning');
    expect(ready.warnings).toHaveLength(1);
    expect(ready.warnings[0]).toContain('LINEAGE_OPENROUTER_MODEL');
    expect(ready.warnings[0]).not.toContain('deepseek-chat');

    // The default vendor-prefixed model produces no warning, and the resolved lane is directly a
    // port configuration — Phase 3 constructs the port from it with no adaptation.
    const defaults = resolveLane('openrouter', { LINEAGE_OPENROUTER_API_KEY: 'k' });
    expect(defaults.status === 'ready' && defaults.warnings).toEqual([]);
    if (defaults.status !== 'ready') return;
    expect(() => new OpenAiCompatiblePort(defaults.lane, {
      fetchImpl: async () => jsonResponse(cannedBody([])),
    })).not.toThrow();
  });
});
