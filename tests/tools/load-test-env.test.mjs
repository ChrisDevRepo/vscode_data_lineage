// Verifies optional test env profiles and isolated GUI host helper contracts.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadTestEnv } from './load-test-env.mjs';
import * as badgeReplay from './chat-ui-replay-trace.mjs';
import {
  assertLoopbackPortAvailable,
  assertAllPassReport,
  assertMochaCompletion,
  assertDbCredentialKeys,
  assertTcpEndpointReady,
  buildLaunchArgs,
  isIsolatedWorkbenchPage,
  parseCdpPort,
  requireDbFixtureExtensionPath,
  validateGuiSession,
} from './gui-test-host.mjs';

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
    'AI_TEST_PROVIDER="fireworks" # selected profile',
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
      assert.throws(() => loadTestEnv({ env: { ...base, [key]: value }, envFile: join(tmpdir(), 'missing-lineage-env'), requireAiProvider: true }), new RegExp(`^Error: ${key} must be`));
    }
  }
});

test('parseCdpPort accepts the default and valid custom ports', () => {
  assert.equal(parseCdpPort(), 9222);
  assert.equal(parseCdpPort('9475'), 9475);
});

test('parseCdpPort rejects invalid or unsafe ports', () => {
  for (const value of ['', '0', '65536', '9222.5', '-1', 'abc']) {
    assert.throws(() => parseCdpPort(value), /integer from 1 to 65535/);
  }
});

test('buildLaunchArgs isolates the profile and binds CDP to loopback', () => {
  const args = buildLaunchArgs({
    extensionPath: '/repo/data-lineage-viz',
    workspaceDir: '/tmp/gui/workspace',
    userDataDir: '/tmp/gui/user-data',
    extensionsDir: '/tmp/gui/extensions',
    cdpPort: 9475,
  });

  assert.deepEqual(args.slice(0, 2), ['/tmp/gui/workspace', '--no-sandbox']);
  assert.ok(args.includes('--extensionDevelopmentPath=/repo/data-lineage-viz'));
  assert.ok(args.includes('--user-data-dir=/tmp/gui/user-data'));
  assert.ok(args.includes('--extensions-dir=/tmp/gui/extensions'));
  assert.ok(args.includes('--disable-extensions'));
  assert.ok(args.includes('--disable-renderer-backgrounding'));
  assert.ok(args.includes('--disable-background-timer-throttling'));
  assert.ok(args.includes('--disable-backgrounding-occluded-windows'));
  assert.ok(args.includes('--window-size=1600,1000'));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--remote-debugging-port=9475'));
  assert.equal(args.some((argument) => argument.includes('/Applications/')), false);
});

test('buildLaunchArgs loads multiple development extensions without extension-tests mode', () => {
  const args = buildLaunchArgs({
    extensionPath: '/repo/data-lineage-viz',
    extensionPaths: ['/repo/data-lineage-viz', '/repo/db-runner'],
    workspaceDir: '/tmp/gui/workspace',
    userDataDir: '/tmp/gui/user-data',
    extensionsDir: '/tmp/gui/extensions',
    cdpPort: 9475,
    inMemorySecrets: true,
  });

  assert.deepEqual(args.filter((argument) => argument.startsWith('--extensionDevelopmentPath=')), [
    '--extensionDevelopmentPath=/repo/data-lineage-viz',
    '--extensionDevelopmentPath=/repo/db-runner',
  ]);
  assert.ok(args.includes('--use-inmemory-secretstorage'));
  assert.equal(args.some((argument) => argument.startsWith('--extensionTestsPath=')), false);
});

test('assertDbCredentialKeys checks presence without returning credential values', () => {
  const complete = 'DLV_SQL_USER=reader\nDLV_SQL_API=secret\nDLV_SQL_SA_USER=sa\nDLV_SQL_SA_API=admin-secret\n';
  assert.equal(assertDbCredentialKeys(complete), undefined);
  assert.throws(() => assertDbCredentialKeys('DLV_SQL_USER=reader\n'), /DLV_SQL_API, DLV_SQL_SA_USER, DLV_SQL_SA_API/);
});

