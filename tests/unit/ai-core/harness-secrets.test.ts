/** A configured private endpoint host and harness secrets never reach run evidence, even when a provider failure echoes them. */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harnessSecrets } from '../../harness/harnessSecrets';
import { main } from '../../harness/cli';

const HOST = 'private-gateway.invalid';
const TOKEN = 'fake-db-token';

describe('harness secrets', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('lists every set secret, however short, and the endpoint host', () => {
    expect(harnessSecrets({ DB_TEST_PASSWORD: 'pw', DB_TEST_TOKEN: TOKEN, AI_TEST_ENDPOINT: `https://${HOST}:8443/v1?api-version=1` }))
      .toEqual(['pw', TOKEN, HOST]);
    expect(harnessSecrets({ AI_TEST_ENDPOINT: 'not a url' })).toEqual([]);
  });

  it('keeps the host and token out of run.json, the trace and the logged error after a forced provider failure', async () => {
    vi.stubEnv('AI_TEST_PROVIDER', 'openai-compatible');
    vi.stubEnv('AI_TEST_MODEL', 'synthetic-model');
    vi.stubEnv('AI_TEST_API_KEY', 'fake-api-key');
    vi.stubEnv('AI_TEST_ENDPOINT', `https://${HOST}/v1`);
    vi.stubEnv('DB_TEST_TOKEN', TOKEN);
    vi.stubEnv('LANGFUSE_BASE_URL', 'https://export.example');
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'fake-public');
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'fake-secret');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
    const provider = Object.assign(async () => { throw new TypeError(`getaddrinfo ENOTFOUND ${HOST} token=${TOKEN}`); }, { close: async () => {} });
    vi.spyOn(createRequire(import.meta.url)('../../fixtures/lm-provider-extension/live-provider-adapter.js'), 'createProviderFetch').mockReturnValue(provider);
    const logged: string[] = [];
    for (const method of ['error', 'warn', 'log', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { logged.push(parts.join(' ')); });
    }
    let result: Readonly<Record<string, unknown>> | undefined;
    await main('ai', ['--prompt', 'test'], value => { result = value; });
    expect(logged.join('\n')).not.toContain('CONFIG');
    const runDir = String(result?.artifacts);
    try {
      expect(result).not.toHaveProperty('endpoint');
      const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
        .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
      const written = files(runDir);
      expect(written.some(file => file.endsWith('run.json'))).toBe(true);
      const evidence = [...written.map(file => readFileSync(file, 'utf8')), ...logged, JSON.stringify(result)].join('\n');
      expect(evidence).toContain('wire-error');
      expect(evidence).not.toContain(HOST);
      expect(evidence).not.toContain(TOKEN);
    } finally { rmSync(runDir, { recursive: true, force: true }); }
  }, 60_000);
});
