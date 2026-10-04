// Starts an isolated VS Code test host for the opt-in Playwright workbench smoke.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const DEFAULT_CDP_PORT = 9222;

/** Parses and validates the loopback Chrome DevTools Protocol port. */
export function parseCdpPort(value = String(DEFAULT_CDP_PORT)) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`PLAYWRIGHT_CDP_PORT must be an integer from 1 to 65535; received ${JSON.stringify(value)}.`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PLAYWRIGHT_CDP_PORT must be an integer from 1 to 65535; received ${JSON.stringify(value)}.`);
  }
  return port;
}

/** Builds arguments that keep the test host separate from the user's VS Code profile. */
export function buildLaunchArgs({ extensionPath, extensionPaths = [extensionPath], workspaceDir, userDataDir, extensionsDir, cdpPort, inMemorySecrets = false }) {
  return [
    workspaceDir,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-cached-data',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1600,1000',
    '--disable-workspace-trust',
    '--disable-extensions',
    '--new-window',
    ...extensionPaths.map((candidate) => `--extensionDevelopmentPath=${candidate}`),
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${cdpPort}`,
    ...(inMemorySecrets ? ['--use-inmemory-secretstorage'] : []),
  ];
}

/** Fails without exposing values when the local DB GUI fixture credentials are incomplete. */
export function assertDbCredentialKeys(text) {
  const values = new Map(text.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    return match ? [[match[1], match[2].replace(/^(['"])(.*)\1$/u, '$2')]] : [];
  }));
  const required = ['DLV_SQL_USER', 'DLV_SQL_API', 'DLV_SQL_SA_USER', 'DLV_SQL_SA_API'];
  const missing = required.filter((key) => !values.get(key));
  if (missing.length) throw new Error(`DB GUI prerequisite missing: ${missing.join(', ')}`);
}

/** Fails fast when the isolated host cannot reach the local SQL fixture listener. */
export async function assertTcpEndpointReady(host, port, connectionFactory = createConnection) {
  await new Promise((resolveReady, rejectUnavailable) => {
    const socket = connectionFactory({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      rejectUnavailable(new Error(`DB GUI prerequisite unavailable: ${host}:${port} timed out.`));
    }, 3000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolveReady();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      rejectUnavailable(new Error(`DB GUI prerequisite unavailable: ${host}:${port}.`, { cause: error }));
    });
  });
}

/** Requires a completed Mocha run with at least one test and no failures or pending tests. */
export function assertMochaCompletion(completion) {
  const { failures, tests, passes, pending } = completion ?? {};
  if (![failures, tests, passes, pending].every(Number.isInteger)
    || tests <= 0 || failures !== 0 || pending !== 0 || passes !== tests) {
    throw new Error(`DB GUI Mocha completion is not all PASS: tests=${tests}, passes=${passes}, pending=${pending}, failures=${failures}.`);
  }
}

/** Requires an executed GUI acceptance report whose expected cases each passed exactly once. */
export function assertAllPassReport(report, expectedIds = []) {
  if (!report || !Array.isArray(report.cases)) throw new Error('DB GUI report has no cases array.');
  const counts = new Map();
  for (const entry of report.cases) counts.set(entry?.id, (counts.get(entry?.id) ?? 0) + 1);
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  const missing = expectedIds.filter((id) => !counts.has(id));
  const unexpected = expectedIds.length ? [...counts.keys()].filter((id) => !expectedIds.includes(id)) : [];
  const nonPass = report.cases.filter((entry) => entry?.status !== 'PASS');
  if (!report.cases.length || duplicates.length || missing.length || unexpected.length || nonPass.length) {
    throw new Error(`DB GUI report is not all PASS: ${[
      ...nonPass.map((entry) => `${entry?.id ?? 'unknown'}=${entry?.status ?? 'missing'}`),
      ...(duplicates.length ? [`duplicate=${duplicates.join(',')}`] : []),
      ...(missing.length ? [`missing=${missing.join(',')}`] : []),
      ...(unexpected.length ? [`unexpected=${unexpected.join(',')}`] : []),
    ].join('; ') || 'no cases ran'}.`);
  }
}

/** Validates the ignored runner session file before a smoke test trusts its endpoint. */
export function validateGuiSession(value) {
  if (!value || typeof value !== 'object') throw new Error('GUI test host session must be an object.');
  const { schemaVersion, sessionId, endpoint, pid, workspaceName, cdpPort } = value;
  if (schemaVersion !== 1) throw new Error('GUI test host session has an unsupported schema version.');
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/u.test(sessionId)) {
    throw new Error('GUI test host session has an invalid identity.');
  }
  if (workspaceName !== `dlv-gui-${sessionId}`) {
    throw new Error('GUI test host session has an invalid workspace identity.');
  }
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('GUI test host session has an invalid process id.');
  const port = parseCdpPort(String(cdpPort));
  if (endpoint !== `http://127.0.0.1:${port}`) {
    throw new Error('GUI test host session endpoint must use its loopback CDP port.');
  }
  return { schemaVersion, sessionId, endpoint, pid, workspaceName, cdpPort: port };
}

/** Matches only the runner's uniquely named workspace in its downloaded VS Code test build. */
export function isIsolatedWorkbenchPage({ title, url }, session, testCacheRoot) {
  if (typeof title !== 'string' || !title.includes('[Extension Development Host]')) return false;
  if (!title.includes(session.workspaceName)) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'vscode-file:' || parsed.hostname !== 'vscode-app') return false;

  const normalizePath = (value) => value.replaceAll('\\', '/').replace(/^\/([A-Za-z]:\/)/u, '$1');
  const workbenchPath = normalizePath(decodeURIComponent(parsed.pathname));
  const cachePath = normalizePath(resolve(testCacheRoot));
  return workbenchPath.startsWith(`${cachePath}/vscode-`);
}