test('requireDbFixtureExtensionPath resolves an existing directory without exposing internal paths', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'dlv-gui-fixture-'));
  try {
    assert.equal(requireDbFixtureExtensionPath(fixtureDir), fixtureDir);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('requireDbFixtureExtensionPath rejects missing, absent and non-directory values', () => {
  assert.throws(() => requireDbFixtureExtensionPath(''), /DLV_GUI_DB_FIXTURE_EXT/);
  assert.throws(() => requireDbFixtureExtensionPath(undefined), /DLV_GUI_DB_FIXTURE_EXT/);
  assert.throws(() => requireDbFixtureExtensionPath(join(tmpdir(), 'dlv-gui-fixture-absent')), /existing directory/);
});

test('assertMochaCompletion rejects zero, pending and incomplete runs', () => {
  assert.equal(assertMochaCompletion({ tests: 3, passes: 3, pending: 0, failures: 0 }), undefined);
  assert.throws(() => assertMochaCompletion({ tests: 0, passes: 0, pending: 0, failures: 0 }), /tests=0/);
  assert.throws(() => assertMochaCompletion({ tests: 3, passes: 2, pending: 1, failures: 0 }), /pending=1/);
  assert.throws(() => assertMochaCompletion({ tests: 3, passes: 2, pending: 0, failures: 1 }), /failures=1/);
});

test('assertAllPassReport rejects gaps, failures, missing IDs, duplicate IDs and empty runs', () => {
  assert.equal(assertAllPassReport({ cases: [{ id: 'DB-03a', status: 'PASS' }] }, ['DB-03a']), undefined);
  assert.throws(() => assertAllPassReport({ cases: [{ id: 'DB-06d', status: 'GAP' }] }), /DB-06d=GAP/);
  assert.throws(() => assertAllPassReport({ cases: [{ id: 'DB-07', status: 'FAIL' }] }), /DB-07=FAIL/);
  assert.throws(() => assertAllPassReport({ cases: [{ id: 'DB-02', status: 'PASS' }] }, ['DB-02', 'DB-03a']), /missing=DB-03a/);
  assert.throws(() => assertAllPassReport({ cases: [{ id: 'DB-02', status: 'PASS' }, { id: 'DB-02', status: 'PASS' }] }, ['DB-02']), /duplicate=DB-02/);
  assert.throws(() => assertAllPassReport({ cases: [] }), /no cases ran/);
});

test('validateGuiSession binds a runner identity to its loopback endpoint', () => {
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const session = {
    schemaVersion: 1,
    sessionId,
    endpoint: 'http://127.0.0.1:9475',
    pid: 1234,
    workspaceName: `dlv-gui-${sessionId}`,
    cdpPort: 9475,
  };

  assert.deepEqual(validateGuiSession(session), session);
  assert.throws(
    () => validateGuiSession({ ...session, endpoint: 'http://localhost:9475' }),
    /loopback CDP port/,
  );
  assert.throws(
    () => validateGuiSession({ ...session, workspaceName: 'ordinary-workspace' }),
    /workspace identity/,
  );
});

test('isIsolatedWorkbenchPage accepts the downloaded Extension Development Host', () => {
  const session = { workspaceName: 'dlv-gui-3a2929d2-1ccd-4355-a624-29445b1df473' };
  const page = {
    title: '[Extension Development Host] dlv-gui-3a2929d2-1ccd-4355-a624-29445b1df473',
    url: `vscode-file://vscode-app${pathToFileURL(resolve('/repo/.vscode-test')).pathname}/vscode-darwin-arm64-1.140.0/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html`,
  };

  assert.equal(isIsolatedWorkbenchPage(page, session, '/repo/.vscode-test'), true);
});

test('isIsolatedWorkbenchPage excludes an ordinary VS Code installation', () => {
  const session = { workspaceName: 'dlv-gui-3a2929d2-1ccd-4355-a624-29445b1df473' };
  const page = {
    title: '[Extension Development Host] dlv-gui-3a2929d2-1ccd-4355-a624-29445b1df473',
    url: 'vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html',
  };

  assert.equal(isIsolatedWorkbenchPage(page, session, '/repo/.vscode-test'), false);
});

test('assertLoopbackPortAvailable rejects a port already owned on loopback', async () => {
  const occupied = new EventEmitter();
  occupied.listen = () => queueMicrotask(() => occupied.emit('error', new Error('EADDRINUSE')));

  await assert.rejects(
    assertLoopbackPortAvailable(9475, () => occupied),
    /Loopback port 9475 is unavailable/,
  );
});

test('assertLoopbackPortAvailable releases an available probe listener', async () => {
  const available = new EventEmitter();
  let options;
  available.listen = (received, callback) => {
    options = received;
    queueMicrotask(callback);
  };
  available.close = (callback) => queueMicrotask(() => callback());

  await assertLoopbackPortAvailable(9475, () => available);
  assert.deepEqual(options, { host: '127.0.0.1', port: 9475, exclusive: true });
});

test('assertTcpEndpointReady accepts a listener and rejects a refused endpoint', async () => {
  const connected = new EventEmitter();
  connected.end = () => {};
  connected.destroy = () => {};
  await assertTcpEndpointReady('127.0.0.1', 14333, () => {
    queueMicrotask(() => connected.emit('connect'));
    return connected;
  });

  const refused = new EventEmitter();
  refused.end = () => {};
  refused.destroy = () => {};
  await assert.rejects(assertTcpEndpointReady('127.0.0.1', 14333, () => {
    queueMicrotask(() => refused.emit('error', new Error('ECONNREFUSED')));
    return refused;
  }), /127\.0\.0\.1:14333/);
});
