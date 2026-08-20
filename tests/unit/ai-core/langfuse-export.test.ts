/**
 * Regression tests for `tests/harness/langfuseExport.ts`.
 *
 * @remarks
 * `fetchImpl` is always mocked — this suite never talks to Langfuse Cloud. What it pins: the
 * request shape (endpoint, Basic-auth header, one `trace-create` plus one `generation-create` per
 * completed model call), that message content is attached only when the source trace ran
 * verbose, that an incomplete `.env`-shaped config self-skips instead of throwing, that a 207
 * partial failure is surfaced per event rather than swallowed, and — the security-relevant one —
 * that the configured secret key can never appear in a returned error string.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseTrace, type ParsedRun } from '../../harness/traceModel';
import { exportRunToLangfuse, resolveLangfuseConfig, type LangfuseConfig } from '../../harness/langfuseExport';

const FIXTURE_PATH = join(__dirname, '../../fixtures/trace/sample-trace.ndjson');
const RUN: ParsedRun = parseTrace(readFileSync(FIXTURE_PATH, 'utf8'));

const BASE_CONFIG = { baseUrl: 'https://cloud.langfuse.test', publicKey: 'pk-test-1', secretKey: 'sk-test-VERY-SECRET-1' };

function okResponse(body: unknown, status = 207): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly batch: ReadonlyArray<{ readonly type: string; readonly body: Record<string, unknown> }>;
}

function captureFetch(response: Response): { fetchImpl: typeof fetch; captured: () => CapturedRequest } {
  let captured: CapturedRequest | undefined;
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const parsedBody = JSON.parse(String(init?.body)) as { batch: CapturedRequest['batch'] };
    captured = { url: String(url), init: init ?? {}, batch: parsedBody.batch };
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, captured: () => captured! };
}

describe('resolveLangfuseConfig', () => {
  it('resolves all three variables from an env-shaped object', () => {
    expect(resolveLangfuseConfig({
      LANGFUSE_BASE_URL: 'https://cloud.langfuse.com',
      LANGFUSE_PUBLIC_KEY: 'pk-1',
      LANGFUSE_SECRET_KEY: 'sk-1',
    })).toEqual({ baseUrl: 'https://cloud.langfuse.com', publicKey: 'pk-1', secretKey: 'sk-1' });
  });

  it.each([
    ['missing base url', { LANGFUSE_PUBLIC_KEY: 'pk-1', LANGFUSE_SECRET_KEY: 'sk-1' }],
    ['missing public key', { LANGFUSE_BASE_URL: 'https://cloud.langfuse.com', LANGFUSE_SECRET_KEY: 'sk-1' }],
    ['missing secret key', { LANGFUSE_BASE_URL: 'https://cloud.langfuse.com', LANGFUSE_PUBLIC_KEY: 'pk-1' }],
    ['all empty strings', { LANGFUSE_BASE_URL: '', LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '' }],
    ['nothing set', {}],
  ])('returns null so the caller self-skips: %s', (_label, env) => {
    expect(resolveLangfuseConfig(env)).toBeNull();
  });
});

describe('exportRunToLangfuse request shape', () => {
  it('posts to {baseUrl}/api/public/ingestion with a Basic base64 Authorization header', async () => {
    const { fetchImpl, captured } = captureFetch(okResponse({ successes: [], errors: [] }));
    await exportRunToLangfuse(RUN, { ...BASE_CONFIG, fetchImpl });

    const request = captured();
    expect(request.url).toBe('https://cloud.langfuse.test/api/public/ingestion');
    const headers = request.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
    // Decode to confirm the header carries `publicKey:secretKey` — without hardcoding a real key
    // anywhere, since these are throwaway test literals, not production credentials.
    const decoded = Buffer.from(headers.authorization.replace('Basic ', ''), 'base64').toString('utf8');
    expect(decoded).toBe(`${BASE_CONFIG.publicKey}:${BASE_CONFIG.secretKey}`);
    expect(headers['content-type']).toBe('application/json');
  });

  it('trims a trailing slash on baseUrl rather than double-slashing the path', async () => {
    const { fetchImpl, captured } = captureFetch(okResponse({ successes: [], errors: [] }));
    await exportRunToLangfuse(RUN, { ...BASE_CONFIG, baseUrl: 'https://cloud.langfuse.test/', fetchImpl });
    expect(captured().url).toBe('https://cloud.langfuse.test/api/public/ingestion');
  });

  it('sends one trace-create per joined turn and one generation-create per completed model call', async () => {
    const { fetchImpl, captured } = captureFetch(okResponse({ successes: [], errors: [] }));
    await exportRunToLangfuse(RUN, { ...BASE_CONFIG, fetchImpl });

    const batch = captured().batch;
    // Fixture: req-a (2 generations), req-b (errored before any generation), req-c (orphan start,
    // no generation) — 3 turns, 2 completed model calls total.
    expect(batch.filter((event) => event.type === 'trace-create')).toHaveLength(3);
    const generationEvents = batch.filter((event) => event.type === 'generation-create');
    expect(generationEvents).toHaveLength(2);
    expect(generationEvents.map((event) => event.body.id).sort()).toEqual(['req-a-gen-1', 'req-a-gen-2']);
  });

  it('never calls fetch for a run with no turns', async () => {
    const { fetchImpl } = captureFetch(okResponse({ successes: [], errors: [] }));
    const empty = parseTrace('');
    const result = await exportRunToLangfuse(empty, { ...BASE_CONFIG, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ exported: 0, errors: [] });
  });

  it('carries lane/promptId run metadata onto every trace, and per-generation finishReason/phase/usage onto its observation', async () => {
    const { fetchImpl, captured } = captureFetch(okResponse({ successes: [], errors: [] }));
    await exportRunToLangfuse(RUN, {
      ...BASE_CONFIG, fetchImpl, runMetadata: { lane: 'openrouter', promptId: 'P2' },
    });

    const traceForA = captured().batch.find(
      (event) => event.type === 'trace-create' && event.body.id === 'req-a',
    )!;
    expect(traceForA.body).toMatchObject({
      name: 'openrouter/P2',
      metadata: { lane: 'openrouter', modelId: 'deepseek/deepseek-chat', outcome: 'ok', modelCalls: 2 },
    });

    const generationTwo = captured().batch.find(
      (event) => event.type === 'generation-create' && event.body.id === 'req-a-gen-2',
    )!;
    expect(generationTwo.body).toMatchObject({
      traceId: 'req-a',
      model: 'deepseek/deepseek-chat',
      usage: { input: 530, output: 58, total: 588, unit: 'TOKENS' },
      metadata: { finishReason: 'stop', phase: 'synthesis' },
    });
  });
});

describe('verbose-only content inclusion', () => {
  it('omits input/output on the non-verbose generation (req-a-gen-1: systemHash only, no system field)', async () => {
    const { fetchImpl, captured } = captureFetch(okResponse({ successes: [], errors: [] }));
    await exportRunToLangfuse(RUN, { ...BASE_CONFIG, fetchImpl });

    const quiet = captured().batch.find(
      (event) => event.type === 'generation-create' && event.body.id === 'req-a-gen-1',
    )!;
    expect(quiet.body.input).toBeUndefined();
    expect(quiet.body.output).toBeUndefined();
  });

  it('attaches verbatim system/messages and response text on the verbose generation (req-a-gen-2)', async () => {
    const { fetchImpl, captured } = captureFetch(okResponse({ successes: [], errors: [] }));
    await exportRunToLangfuse(RUN, { ...BASE_CONFIG, fetchImpl });

    const verbose = captured().batch.find(
      (event) => event.type === 'generation-create' && event.body.id === 'req-a-gen-2',
    )!;
    expect(verbose.body.input).toMatchObject({ system: 'You are the lineage analyst.' });
    expect(verbose.body.output).toMatchObject({ text: 'Orders traces to dbo.SalesLine.' });
  });
});

describe('ingestion response handling', () => {
  it('reports the successes count and one error line per rejected event on a 207', async () => {
    const { fetchImpl } = captureFetch(okResponse({
      successes: [{ id: 'a', status: 200 }, { id: 'b', status: 200 }],
      errors: [{ id: 'c', status: 400, message: 'invalid body' }],
    }, 207));

    const result = await exportRunToLangfuse(RUN, { ...BASE_CONFIG, fetchImpl });
    expect(result.exported).toBe(2);
    expect(result.errors).toEqual(['id=c status=400: invalid body']);
  });

  it('reports a transport-level failure as one error without throwing', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const result = await exportRunToLangfuse(RUN, { ...BASE_CONFIG, fetchImpl });
    expect(result.exported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('ECONNRESET');
  });

  it('surfaces a non-207 non-2xx status as a single batch-level error', async () => {
    const { fetchImpl } = captureFetch(okResponse({ message: 'unauthorized' }, 401));
    const result = await exportRunToLangfuse(RUN, { ...BASE_CONFIG, fetchImpl });
    expect(result.exported).toBe(0);
    expect(result.errors[0]).toContain('401');
  });
});

describe('secret containment', () => {
  it('never lets the configured secret key appear in a returned error string', async () => {
    const secretKey = 'sk-super-secret-marker-9f8e7d';
    const fetchImpl = vi.fn(async () => {
      // A network layer that quotes the failing request back verbatim — the worst case this
      // guard exists for, since the secret only ever reaches the wire inside this header value.
      throw new Error(`connect ECONNREFUSED — request had authorization: Basic ${secretKey}`);
    }) as unknown as typeof fetch;

    const result = await exportRunToLangfuse(RUN, { ...BASE_CONFIG, secretKey, fetchImpl });
    const joined = result.errors.join(' | ');
    expect(joined).not.toContain(secretKey);
    expect(joined).toContain('[redacted]');
  });

  it('redacts the secret out of a 207 error message that happens to contain it', async () => {
    const secretKey = 'sk-echoed-in-error-message';
    const { fetchImpl } = captureFetch(okResponse({
      successes: [],
      errors: [{ id: 'x', status: 400, message: `bad request, key was ${secretKey}` }],
    }, 207));

    const result = await exportRunToLangfuse(RUN, { ...BASE_CONFIG, secretKey, fetchImpl });
    expect(result.errors[0]).not.toContain(secretKey);
    expect(result.errors[0]).toContain('[redacted]');
  });
});

// Type-level sanity: the config object literal shape the harness plan pins.
void ((): LangfuseConfig => ({ baseUrl: 'x', publicKey: 'x', secretKey: 'x' }));
