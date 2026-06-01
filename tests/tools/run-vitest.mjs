import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const env = { ...process.env };
const vitestBin = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const hasConfigLoader = args.includes('--configLoader');
const vitestArgs = hasConfigLoader ? args : ['--configLoader', 'runner', ...args];

for (const key of Object.keys(env)) {
  if (key === 'INIT_CWD' || key.startsWith('npm_')) {
    delete env[key];
  }
}

const result = spawnSync(process.execPath, [vitestBin, ...vitestArgs], {
  cwd: repoRoot,
  env,
  shell: false,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
