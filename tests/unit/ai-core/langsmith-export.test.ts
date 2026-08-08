/**
 * Regression tests for `tests/harness/langsmithExport.ts`.
 *
 * @remarks
 * `fetchImpl` is always mocked — this suite never talks to LangSmith. What it pins: the request
 * shape (endpoint, `x-api-key` header, one `chain` root run plus one `llm` child run per completed
 * model call, correct `trace_id`/`parent_run_id`/`dotted_order` nesting), that message content is
 * attached only when the source trace ran verbose while token usage is not, that an incomplete
 * `.env`-shaped config self-skips instead of throwing, that a per-turn HTTP failure is surfaced
 * without losing another turn's success, that the configured API key can never appear in a returned
 * error string, and — the containment-relevant one — that this module never imports the real
 * `langsmith` package.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseTrace, type ParsedRun } from '../../harness/traceModel';
import { exportRunToLangSmith, resolveLangSmithConfig, type LangSmithConfig } from '../../harness/langsmithExport';

const FIXTURE_PATH = join(__dirname, '../../fixtures/trace/sample-trace.ndjson');
const RUN: ParsedRun = parseTrace(readFileSync(FIXTURE_PATH, 'utf8'));

const BASE_CONFIG = { baseUrl: 'https://api.langsmith.test', apiKey: 'ls-test-VERY-SECRET-1' };

function okResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => '',
  } as Response;
}

function errorResponse(status: number, bodyText: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => bodyText,
  } as Response;
}

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly post: ReadonlyArray<Record<string, unknown>>;
}

/** Captures every call made to a queue of responses, one per call, in order. */
function captureFetch(responses: readonly Response[]): { fetchImpl: typeof fetch; calls: () => CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  let index = 0;
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const parsedBody = JSON.parse(String(init?.body)) as { post: ReadonlyArray<Record<string, unknown>> };
    calls.push({ url: String(url), init: init ?? {}, post: parsedBody.post });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe('resolveLangSmithConfig', () => {
  it('resolves apiKey and an explicit baseUrl/project from an env-shaped object', () => {
    expect(resolveLangSmithConfig({
      LANGSMITH_API_KEY: 'ls-1',
      LANGSMITH_BASE_URL: 'https://eu.api.smith.langchain.com',
      LANGSMITH_PROJECT: 'lineage-e2e',
    })).toEqual({ baseUrl: 'https://eu.api.smith.langchain.com', apiKey: 'ls-1', project: 'lineage-e2e' });
  });

  it('defaults baseUrl to the public LangSmith API host and omits project when unset', () => {
    expect(resolveLangSmithConfig({ LANGSMITH_API_KEY: 'ls-1' })).toEqual({
      baseUrl: 'https://api.smith.langchain.com',
      apiKey: 'ls-1',
    });
  });

  it.each([
    ['missing api key', {}],
    ['empty api key', { LANGSMITH_API_KEY: '' }],
  ])('returns null so the caller self-skips: %s', (_label, env) => {
    expect(resolveLangSmithConfig(env)).toBeNull();
  });
});

describe('exportRunToLangSmith request shape', () => {
  it('posts to {baseUrl}/runs/batch with an x-api-key header', async () => {
    const { fetchImpl, calls } = captureFetch([okResponse(), okResponse(), okResponse()]);
    await exportRunToLangSmith(RUN, { ...BASE_CONFIG, fetchImpl });

    const first = calls()[0];
    expect(first.url).toBe('https://api.langsmith.test/runs/batch');
    const headers = first.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(BASE_CONFIG.apiKey);
    expect(headers['content-type']).toBe('application/json');
  });

  it('trims a trailing slash on baseUrl rather than double-slashing the path', async () => {
    const { fetchImpl, calls } = captureFetch([okResponse(), okResponse(), okResponse()]);
    await exportRunToLangSmith(RUN, { ...BASE_CONFIG, baseUrl: 'https://api.langsmith.test/', fetchImpl });
    expect(calls()[0].url).toBe('https://api.langsmith.test/runs/batch');
  });

  it('sends one call per joined turn, each posting one root chain run plus its child llm runs', async () => {
    const { fetchImpl, calls } = captureFetch([okResponse(), okResponse(), okResponse()]);
    await exportRunToLangSmith(RUN, { ...BASE_CONFIG, fetchImpl });

    // Fixture: req-a (2 generations), req-b (errored before any generation), req-c (orphan start,
    // no generation) — 3 turns, one /runs/batch call each.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const postForA = calls()[0].post;
    expect(postForA).toHaveLength(3); // 1 chain root + 2 llm children
    expect(postForA.filter((run) => run.run_type === 'llm')).toHaveLength(2);
  });

  it('never calls fetch for a run with no turns', async () => {
    const { fetchImpl } = captureFetch([okResponse()]);
    const empty = parseTrace('');
    const result = await exportRunToLangSmith(empty, { ...BASE_CONFIG, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ exported: 0, errors: [] });
  });

  it('nests trace_id/parent_run_id/dotted_order correctly: children share the root trace_id and parent, and extend its dotted_order', async () => {
    const { fetchImpl, calls } = captureFetch([okResponse(), okResponse(), okResponse()]);
    await exportRunToLangSmith(RUN, { ...BASE_CONFIG, fetchImpl });

    const postForA = calls()[0].post;
    const root = postForA.find((run) => run.run_type === 'chain')!;
    const children = postForA.filter((run) => run.run_type === 'llm');
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.trace_id).toBe(root.id);
      expect(child.parent_run_id).toBe(root.id);
      expect(String(child.dotted_order)).toMatch(new RegExp(`^${String(root.dotted_order)}\\.`));
    }
    // Root's own dotted_order is a single segment (no dot) — the documented root-run constraint.
    expect(String(root.dotted_order)).not.toContain('.');
  });

  it('carries lane/promptId run metadata onto the root run, and per-generation finishReason/phase/ls_model_name onto its child', async () => {
    const { fetchImpl, calls } = captureFetch([okResponse(), okResponse(), okResponse()]);
    await exportRunToLangSmith(RUN, {
      ...BASE_CONFIG, fetchImpl, runMetadata: { lane: 'openrouter', promptId: 'P2' },
    });

    const postForA = calls()[0].post;
    const root = postForA.find((run) => run.run_type === 'chain')!;
    expect(root.name).toBe('openrouter/P2');
    expect((root.extra as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      lane: 'openrouter', modelId: 'deepseek/deepseek-chat', outcome: 'ok', modelCalls: 2,
    });

    const secondGeneration = postForA.filter((run) => run.run_type === 'llm')[1];
    expect((secondGeneration.extra as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      finishReason: 'stop', phase: 'synthesis', ls_model_name: 'deepseek/deepseek-chat',
    });
  });

  it('attaches usage_metadata to every completed generation regardless of verbosity', async () => {
    const { fetchImpl, calls } = captureFetch([okResponse(), okResponse(), okResponse()]);
    await exportRunToLangSmith(RUN, { ...BASE_CONFIG, fetchImpl });

    const postForA = calls()[0].post;
    const generations = postForA.filter((run) => run.run_type === 'llm');
    for (const generation of generations) {
      const outputs = generation.outputs as { usage_metadata?: Record<string, number> } | undefined;
      expect(outputs?.usage_metadata).toMatchObject({ input_tokens: expect.any(Number), output_tokens: expect.any(Number) });
    }
  });

  it('applies session_name from config.project to every posted run when configured', async () => {
    const { fetchImpl, calls } = captureFetch([okResponse(), okResponse(), okResponse()]);
    await exportRunToLangSmith(RUN, { ...BASE_CONFIG, project: 'lineage-e2e', fetchImpl });

    for (const run of calls()[0].post) {
      expect(run.session_name).toBe('lineage-e2e');
    }
  });
});

