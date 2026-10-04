/** Compile fresh, isolate the VS Code shim, then run an explicitly selected optional service check. */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTestEnv } from './load-test-env.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
process.chdir(root);
const [kind, ...args] = process.argv.slice(2);
if (!['ai', 'db'].includes(kind)) throw new Error('Choose ai or db.');
if (!args.includes('--help')) loadTestEnv();
const build = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tests/harness/tsconfig.json'], {
  cwd: root, stdio: 'inherit', shell: false,
});
if (build.status !== 0) process.exit(build.status ?? 1);
const Module = require('node:module');
const originalLoad = Module._load;
const shim = require(resolve(root, 'out/test-headless/tests/harness/vscodeHostShim.js'));
Module._load = function(request, parent, isMain) {
  return request === 'vscode' ? shim : originalLoad.call(this, request, parent, isMain);
};
const { main } = require(resolve(root, 'out/test-headless/tests/harness/cli.js'));
try {
  process.exitCode = await main(kind, args);
} catch {
  console.error('FAIL: optional runner could not complete; inspect ignored test-results/headless output.');
  process.exitCode = 2;
}
