import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAiCompatiblePort, type FetchLike } from '../../harness/openAiCompatiblePort';
import { modelUserMessage } from '../../../src/ai/model/modelPort';

it.each([false, true])('preserves an HTTP-success provider error without retrying or executing tool calls (mixed choices: %s)', async mixedChoices => {
  const warning = 'Previously delivered tool calls must not be executed again on retry.';
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({
    error: { code: 'invalid_tool_call', type: 'server_error', message: `Model output contains an unrecoverable tool call. ${warning} Bearer synthetic-secret https://private.example/token` },
    ...(mixedChoices ? { choices: [{ message: { tool_calls: [{ id: 'must-not-run', function: { name: 'danger', arguments: '{}' } }] } }] } : {}),
  }) }));
  const logs: string[] = [];
  const port = new OpenAiCompatiblePort({ baseUrl: 'https://provider.example/v1', apiKey: 'synthetic-secret', model: 'synthetic-model' }, { fetchImpl, debugLog: line => logs.push(line) });
  const result = await port.generateToolTurn({ messages: [modelUserMessage('synthetic input')], tools: [], toolChoice: 'auto', phase: 'active' });
  expect(result).toMatchObject({ status: 'error', providerError: { code: 'provider_error', cause: { code: 'invalid_tool_call' } } });
  expect(JSON.stringify(result)).toContain(warning);
  expect(JSON.stringify(result)).toContain('server_error');
  expect(JSON.stringify(result) + logs.join('')).not.toMatch(/synthetic-secret|private\.example/);
  expect(result.toolCalls).toEqual([]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('keeps a missing-choice response distinct from a provider error envelope', async () => {
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ error: null }) }));
  const port = new OpenAiCompatiblePort({ baseUrl: 'https://provider.example/v1', apiKey: 'synthetic-secret', model: 'synthetic-model' }, { fetchImpl });
  const result = await port.generateToolTurn({ messages: [modelUserMessage('synthetic input')], tools: [], toolChoice: 'auto', phase: 'active' });
  expect(result).toMatchObject({ status: 'error', providerError: { code: 'unsupported_response' } });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});


it('rejects a choice-level provider error before exposing its 24 partial tool calls', async () => {
  const partialCalls = Array.from({ length: 24 }, (_, index) => ({ id: `partial-${index}`, type: 'function',
    function: { name: 'synthetic_tool', arguments: index === 23 ? '{' : '{}' } }));
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({
    choices: [{ finish_reason: 'error', native_finish_reason: 'error',
      error: { code: 502, message: 'Network connection lost. Bearer synthetic-secret https://private.example/token', metadata: { error_type: 'provider_unavailable' } },
      message: { role: 'assistant', content: 'Partial answer must not be delivered.', tool_calls: partialCalls } }],
  }) }));
  const onTextDelta = vi.fn();
  const port = new OpenAiCompatiblePort({ baseUrl: 'https://provider.example/v1', apiKey: 'synthetic-secret', model: 'synthetic-model' }, { fetchImpl });
  const result = await port.generateToolTurn({ messages: [modelUserMessage('synthetic input')], tools: [{ name: 'synthetic_tool', description: 'Synthetic read.', inputSchema: z.object({}) }], toolChoice: 'auto', phase: 'active', onTextDelta });
  expect(result).toMatchObject({ status: 'error', providerError: { code: 'provider_error', cause: { code: '502' } } });
  expect(result.toolCalls).toEqual([]);
  expect(result.text).toBe('');
  expect(onTextDelta).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).toContain('Network connection lost.');
  expect(JSON.stringify(result)).not.toMatch(/synthetic-secret|private\.example|partial-23|Partial answer/);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

describe('transient upstream error delivered inside HTTP 200 (DD-4a)', () => {
  const envelope = (code: number) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({
    choices: [{ finish_reason: 'error', error: { code, message: 'Server error. Stream terminated' }, message: { role: 'assistant', content: '' } }],
  }) });
  const completion = { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'synthetic answer' } }],
  }) };
  const turn = (fetchImpl: FetchLike, logs: string[] = []) =>
    new OpenAiCompatiblePort({ baseUrl: 'https://provider.example/v1', apiKey: 'synthetic-secret', model: 'synthetic-model' },
      { fetchImpl, debugLog: line => logs.push(line) })
      .generateToolTurn({ messages: [modelUserMessage('synthetic input')], tools: [], toolChoice: 'auto', phase: 'active' });

  it('retries a transient envelope once and returns the following completion', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValueOnce(envelope(503)).mockResolvedValueOnce(completion);
    const logs: string[] = [];
    const result = await turn(fetchImpl, logs);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'completed', text: 'synthetic answer' });
    expect(logs.join('\n')).toMatch(/\[AI\] transport-retry attempt=1\/3 status=503/);
  });

  it('does not retry a non-transient envelope code', async () => {
    const fetchImpl = vi.fn(async () => envelope(400));
    const result = await turn(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'error', providerError: { code: 'provider_error', cause: { code: '400' } } });
  });

  it('stops at the attempt bound and surfaces the provider error', async () => {
    const fetchImpl = vi.fn(async () => envelope(502));
    const result = await turn(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ status: 'error', providerError: { code: 'provider_error', cause: { code: '502' } } });
  }, 15_000);
});

describe('connection-phase transport failures (DD-4a)', () => {
  const completion = { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'synthetic answer' } }],
  }) };
  const failure = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
  const turn = (fetchImpl: FetchLike, logs: string[] = []) =>
    new OpenAiCompatiblePort({ baseUrl: 'https://provider.example/v1', apiKey: 'synthetic-secret', model: 'synthetic-model' },
      { fetchImpl, debugLog: line => logs.push(line) })
      .generateToolTurn({ messages: [modelUserMessage('synthetic input')], tools: [], toolChoice: 'auto', phase: 'active' });

  it.each(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND'])('retries %s and returns the following completion', async code => {
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValueOnce(failure(code)).mockResolvedValueOnce(completion);
    const logs: string[] = [];
    const result = await turn(fetchImpl, logs);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'completed', text: 'synthetic answer' });
    expect(logs.join('\n')).toContain(`transport-retry attempt=1/3 code=${code}`);
  }, 15_000);

  it('does not retry a headers timeout: the request may already be generating', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(failure('UND_ERR_HEADERS_TIMEOUT'));
    const result = await turn(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'error', providerError: { code: 'provider_error' } });
  });

  it('surfaces a persistent connect timeout after the attempt bound', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(failure('UND_ERR_CONNECT_TIMEOUT'));
    const result = await turn(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ status: 'error', providerError: { code: 'provider_error' } });
  }, 20_000);
});
