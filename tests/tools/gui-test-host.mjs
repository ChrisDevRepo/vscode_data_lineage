// Starts an isolated VS Code test host for the opt-in Playwright workbench smoke.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const DEFAULT_CDP_PORT = 9222;

/** Parses and validates the loopback Chrome DevTools Protocol port. */
export function parseCdpPort(value = String(DEFAULT_CDP_PORT)) {
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `PLAYWRIGHT_CDP_PORT must be an integer from 1 to 65535; received ${JSON.stringify(value)}.`,
    );
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `PLAYWRIGHT_CDP_PORT must be an integer from 1 to 65535; received ${JSON.stringify(value)}.`,
    );
  }
  return port;
}

/** Builds arguments that keep the test host separate from the user's VS Code profile. */
export function buildLaunchArgs({
  extensionPath,
  workspaceDir,
  userDataDir,
  extensionsDir,
  cdpPort,
}) {
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
    `--extensionDevelopmentPath=${extensionPath}`,
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${cdpPort}`,
  ];
}

/** Validates the ignored runner session file before a smoke test trusts its endpoint. */
export function validateGuiSession(value) {
  if (!value || typeof value !== 'object')
    throw new Error('GUI test host session must be an object.');
  const { schemaVersion, sessionId, endpoint, pid, workspaceName, cdpPort } =
    value;
  if (schemaVersion !== 1)
    throw new Error('GUI test host session has an unsupported schema version.');
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/u.test(sessionId)) {
    throw new Error('GUI test host session has an invalid identity.');
  }
  if (workspaceName !== `dlv-gui-${sessionId}`) {
    throw new Error('GUI test host session has an invalid workspace identity.');
  }
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw new Error('GUI test host session has an invalid process id.');
  const port = parseCdpPort(String(cdpPort));
  if (endpoint !== `http://127.0.0.1:${port}`) {
    throw new Error(
      'GUI test host session endpoint must use its loopback CDP port.',
    );
  }
  return {
    schemaVersion,
    sessionId,
    endpoint,
    pid,
    workspaceName,
    cdpPort: port,
  };
}

/** Matches only the runner's uniquely named workspace in its downloaded VS Code test build. */
export function isIsolatedWorkbenchPage(
  { title, url },
  session,
  testCacheRoot,
) {
  if (
    typeof title !== 'string' ||
    !title.includes('[Extension Development Host]')
  )
    return false;
  if (!title.includes(session.workspaceName)) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'vscode-file:' || parsed.hostname !== 'vscode-app')
    return false;

  const normalizePath = (value) =>
    value.replaceAll('\\', '/').replace(/^\/([A-Za-z]:\/)/u, '$1');
  const workbenchPath = normalizePath(decodeURIComponent(parsed.pathname));
  const cachePath = normalizePath(resolve(testCacheRoot));
  return workbenchPath.startsWith(`${cachePath}/vscode-`);
}

/** Fails when another process already owns the requested loopback CDP port. */
export async function assertLoopbackPortAvailable(
  port,
  serverFactory = createServer,
) {
  await new Promise((resolveAvailable, rejectUnavailable) => {
    const server = serverFactory();
    server.once('error', (error) => {
      rejectUnavailable(
        new Error(
          `Loopback port ${port} is unavailable; choose another PLAYWRIGHT_CDP_PORT.`,
          {
            cause: error,
          },
        ),
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
    previous = validateGuiSession(
      JSON.parse(readFileSync(sessionFile, 'utf8')),
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error(
      `Cannot claim the GUI test host session marker: ${error.message}`,
    );
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
  throw new Error(
    `GUI test host session ${previous.sessionId} is already active (pid ${previous.pid}).`,
  );
}

async function run() {
  const extensionPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const cdpPort = parseCdpPort(process.env.PLAYWRIGHT_CDP_PORT);
  const sessionId = randomUUID();
  const workspaceName = `dlv-gui-${sessionId}`;
  const sessionFile = join(
    extensionPath,
    '.vscode-test',
    'gui-host-session.json',
  );
  mkdirSync(dirname(sessionFile), { recursive: true });
  clearStaleSession(sessionFile);
  await assertLoopbackPortAvailable(cdpPort);
  const tempRoot = mkdtempSync(join(tmpdir(), 'data-lineage-viz-gui-'));
  const workspaceDir = join(tempRoot, workspaceName);
  const userDataDir = join(tempRoot, 'user-data');
  const extensionsDir = join(tempRoot, 'extensions');

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
    for (const directory of [workspaceDir, userDataDir, extensionsDir])
      mkdirSync(directory);
    const executable = await downloadAndUnzipVSCode({
      extensionDevelopmentPath: extensionPath,
    });
    const args = buildLaunchArgs({
      extensionPath,
      workspaceDir,
      userDataDir,
      extensionsDir,
      cdpPort,
    });
    const env = { ...process.env };
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
    writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });

    console.log(
      `[gui-host] Isolated VS Code test host starting at http://127.0.0.1:${cdpPort}.`,
    );
    console.log(
      '[gui-host] Run npm run test:gui:smoke in another terminal; press Ctrl-C here when finished.',
    );

    const result = await childResult;
    if (forwardedSignal) {
      process.exitCode = forwardedSignal === 'SIGINT' ? 130 : 143;
    } else if (result.code !== 0) {
      throw new Error(
        `VS Code test host exited with ${result.signal ?? `code ${result.code}`}.`,
      );
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await childResult?.catch(() => undefined);
    }
    try {
      const active = validateGuiSession(
        JSON.parse(readFileSync(sessionFile, 'utf8')),
      );
      if (active.sessionId === sessionId) unlinkSync(sessionFile);
    } catch (error) {
      if (error?.code !== 'ENOENT')
        console.warn(
          `[gui-host] Could not remove session marker: ${error.message}`,
        );
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  run().catch((error) => {
    console.error(
      `[gui-host] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
