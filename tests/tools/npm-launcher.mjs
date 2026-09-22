// Resolve npm-family CLI entry points and spawn them through Node so tooling has identical
// argument semantics on Windows and POSIX without invoking platform launcher shims.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** The node binary to spawn with. `npm_node_execpath` is set for anything npm launches. */
export const nodeBin = process.env.npm_node_execpath || process.execPath;

/**
 * Resolves a tool's CLI entry point (`npm` -> `npm-cli.js`) to an absolute path.
 *
 * @param {'npm' | 'npx'} tool - Which npm-family launcher to locate.
 * @returns {string | null} Absolute path, or `null` when no known layout matches.
 *
 * @remarks
 * `npm_execpath` is set for anything npm launches — including a script's own child processes, which
 * inherit the environment — so it covers `npm run <script>` and everything below it. The layout
 * fallbacks cover a direct `node tests/tools/<script>.mjs` invocation, where install layouts differ:
 * Windows keeps npm beside `node.exe`, POSIX puts it under `<prefix>/lib/node_modules`.
 */
function resolveNpmCli(tool) {
  const cliFile = `${tool}-cli.js`;
  const fromEnv = process.env.npm_execpath;
  if (fromEnv) {
    const beside = path.join(path.dirname(fromEnv), cliFile);
    if (existsSync(beside)) return beside;
  }
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', cliFile),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', cliFile),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Builds a `{ cmd, args }` spawn descriptor for npm or npx, preferring the portable form.
 *
 * @param {'npm' | 'npx'} tool - Which npm-family launcher to invoke.
 * @param {readonly string[]} args - Arguments to pass to it.
 * @returns {{ cmd: string, args: string[], viaShim: boolean }} Spawn descriptor; `viaShim` marks
 *   the degraded fallback so callers can report *how* a failure happened.
 *
 * @remarks Falls back to the PATH launcher only when no supported CLI layout can be resolved.
 */
export function npmCommand(tool, args) {
  const cli = resolveNpmCli(tool);
  if (cli) return { cmd: nodeBin, args: [cli, ...args], viaShim: false };
  return { cmd: tool, args: [...args], viaShim: true };
}

/** Memoized result of {@link pythonCommand} — probing spawns a process, so repeat callers must not each pay for it. */
let cachedPythonBin;

/**
 * Resolves a Python 3 interpreter on PATH by name, without assuming `python3` is what a given
 * machine exposes.
 *
 * @returns {string | null} `'python3'` or `'python'`, whichever answers `--version` first, or
 *   `null` when neither is on PATH.
 *
 * @remarks
 * Probed once per process and cached: a step that needs this every run should not re-spawn a
 * probe process per call. Callers treat `null` as a reason to skip their step, not to fail it —
 * an interpreter missing from PATH says nothing about whether the step's own check would pass.
 */
export function pythonCommand() {
  if (cachedPythonBin !== undefined) return cachedPythonBin;
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) {
      cachedPythonBin = candidate;
      return cachedPythonBin;
    }
  }
  cachedPythonBin = null;
  return cachedPythonBin;
}
