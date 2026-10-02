/** Optional runner configuration, provider failures/cancellation, trace parsing and explicit export boundaries. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { databaseConfig, main, parseOptions } from '../../harness/cli';
import { OpenAiCompatiblePort, type FetchLike } from '../../harness/openAiCompatiblePort';
import { parseTrace, serializeRun } from '../../harness/traceModel';
import { exportRunToLangfuse } from '../../harness/langfuseExport';
import { modelUserMessage } from '../../../src/ai/model/modelPort';
import { DEFAULT_TURN_TOKEN_BUDGET } from '../../../src/ai/support/tokenBudget';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

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
  it('runs the demo and ordered follow-ups through the production runtime with synthetic HTTP responses', async () => {
    vi.stubEnv('AI_TEST_PROVIDER', 'openai-compatible');
    vi.stubEnv('AI_TEST_ENDPOINT', 'https://provider.example/v1');
    vi.stubEnv('AI_TEST_API_KEY', 'synthetic-secret');
    vi.stubEnv('AI_TEST_MODEL', 'synthetic-model');
    vi.stubEnv('AI_TEST_REASONING_EFFORT', '');
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { tools?: Array<{ function: { name: string } }> };
      const structured = body.tools?.some(tool => tool.function.name === 'structured_output');
      return new Response(JSON.stringify({ choices: [{ finish_reason: structured ? 'tool_calls' : 'stop', message: structured ? {
        content: null, tool_calls: [{ id: 'synthetic-entry', type: 'function', function: {
          name: 'structured_output', arguments: JSON.stringify({ entry: 'discovery', targetColumns: null }),
        } }],
      } : { content: 'Synthetic offline answer.' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchImpl);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main('ai', ['--prompt', 'Summarize loaded objects', '--followup', 'Summarize again', '--timeout-ms', '10000']);
    expect(code).toBe(0);
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    const report = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));
    expect(report).toMatchObject({ runtime: 'ok', export: 'disabled', provider: 'openai-compatible' });
    expect(report.turns).toHaveLength(2);
  });
  it('fails explicit missing-service configuration instead of self-skipping', async () => {
    vi.stubEnv('DB_TEST_SERVER', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main('db', [])).toBe(4);
    expect(vi.mocked(console.error).mock.calls[0]?.[0]).toContain('DB_TEST_SERVER');
  });
});
