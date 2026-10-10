/**
 * Lifecycle of the live Extension Development Host that serves the MCP server for external tests.
 *
 * @remarks
 * Shared by the deep MCP matrix (`tests/tools/mcp-live.mjs`) and the facts toolbelt
 * (`tests/tools/mcp/facts.mjs`). One definition of: the isolated profile, the host launch, the
 * command channel that performs user-level actions inside the host (toggle the setting, change the
 * port, load a project), and the optional detached mode that keeps a host running between commands.
 * The host test it drives is `tests/integration/mcp-live.test.ts`.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const WORK = join(root, 'tmp', 'mcp-live');
export const CONTROL = join(WORK, 'control');
export const USER_DATA = join(WORK, 'user-data');
export const SESSION_FILE = join(WORK, 'session.json');
export const HOST_LOG = join(WORK, 'host.log');
export const DEFAULT_PORT = 39372;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exits the process with code 4 (prerequisite or host failure) and a one-line reason. */
export function fail4(message) {
  console.error(`MCP-LIVE: ${message}`);
  process.exit(4);
}

/** Polls `predicate` until it returns a truthy value or `ms` pass. */
export async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${label}`);
}

export const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Creates a clean isolated profile whose user settings turn the MCP server on at `port`. */
export function prepare(port = DEFAULT_PORT) {
  if (!existsSync(join(root, 'out/test/tests/integration/mcp-live.test.js'))) {
    fail4('integration tests are not compiled. Run `npm run pretest:integration` (or `npm run test:mcp:live`).');
  }
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(CONTROL, { recursive: true });
  mkdirSync(join(USER_DATA, 'User'), { recursive: true });
  writeFileSync(join(USER_DATA, 'User/settings.json'), JSON.stringify({
    'dataLineageViz.mcp.enabled': true,
    'dataLineageViz.mcp.port': port,
  }, null, 2));
}

function hostCommandLine() {
  const needsDisplay = !process.env.DISPLAY && process.platform === 'linux';
  return needsDisplay
    ? ['xvfb-run', ['-a', 'npx', 'vscode-test', '--label', 'mcp-live']]
    : ['npx', ['vscode-test', '--label', 'mcp-live']];
}

/**
 * Starts the host. In the default mode the output is buffered and `exited` resolves with the exit
 * code; with `detach` the host runs in its own process group, writes `host.log`, and outlives this process.
 */
export function launchHost({ port = DEFAULT_PORT, detach = false } = {}) {
  const [command, commandArgs] = hostCommandLine();
  const env = {
    ...process.env,
    MCP_LIVE_DIR: CONTROL,
    MCP_LIVE_USER_DATA: USER_DATA,
    MCP_LIVE_PORT: String(port),
    // A detached session is meant to be used between commands; a matrix run is bounded to 15 minutes.
    MCP_LIVE_MAX_MS: String(detach ? 4 * 60 * 60_000 : 15 * 60_000),
  };
  if (detach) {
    const fd = openSync(HOST_LOG, 'a');
    const child = spawn(command, commandArgs, { cwd: root, env, detached: true, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    child.on('error', (error) => fail4(`could not start the host (${command}): ${error.message}`));
    child.unref();
    return { child, exited: new Promise(() => undefined), logPath: HOST_LOG };
  }
  const child = spawn(command, commandArgs, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', (d) => chunks.push(d));
  child.stderr.on('data', (d) => chunks.push(d));
  const exited = new Promise((res) => child.on('exit', (code) => { writeFileSync(HOST_LOG, Buffer.concat(chunks)); res(code); }));
  child.on('error', (error) => fail4(`could not start the host (${command}): ${error.message}`));
  return { child, exited, logPath: HOST_LOG };
}

/** Waits for the host test to publish `ready.json`; fails fast when the host process ends first. */
export async function waitForReady(host) {
  let exitCode;
  host.exited.then((code) => { exitCode = code; });
  const ready = await waitFor(
    () => (existsSync(join(CONTROL, 'ready.json')) ? JSON.parse(readFileSync(join(CONTROL, 'ready.json'), 'utf8')) : exitCode !== undefined ? 'exited' : null),
    300_000,
    'the live host to publish ready.json',
  ).catch((error) => fail4(`${error.message}. See ${host.logPath} (the first run downloads the VS Code test build).`));
  if (ready === 'exited') fail4(`the host exited with code ${exitCode} before it was ready. See ${host.logPath}.`);
  return ready;
}

/** Sends a user-level action to the host (`toggle`, `setPort`, `loadDemo`, `loadAI`, `status`) and returns its answer. */
export async function hostCommand(action, extra = {}) {
  const taken = readdirSync(CONTROL).map((f) => /^cmd-(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number);
  const n = (taken.length ? Math.max(...taken) : 0) + 1;
  const tmp = join(CONTROL, `cmd-${n}.tmp`);
  writeFileSync(tmp, JSON.stringify({ action, ...extra }));
  renameSync(tmp, join(CONTROL, `cmd-${n}.json`));
  const file = join(CONTROL, `res-${n}.json`);
  await waitFor(() => existsSync(file), 150_000, `host answer to ${action}`);
  const answer = JSON.parse(readFileSync(file, 'utf8'));
  if (!answer.ok) throw new Error(`host action ${action} failed: ${answer.error}`);
  return answer;
}

/** Tells the host to finish and waits for it; falls back to killing the launcher process. */
export async function finishHost(host) {
  writeFileSync(join(CONTROL, 'done'), '');
  const code = await Promise.race([host.exited, sleep(60_000).then(() => 'timeout')]);
  if (code === 'timeout') host.child.kill();
  return code;
}

// ───────────────────────────── detached sessions (for the facts toolbelt) ─────────────────────────────

/** The running detached session, or `null` when none is alive. */
export function readSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    return isAlive(session.pid) && existsSync(join(CONTROL, 'ready.json')) ? session : null;
  } catch { return null; }
}

/** Starts a host that keeps running after this process exits, and records it in `session.json`. */
export async function startDetached(port = DEFAULT_PORT) {
  prepare(port);
  const host = launchHost({ port, detach: true });
  const ready = await waitForReady(host);
  writeFileSync(SESSION_FILE, JSON.stringify({ pid: host.child.pid, port: ready.port, ready, startedAt: new Date().toISOString() }, null, 2));
  return { ready, session: readSession() };
}

/** Stops the detached host (graceful first, then its whole process group). */
export async function stopDetached() {
  const session = readSession();
  if (!session) return false;
  writeFileSync(join(CONTROL, 'done'), '');
  const deadline = Date.now() + 60_000;
  while (isAlive(session.pid) && Date.now() < deadline) await sleep(500);
  if (isAlive(session.pid)) { try { process.kill(-session.pid, 'SIGTERM'); } catch { process.kill(session.pid, 'SIGTERM'); } }
  rmSync(SESSION_FILE, { force: true });
  return true;
}

/** Runs `fn(ready)` against the running detached host, or against a one-shot host started just for the call. */
export async function withHost(fn, port = DEFAULT_PORT) {
  const session = readSession();
  if (session) return fn(session.ready);
  prepare(port);
  const host = launchHost({ port });
  const ready = await waitForReady(host);
  try { return await fn(ready); } finally { await finishHost(host); }
}
