// Verifies optional test env loading, provider aliases, precedence, and validation.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadTestEnv } from './load-test-env.mjs';

test('every provider profile resolves from the supplied environment when .env is absent', () => {
  const profiles = [
    ['azure', 'AZURE_URI', 'AZURE_API', 'AZURE_MODEL'],
    ['fireworks', 'FIREWORKS_URL', 'FIREWORKS_API', 'FIREWORKS_MODEL'],
    ['openrouter', 'OPENROUTER_URL', 'OPENROUTER_API', 'OPENROUTER_MODEL'],
    [
      'openai-compatible',
      'AI_TEST_OPENAI_COMPATIBLE_ENDPOINT',
      'AI_TEST_OPENAI_COMPATIBLE_API_KEY',
      'AI_TEST_OPENAI_COMPATIBLE_MODEL',
    ],
  ];

  for (const [provider, endpointKey, apiKey, modelKey] of profiles) {
    const env = {
      AI_TEST_PROVIDER: provider,
      [endpointKey]: 'https://provider.example/v1',
      [apiKey]: 'secret',
      [modelKey]: `${provider}-model`,
    };
    const identity = loadTestEnv({
      env,
      envFile: join(tmpdir(), 'missing-lineage-env'),
      requireAiProvider: true,
    });

    assert.deepEqual(identity, { provider, model: `${provider}-model` });
    assert.equal(env.AI_TEST_ENDPOINT, 'https://provider.example/v1');
    assert.equal(env.AI_TEST_API_KEY, 'secret');
    assert.equal(env.AI_TEST_MODEL, `${provider}-model`);
  }
});

test('non-empty environment values win over .env and provider aliases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lineage-env-'));
  const envFile = join(directory, '.env');
  writeFileSync(envFile, [
    'AI_TEST_PROVIDER=fireworks',
    'AI_TEST_ENDPOINT=https://file.example/v1',
    'AI_TEST_API_KEY=file-secret',
    'AI_TEST_MODEL=file-model',
    'FIREWORKS_URL=https://profile.example/v1',
    'FIREWORKS_API=profile-secret',
    'FIREWORKS_MODEL=profile-model',
  ].join('\n'));
  const env = {
    AI_TEST_ENDPOINT: 'https://shell.example/v1',
    AI_TEST_API_KEY: 'shell-secret',
    AI_TEST_MODEL: 'shell-model',
  };

  try {
    const identity = loadTestEnv({ env, envFile, requireAiProvider: true });
    assert.deepEqual(identity, { provider: 'fireworks', model: 'shell-model' });
    assert.equal(env.AI_TEST_ENDPOINT, 'https://shell.example/v1');
    assert.equal(env.AI_TEST_API_KEY, 'shell-secret');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('selected profiles reject missing values and invalid endpoints without exposing secrets', () => {
  assert.throws(
    () => loadTestEnv({
      env: { AI_TEST_PROVIDER: 'azure', AZURE_API: 'do-not-print', AZURE_MODEL: 'deployment' },
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
      env: {
        AI_TEST_PROVIDER: 'openrouter',
        OPENROUTER_URL: 'not-a-url',
        OPENROUTER_API: 'do-not-print',
        OPENROUTER_MODEL: 'model',
      },
      envFile: join(tmpdir(), 'missing-lineage-env'),
      requireAiProvider: true,
    }),
    /must be an absolute HTTP\(S\) URL/u,
  );

  assert.throws(
    () => loadTestEnv({
      env: { AI_TEST_PROVIDER: 'typo-provider' },
      envFile: join(tmpdir(), 'missing-lineage-env'),
      requireAiProvider: true,
    }),
    /Unsupported AI_TEST_PROVIDER/u,
  );
});
