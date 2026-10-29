/** A configured private endpoint host and harness secrets never reach run evidence, even when a provider failure echoes them. */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelUserMessage } from '../../../src/ai/model/modelPort';
import { harnessSecrets } from '../../harness/harnessSecrets';
import { OpenAiCompatiblePort } from '../../harness/openAiCompatiblePort';
import { main } from '../../harness/cli';

const HOST = 'private-gateway.invalid';
const TOKEN = 'fake-db-token';

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);

/** Runs the headless harness against a fake private endpoint whose provider transport is `transport` (or fails to build when it throws on creation). */
async function runHarness(transport: () => unknown, model = 'synthetic-model') {
  vi.stubEnv('AI_TEST_PROVIDER', 'openai-compatible');
  vi.stubEnv('AI_TEST_MODEL', model);
  vi.stubEnv('AI_TEST_API_KEY', 'fake-api-key');
  vi.stubEnv('AI_TEST_ENDPOINT', `https://${HOST}/v1`);
  vi.stubEnv('DB_TEST_TOKEN', TOKEN);
  vi.stubEnv('LANGFUSE_BASE_URL', 'https://export.example');
  vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'fake-public');
  vi.stubEnv('LANGFUSE_SECRET_KEY', 'fake-secret');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
  vi.spyOn(createRequire(import.meta.url)('../../fixtures/lm-provider-extension/live-provider-adapter.js'), 'createProviderFetch')
    .mockImplementation(transport as () => never);
  const logged: string[] = [];
  for (const method of ['error', 'warn', 'log', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { logged.push(parts.join(' ')); });
  }
  let result: Readonly<Record<string, unknown>> | undefined;
  await main('ai', ['--prompt', 'test'], value => { result = value; });
  expect(logged.join('\n')).not.toContain('CONFIG');
  const runDir = String(result?.artifacts);
  const written = files(runDir).map(file => ({ file, text: readFileSync(file, 'utf8') }));
  rmSync(runDir, { recursive: true, force: true });
  return { result: result!, written, logged };
}

describe('harness secrets', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('lists every set secret, however short, and the endpoint host', () => {
    expect(harnessSecrets({ DB_TEST_PASSWORD: 'pw', DB_TEST_TOKEN: TOKEN, AI_TEST_ENDPOINT: `https://${HOST}:8443/v1?api-version=1` }))
      .toEqual(['pw', TOKEN, HOST]);
    expect(harnessSecrets({ AI_TEST_ENDPOINT: 'not a url' })).toEqual([]);
  });

  it('keeps the host and token out of run.json, the trace and the logs after a provider failure, including nested causes', async () => {
    const failure = () => {
      const cause = Object.assign(new Error(`connect ENOTFOUND ${HOST} ${TOKEN}`), { code: 'ENOTFOUND' });
      return new TypeError('fetch failed', { cause });
    };
    const { result, written, logged } = await runHarness(() => Object.assign(async () => { throw failure(); }, { close: async () => {} }));
    expect(result).not.toHaveProperty('endpoint');
    expect(written.some(({ file }) => file.endsWith('run.json'))).toBe(true);
    const evidence = [...written.map(({ text }) => text), ...logged, JSON.stringify(result)].join('\n');
    expect(evidence).toContain('wire-error');
    expect(evidence).not.toContain(HOST);
    expect(evidence).not.toContain(TOKEN);
  }, 60_000);

  it('redacts the failure log of a run that fails before any provider call', async () => {
    const { written, logged } = await runHarness(() => { throw new Error(`cannot build transport for ${HOST} ${TOKEN}`); });
    const evidence = [...written.map(({ text }) => text), ...logged].join('\n');
    expect(evidence).toContain('Smoke failed');
    expect(evidence).not.toContain(HOST);
    expect(evidence).not.toContain(TOKEN);
  }, 60_000);

  it('redacts uploaded evidence that carries a secret the run itself logged', async () => {
    const failing = () => Object.assign(async () => { throw new Error('offline'); }, { close: async () => {} });
    const { written } = await runHarness(failing, `model-${TOKEN}`);
    const frozen = written.filter(({ text }) => text.includes('"debug-log"'));
    expect(frozen).not.toHaveLength(0);
    expect(written.some(({ file, text }) => file.endsWith('host.log') && text.includes(TOKEN))).toBe(true);
    for (const { text } of frozen) expect(text).not.toContain(TOKEN);
  }, 60_000);

  it('leaves a successful reply unchanged even when a short secret occurs inside it', async () => {
    const reply = { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c1', type: 'function',
      function: { name: 'lineage_search_objects', arguments: '{"query":"Sales abc table"}' } }] } }] };
    const port = new OpenAiCompatiblePort({ baseUrl: `https://${HOST}/v1`, apiKey: 'fake-api-key', model: 'synthetic', redact: ['abc', HOST] },
      { fetchImpl: async () => new Response(JSON.stringify(reply)) });
    const result = await port.generateToolTurn({ messages: [modelUserMessage('Find.')], phase: 'discover',
      tools: [{ name: 'lineage_search_objects', description: 'Search.', inputSchema: z.object({ query: z.string() }) }] });
    expect(result.status).toBe('completed');
    expect(result.toolCalls).toMatchObject([{ input: { query: 'Sales abc table' } }]);
  });
});
