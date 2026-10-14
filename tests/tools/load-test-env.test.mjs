// Verifies optional test env loading, provider aliases, precedence, and validation.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadTestEnv } from './load-test-env.mjs';
import * as badgeReplay from './chat-ui-replay-trace.mjs';

test('badge setup can explicitly use fresh analysis without accepting invalid settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'dlv-badge-setup-'));
  try {
    for (const setting of [undefined, '', '0']) {
      assert.throws(() => badgeReplay.badgeReplayTrace(root, setting), /Badge acceptance needs/);
    }
    assert.equal(badgeReplay.badgeReplayTrace(root, '1'), undefined);
    for (const setting of ['true', '2']) {
      assert.throws(() => badgeReplay.badgeReplayTrace(root, setting), /DLV_CHAT_UI_BADGE_LIVE must/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test('native control waits report new provider failures and ignore prior chat failures', () => {
  const errors = [{ requestIndex: 1, message: 'AI provider returned HTTP 402' }];
  assert.doesNotThrow(() => badgeReplay.assertUiProviderHealthy(errors, 1));
  errors.push({ requestIndex: 3, message: 'AI provider request timed out after 300 seconds.' });
  assert.throws(() => badgeReplay.assertUiProviderHealthy(errors, 1), /request 3: AI provider request timed out after 300 seconds/);
  assert.throws(() => badgeReplay.assertUiProviderHealthy(errors, 0), /request 1: AI provider returned HTTP 402/);
});

test('native AI budgets allow slow local models and reject invalid timer values', () => {
  const base = { AI_TEST_PROVIDER: 'openai-compatible', AI_TEST_ENDPOINT: 'http://localhost:8000/v1', AI_TEST_API_KEY: 'placeholder', AI_TEST_MODEL: 'local' };
  for (const [settings, expected] of [
    [{}, ['7200000', '7200000']],
    [{ AI_TEST_TIMEOUT_MS: '28800000' }, ['28800000', '28800000']],
    [{ AI_TEST_TIMEOUT_MS: '28800000', AI_TEST_REQUEST_TIMEOUT_MS: '10800000' }, ['28800000', '10800000']],
  ]) {
    const env = { ...base, ...settings };
    loadTestEnv({ env, envFile: join(tmpdir(), 'missing-lineage-env'), requireAiProvider: true });
    assert.deepEqual([env.AI_TEST_TIMEOUT_MS, env.AI_TEST_REQUEST_TIMEOUT_MS], expected);
  }
  for (const key of ['AI_TEST_TIMEOUT_MS', 'AI_TEST_REQUEST_TIMEOUT_MS']) {
    for (const value of ['0', '-1', 'NaN', '1.5', '2147423648']) {
      assert.throws(() => loadTestEnv({ env: { ...base, [key]: value }, envFile: join(tmpdir(), 'missing-lineage-env'), requireAiProvider: true }), { name: 'ZodError' });
    }
  }
});
