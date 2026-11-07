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

  assert.throws(
    () =>
      loadTestEnv({
        env: { AI_TEST_PROVIDER: 'azure', AZURE_MODEL: 'm' },
        envFile: join(tmpdir(), 'missing'),
        requireAiProvider: true,
      }),
    /missing AI_TEST_ENDPOINT/,
  );

  const qwenEnv = {
    AI_TEST_PROVIDER: 'Qwen',
    QWEN_URL: 'https://qwen.example/compatible-mode/v1',
    QWEN_API: 'qwen-key',
    QWEN_MODEL: 'qwen3.8-flash',
  };
  const qwenId = loadTestEnv({
    env: qwenEnv,
    envFile: join(tmpdir(), 'missing-env'),
    requireAiProvider: true,
  });
  assert.deepEqual(qwenId, { provider: 'qwen', model: 'qwen3.8-flash' });
  assert.equal(qwenEnv.AI_TEST_PROVIDER, 'qwen');
  assert.equal(
    qwenEnv.AI_TEST_ENDPOINT,
    'https://qwen.example/compatible-mode/v1',
  );
  assert.equal(qwenEnv.AI_TEST_API_KEY, 'qwen-key');
  assert.equal(qwenEnv.AI_TEST_MODEL, 'qwen3.8-flash');
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
