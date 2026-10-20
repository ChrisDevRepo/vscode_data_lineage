import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  const base = { DB_TEST_AUTH_TYPE: 'entraId', DB_TEST_CLIENT_ID: 'c', DB_TEST_TENANT_ID: 't', DB_TEST_USER: 'u', DB_TEST_PASSWORD: 'p' };
  const acquire = async () => ({ token: 'in-memory-token' });
  for (const env of [{ ...base, DB_TEST_AUTH_TYPE: 'sqlLogin' }, { ...base, DB_TEST_TOKEN: 'existing' }]) {
    await prepareDatabaseToken(env, acquire);
  }
  const env = { ...base };
  await prepareDatabaseToken(env, acquire);
  assert.equal(env.DB_TEST_TOKEN, 'in-memory-token');
  await assert.rejects(prepareDatabaseToken({ ...base, DB_TEST_PASSWORD: '' }, acquire), /DB_TEST_PASSWORD/);
});

test('cached CLI database setup executes launcher safely', async () => {
  const env = { DB_TEST_AUTH_TYPE: 'entraId', DB_TEST_AZURE_CLI_COMMAND: JSON.stringify(['cli-launcher', 'az']) };
  const execute = async () => ({ stdout: 'synthetic-token\n' });
  await prepareDatabaseToken(env, undefined, 1000, execute);
  assert.equal(env.DB_TEST_TOKEN, 'synthetic-token');
});

test('badge setup handles acceptance settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'dlv-badge-'));
  try {
    assert.throws(() => badgeReplay.badgeReplayTrace(root, undefined), /Badge acceptance needs/);
    assert.equal(badgeReplay.badgeReplayTrace(root, '1'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider profiles resolve from environment and precedence', () => {
  const env = { AI_TEST_PROVIDER: 'azure', AZURE_URI: 'https://p.example/v1', AZURE_API: 'sec', AZURE_MODEL: 'm' };
  const id = loadTestEnv({ env, envFile: join(tmpdir(), 'missing-env'), requireAiProvider: true });
  assert.deepEqual(id, { provider: 'azure', model: 'm' });
  assert.equal(env.AI_TEST_ENDPOINT, 'https://p.example/v1');

  const dir = mkdtempSync(join(tmpdir(), 'env-test-'));
  try {
    writeFileSync(join(dir, '.env'), 'AI_TEST_PROVIDER="fireworks"\nAI_TEST_MODEL=file-m\nFIREWORKS_URL=https://f.example\nFIREWORKS_API=s\nFIREWORKS_MODEL=m');
    const override = { AI_TEST_MODEL: 'shell-m' };
    const res = loadTestEnv({ env: override, envFile: join(dir, '.env'), requireAiProvider: true });
    assert.equal(res.model, 'shell-m');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.throws(() => loadTestEnv({ env: { AI_TEST_PROVIDER: 'azure', AZURE_MODEL: 'm' }, envFile: join(tmpdir(), 'missing'), requireAiProvider: true }), /missing AI_TEST_ENDPOINT/);
});

test('native controls and timeouts', () => {
  const errors = [{ requestIndex: 1, message: 'AI provider returned HTTP 402' }];
  assert.doesNotThrow(() => badgeReplay.assertUiProviderHealthy(errors, 1));
  errors.push({ requestIndex: 2, message: 'request timed out' });
  assert.throws(() => badgeReplay.assertUiProviderHealthy(errors, 1), /request timed out/);

  const env = { AI_TEST_PROVIDER: 'openai-compatible', AI_TEST_ENDPOINT: 'http://loc:8000/v1', AI_TEST_API_KEY: 'k', AI_TEST_MODEL: 'm', AI_TEST_TIMEOUT_MS: '5000' };
  loadTestEnv({ env, envFile: join(tmpdir(), 'missing'), requireAiProvider: true });
  assert.equal(env.AI_TEST_TIMEOUT_MS, '5000');
});

test('gui launch and session helpers', async () => {
  assert.equal(parseCdpPort(), 9222);
  assert.equal(parseCdpPort('9475'), 9475);
  assert.throws(() => parseCdpPort('invalid'), /integer from 1 to 65535/);

  const args = buildLaunchArgs({ extensionPath: '/ext', workspaceDir: '/ws', userDataDir: '/ud', extensionsDir: '/ed', cdpPort: 9475 });
  assert.ok(args.includes('--remote-debugging-port=9475'));

  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const session = { schemaVersion: 1, sessionId, endpoint: 'http://127.0.0.1:9475', pid: 1, workspaceName: `dlv-gui-${sessionId}`, cdpPort: 9475 };
  assert.deepEqual(validateGuiSession(session), session);
  assert.throws(() => validateGuiSession({ ...session, endpoint: 'http://loc:9475' }), /loopback CDP port/);

  const cacheRoot = resolve('/repo/.vscode-test');
  assert.equal(isIsolatedWorkbenchPage({ title: '[Extension Development Host] dlv-gui-s', url: `vscode-file://vscode-app${cacheRoot}/vscode-darwin/workbench.html` }, { workspaceName: 'dlv-gui-s' }, '/repo/.vscode-test'), true);
  assert.equal(isIsolatedWorkbenchPage({ title: 'Ordinary', url: 'vscode-file://vscode-app/Applications/workbench.html' }, { workspaceName: 'dlv-gui-s' }, '/repo/.vscode-test'), false);

  const probe = new EventEmitter();
  probe.listen = (opts, cb) => queueMicrotask(cb);
  probe.close = (cb) => queueMicrotask(cb);
  await assertLoopbackPortAvailable(9475, () => probe);
});
