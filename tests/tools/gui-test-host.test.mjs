// Covers isolated GUI host arguments and CDP port validation without launching VS Code.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
    url: 'vscode-file://vscode-app/repo/.vscode-test/vscode-darwin-arm64-1.140.0/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html',
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
