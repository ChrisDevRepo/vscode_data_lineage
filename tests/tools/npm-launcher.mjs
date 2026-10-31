import { existsSync } from 'node:fs';
import path from 'node:path';

/** The node binary to spawn with. `npm_node_execpath` is set for anything npm launches. */
export const nodeBin = process.env.npm_node_execpath || process.execPath;

/** Resolves a tool's CLI entry point (`npm` -> `npm-cli.js`) to an absolute path. */
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

/** Builds a `{ cmd, args }` spawn descriptor for npm or npx, preferring the portable form. */
export function npmCommand(tool, args) {
  const cli = resolveNpmCli(tool);
  if (cli) return { cmd: nodeBin, args: [cli, ...args], viaShim: false };
  return { cmd: tool, args: [...args], viaShim: true };
}
