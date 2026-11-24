// Verifies optional test env loading, precedence, and validation of the AI_TEST_* model entry.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadTestEnv } from './load-test-env.mjs';

const entry = (over = {}) => ({
  AI_TEST_ENDPOINT: 'https://provider.example/v1',
  AI_TEST_API_KEY: 'secret',
  AI_TEST_MODEL: 'the-model',
  AI_TEST_API_TYPE: 'chat-completions',
  AI_TEST_MAX_INPUT_TOKENS: '100000',
  AI_TEST_MAX_OUTPUT_TOKENS: '8000',
  ...over,
});

test('the model entry resolves from the supplied environment when .env is absent', () => {
  const env = entry({ AI_TEST_MODEL: ' the-model ' });
  const identity = loadTestEnv({ env, envFile: join(tmpdir(), 'missing-lineage-env'), requireAiProvider: true });

  assert.deepEqual(identity, { model: 'the-model' });
  assert.equal(env.AI_TEST_MODEL, 'the-model');
  assert.equal(env.AI_TEST_API_KEY, 'secret');
});

test('non-empty environment values win over .env', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lineage-env-'));
  const envFile = join(directory, '.env');
  writeFileSync(envFile, [
    'AI_TEST_ENDPOINT=https://file.example/v1',
    'AI_TEST_API_KEY=file-secret',
    'AI_TEST_MODEL=file-model',
    'AI_TEST_API_TYPE=responses',
    'AI_TEST_MAX_INPUT_TOKENS=1',
    'AI_TEST_MAX_OUTPUT_TOKENS=1',
  ].join('\n'));
  const env = {
    AI_TEST_ENDPOINT: 'https://shell.example/v1',
    AI_TEST_API_KEY: 'shell-secret',
    AI_TEST_MODEL: 'shell-model',
  };

  try {
    const identity = loadTestEnv({ env, envFile, requireAiProvider: true });
    assert.deepEqual(identity, { model: 'shell-model' });
    assert.equal(env.AI_TEST_ENDPOINT, 'https://shell.example/v1');
    assert.equal(env.AI_TEST_API_KEY, 'shell-secret');
    assert.equal(env.AI_TEST_API_TYPE, 'responses');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a required entry rejects missing values and invalid endpoints without exposing secrets', () => {
  assert.throws(
    () => loadTestEnv({
      env: { AI_TEST_API_KEY: 'do-not-print', AI_TEST_MODEL: 'deployment' },
      envFile: join(tmpdir(), 'missing-lineage-env'),
      requireAiProvider: true,
    }),
    (error) => {
      assert.match(error.message, /missing AI_TEST_ENDPOINT/u);
      assert.doesNotMatch(error.message, /do-not-print/u);
      return true;
    },
  );

  assert.throws(
    () => loadTestEnv({
      env: entry({ AI_TEST_ENDPOINT: 'not-a-url', AI_TEST_API_KEY: 'do-not-print' }),
      envFile: join(tmpdir(), 'missing-lineage-env'),
      requireAiProvider: true,
    }),
    /must be an absolute HTTP\(S\) URL/u,
  );

  assert.throws(
    () => loadTestEnv({
      env: entry({ AI_TEST_ENDPOINT: 'ftp://provider.example' }),
      envFile: join(tmpdir(), 'missing-lineage-env'),
      requireAiProvider: true,
    }),
    /must use HTTP or HTTPS/u,
  );
});
