import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { loadTestEnv, prepareDatabaseToken } from './load-test-env.mjs';
import * as badgeReplay from './chat-ui-replay-trace.mjs';
import {
  assertLoopbackPortAvailable,
  buildLaunchArgs,
  isIsolatedWorkbenchPage,
  parseCdpPort,
  validateGuiSession,
} from './gui-test-host.mjs';

test('database token setup handles tokens and credential validation', async () => {
  const base = {
    DB_TEST_AUTH_TYPE: 'entraId',
    DB_TEST_CLIENT_ID: 'c',
    DB_TEST_TENANT_ID: 't',
    DB_TEST_USER: 'u',
    DB_TEST_PASSWORD: 'p',
  };
  const acquire = async () => ({ token: 'in-memory-token' });
  for (const env of [
    { ...base, DB_TEST_AUTH_TYPE: 'sqlLogin' },
    { ...base, DB_TEST_TOKEN: 'existing' },
  ]) {
    await prepareDatabaseToken(env, acquire);
  }
  const env = { ...base };
  await prepareDatabaseToken(env, acquire);
  assert.equal(env.DB_TEST_TOKEN, 'in-memory-token');
  await assert.rejects(
    prepareDatabaseToken({ ...base, DB_TEST_PASSWORD: '' }, acquire),
    /DB_TEST_PASSWORD/,
  );
});

test('cached CLI database setup executes launcher safely', async () => {
  const env = {
    DB_TEST_AUTH_TYPE: 'entraId',
    DB_TEST_AZURE_CLI_COMMAND: JSON.stringify(['cli-launcher', 'az']),
  };
  const execute = async () => ({ stdout: 'synthetic-token\n' });
  await prepareDatabaseToken(env, undefined, 1000, execute);
  assert.equal(env.DB_TEST_TOKEN, 'synthetic-token');
});

test('badge setup handles acceptance settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'dlv-badge-'));
  try {
    assert.throws(
      () => badgeReplay.badgeReplayTrace(root, undefined),
      /Badge acceptance needs/,
    );
    assert.equal(badgeReplay.badgeReplayTrace(root, '1'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
});

test('native controls and timeouts', () => {
  const errors = [
    { requestIndex: 1, message: 'AI provider returned HTTP 402' },
  ];
  assert.doesNotThrow(() => badgeReplay.assertUiProviderHealthy(errors, 1));
  errors.push({ requestIndex: 2, message: 'request timed out' });
  assert.throws(
    () => badgeReplay.assertUiProviderHealthy(errors, 1),
    /request timed out/,
  );

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

test('gui host: parseCdpPort accepts the default and valid custom ports', () => {
  assert.equal(parseCdpPort(), 9222);
  assert.equal(parseCdpPort('9475'), 9475);
});

test('gui host: parseCdpPort rejects invalid or unsafe ports', () => {
  for (const value of ['', '0', '65536', '9222.5', '-1', 'abc']) {
    assert.throws(() => parseCdpPort(value), /integer from 1 to 65535/);
  }
});

test('gui host: buildLaunchArgs isolates the profile and binds CDP to loopback', () => {
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
  assert.equal(
    args.some((argument) => argument.includes('/Applications/')),
    false,
  );
});

test('gui host: validateGuiSession binds a runner identity to its loopback endpoint', () => {
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
    () =>
      validateGuiSession({ ...session, workspaceName: 'ordinary-workspace' }),
    /workspace identity/,
  );
});

test('gui host: isIsolatedWorkbenchPage accepts the downloaded Extension Development Host', () => {
  const session = {
    workspaceName: 'dlv-gui-3a2929d2-1ccd-4355-a624-29445b1df473',
  };
  const page = {
    title:
      '[Extension Development Host] dlv-gui-3a2929d2-1ccd-4355-a624-29445b1df473',
    url: `vscode-file://vscode-app${pathToFileURL(resolve('/repo/.vscode-test')).pathname}/vscode-darwin-arm64-1.140.0/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html`,
  };

  assert.equal(
    isIsolatedWorkbenchPage(page, session, '/repo/.vscode-test'),
    true,
  );
});

test('gui host: isIsolatedWorkbenchPage excludes an ordinary VS Code installation', () => {
  const session = {
    workspaceName: 'dlv-gui-3a2929d2-1ccd-4355-a624-29445b1df473',
  };
  const page = {
    title:
      '[Extension Development Host] dlv-gui-3a2929d2-1ccd-4355-a624-29445b1df473',
    url: 'vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html',
  };

  assert.equal(
    isIsolatedWorkbenchPage(page, session, '/repo/.vscode-test'),
    false,
  );
});

test('gui host: assertLoopbackPortAvailable rejects a port already owned on loopback', async () => {
  const occupied = new EventEmitter();
  occupied.listen = () =>
    queueMicrotask(() => occupied.emit('error', new Error('EADDRINUSE')));

  await assert.rejects(
    assertLoopbackPortAvailable(9475, () => occupied),
    /Loopback port 9475 is unavailable/,
  );
});

test('gui host: assertLoopbackPortAvailable releases an available probe listener', async () => {
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