describe('verbose-only content inclusion', () => {
  it('omits inputs on the non-verbose generation (req-a-gen-1: systemHash only, no system field)', async () => {
    const { fetchImpl, calls } = captureFetch([okResponse(), okResponse(), okResponse()]);
    await exportRunToLangSmith(RUN, { ...BASE_CONFIG, fetchImpl });

    const postForA = calls()[0].post;
    const quiet = postForA.filter((run) => run.run_type === 'llm')[0];
    expect(quiet.inputs).toBeUndefined();
    // usage_metadata still present even though message content is not.
    expect((quiet.outputs as Record<string, unknown>).usage_metadata).toBeDefined();
  });

  it('attaches verbatim system/messages and response text on the verbose generation (req-a-gen-2)', async () => {
    const { fetchImpl, calls } = captureFetch([okResponse(), okResponse(), okResponse()]);
    await exportRunToLangSmith(RUN, { ...BASE_CONFIG, fetchImpl });

    const postForA = calls()[0].post;
    const verbose = postForA.filter((run) => run.run_type === 'llm')[1];
    expect(verbose.inputs).toMatchObject({ system: 'You are the lineage analyst.' });
    expect(verbose.outputs).toMatchObject({ text: 'Orders traces to dbo.SalesLine.' });
  });
});

