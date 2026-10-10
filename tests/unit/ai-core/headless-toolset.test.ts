/** Optional runner configuration, provider failures/cancellation, trace parsing and explicit export boundaries. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { databaseConfig, main, parseOptions } from '../../harness/cli';
import { OpenAiCompatiblePort, type FetchLike } from '../../harness/openAiCompatiblePort';
import { parseTrace, serializeRun } from '../../harness/traceModel';
import { exportRunToLangfuse, type LangfuseAttachments } from '../../harness/langfuseExport';
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
  it('defaults to a 30-minute AI deadline and a five-minute database deadline', () => {
    expect(parseOptions('ai', []).timeoutMs).toBe(1_800_000);
    expect(parseOptions('db', []).timeoutMs).toBe(300_000);
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


describe('Langfuse export of tool outcomes and run identity', () => {
  const tool = (seq: number, at: string, extra: Record<string, unknown>) => ({
    at, type: 'tool', requestId: 'synthetic', runFingerprint: 'run', seq, phase: 'active', durationMs: 5, ...extra,
  });
  const trace = [
    { at: '2026-01-01T00:00:00.000Z', type: 'turn-start', requestId: 'synthetic', runFingerprint: 'run', sessionFingerprint: 'session', modelFingerprint: 'model' },
    tool(1, '2026-01-01T00:00:00.100Z', { toolName: 'lineage_search_objects', status: 'accepted' }),
    tool(2, '2026-01-01T00:00:00.200Z', { toolName: 'lineage_start_exploration', status: 'rejected', rejectionCode: 'unknown_columns', issuePaths: ['targetColumns.0'] }),
    tool(3, '2026-01-01T00:00:00.300Z', { toolName: 'lineage_start_exploration', status: 'gate' }),
    tool(4, '2026-01-01T00:00:00.400Z', { toolName: 'lineage_submit_findings', status: 'dispatch_error' }),
    tool(5, '2026-01-01T00:00:00.500Z', { toolName: 'lineage_start_exploration', status: 'refused', rejectionCode: 'over_active_scope_budget' }),
    tool(6, '2026-01-01T00:00:00.500Z', { toolName: 'lineage_start_exploration', status: 'not_evaluated', rejectionCode: 'phase_closed' }),
    { at: '2026-01-01T00:00:01.000Z', type: 'turn-terminal', requestId: 'synthetic', runFingerprint: 'run', status: 'ok', modelCalls: 2, durationMs: 1000 },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';

  const exportBody = async (runMetadata?: { lane?: string; promptId?: string; sessionId?: string; tags?: string[] }) => {
    let body = '';
    const fetchImpl = async (_url: unknown, init?: RequestInit) => {
      body = String(init?.body);
      return new Response('{}', { status: 200 });
    };
    const result = await exportRunToLangfuse(parseTrace(trace), {
      baseUrl: 'https://langfuse.example', publicKey: 'synthetic-public', secretKey: 'synthetic-secret',
      fetchImpl: fetchImpl as typeof fetch, runMetadata,
    });
    const spans = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans as Array<{ name: string; attributes: Array<{ key: string; value: Record<string, unknown> }>; status: { code: number } }>;
    const attr = (span: (typeof spans)[number], key: string) => span.attributes.find(entry => entry.key === key)?.value;
    return { result, spans, attr };
  };

  it('exports each tool call as a tool observation whose level reflects the outcome', async () => {
    const { result, spans, attr } = await exportBody();
    const tools = spans.filter(span => span.name.startsWith('tool:'));
    expect(tools).toHaveLength(6);
    expect(result.exported).toBe(7);
    const levels = tools.map(span => attr(span, 'langfuse.observation.level')?.stringValue);
    expect(levels).toEqual(['DEFAULT', 'WARNING', 'DEFAULT', 'ERROR', 'DEFAULT', 'DEFAULT']);
    expect(attr(tools[1], 'langfuse.observation.metadata.rejectionCode')?.stringValue).toBe('unknown_columns');
    expect(attr(tools[1], 'langfuse.observation.metadata.issuePaths')?.stringValue).toBe('targetColumns.0');
    expect(attr(tools[2], 'langfuse.observation.metadata.status')?.stringValue).toBe('gate');
    expect(tools[3].status.code).toBe(2);
  });

  it('counts rejections, gates and dispatch errors separately on the trace', async () => {
    const { spans, attr } = await exportBody();
    const root = spans.find(span => !span.name.startsWith('tool:'))!;
    expect(attr(root, 'langfuse.trace.metadata.toolCalls')?.stringValue).toBe('6');
    expect(attr(root, 'langfuse.trace.metadata.rejections')?.stringValue).toBe('1');
    expect(attr(root, 'langfuse.trace.metadata.gates')?.stringValue).toBe('1');
    expect(attr(root, 'langfuse.trace.metadata.refusals')?.stringValue).toBe('1');
    expect(attr(root, 'langfuse.trace.metadata.notEvaluated')?.stringValue).toBe('1');
    expect(attr(root, 'langfuse.trace.metadata.dispatchErrors')?.stringValue).toBe('1');
    expect(JSON.parse(String(attr(root, 'langfuse.trace.metadata.rejectionCodes')?.stringValue))).toEqual({ unknown_columns: 1 });
  });

  it('carries the session id, tags and label, and omits them when not given', async () => {
    const withIdentity = await exportBody({ lane: 'synthetic-lane', promptId: 'Q1', sessionId: 'eval-1', tags: ['arm:candidate', 'commit:abc'] });
    const root = withIdentity.spans.find(span => !span.name.startsWith('tool:'))!;
    expect(root.name).toBe('synthetic-lane/Q1');
    expect(withIdentity.attr(root, 'langfuse.session.id')?.stringValue).toBe('eval-1');
    expect(withIdentity.attr(root, 'langfuse.trace.tags')).toEqual({ arrayValue: { values: [{ stringValue: 'arm:candidate' }, { stringValue: 'commit:abc' }] } });
    const without = await exportBody();
    const bare = without.spans.find(span => !span.name.startsWith('tool:'))!;
    expect(without.attr(bare, 'langfuse.session.id')).toBeUndefined();
    expect(without.attr(bare, 'langfuse.trace.tags')).toBeUndefined();
  });

  it('never exports tool arguments or results', async () => {
    const { spans } = await exportBody();
    expect(JSON.stringify(spans.filter(span => span.name.startsWith('tool:')))).not.toMatch(/"input"|"output"|arguments|result/);
  });
});

describe('Langfuse export of a failed run', () => {
  const trace = [
    { at: '2026-01-01T00:00:00.000Z', type: 'turn-start', requestId: 'failed', runFingerprint: 'run', sessionFingerprint: 'session', modelFingerprint: 'model' },
    { at: '2026-01-01T00:00:00.100Z', type: 'wire-request', requestId: 'failed', generation: 1, phase: 'discovery', system: 'synthetic system', messages: [{ role: 'user', content: 'synthetic question' }] },
    { at: '2026-01-01T00:00:00.200Z', type: 'wire-error', requestId: 'failed', generation: 1, phase: 'discovery', diagnostic: { phase: 'discovery', name: 'Error', message: 'HTTP 412', code: 'HTTP_412' } },
    { at: '2026-01-01T00:00:00.300Z', type: 'turn-terminal', requestId: 'failed', runFingerprint: 'run', status: 'error', reason: 'provider_error', modelCalls: 1, durationMs: 300 },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';

  it('gives the root span the failed request as input and the provider failure as output', async () => {
    let body = '';
    const fetchImpl = async (_url: unknown, init?: RequestInit) => { body = String(init?.body); return new Response('{}', { status: 200 }); };
    await exportRunToLangfuse(parseTrace(trace), {
      baseUrl: 'https://langfuse.example', publicKey: 'synthetic-public', secretKey: 'synthetic-secret', fetchImpl: fetchImpl as typeof fetch,
    });
    const spans = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans as Array<{ parentSpanId?: string; attributes: Array<{ key: string; value: { stringValue?: string } }>; status: { code: number; message?: string } }>;
    const root = spans.find(span => span.parentSpanId === undefined)!;
    const attr = (key: string) => root.attributes.find(entry => entry.key === key)?.value.stringValue;
    expect(attr('langfuse.observation.input')).toContain('synthetic question');
    expect(attr('langfuse.observation.output')).toContain('HTTP_412');
    expect(root.status).toEqual({ code: 2, message: 'provider_error' });
  });
});

describe('Langfuse evidence attachments', () => {
  interface Call { url: string; method: string; headers: Record<string, string>; body: string }
  const harness = (options: { mediaStatus?: number; uploadStatus?: number; alreadyStored?: boolean } = {}) => {
    const calls: Call[] = [];
    const fetchImpl = async (url: unknown, init?: RequestInit) => {
      const call = { url: String(url), method: String(init?.method), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : init?.body) };
      calls.push(call);
      if (call.url.endsWith('/api/public/media') && call.method === 'POST') {
        return options.mediaStatus && options.mediaStatus !== 200
          ? new Response('{}', { status: options.mediaStatus })
          : new Response(JSON.stringify({ mediaId: `media-${calls.length}`, uploadUrl: options.alreadyStored ? null : 'https://media.example/upload' }), { status: 200 });
      }
      if (call.url === 'https://media.example/upload') return new Response('', { status: options.uploadStatus ?? 200 });
      return new Response('{}', { status: 200 });
    };
    return { calls, fetchImpl: fetchImpl as typeof fetch };
  };
  const config = (fetchImpl: typeof fetch, attachments: LangfuseAttachments) => ({
    baseUrl: 'https://langfuse.example', publicKey: 'synthetic-public', secretKey: 'synthetic-secret', fetchImpl, attachments,
  });
  const files: LangfuseAttachments = {
    run: [{ name: 'debug-log', contentType: 'text/plain', content: 'line with synthetic-key-123 and more' }],
    turns: [[{ name: 'answer', contentType: 'text/markdown', content: '# Answer' }]],
    redact: ['synthetic-key-123'],
  };
  const otlpRoot = (calls: Call[]) => {
    const post = calls.find(call => call.url.endsWith('/api/public/otel/v1/traces'))!;
    const spans = JSON.parse(post.body).resourceSpans[0].scopeSpans[0].spans as Array<{ attributes: Array<{ key: string; value: { stringValue?: string } }> }>;
    return JSON.parse(spans[0].attributes.find(entry => entry.key === 'langfuse.trace.metadata.attachments')!.value.stringValue!) as Record<string, string>;
  };

  it('uploads run and turn files, confirms them, and references them from the trace metadata', async () => {
    const { calls, fetchImpl } = harness();
    const result = await exportRunToLangfuse(parseTrace(syntheticTrace), config(fetchImpl, files));
    expect(result.errors).toEqual([]);
    const requests = calls.filter(call => call.url.endsWith('/api/public/media') && call.method === 'POST').map(call => JSON.parse(call.body));
    expect(requests).toEqual([
      expect.objectContaining({ field: 'metadata', contentType: 'text/plain', contentLength: 'line with [redacted] and more'.length }),
      expect.objectContaining({ field: 'metadata', contentType: 'text/markdown', contentLength: '# Answer'.length }),
    ]);
    expect(calls.filter(call => call.method === 'PUT').every(call => call.headers['x-amz-checksum-sha256']?.length === 44)).toBe(true);
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(2);
    const tokens = otlpRoot(calls);
    expect(Object.keys(tokens)).toEqual(['debug-log', 'answer']);
    expect(tokens.answer).toMatch(/^@@@langfuseMedia:type=text\/markdown\|id=media-\d+\|source=bytes@@@$/);
  });

  it('removes configured secrets before the file is hashed or uploaded', async () => {
    const { calls, fetchImpl } = harness();
    await exportRunToLangfuse(parseTrace(syntheticTrace), config(fetchImpl, files));
    const uploaded = calls.filter(call => call.method === 'PUT').map(call => call.body).join('');
    expect(uploaded).toContain('line with [redacted] and more');
    expect(JSON.stringify(calls)).not.toContain('synthetic-key-123');
  });

  it('references a file the backend already stores without uploading it again', async () => {
    const { calls, fetchImpl } = harness({ alreadyStored: true });
    await exportRunToLangfuse(parseTrace(syntheticTrace), config(fetchImpl, files));
    expect(calls.some(call => call.method === 'PUT')).toBe(false);
    expect(Object.keys(otlpRoot(calls))).toEqual(['debug-log', 'answer']);
  });

  it.each([{ mediaStatus: 500 }, { uploadStatus: 403 }])('reports a failed upload %j and still exports the spans', async failure => {
    const { calls, fetchImpl } = harness(failure);
    const result = await exportRunToLangfuse(parseTrace(syntheticTrace), config(fetchImpl, files));
    expect(result.errors.join(' ')).toMatch(/Attachment (debug-log|answer) not stored/);
    expect(calls.some(call => call.url.endsWith('/api/public/otel/v1/traces'))).toBe(true);
  });

  it('skips a file above the size limit instead of truncating it', async () => {
    const { calls, fetchImpl } = harness();
    const big: LangfuseAttachments = { run: [{ name: 'event-trace', contentType: 'text/plain', content: 'x'.repeat(50 * 1024 * 1024 + 1) }] };
    const result = await exportRunToLangfuse(parseTrace(syntheticTrace), config(fetchImpl, big));
    expect(result.errors.join(' ')).toContain('skipped');
    expect(calls.some(call => call.url.endsWith('/api/public/media'))).toBe(false);
  });

  it('makes no media request unless attachments are supplied', async () => {
    const { calls, fetchImpl } = harness();
    await exportRunToLangfuse(parseTrace(syntheticTrace), { baseUrl: 'https://langfuse.example', publicKey: 'synthetic-public', secretKey: 'synthetic-secret', fetchImpl });
    expect(calls.some(call => call.url.includes('/api/public/media'))).toBe(false);
  });

  it('requires --langfuse for --attach', () => {
    expect(parseOptions('ai', ['--langfuse', '--attach'])).toMatchObject({ attach: true });
    expect(() => parseOptions('ai', ['--attach'])).toThrow(/--langfuse/);
    expect(() => parseOptions('db', ['--attach'])).toThrow();
  });
});

describe('run identity options', () => {
  it('accepts a label, a session and repeated tags on the AI runner only', () => {
    expect(parseOptions('ai', ['--label', 'Q1', '--session', 'eval-1', '--tag', 'a', '--tag', 'b']))
      .toMatchObject({ label: 'Q1', session: 'eval-1', tags: ['a', 'b'] });
    expect(() => parseOptions('db', ['--label', 'Q1'])).toThrow();
  });
  it.each([['--label', ''], ['--tag'], ['--session', 'x'.repeat(191)]])('rejects invalid identity option %j', (...args) => {
    expect(() => parseOptions('ai', args)).toThrow();
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
  it('traces the exact URL and body it sends, reasoning effort included', async () => {
    vi.stubEnv('AI_TEST_PROVIDER', 'openai-compatible');
    vi.stubEnv('AI_TEST_ENDPOINT', 'https://provider.example/v1/chat/completions');
    vi.stubEnv('AI_TEST_API_KEY', 'synthetic-secret');
    vi.stubEnv('AI_TEST_MODEL', 'synthetic-model');
    vi.stubEnv('AI_TEST_REASONING_EFFORT', 'low');
    const sent: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { tools?: Array<{ function: { name: string } }> };
      sent.push({ url: String(url), body });
      const structured = body.tools?.some(tool => tool.function.name === 'structured_output');
      return new Response(JSON.stringify({ choices: [{ finish_reason: structured ? 'tool_calls' : 'stop', message: structured ? {
        content: null, tool_calls: [{ id: 'synthetic-entry', type: 'function', function: {
          name: 'structured_output', arguments: JSON.stringify({ entry: 'discovery', targetColumns: null }),
        } }],
      } : { content: 'Synthetic offline answer.' } }] }), { status: 200 });
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main('ai', ['--prompt', 'Summarize loaded objects', '--timeout-ms', '10000', '--trace-verbose'])).toBe(0);
    const report = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));
    const traceDir = join(report.artifacts as string, 'lm-trace');
    const traced = readFileSync(join(traceDir, readdirSync(traceDir).find(name => name.endsWith('.ndjson'))!), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; direction?: string; url?: string; body?: unknown })
      .filter(record => record.type === 'provider-raw' && record.direction === 'request');
    expect(sent.length).toBeGreaterThan(0);
    expect(traced.map(record => ({ url: record.url, body: record.body }))).toEqual(sent);
    expect(sent.every(request => request.url === 'https://provider.example/v1/chat/completions')).toBe(true);
    expect(sent.every(request => (request.body as { reasoning_effort?: string }).reasoning_effort === 'low')).toBe(true);
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
