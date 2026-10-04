/** Optional runner configuration, provider failures/cancellation, trace parsing and explicit export boundaries. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { databaseConfig, main, parseOptions } from '../../harness/cli';
import { OpenAiCompatiblePort, type FetchLike } from '../../harness/openAiCompatiblePort';
import { parseTrace, serializeRun } from '../../harness/traceModel';
import { exportRunToLangfuse } from '../../harness/langfuseExport';
import { modelUserMessage } from '../../../src/ai/model/modelPort';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const config = { baseUrl: 'https://provider.example/v1', apiKey: 'synthetic-secret', model: 'synthetic-model' };
const response = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) });
const generation = { messages: [modelUserMessage('synthetic input')], tools: [], toolChoice: 'auto' as const, phase: 'discovery' };

describe('public toolset options', () => {
  it('accepts a prompt and ordered follow-ups without a question registry', () => {
    expect(parseOptions('ai', ['--prompt', 'Inspect dependencies', '--followup', 'First', '--followup', 'Second', '--timeout-ms', '1000']))
      .toMatchObject({ prompt: 'Inspect dependencies', followups: ['First', 'Second'], timeoutMs: 1000, langfuse: false, verbose: false });
  });
  it.each([['--timeout-ms', '0'], ['--timeout-ms', 'NaN'], ['--prompt'], ['--runs', '10']])('rejects invalid or campaign options %j', (...args) => {
    expect(() => parseOptions('ai', args)).toThrow();
  });
  it('rejects AI-only switches on the database runner', () => {
    expect(() => parseOptions('db', ['--langfuse'])).toThrow();
  });
  it('requires database credentials and validates port/TLS options without storing the password', () => {
    expect(() => databaseConfig({})).toThrow('DB_TEST_SERVER');
    const env = { DB_TEST_SERVER: 'localhost', DB_TEST_DATABASE: 'synthetic', DB_TEST_USER: 'reader', DB_TEST_PASSWORD: 'synthetic-password' };
    expect(databaseConfig(env)).toMatchObject({ encrypt: true, trustServerCertificate: false });
    expect(databaseConfig(env)).not.toHaveProperty('password');
    expect(() => databaseConfig({ ...env, DB_TEST_PORT: '65536' })).toThrow();
    expect(() => databaseConfig({ ...env, DB_TEST_ENCRYPT: 'yes' })).toThrow();
  });
});

describe('shared headless provider transport', () => {
  it.each(['http', 'transport'] as const)('cancels during %s retry backoff without another request', async failure => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      if (failure === 'transport') throw Object.assign(new Error('Synthetic connection reset'), { code: 'ECONNRESET' });
      return { ...response({}), ok: false, status: 503, headers: { get: () => '1' } };
    });
    const port = new OpenAiCompatiblePort(config, { fetchImpl,
      debugLog: () => { setTimeout(() => controller.abort(), 100); },
    });
    const outcome = port.generateToolTurn({ ...generation, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toMatchObject({ status: 'cancelled' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels an active request and clears its request timeout', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchImpl = vi.fn<FetchLike>(async (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('Synthetic abort')), { once: true });
    }));
    const port = new OpenAiCompatiblePort(config, { fetchImpl });
    const outcome = port.generateToolTurn({ ...generation, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await outcome).toMatchObject({ status: 'cancelled' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('classifies caller cancellation during a request timeout as cancellation', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchImpl = vi.fn<FetchLike>(async (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        controller.abort();
        reject(new Error('Synthetic timeout and cancellation'));
      }, { once: true });
    }));
    const port = new OpenAiCompatiblePort({ ...config, requestTimeoutMs: 10 }, { fetchImpl });
    const outcome = port.generateToolTurn({ ...generation, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toMatchObject({ status: 'cancelled' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retains successful retries and stops at the existing transport attempt limit', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<FetchLike>()
      .mockResolvedValueOnce({ ...response({}), ok: false, status: 503 })
      .mockResolvedValue(response({ choices: [{ message: { content: 'Recovered' }, finish_reason: 'stop' }] }));
    const port = new OpenAiCompatiblePort(config, { fetchImpl });
    const outcome = port.generateToolTurn(generation);
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ status: 'completed', text: 'Recovered' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    fetchImpl.mockReset().mockResolvedValue({ ...response({}), ok: false, status: 503 });
    const failed = port.generateToolTurn(generation);
    await vi.runAllTimersAsync();
    expect(await failed).toMatchObject({ status: 'error' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('decodes a synthetic generation using the production ModelPort contract', async () => {
    const port = new OpenAiCompatiblePort(config, { fetchImpl: async () => response({ choices: [{ message: { content: 'Synthetic answer' }, finish_reason: 'stop' }] }), budget: DEFAULT_TURN_TOKEN_BUDGET });
    expect(await port.generateToolTurn(generation)).toMatchObject({ status: 'completed', text: 'Synthetic answer' });
    expect(port.modelCalls).toBe(1);
  });
  it('rejects malformed structured arguments rather than treating completion as correctness', async () => {
    const fetchImpl: FetchLike = async () => response({ choices: [{ message: { content: null, tool_calls: [{ id: 'one', function: { name: 'structured_output', arguments: 'not-json' } }] }, finish_reason: 'tool_calls' }] });
    const port = new OpenAiCompatiblePort(config, { fetchImpl });
    await expect(port.generateStructured({ system: 'synthetic', messages: [modelUserMessage('synthetic')], schema: z.object({ answer: z.string() }) })).rejects.toThrow();
  });
  it('honors pre-cancellation without sending a provider request', async () => {
    const fetchImpl = vi.fn();
    const port = new OpenAiCompatiblePort(config, { fetchImpl });
    const controller = new AbortController(); controller.abort();
    expect(await port.generateToolTurn({ ...generation, signal: controller.signal })).toMatchObject({ status: 'cancelled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('does not expose API keys from an HTTP rejection', async () => {
    const port = new OpenAiCompatiblePort(config, { fetchImpl: async () => ({ ...response({}), ok: false, status: 401, text: async () => config.apiKey }) });
    const outcome = await port.generateToolTurn(generation);
    expect(outcome.status).toBe('error');
    expect(JSON.stringify(outcome)).not.toContain(config.apiKey);
  });
});

const syntheticTrace = [
  { at: '2026-01-01T00:00:00.000Z', type: 'turn-start', requestId: 'synthetic', runFingerprint: 'run', sessionFingerprint: 'session', modelFingerprint: 'model' },
  { at: '2026-01-01T00:00:00.010Z', type: 'turn-terminal', requestId: 'synthetic', runFingerprint: 'run', status: 'ok', modelCalls: 0, durationMs: 10 },
].map(row => JSON.stringify(row)).join('\n') + '\n';

describe('public trace/export plumbing', () => {
  it.each(['1', 1])('reports OTLP rejection %s even without an error message', async rejectedSpans => {
    const result = await exportRunToLangfuse(parseTrace(syntheticTrace), {
      baseUrl: 'https://langfuse.example', publicKey: 'synthetic-public', secretKey: 'synthetic-secret',
      fetchImpl: async () => new Response(JSON.stringify({ partialSuccess: { rejectedSpans } }), { status: 200 }),
    });
    expect(result.exported).toBe(0);
    expect(result.errors).toEqual([expect.stringContaining('rejectedSpans=1')]);
  });
  it('preserves unknown and malformed records without discarding the valid trace', () => {
    const text = syntheticTrace + '{"at":"2026-01-01T00:00:00Z","type":"future"}\nnot-json\n';
    const run = parseTrace(text);
    expect(run.malformed).toHaveLength(1);
    expect(serializeRun(run)).toBe(text);
  });
  it('posts only on explicit export and reports OTLP partial rejection', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ partialSuccess: { rejectedSpans: '1', errorMessage: 'synthetic rejection' } }) } as Response));
    const run = parseTrace(syntheticTrace);
    expect(fetchImpl).not.toHaveBeenCalled();
    const result = await exportRunToLangfuse(run, { baseUrl: 'https://langfuse.example', publicKey: 'synthetic-public', secretKey: 'synthetic-secret', fetchImpl: fetchImpl as typeof fetch });
    expect(fetchImpl.mock.calls[0]).toBeDefined();
    expect(result.exported).toBe(0);
    expect(result.errors.join(' ')).toContain('rejectedSpans');
  });
  it('scrubs the configured secret when export fails', async () => {
    const secretKey = 'synthetic-secret';
    const result = await exportRunToLangfuse(parseTrace(syntheticTrace), {
      baseUrl: 'https://langfuse.example', publicKey: 'synthetic-public', secretKey,
      fetchImpl: async () => { throw new Error(secretKey); },
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors.join(' ')).not.toContain(secretKey);
  });
});


describe('offline headless runtime smoke', () => {
  it.each([
    { verbose: false, rejected: 0, exportEnabled: false },
    { verbose: false, rejected: 0, exportEnabled: true },
    { verbose: true, rejected: 0, exportEnabled: true },
    { verbose: true, rejected: 1, exportEnabled: true },
  ])('joins two turns and reports export status (export=$exportEnabled, verbose=$verbose, rejected=$rejected)', async ({ verbose, rejected, exportEnabled }) => {
    vi.stubEnv('AI_TEST_PROVIDER', 'openai-compatible');
    vi.stubEnv('AI_TEST_ENDPOINT', 'https://provider.example/v1');
    vi.stubEnv('AI_TEST_API_KEY', 'synthetic-secret');
    vi.stubEnv('AI_TEST_MODEL', 'synthetic-model');
    vi.stubEnv('AI_TEST_REASONING_EFFORT', '');
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://langfuse.example');
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'synthetic-public');
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'synthetic-secret');
    let exportedPayload: { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{
      traceId: string; spanId: string; parentSpanId?: string; startTimeUnixNano: string; endTimeUnixNano: string;
      attributes: Array<{ key: string; value: { stringValue: string } }>;
    }> }> }> } | undefined;
    const fetchImpl = vi.fn(async (url: unknown, init: RequestInit) => {
      if (String(url).startsWith('https://langfuse.example')) {
        exportedPayload = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ partialSuccess: { rejectedSpans: String(rejected) } }), { status: 200 });
      }
      const body = JSON.parse(String(init.body)) as { tools?: Array<{ function: { name: string } }> };
      const structured = body.tools?.some(tool => tool.function.name === 'structured_output');
      return new Response(JSON.stringify({ usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }, choices: [{ finish_reason: structured ? 'tool_calls' : 'stop', message: structured ? {
        content: null, tool_calls: [{ id: 'synthetic-entry', type: 'function', function: {
          name: 'structured_output', arguments: JSON.stringify({ entry: 'discovery', targetColumns: null }),
        } }],
      } : { content: 'Synthetic offline answer.' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main('ai', ['--prompt', 'Summarize loaded objects', '--followup', 'Summarize again', '--timeout-ms', '10000', ...(exportEnabled ? ['--langfuse'] : []), ...(verbose ? ['--trace-verbose'] : [])]);
    expect(code).toBe(rejected ? 2 : 0);
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    const report = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));
    expect(report).toMatchObject({ runtime: 'ok', export: exportEnabled ? (rejected ? 'error' : 'ok') : 'disabled', provider: 'openai-compatible' });
    expect(report.turns).toHaveLength(2);
    if (!exportEnabled) {
      expect(exportedPayload).toBeUndefined();
      return;
    }
    const spans = exportedPayload!.resourceSpans[0].scopeSpans[0].spans;
    expect(report.exportedSpans).toBe(spans.length - rejected);
    const roots = spans.filter(span => !span.parentSpanId);
    const generations = spans.filter(span => span.parentSpanId);
    expect(roots).toHaveLength(2);
    expect(new Set(roots.map(span => span.traceId)).size).toBe(2);
    expect(generations.length).toBeGreaterThanOrEqual(2);
    for (const root of roots) {
      const children = generations.filter(span => span.parentSpanId === root.spanId);
      expect(children.length).toBeGreaterThan(0);
      for (const child of children) {
        expect(child.traceId).toBe(root.traceId);
        expect(BigInt(child.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(child.startTimeUnixNano));
        expect(child.attributes).toContainEqual(expect.objectContaining({ key: 'langfuse.observation.usage_details' }));
        expect(child.attributes.some(attr => attr.key === 'langfuse.observation.input')).toBe(verbose);
        expect(child.attributes.some(attr => attr.key === 'langfuse.observation.output')).toBe(verbose);
      }
    }
    const traceDir = join(report.artifacts as string, 'lm-trace');
    const traceFile = readdirSync(traceDir).find(name => name.endsWith('.ndjson'))!;
    const run = parseTrace(readFileSync(join(traceDir, traceFile), 'utf8'));
    expect(run.generations.every(entry => entry.requestId !== 'unknown')).toBe(true);
  });
  it('fails explicit missing-service configuration instead of self-skipping', async () => {
    vi.stubEnv('DB_TEST_SERVER', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main('db', [])).toBe(4);
    expect(vi.mocked(console.error).mock.calls[0]?.[0]).toContain('DB_TEST_SERVER');
  });
});


it('exports retried request fingerprints as separate trees with their own wire evidence', async () => {
  const rows: Record<string, unknown>[] = [];
  for (const [requestId, fingerprint, answer] of [['same', 'first', 'first answer'], ['other', 'other-run', 'other answer'], ['same', 'second', 'second answer']]) {
    const at = '2026-01-01T00:00:00.010Z';
    rows.push({ at, type: 'turn-start', requestId, runFingerprint: fingerprint },
      { at, type: 'wire-request', requestId, generation: 1, system: fingerprint, messages: [] },
      { at, type: 'wire-response', requestId, generation: 1, text: answer, toolCalls: [] },
      { at, type: 'generation', requestId, generation: 1, latencyMs: 1, modelId: fingerprint },
      { at, type: 'turn-terminal', requestId, runFingerprint: fingerprint, status: 'ok' });
  }
  type ExportSpan = { traceId: string; spanId: string; parentSpanId?: string;
    attributes: Array<{ key: string; value: { stringValue: string } }> };
  let payload: { resourceSpans: Array<{ scopeSpans: Array<{ spans: ExportSpan[] }> }> } | undefined;
  await exportRunToLangfuse(parseTrace(rows.map(row => JSON.stringify(row)).join('\n') + '\n'), {
    baseUrl: 'https://synthetic.invalid', publicKey: 'synthetic', secretKey: 'synthetic',
    fetchImpl: async (_url, init) => { payload = JSON.parse(String(init?.body)); return new Response('{}'); },
  });
  const spans = payload!.resourceSpans[0].scopeSpans[0].spans;
  const roots = spans.filter((span: ExportSpan) => !span.parentSpanId);
  expect(roots).toHaveLength(3);
  expect(new Set(roots.map((span: ExportSpan) => span.traceId)).size).toBe(3);
  expect(new Set(spans.map((span: ExportSpan) => span.spanId)).size).toBe(6);
  for (const [index, root] of roots.entries()) {
    const children = spans.filter((span: ExportSpan) => span.parentSpanId === root.spanId);
    expect(children).toHaveLength(1);
    expect(children[0].traceId).toBe(root.traceId);
    const expected = ['first answer', 'other answer', 'second answer'][index];
    for (const span of [root, children[0]]) {
      expect(span.attributes.find((attr: ExportSpan["attributes"][number]) => attr.key === 'langfuse.observation.output')!.value.stringValue).toContain(expected);
    }
  }
});