/** Fails when another process already owns the requested loopback CDP port. */
export async function assertLoopbackPortAvailable(port, serverFactory = createServer) {
  await new Promise((resolveAvailable, rejectUnavailable) => {
    const server = serverFactory();
    server.once('error', (error) => {
      rejectUnavailable(
        new Error(`Loopback port ${port} is unavailable; choose another PLAYWRIGHT_CDP_PORT.`, {
          cause: error,
        }),
      );
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close((error) => {
        if (error) rejectUnavailable(error);
        else resolveAvailable();
      });
    });
  });
}

function clearStaleSession(sessionFile) {
  let previous;
  try {
    previous = validateGuiSession(JSON.parse(readFileSync(sessionFile, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error(`Cannot claim the GUI test host session marker: ${error.message}`);
  }

  try {
    process.kill(previous.pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') {
      unlinkSync(sessionFile);
      return;
    }
    throw error;
  }
  throw new Error(`GUI test host session ${previous.sessionId} is already active (pid ${previous.pid}).`);
}

async function run() {
  const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const dbMode = process.env.DLV_GUI_MODE === 'db';
  const fixtureExtensionPath = resolve(extensionPath, 'internal-tests/gui-electron/fixture-extension');
  const cdpPort = parseCdpPort(process.env.PLAYWRIGHT_CDP_PORT);
  const sessionId = randomUUID();
  const workspaceName = `dlv-gui-${sessionId}`;
  const sessionFile = join(extensionPath, '.vscode-test', 'gui-host-session.json');
  mkdirSync(dirname(sessionFile), { recursive: true });
  clearStaleSession(sessionFile);
  await assertLoopbackPortAvailable(cdpPort);
  const tempRoot = mkdtempSync(join(tmpdir(), 'data-lineage-viz-gui-'));
  const workspaceDir = join(tempRoot, workspaceName);
  const userDataDir = join(tempRoot, 'user-data');
  const extensionsDir = join(tempRoot, 'extensions');
  const theme = process.env.DLV_GUI_THEME || 'Default Dark Modern';
  const runId = `gui-DB-${theme.replace(/\s+/gu, '-')}`;
  const completionFile = join(tempRoot, 'db-suite-complete.json');
  const reportPath = join(extensionPath, 'tmp/gui-acceptance', `report-DB-${theme.replace(/\s+/gu, '-')}.json`);

  let child;
  let childResult;
  let forwardedSignal;
  const forwardSignal = (signal) => {
    forwardedSignal = signal;
    if (child && !child.killed) child.kill(signal);
  };
  const onSigint = () => forwardSignal('SIGINT');
  const onSigterm = () => forwardSignal('SIGTERM');

  try {
    for (const directory of [workspaceDir, userDataDir, extensionsDir]) mkdirSync(directory);
    if (dbMode) {
      assertDbCredentialKeys(readFileSync(join(extensionPath, '.env'), 'utf8'));
      await assertTcpEndpointReady('127.0.0.1', 14333);
      mkdirSync(join(userDataDir, 'User'), { recursive: true });
      writeFileSync(join(userDataDir, 'User', 'settings.json'), JSON.stringify({
        'update.mode': 'none',
        'window.dialogStyle': 'custom',
        'security.workspace.trust.enabled': false,
        'workbench.colorTheme': theme,
      }, null, 2));
      const contextDir = join(extensionPath, 'tmp/gui-acceptance');
      mkdirSync(contextDir, { recursive: true });
      try { unlinkSync(reportPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      writeFileSync(join(contextDir, `run-context-${runId}.json`), JSON.stringify({
        userDataDir, extensionsDir, workspaceFolder: workspaceDir, theme,
        remoteDebuggingPort: String(cdpPort), extensionDevelopmentPath: extensionPath,
      }, null, 2));
    }
    const executable = await downloadAndUnzipVSCode({ extensionDevelopmentPath: extensionPath });
    const args = buildLaunchArgs({
      extensionPath,
      extensionPaths: dbMode ? [extensionPath, fixtureExtensionPath] : [extensionPath],
      workspaceDir, userDataDir, extensionsDir, cdpPort, inMemorySecrets: dbMode,
    });
    const env = { ...process.env };
    if (dbMode) Object.assign(env, {
      DLV_GUI_CDP_PORT: String(cdpPort),
      DLV_GUI_RUN_ID: runId,
      DLV_GUI_THEME: theme,
      DLV_GUI_EXT_PATH: extensionPath,
      DLV_GUI_COMPLETE_FILE: completionFile,
    });
    delete env.ELECTRON_RUN_AS_NODE;

    child = spawn(executable, args, {
      cwd: extensionPath,
      env,
      shell: false,
      stdio: 'inherit',
    });
    childResult = new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('close', (code, signal) => resolveExit({ code, signal }));
    });
    if (!child.pid) throw new Error('VS Code test host did not start.');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    const session = validateGuiSession({
      schemaVersion: 1,
      sessionId,
      endpoint: `http://127.0.0.1:${cdpPort}`,
      pid: child.pid,
      workspaceName,
      cdpPort,
    });
    writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

    console.log(`[gui-host] Isolated VS Code test host starting at http://127.0.0.1:${cdpPort}.`);
    console.log(dbMode
      ? '[gui-host] DB GUI suite is running in the isolated host and will close it when complete.'
      : '[gui-host] Run npm run test:gui:smoke in another terminal; press Ctrl-C here when finished.');

    const result = await childResult;
    if (forwardedSignal) {
      process.exitCode = forwardedSignal === 'SIGINT' ? 130 : 143;
    } else if (result.code !== 0) {
      throw new Error(`VS Code test host exited with ${result.signal ?? `code ${result.code}`}.`);
    }
    if (dbMode) {
      const completion = JSON.parse(readFileSync(completionFile, 'utf8'));
      assertMochaCompletion(completion);
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      const expectedIds = (process.env.DLV_GUI_EXPECT_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
      if (process.env.DLV_GUI_GREP && !expectedIds.length) throw new Error('DLV_GUI_EXPECT_IDS is required with DLV_GUI_GREP in DB mode.');
      assertAllPassReport(report, expectedIds);
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await childResult?.catch(() => undefined);
    }
    try {
      const active = validateGuiSession(JSON.parse(readFileSync(sessionFile, 'utf8')));
      if (active.sessionId === sessionId) unlinkSync(sessionFile);
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn(`[gui-host] Could not remove session marker: ${error.message}`);
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => {
    console.error(`[gui-host] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
