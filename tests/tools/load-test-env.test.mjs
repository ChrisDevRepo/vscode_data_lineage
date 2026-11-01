import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadTestEnv } from './load-test-env.mjs';

test('provider profiles resolve from environment and precedence', () => {
  const env = {
    AI_TEST_PROVIDER: 'azure',
    AZURE_URI: 'https://p.example/v1',
    AZURE_API: 'sec',
    AZURE_MODEL: 'm',
  };
  const id = loadTestEnv({
    env,
    envFile: join(tmpdir(), 'missing-env'),
    requireAiProvider: true,
  });
  assert.deepEqual(id, { provider: 'azure', model: 'm' });
  assert.equal(env.AI_TEST_ENDPOINT, 'https://p.example/v1');

  const dir = mkdtempSync(join(tmpdir(), 'env-test-'));
  try {
    writeFileSync(
      join(dir, '.env'),
      'AI_TEST_PROVIDER="fireworks"\nAI_TEST_MODEL=file-m\nFIREWORKS_URL=https://f.example\nFIREWORKS_API=s\nFIREWORKS_MODEL=m',
    );
    const override = { AI_TEST_MODEL: 'shell-m' };
    const res = loadTestEnv({
      env: override,
      envFile: join(dir, '.env'),
      requireAiProvider: true,
    });
    assert.equal(res.model, 'shell-m');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selected profiles reject bad input without echoing secrets', () => {
  const cases = [
    [
      {
        AI_TEST_PROVIDER: 'azure',
        AZURE_API: 'do-not-print',
        AZURE_MODEL: 'm',
      },
      /missing AI_TEST_ENDPOINT/u,
    ],
    [
      {
        AI_TEST_PROVIDER: 'openrouter',
        OPENROUTER_URL: 'not-a-url',
        OPENROUTER_API: 'do-not-print',
        OPENROUTER_MODEL: 'm',
      },
      /must be an absolute HTTP\(S\) URL/u,
    ],
    [
      { AI_TEST_PROVIDER: 'typo-provider', AI_TEST_API_KEY: 'do-not-print' },
      /Unsupported AI_TEST_PROVIDER/u,
    ],
  ];
  for (const [env, message] of cases) {
    assert.throws(
      () =>
        loadTestEnv({
          env,
          envFile: join(tmpdir(), 'missing'),
          requireAiProvider: true,
        }),
      (err) => {
        assert.match(err.message, message);
        assert.doesNotMatch(err.message, /do-not-print/u);
        return true;
      },
    );
  }
});

test('loadTestEnv keeps a configured AI test timeout', () => {
  const env = {
    AI_TEST_PROVIDER: 'openai-compatible',
    AI_TEST_ENDPOINT: 'http://loc:8000/v1',
    AI_TEST_API_KEY: 'k',
    AI_TEST_MODEL: 'm',
    AI_TEST_TIMEOUT_MS: '5000',
  };
  loadTestEnv({
    env,
    envFile: join(tmpdir(), 'missing'),
    requireAiProvider: true,
  });
  assert.equal(env.AI_TEST_TIMEOUT_MS, '5000');
});