describe('per-turn response handling', () => {
  it('reports the count posted for a turn whose call succeeded, and one error line for a turn whose call failed', async () => {
    // req-a succeeds (3 runs posted), req-b's call fails, req-c succeeds (1 run posted).
    const { fetchImpl } = captureFetch([okResponse(200), errorResponse(400, 'invalid run'), okResponse(200)]);
    const result = await exportRunToLangSmith(RUN, { ...BASE_CONFIG, fetchImpl });
    expect(result.exported).toBe(4); // 3 (req-a) + 1 (req-c, root-only)
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('req-b');
    expect(result.errors[0]).toContain('400');
  });

  it('reports a transport-level failure for one turn as one error, without losing other turns', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error('ECONNRESET');
      return okResponse(200);
    }) as unknown as typeof fetch;
    const result = await exportRunToLangSmith(RUN, { ...BASE_CONFIG, fetchImpl });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('ECONNRESET');
    expect(result.exported).toBe(4); // req-a (3) + req-c (1); req-b's call is the failing one
  });
});

describe('secret containment', () => {
  it('never lets the configured API key appear in a returned error string', async () => {
    const apiKey = 'ls-super-secret-marker-9f8e7d';
    const fetchImpl = vi.fn(async () => {
      // A network layer that quotes the failing request back verbatim — the worst case this
      // guard exists for, since the secret only ever reaches the wire inside this header value.
      throw new Error(`connect ECONNREFUSED — request had x-api-key: ${apiKey}`);
    }) as unknown as typeof fetch;

    const result = await exportRunToLangSmith(RUN, { ...BASE_CONFIG, apiKey, fetchImpl });
    const joined = result.errors.join(' | ');
    expect(joined).not.toContain(apiKey);
    expect(joined).toContain('[redacted]');
  });

  it('redacts the API key out of an error response body that happens to contain it', async () => {
    const apiKey = 'ls-echoed-in-error-message';
    const { fetchImpl } = captureFetch([errorResponse(401, `unauthorized, key was ${apiKey}`)]);
    const result = await exportRunToLangSmith(RUN, { ...BASE_CONFIG, apiKey, fetchImpl });
    expect(result.errors.join(' | ')).not.toContain(apiKey);
    expect(result.errors.join(' | ')).toContain('[redacted]');
  });
});

describe('LangSmith containment', () => {
  it('never imports the real langsmith package', () => {
    const source = readFileSync(join(__dirname, '../../harness/langsmithExport.ts'), 'utf8');
    // Matches a bare `from 'langsmith'` / `require('langsmith')` import — not the module's own
    // file name (`langsmithExport`) or doc-comment mentions of the package by name.
    expect(source).not.toMatch(/from\s+['"]langsmith['"]/);
    expect(source).not.toMatch(/require\(\s*['"]langsmith['"]\s*\)/);
  });

  it('loads under vitest without the langsmith package being resolvable as a dependency', async () => {
    // The module itself is the proof: if it needed `langsmith`, this import would already have
    // thrown before this test body ran (the stub in stubs/langsmith/ is inert — see AGENTS.md).
    const module = await import('../../harness/langsmithExport');
    expect(typeof module.exportRunToLangSmith).toBe('function');
    expect(typeof module.resolveLangSmithConfig).toBe('function');
  });
});

// Type-level sanity: the config object literal shape the harness plan pins.
void ((): LangSmithConfig => ({ baseUrl: 'x', apiKey: 'x' }));
