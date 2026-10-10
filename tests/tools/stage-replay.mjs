/** Bundles `stageReplay.ts` into ignored out/test-tools, loads optional test settings, then runs it. */
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTestEnv } from './load-test-env.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
process.chdir(root);
if (args[0] === 'replay' && !args.includes('--help')) loadTestEnv();
const outfile = resolve(root, 'out/test-tools/stageReplay.mjs');
await build({
  entryPoints: [resolve(root, 'tests/tools/stageReplay.ts')],
  outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'warning',
});
const { main } = await import(pathToFileURL(outfile).href);
process.exitCode = await main(args, {
  repoRoot: root,
  env: process.env,
  fetchImpl: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: () => Date.now(),
  log: (line) => console.log(line),
});
