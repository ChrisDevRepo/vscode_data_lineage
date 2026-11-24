// Verifies optional test env loading and that a non-empty process value wins over `.env`.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadTestEnv } from './load-test-env.mjs';

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
    loadTestEnv({ env, envFile });
    assert.equal(env.AI_TEST_ENDPOINT, 'https://shell.example/v1');
    assert.equal(env.AI_TEST_API_KEY, 'shell-secret');
    assert.equal(env.AI_TEST_MODEL, 'shell-model');
    assert.equal(env.AI_TEST_API_TYPE, 'responses');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an absent .env leaves the supplied environment unchanged', () => {
  const env = { AI_TEST_MODEL: 'the-model' };
  loadTestEnv({ env, envFile: join(tmpdir(), 'missing-lineage-env') });
  assert.deepEqual(env, { AI_TEST_MODEL: 'the-model' });
});
